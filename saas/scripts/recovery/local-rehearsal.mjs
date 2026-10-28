#!/usr/bin/env node
// LOCAL_NATIVE_LOGICAL_REHEARSAL_ONLY. Not a managed-backup, PITR, GoTrue, Vault, Storage or billing recovery test.
// Requires Node >=22.12.0 (repository engine).
// Usage: node scripts/recovery/local-rehearsal.mjs --pg-bin <PostgreSQL 17 bin dir> [--keep-artifacts]
// Creates a private throwaway cluster (Unix socket only, trust auth for one bootstrap user), loads the labelled
// Auth/Vault doubles + real migrations + synthetic seed, takes a custom-format archive and proves restore,
// recovery after source mutation, pre-restore corruption rejection and single-transaction atomicity.
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as L from "./rehearsal-lib.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const t0 = Date.now();
const report = { label: L.LABEL, notice: "Local synthetic logical rehearsal only. Not managed backup certification; not hosted, billing-state or PITR recovery evidence.",
  status: "FAIL", versions: null, steps: [], measured_drill_ms_not_sla: {}, manifest: null, controls: {} };
const step = (name, ok, detail = {}) => { report.steps.push({ name, ok, ...detail }); if (!ok) throw new Error(`step failed: ${name}`); };

function run(bin, args, { env, input, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { env, shell: false, stdio: ["pipe", "pipe", "pipe"], timeout: 600_000 });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => {
      if (!allowFail && (code !== 0 || err.trim() !== "")) reject(new Error(`${basename(bin)} exit ${code}; stderr: ${err.trim().slice(0, 2000)}`));
      else resolve({ code, out, err });
    });
    p.stdin.end(input ?? "");
  });
}

