// Guards for the LOCAL_NATIVE_LOGICAL_REHEARSAL_ONLY utility. Pure checks run the helpers directly; the one
// embedded-Postgres (PGlite) check proves the seed, probes and manifest SQL are valid on the real migrations.
// No native PostgreSQL is started here; the native drill is executed by the root operator.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import * as L from "../../scripts/recovery/rehearsal-lib.mjs";

const root = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const runner = read("scripts", "recovery", "local-rehearsal.mjs");

describe("rehearsal inputs", () => {
  it("accepts only a local --pg-bin path and --keep-artifacts", () => {
    expect(L.parseArgs(["--pg-bin", "/tmp/savour-pg17-runtime/mount/Postgres.app/Contents/Versions/17/bin"]).keepArtifacts).toBe(false);
    expect(L.parseArgs(["--pg-bin", "/opt/pg17/bin", "--keep-artifacts"]).keepArtifacts).toBe(true);
    for (const bad of [[], ["--pg-bin"], ["--pg-bin", "relative/bin"], ["--pg-bin", "/a/../b"], ["--pg-bin", "/a b"],
      ["--pg-bin", "postgres://u:p@host/db"], ["--pg-bin", "/x", "--host", "db.example"], ["--pg-bin", "/x", "--backup", "/tmp/x.dump"],
      ["--pg-bin", "/x", "--pg-bin", "/y"], ["--database-url=postgres://x"]]) {
      expect(() => L.parseArgs(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("scrubs PG*, DATABASE_URL and SUPABASE* from the child environment", () => {
    const env = L.scrubEnv({ PATH: "/usr/bin", PGHOST: "h", PGPASSWORD: "p", pgdatabase: "d", PGSERVICEFILE: "f", DATABASE_URL: "u",
      SUPABASE_SERVICE_ROLE_KEY: "k", SUPABASE_URL: "s", HOME: "/home/x" });
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "TZ"]);
  });

  it("requires every binary on one identical PostgreSQL 17 minor version", () => {
    const ok = Object.fromEntries(L.REQUIRED_BINARIES.map((b) => [b, `${b} (PostgreSQL) 17.11`]));
    expect(new Set(Object.values(L.checkVersions(ok)))).toEqual(new Set(["17.11"]));
    expect(() => L.checkVersions({ ...ok, pg_dump: "pg_dump (PostgreSQL) 16.4" })).toThrow(/not 17/);
    expect(() => L.checkVersions({ ...ok, pg_restore: "pg_restore (PostgreSQL) 17.2" })).toThrow(/mixed/);
    expect(() => L.checkVersions({ ...ok, postgres: "" })).toThrow(/no PostgreSQL version/);
  });
});

describe("archive gate and comparisons", () => {
  const archive = Buffer.from("PGDMP" + "x".repeat(4096));
  const facts = L.archiveFacts(archive);

  it("rejects byte-flipped and truncated copies before restore, accepts the original", () => {
    expect(L.verifyArchive(archive, facts)).toBe(true);
    expect(() => L.verifyArchive(L.byteFlipped(archive), facts)).toThrow(/rejected before restore/);
    expect(() => L.verifyArchive(L.truncated(archive), facts)).toThrow(/rejected before restore/);
    expect(L.byteFlipped(archive).length).toBe(archive.length);
  });

  it("diffManifest names exactly the changed paths", () => {
    const m = { tables: { "public.workspaces": { rows: 2, sha256: "a" } }, sequences: { "public.s": { last_value: 3 } } };
    expect(L.diffManifest(m, structuredClone(m))).toEqual([]);
    const c = structuredClone(m);
    c.tables["public.workspaces"].sha256 = "b";
    expect(L.diffManifest(m, c)).toEqual(["tables.public.workspaces.sha256"]);
    expect(L.diffManifest(m, { tables: {} })).toEqual(["sequences", "tables.public.workspaces"]);
  });

  it("proves the negative control error is late only when triggers follow all table data in the TOC", () => {
    const toc = (...k: string[]) => k.map((x, i) => `${i + 1}; 0 0 ${x} public t owner`).join("\n");
    expect(L.triggersAfterData(toc("TABLE", "TABLE DATA", "TABLE DATA", "INDEX", "TRIGGER"))).toBe(true);
    expect(L.triggersAfterData(toc("TABLE", "TRIGGER", "TABLE DATA"))).toBe(false);
    expect(L.triggersAfterData(toc("TABLE", "TABLE DATA"))).toBe(false);
  });

  it("refuses identifiers that were not server-quoted and covers the catalog inventory", () => {
    expect(() => L.tableHashSql(["public.x; drop table y"])).toThrow();
    expect(L.tableHashSql(['public.workspaces', '"odd"."Name"'])).toContain("union all");
    expect(Object.keys(L.CATALOG_SECTIONS).sort()).toEqual(["columns", "constraints", "default_acls", "event_triggers", "functions",
      "indexes", "policies", "relations", "schemas", "triggers", "types", "views"]);
    expect(L.CATALOG_SECTIONS.relations).toMatch(/relrowsecurity[\s\S]*relforcerowsecurity[\s\S]*relacl/);
  });

  it("report output hides private paths and refuses credential-like content", () => {
    const text = L.sanitizeReport({ label: L.LABEL, where: "/var/folders/x/savour-rr-abc/data" }, ["/var/folders/x/savour-rr-abc"]);
    expect(text).not.toContain("savour-rr-abc");
    expect(L.sanitizeReport({ e: 'connection on socket /tmp/s/.s.PGSQL.5432 failed' }, ["/tmp/s"])).toContain("<socket>");
    let error = "";
    try { L.parseArgs(["--accidentally-pasted-secret=opaque-token"]); } catch (e) { error = String(e); }
    expect(error).not.toContain("opaque-token");
    for (const bad of ["postgresql://u@h/d", "password=x", "host=db", "sk_sandbox_ABCDEFGHIJKLMNOP"]) {
      expect(() => L.sanitizeReport({ e: bad }, [])).toThrow(/report refused/);
    }
  });
});

describe("runner static safety", () => {
  it("spawns argument arrays without a shell and never uses forbidden tools or options", () => {
    expect(runner).toContain("shell: false");
    expect(runner).not.toMatch(/exec\(|execSync|shell:\s*true|pg_dumpall|--clean|--create|--no-owner|listen_addresses = '\*'|PGPASSWORD|http/);
    expect(runner).toMatch(/"--single-transaction", "--exit-on-error"/);
    expect(runner).toMatch(/"-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"/);
    expect(runner).toContain("listen_addresses = ''");
    // Deletion is limited to the mkdtemp directory it created.
    expect(runner.match(/rmSync\(/g)).toHaveLength(1);
    expect(runner).toMatch(/dirname\(work\) === tmpRoot && basename\(work\)\.startsWith\(L\.WORKDIR_PREFIX\)\) \{ rmSync\(work/);
    expect(runner).toContain("if (startAttempted)");
    expect(runner).toContain("args.keepArtifacts || !report.controls.server_stopped");
  });
});

describe("fixture, probes and manifest SQL on the real migrations (PGlite)", () => {
  it("seeds two businesses with trial billing and approved reports, probes pass and roll back, manifest is stable", async () => {
    const db = new PGlite();
    try {
      await db.exec(read("tests", "sql", "supabase-stub.sql"));
      for (const f of readdirSync(join(root, "supabase", "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
        await db.exec(read("supabase", "migrations", f));
      }
      await db.exec(read("scripts", "recovery", "seed.sql"));
      const one = async (sql: string) => {
        const res = await db.exec(sql);
        const last = res[res.length - 1].rows[0];
        return Object.values(last)[0] as unknown;
      };
      const manifest = async () => {
        const tables = await one(L.TABLE_LIST_SQL) as string[];
        return { tables: await one(L.tableHashSql(tables)), sequences: await one(L.sequenceStateSql(await one(L.SEQUENCE_LIST_SQL) as string[])), catalog: await one(L.CATALOG_SQL) };
      };
      const before = await manifest() as { tables: Record<string, { rows: number }>; catalog: Record<string, { count: number }> };
      expect(before.tables["public.workspaces"].rows).toBe(2);
      expect(before.tables["billing.workspace_billing"].rows).toBe(2);
      expect(before.tables["public.report_revisions"].rows).toBe(2);
      expect(before.tables["billing.paid_periods"].rows).toBe(0);
      expect(before.catalog.policies.count).toBeGreaterThan(10);
      expect(before.catalog.triggers.count).toBeGreaterThan(10);
      expect(await one(read("scripts", "recovery", "probes.sql"))).toBe("probes_passed");
      expect(L.diffManifest(before, await manifest())).toEqual([]);
      await db.exec("reset role; update public.workspaces set name = 'changed' where name = 'Rehearsal Business A'");
      expect(L.diffManifest(before, await manifest())).toEqual(["tables.public.workspaces.sha256"]);
    } finally {
      await db.close();
    }
  }, 180_000);
});
