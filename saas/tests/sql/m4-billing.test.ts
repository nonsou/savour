// Milestone 4 billing on embedded Postgres (PGlite, single connection). Real overlapping transactions
// (last seat/slot/reservation races, refund-vs-payment, guest invitation vs session writers) are not
// exercised here; they need the two-connection procedure in supabase/tests/m4_two_connection_checks.md.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const MIGRATIONS = readdirSync(join(root, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort();
const M4 = MIGRATIONS.filter((f) => f >= "20261011171453");
const BEFORE_M4 = MIGRATIONS.filter((f) => f < "20261011171453");

async function db(files = MIGRATIONS) {
  const d = new PGlite();
  await d.exec(read("tests", "sql", "supabase-stub.sql"));
  for (const f of files) await d.exec(read("supabase", "migrations", f));
  return d;
}
const as = (uid: string) => `select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated","aal":"aal1"}', false); set role authenticated;`;

describe("M4 sealing: nine applied migrations and 25 approved snapshots", () => {
  const pins: Record<string, string> = {
    "20261010202119_m1_core.sql": "adb428ade9e34f0ae7bfa0e49f1a4205ee455ce9813b38015a4050002343c205",
    "20261010224854_guest_read_closes_with_collection.sql": "b72c274444729514aa39a01bc5fb3959257db1fa4a7721e2fa740c4f7c758e0e",
    "20261010230958_m2_session_status_draft.sql": "4fbe4e2f0a4ad461107c47e2243b581d6c578b62a136e580ed87faf6a3846b0b",
    "20261010230959_m2_directory.sql": "a65dcfbae0b1a58fba517463ffb2b627641474d94a9b5e4c3630f9fc503eeaf1",
    "20261010231001_m2_session_lifecycle.sql": "a76c2f8a292a4639fcf82a8512ed98de1d34c8df7f032e64b736017a70d0ff5f",
    "20261010235525_m2_fk_covering_indexes.sql": "b68b800086ea9db7a2f48bec1c565abc69260e6b75643f3ddfaf6e242be25ccd",
    "20261011144333_m3_actions_inbox.sql": "5751b0341d5516da11a0aaa6b33be2e3cbd10af718e3ab499f69e86744033cce",
    "20261011144335_m3_report_snapshot.sql": "a2f74c6a0229b4c1b71f4b198a795cf08736e4c1d536f7533f3de46a1af3600a",
    "20261011144337_m3_analytics.sql": "efa8733057fbce7594163945c4e05ab7cb84e3b58ee016e9ef130828c0c62267",
  };
  it("keeps all nine applied migration files byte-identical and adds only later files", () => {
    expect(BEFORE_M4).toEqual(Object.keys(pins).sort());
    for (const [file, sha] of Object.entries(pins)) {
      expect(createHash("sha256").update(readFileSync(join(root, "supabase", "migrations", file))).digest("hex"), file).toBe(sha);
    }
  });

  const baseline = join(root, "..", "docs", "milestone-4", "qa-snapshot-baseline.json");
  const pin = join(root, "supabase", "tests", "sol_m4_snapshot_pin.sql");
  it.skipIf(!existsSync(baseline) || !existsSync(pin))("Sol's read-only pin lists all 25 baseline approvals with hash and formula", () => {
    const rows = JSON.parse(readFileSync(baseline, "utf8")) as { session_id: string; revision: number; inputs_hash: string; formula_version: string; content_sha256: string }[];
    const text = readFileSync(pin, "utf8");
    expect(rows).toHaveLength(25);
    for (const r of rows) {
      expect(["savour-m1.1", "savour-m2.1", "savour-m3.1"]).toContain(r.formula_version);
      expect(text).toContain(`('${r.session_id}'::uuid,${r.revision},'${r.inputs_hash}','${r.formula_version}','${r.content_sha256}')`);
    }
    expect(text).toContain("set transaction read only");
  });
});

describe("M4 transactional billing script", () => {
  it("passes every billing, platform and isolation expectation and rolls back", async () => {
    const d = await db();
    const results = await d.exec(read("supabase", "tests", "m4_billing.sql"));
    const passed = results.flatMap((r) => r.rows).find((row) => row && "passed" in row) as { passed: number } | undefined;
    expect(Number(passed?.passed)).toBe(257);
    const left = await d.query<{ w: number; c: number; v: number }>(
      "select (select count(*) from public.workspaces)::int as w, (select count(*) from platform.provider_connections)::int as c, (select count(*) from vault.secrets)::int as v");
    expect(left.rows[0]).toEqual({ w: 0, c: 0, v: 0 });
    await d.close();
  }, 120_000);
});