async function main() {
  const args = L.parseArgs(process.argv.slice(2));
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Unix sockets required (darwin/linux)");
  if (process.getuid?.() === 0) throw new Error("refusing to run as root");
  const binDir = realpathSync(args.pgBin);
  L.assertSafePath(binDir, "resolved --pg-bin");
  if (!statSync(binDir).isDirectory() || (statSync(binDir).mode & 0o002)) throw new Error("--pg-bin must be a non-world-writable directory");
  const bin = Object.fromEntries(L.REQUIRED_BINARIES.map((b) => [b, join(binDir, b)]));
  const env = L.scrubEnv(process.env);
  const outputs = {};
  for (const b of L.REQUIRED_BINARIES) {
    if (!existsSync(bin[b]) || !statSync(bin[b]).isFile()) throw new Error(`missing binary ${b}`);
    outputs[b] = (await run(bin[b], ["--version"], { env })).out;
  }
  report.versions = L.checkVersions(outputs);

  // Private work dir (0700) under the OS temp dir; only this exact path is ever deleted.
  const tmpRoot = realpathSync(tmpdir());
  const work = mkdtempSync(join(tmpRoot, L.WORKDIR_PREFIX));
  chmodSync(work, 0o700);
  L.assertSafePath(work, "work dir");
  const data = join(work, "data"), sock = join(work, "s"), artifacts = join(work, "artifacts");
  for (const d of [sock, artifacts]) { mkdirSync(d, { mode: 0o700 }); }
  if (join(sock, `.s.PGSQL.${L.PORT}`).length > 100) throw new Error("socket path too long");
  let pid = null, startAttempted = false;
  const conn = (db) => ["-h", sock, "-p", L.PORT, "-U", L.SUPERUSER, "-d", db];
  const psql = (db, sql) => run(bin.psql, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...conn(db), "-f", "-"], { env, input: sql }).then((r) => r.out.trim());
  const psqlFile = (db, file) => run(bin.psql, ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", ...conn(db), "-c", "set client_min_messages to warning", "-f", file], { env });
  const createDb = (db) => psql("postgres", `create database ${db} template template0;`);
  const manifestOf = async (db) => {
    const tables = JSON.parse(await psql(db, L.TABLE_LIST_SQL));
    return { tables: JSON.parse(await psql(db, L.tableHashSql(tables))), sequences: JSON.parse(await psql(db, L.sequenceStateSql(JSON.parse(await psql(db, L.SEQUENCE_LIST_SQL))))),
      catalog: JSON.parse(await psql(db, L.CATALOG_SQL)) };
  };
  const timed = async (k, f) => { const s = Date.now(); try { return await f(); } finally { report.measured_drill_ms_not_sla[k] = Date.now() - s; } };
  const restore = (db, archive, allowFail = false) => run(bin.pg_restore, ["--single-transaction", "--exit-on-error", "--no-password", ...conn(db), archive], { env, allowFail });

  try {
    await run(bin.initdb, ["-D", data, "-U", L.SUPERUSER, "--auth-local=trust", "--auth-host=reject", "--encoding=UTF8", "--locale=C", "--no-instructions"], { env, allowFail: true })
      .then((r) => { if (r.code !== 0) throw new Error(`initdb failed: ${r.err.slice(0, 1000)}`); });
    writeFileSync(join(data, "pg_hba.conf"), `local all ${L.SUPERUSER} trust\n`);
    appendFileSync(join(data, "postgresql.conf"), `\n# ${L.LABEL}\nlisten_addresses = ''\nunix_socket_directories = '${sock}'\nunix_socket_permissions = 0700\nport = ${L.PORT}\ntimezone = 'UTC'\nmax_connections = 20\n`);
    startAttempted = true;
    await run(bin.pg_ctl, ["-D", data, "-l", join(work, "server.log"), "-w", "-t", "60", "start"], { env, allowFail: true })
      .then((r) => { if (r.code !== 0) throw new Error("pg_ctl start failed"); });
    pid = Number(readFileSync(join(data, "postmaster.pid"), "utf8").split("\n")[0]);
    step("private cluster started (unix socket only)", Number.isInteger(pid) && pid > 0);
    step("no TCP listener configured", (await psql("postgres", "show listen_addresses;")) === "");

    const S = L.DATABASES;
    await createDb(S.source);
    await timed("load_source", async () => {
      await psqlFile(S.source, join(ROOT, "tests/sql/supabase-stub.sql"));
      const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
      for (const f of migrations) await psqlFile(S.source, join(ROOT, "supabase/migrations", f));
      await psqlFile(S.source, join(ROOT, "scripts/recovery/seed.sql"));
      report.controls.migrations_applied = migrations.length;
    });
    const fixture = JSON.parse(await psql(S.source, `select json_build_object('workspaces', (select count(*) from public.workspaces),
      'workspace_billing', (select count(*) from billing.workspace_billing), 'report_revisions', (select count(*) from public.report_revisions));`));
    step("fixture: two businesses, two trial billing rows, approved reports", fixture.workspaces === 2 && fixture.workspace_billing === 2 && fixture.report_revisions >= 2, { fixture });

    const archive = join(artifacts, "source.dump");
    const before = await manifestOf(S.source);
    await timed("pg_dump", () => run(bin.pg_dump, ["-Fc", "--no-password", ...conn(S.source), "-f", archive], { env }));
    const after = await manifestOf(S.source);
    step("source unchanged during dump (no other clients)", L.diffManifest(before, after).length === 0);
    const buf = readFileSync(archive);
    const manifest = { archive: L.archiveFacts(buf), versions: report.versions, ...before };
    writeFileSync(join(artifacts, "manifest.json"), JSON.stringify(manifest, null, 2));
    report.manifest = { archive: manifest.archive, tables: Object.keys(manifest.tables).length, sequences: Object.keys(manifest.sequences).length,
      catalog_sections: Object.fromEntries(Object.entries(manifest.catalog).map(([k, v]) => [k, v.count])),
      report_revisions: manifest.tables["public.report_revisions"], workspace_billing: manifest.tables["billing.workspace_billing"] };
    const list = (await run(bin.pg_restore, ["--list", archive], { env })).out;
    step("archive TOC readable", list.includes("TABLE DATA"));

    // Corruption controls: rejected by the SHA-256/size gate before any pg_restore call.
    for (const [name, bad] of [["byte_flip", L.byteFlipped(buf)], ["truncate", L.truncated(buf)]]) {
      let rejected = false;
      try { L.verifyArchive(bad, manifest.archive); } catch { rejected = true; }
      step(`corrupt copy rejected before restore: ${name}`, rejected);
    }

    const restoreAndCompare = async (db, key) => {
      await createDb(db);
      step(`${db} is fresh and empty`, (await psql(db, `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname <> 'information_schema' and n.nspname !~ '^pg_';`)) === "0");
      L.verifyArchive(readFileSync(archive), manifest.archive);
      await timed(key, () => restore(db, archive));
      const diff = L.diffManifest({ tables: manifest.tables, sequences: manifest.sequences, catalog: manifest.catalog }, await manifestOf(db));
      step(`${db} matches dump-time manifest`, diff.length === 0, { differences: diff.slice(0, 20) });
    };
    await restoreAndCompare(S.restore, "restore");
    step("post-restore probes (tenant denial, immutable report)", (await psql(S.restore, readFileSync(join(ROOT, "scripts/recovery/probes.sql"), "utf8"))).endsWith("probes_passed"));
    step("probes rolled back", L.diffManifest(manifest.tables, (await manifestOf(S.restore)).tables).length === 0);

    // Recovery: change the owned source after the dump, then recover a fresh DB from the original archive.
    await psql(S.source, "update public.workspaces set name = 'Rehearsal Business A (changed after dump)' where name = 'Rehearsal Business A';");
    const changed = L.diffManifest(manifest.tables, (await manifestOf(S.source)).tables);
    step("source mutation visible in manifest", changed.includes("public.workspaces.sha256"), { changed });
    await restoreAndCompare(S.recovered, "recover");

    // Negative atomicity control: a local event trigger fails the first CREATE TRIGGER, which pg_restore runs after all data.
    step("TOC places triggers after all table data", L.triggersAfterData(list));
    await createDb(S.negative);
    await psql(S.negative, `create schema rehearsal_negative_control;
      create function rehearsal_negative_control.refuse() returns event_trigger language plpgsql as $f$
      begin raise exception '${L.NEGATIVE_MARKER}'; end $f$;
      create event trigger rehearsal_negative_control on ddl_command_start when tag in ('CREATE TRIGGER') execute function rehearsal_negative_control.refuse();`);
    const neg = await restore(S.negative, archive, true);
    step("negative restore fails late with the control error", neg.code !== 0 && neg.err.includes(L.NEGATIVE_MARKER));
    const left = await psql(S.negative, `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('information_schema', 'rehearsal_negative_control') and n.nspname !~ '^pg_';`);
    const schemas = await psql(S.negative, "select string_agg(nspname, ',' order by nspname) from pg_namespace where nspname <> 'information_schema' and nspname !~ '^pg_';");
    step("no partial app schema or data survives single-transaction failure", left === "0" && schemas === "public,rehearsal_negative_control", { schemas });
    report.status = "PASS";
  } finally {
    // Always stop after a startup attempt, including partial startup / unreadable PID failures.
    if (startAttempted) {
      if (!pid && existsSync(join(data, "postmaster.pid"))) {
        const candidate = Number(readFileSync(join(data, "postmaster.pid"), "utf8").split("\n")[0]);
        if (Number.isInteger(candidate) && candidate > 0) pid = candidate;
      }
      try {
        const r = await run(bin.pg_ctl, ["-D", data, "-m", "fast", "-w", "-t", "60", "stop"], { env, allowFail: true });
        if (r.code !== 0) await run(bin.pg_ctl, ["-D", data, "-m", "immediate", "-w", "-t", "60", "stop"], { env, allowFail: true });
      } catch { /* Preserve the owned directory unless shutdown can be verified below. */ }
      let alive = false;
      if (pid) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code !== "ESRCH"; } }
      report.controls.server_stopped = !alive && !existsSync(join(data, "postmaster.pid")) && !existsSync(join(sock, `.s.PGSQL.${L.PORT}`));
    } else report.controls.server_stopped = true;
    if (!report.controls.server_stopped) report.status = "FAIL";
    if (args.keepArtifacts || !report.controls.server_stopped) report.controls.artifacts = "kept (inspect shutdown status) at <private>";
    else if (dirname(work) === tmpRoot && basename(work).startsWith(L.WORKDIR_PREFIX)) { rmSync(work, { recursive: true, force: true }); report.controls.artifacts = "deleted"; }
    report.measured_drill_ms_not_sla.total = Date.now() - t0;
    report.private_paths = [work];
  }
}

main().catch((e) => { report.status = "FAIL"; report.error = String(e?.message ?? e); }).finally(() => {
  const paths = report.private_paths ?? [];
  delete report.private_paths;
  if (report.controls.artifacts?.startsWith("kept")) process.stderr.write(`artifacts kept at ${paths[0]}\n`);
  process.stdout.write(L.sanitizeReport(report, paths) + "\n");
  process.exitCode = report.status === "PASS" ? 0 : 1;
});