describe("M4 backfill and a genuinely expired workspace", () => {
  it("backfills truthfully, keeps every snapshot, and refuses Sol's four reproduced read-only writes", async () => {
    const O = "eeeeeeee-0000-4000-8000-000000004401";
    const P = "eeeeeeee-0000-4000-8000-000000004402";
    const d = await db(BEFORE_M4);
    await d.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${O}', 'm4-backfill-o@savour.test', now()), ('${P}', 'm4-backfill-p@savour.test', now());`);
    await d.exec(as(O));
    const one = async <T>(sql: string, params: unknown[] = []) => (await d.query<{ v: T }>(sql + " as v", params)).rows[0].v;
    const ws = await one<string>("select public.create_workspace('Old Co', 'Nigeria', 'Africa/Lagos', 'Owner O')");
    const loc = await one<string>("select public.upsert_location($1, null, 'Main', false)", [ws]);
    const s1 = await one<string>("select public.upsert_subject($1, null, 'Stall One', 'vendor', false)", [ws]);
    const s2 = await one<string>("select public.upsert_subject($1, null, 'Stall Two', 'vendor', false)", [ws]);
    const tv = await one<string>(`select public.publish_template($1, null, 'Panel', 'food_vendors', 'off', '[{"key":"taste","label":"Taste"}]'::jsonb)`, [ws]);
    // Approved session (snapshot) and an open session with one submitted and one outstanding assignment.
    const done = await one<string>("select public.create_session($1, $2, $3, 'Approved panel', current_date, $4::uuid[], $5::uuid[], $5::uuid[], 24, null)", [ws, loc, tv, [s1], [O]]);
    await d.query(`select public.submit_assessment($1, $2, $3, null, '{"taste":4}'::jsonb, null, 0, gen_random_uuid(), null)`, [done, s1, O]);
    await d.query("select public.resolve_outcome($1, $2, 'assessed', null, 1)", [done, s1]);
    await d.query("select public.approve_session($1, (select data_version from public.sessions where id = $1))", [done]);
    const open = await one<string>("select public.create_session($1, $2, $3, 'Open panel', current_date, $4::uuid[], $5::uuid[], $5::uuid[], 24, null)", [ws, loc, tv, [s1, s2], [O]]);
    await d.query(`select public.submit_assessment($1, $2, $3, null, '{"taste":3}'::jsonb, null, 0, gen_random_uuid(), null)`, [open, s1, O]);
    const sample = await one<string>("select public.create_sample_session($1, $2, $3)", [ws, loc, tv]);
    await d.exec(as(P));
    const wsP = await one<string>("select public.create_workspace('Over Cap Co', 'Nigeria', 'Africa/Lagos', 'Owner P')");
    for (const n of ["North", "South", "East"]) await d.query("select public.upsert_location($1, null, $2, false)", [wsP, n]);
    await d.exec("reset role");
    // A genuinely 15-day-old workspace (created before the migration), not a time-travelled trial row.
    await d.query("update public.workspaces set created_at = now() - interval '15 days' where id = $1", [ws]);
    const snapshots = "select id, inputs_hash, formula_version, inputs::text as inputs from public.report_revisions order by id";
    const before = (await d.query(snapshots)).rows;
    const firstSubmits = (await d.query<{ session_id: string; subject_id: string; t: string }>(
      "select a.session_id, a.subject_id, min(e.created_at)::text as t from public.assessments a join public.assessment_events e on e.assessment_id = a.id group by 1, 2")).rows;

    for (const f of M4) await d.exec(read("supabase", "migrations", f));

    expect((await d.query(snapshots)).rows).toEqual(before);
    const wb = (await d.query<{ trial_started_at: string; created_at: string; backfilled: boolean; ends: string }>(
      "select b.trial_started_at::text, w.created_at::text, b.backfilled, (b.trial_ends_at - b.trial_started_at)::text as ends from billing.workspace_billing b join public.workspaces w on w.id = b.workspace_id where b.workspace_id = $1", [ws])).rows[0];
    expect(wb).toMatchObject({ backfilled: true, ends: "14 days" });
    expect(wb.trial_started_at).toBe(wb.created_at);
    expect((await d.query("select 1 from billing.paid_periods")).rows).toHaveLength(0);
    const res = (await d.query<{ session_id: string; subject_id: string; state: string; consumed_at: string | null }>(
      "select session_id, subject_id, state, consumed_at::text from billing.assessment_reservations order by session_id, subject_id")).rows;
    expect(res.filter((r) => r.session_id === sample)).toEqual([]);
    for (const f of firstSubmits.filter((x) => x.session_id !== sample)) {
      expect(res.find((r) => r.session_id === f.session_id && r.subject_id === f.subject_id)).toMatchObject({ state: "consumed", consumed_at: f.t });
    }
    expect(res.find((r) => r.session_id === open && r.subject_id === s2)).toMatchObject({ state: "reserved" });

    await d.exec(as(O));
    const ctx = await one<{ access: { state: string; writable: boolean } }>("select public.workspace_context($1)", [ws]);
    expect(ctx.access).toMatchObject({ state: "read_only", writable: false });
    const refused = async (label: string, sql: string, params: unknown[]) => {
      await expect(d.query(sql, params), label).rejects.toThrow(/read_only/);
    };
    await refused("new category", "select public.save_category($1, null, 'Grills', false, null)", [ws]);
    await refused("new contact", "select public.save_subject_contact($1, $2, 'Ada', '+234000', null, 0)", [ws, s1]);
    await refused("existing subject edit", "select public.upsert_subject($1, $2, 'Stall One Renamed', 'vendor', false)", [ws, s1]);
    await refused("existing location edit", "select public.upsert_location($1, $2, 'Main Renamed', false)", [ws, loc]);
    // Accepted outstanding work is still completable and reports stay readable after expiry.
    await d.query(`select public.submit_assessment($1, $2, $3, null, '{"taste":5}'::jsonb, null, 0, gen_random_uuid(), null)`, [open, s2, O]);
    expect(await one<{ meta: { status: string } }>("select public.get_session_report($1, null, false, 'pdf')", [done])).toMatchObject({ meta: { status: "approved" } });

    // Over-cap legacy data is kept; only new creation is blocked; archiving still works.
    await d.exec(as(P));
    expect(Number(await one<number>("select (public.get_billing($1) -> 'access' -> 'usage' ->> 'locations')::int", [wsP]))).toBe(3);
    await expect(d.query("select public.upsert_location($1, null, 'West', false)", [wsP])).rejects.toThrow(/quota_exceeded/);
    const north = await one<string>("select (select id from public.locations where name = 'North')");
    await d.query("select public.upsert_location($1, $2, 'North', true)", [wsP, north]);
    await d.close();
  }, 120_000);
});

describe("M4 lock order and index coverage on the final schema", () => {
  it("orders locks consistently: session before billing, payment lock before billing, no session locks in payment writers", async () => {
    const d = await db();
    const src = Object.fromEntries((await d.query<{ name: string; src: string }>(
      "select n.nspname || '.' || p.proname as name, lower(p.prosrc) as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('private', 'billing', 'platform')")).rows
      .map((r) => [r.name, r.src]));
    await d.close();
    const inv = src["private.create_invitation"];
    expect(inv.indexOf("private.lock_session(p_session)")).toBeGreaterThan(0);
    expect(inv.indexOf("private.lock_session(p_session)")).toBeLessThan(inv.indexOf("private.require_capacity("));
    for (const fn of ["billing.absorb_payment", "billing.absorb_refund", "billing.absorb_dispute"]) {
      const s = src[fn];
      const lockP = s.indexOf("billing.lock_payment(");
      expect(lockP, fn).toBeGreaterThan(0);
      const lockB = s.indexOf("private.lock_billing(");
      if (lockB >= 0) expect(lockP, fn).toBeLessThan(lockB);
      expect(s, fn).not.toContain("lock_session");
      expect(s, fn).not.toMatch(/from public\.(sessions|memberships|workspaces)[^;]*for (no key )?update/);
    }
    // Every count-increasing writer reaches capacity only through the gate (billing lock last).
    for (const fn of ["private.open_session", "private.set_assignment", "private.accept_invitation", "private.commit_subject_import"]) {
      expect(src[fn], fn).toMatch(/private\.(require_capacity|reserve_session_work)\(/);
    }
    expect(src["private.reopen_collection"]).toContain("private.require_writable(");
    expect(src["private.consume_assessment"]).toContain("assessment_not_reserved");
  }, 120_000);

  it("covers every foreign key on billing and platform tables with a leading non-partial index", async () => {
    const d = await db();
    const rows = (await d.query<{ fk: string; covered: boolean }>(`
      select c.conrelid::regclass::text || ' (' || (select string_agg(a.attname, ', ' order by k.ord)
          from unnest(c.conkey) with ordinality k (attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) || ')' as fk,
        exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indpred is null
          and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey) as covered
      from pg_constraint c where c.contype = 'f' and c.connamespace in ('billing'::regnamespace, 'platform'::regnamespace)`)).rows;
    await d.close();
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((r) => !r.covered).map((r) => r.fk)).toEqual([]);
  }, 120_000);
});
