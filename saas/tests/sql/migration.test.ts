// Replays every migration on an empty embedded Postgres (PGlite) and runs the transactional
// security test. PGlite is single-connection: true parallel lock contention is not exercised
// here (see README "Known gaps"); the stale-version guards are.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

async function freshDb() {
  const db = new PGlite();
  await db.exec(read("tests", "sql", "supabase-stub.sql"));
  const dir = join(root, "supabase", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(read("supabase", "migrations", file));
  }
  return db;
}

async function runScript(name: string) {
  const db = await freshDb();
  const results = await db.exec(read("supabase", "tests", name));
  const passed = results.flatMap((r) => r.rows).find((row) => row && "passed" in row) as { passed: number } | undefined;
  // Every script rolls back: no fixture data remains.
  const left = await db.query<{ n: number }>("select count(*)::int as n from public.workspaces");
  await db.close();
  return { passed: Number(passed?.passed), left: left.rows[0].n };
}

describe("applied migrations are immutable", () => {
  it.each([
    ["20261010202119_m1_core.sql", "adb428ade9e34f0ae7bfa0e49f1a4205ee455ce9813b38015a4050002343c205"],
    ["20261010224854_guest_read_closes_with_collection.sql", "b72c274444729514aa39a01bc5fb3959257db1fa4a7721e2fa740c4f7c758e0e"],
    // Milestone 2, applied to savour-dev by Sol (sealed).
    ["20261010230958_m2_session_status_draft.sql", "4fbe4e2f0a4ad461107c47e2243b581d6c578b62a136e580ed87faf6a3846b0b"],
    ["20261010230959_m2_directory.sql", "a65dcfbae0b1a58fba517463ffb2b627641474d94a9b5e4c3630f9fc503eeaf1"],
    ["20261010231001_m2_session_lifecycle.sql", "a76c2f8a292a4639fcf82a8512ed98de1d34c8df7f032e64b736017a70d0ff5f"],
    ["20261010235525_m2_fk_covering_indexes.sql", "b68b800086ea9db7a2f48bec1c565abc69260e6b75643f3ddfaf6e242be25ccd"],
  ])("%s keeps its applied SHA-256", (file, sha) => {
    expect(createHash("sha256").update(readFileSync(join(root, "supabase", "migrations", file))).digest("hex")).toBe(sha);
  });
});

// Every foreign key on a Milestone 2 table has a non-partial index whose leading columns are the
// foreign-key columns in order (the Supabase advisor's unindexed-foreign-key rule).
async function m2ForeignKeys(db: PGlite) {
  return (await db.query<{ fk: string; covered: boolean }>(`
    select c.conrelid::regclass::text || ' (' || (select string_agg(a.attname, ', ' order by k.ord)
        from unnest(c.conkey) with ordinality k (attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) || ')' as fk,
      exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indpred is null
        and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey) as covered
    from pg_constraint c
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      and c.conrelid::regclass::text in ('categories', 'subjects', 'subject_locations', 'subject_contacts',
        'subject_imports', 'correction_requests')
    order by 1`)).rows;
}

describe("milestone 2 foreign keys are covered by indexes", () => {
  it("has a non-partial covering index for each of the 9 foreign keys", async () => {
    const db = await freshDb();
    const rows = await m2ForeignKeys(db);
    await db.close();
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => !r.covered).map((r) => r.fk)).toEqual([]);
  }, 120_000);

  it("detects the six advisor findings on the sealed M2 schema without the forward fix", async () => {
    const db = new PGlite();
    await db.exec(read("tests", "sql", "supabase-stub.sql"));
    const dir = join(root, "supabase", "migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql") && f < "20261010235525").sort()) {
      await db.exec(read("supabase", "migrations", file));
    }
    const rows = await m2ForeignKeys(db);
    await db.close();
    expect(rows.filter((r) => !r.covered).map((r) => r.fk)).toEqual([
      "correction_requests (workspace_id, session_id, subject_id)", "correction_requests (workspace_id, assessor_id)",
      "subject_contacts (workspace_id, subject_id)", "subject_locations (workspace_id, subject_id)",
      "subject_locations (workspace_id, location_id)", "subjects (workspace_id, category_id)",
    ].sort());
  }, 120_000);
});

describe("milestone 2 transactional SQL scripts", () => {
  it("directory, contacts and CSV import", async () => {
    const r = await runScript("m2_directory.sql");
    expect(r.passed).toBe(82);
    expect(r.left).toBe(0);
  }, 120_000);

  it("lifecycle, scope edits, collection reopen, waivers, corrections, samples", async () => {
    const r = await runScript("m2_lifecycle.sql");
    expect(r.passed).toBe(158);
    expect(r.left).toBe(0);
  }, 120_000);
});

// Milestone 3: every foreign key on the new tables has a non-partial covering index (the advisor
// rule), checked on the full schema. The new migrations are not sealed: they are unapplied until Sol
// reviews and applies them.
describe("milestone 3 schema", () => {
  it("covers every foreign key on findings, actions, action_events and notifications", async () => {
    const db = await freshDb();
    const { rows } = await db.query<{ fk: string; covered: boolean }>(`
      select c.conrelid::regclass::text || ' (' || (select string_agg(a.attname, ', ' order by k.ord)
          from unnest(c.conkey) with ordinality k (attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) || ')' as fk,
        exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indpred is null
          and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] = c.conkey) as covered
      from pg_constraint c
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
        and c.conrelid::regclass::text in ('findings', 'actions', 'action_events', 'notifications')
      order by 1`);
    await db.close();
    expect(rows).toHaveLength(10);
    expect(rows.filter((r) => !r.covered).map((r) => r.fk)).toEqual([]);
  }, 120_000);

  it("keeps notifications unreadable except through the inbox RPC, and hides idempotency columns", async () => {
    const db = await freshDb();
    const priv = (await db.query<{ t: string; ok: boolean }>(`
      select t, has_table_privilege('authenticated', t, 'select') as ok
      from unnest(array['public.notifications', 'public.findings', 'public.actions', 'public.action_events']) t`)).rows;
    const cols = (await db.query<{ c: string; ok: boolean }>(`
      select tbl || '.' || col as c, has_column_privilege('authenticated', tbl, col, 'select') as ok
      from (values ('public.findings', 'idempotency_key'), ('public.findings', 'payload_hash'),
        ('public.action_events', 'idempotency_key'), ('public.action_events', 'payload_hash'), ('public.findings', 'title')) v (tbl, col)`)).rows;
    await db.close();
    expect(Object.fromEntries(priv.map((r) => [r.t, r.ok]))).toEqual({
      "public.notifications": false, "public.findings": false, "public.actions": true, "public.action_events": false });
    expect(Object.fromEntries(cols.map((r) => [r.c, r.ok]))).toEqual({
      "public.findings.idempotency_key": false, "public.findings.payload_hash": false, "public.action_events.idempotency_key": false,
      "public.action_events.payload_hash": false, "public.findings.title": true });
  }, 120_000);

  it("validates criteria without trigger settings exactly as the Milestone 1 validator did", async () => {
    const m1 = new PGlite();
    await m1.exec(read("tests", "sql", "supabase-stub.sql"));
    await m1.exec(read("supabase", "migrations", "20261010202119_m1_core.sql"));
    const m3 = await freshDb();
    const samples = [
      [{ key: "taste", label: " Taste ", guidance: "  Flavour ", allow_na: false }, { key: "safety", label: "Safety", allow_na: true }],
      [{ key: "a", label: "A", unknown_field: 1 }], [],
      [{ key: "hygiene", label: "Hygiene", guidance: "", critical: false }],
    ];
    for (const c of samples) {
      const q = "select private.validate_criteria($1::jsonb)::text as v";
      const [a, b] = [(await m1.query<{ v: string }>(q, [JSON.stringify(c)])).rows[0].v, (await m3.query<{ v: string }>(q, [JSON.stringify(c)])).rows[0].v];
      expect(b).toBe(a);
    }
    await m1.close();
    await m3.close();
  }, 120_000);
});

describe("milestone 3 transactional SQL scripts", () => {
  it("findings, actions, workflow, self-verification, revocation, inbox, snapshots, packs and isolation", async () => {
    const r = await runScript("m3_actions.sql");
    expect(r.passed).toBe(205);
    expect(r.left).toBe(0);
  }, 120_000);

  it("analytics source: scope, filters, samples, provisional separation, redaction, export audit", async () => {
    const r = await runScript("m3_analytics.sql");
    expect(r.passed).toBe(36);
    expect(r.left).toBe(0);
  }, 120_000);
});

// Lock-order invariants (see the lock order comment in the lifecycle migration). Static checks
// on the final function definitions; they do not prove real parallel behaviour (PGlite has one
// connection), which needs a two-connection check on real Postgres.
describe("lock-order invariants on the final schema", () => {
  it("workspace, membership and directory rows are never locked FOR UPDATE; guest acceptance locks the session first", async () => {
    const db = await freshDb();
    const { rows } = await db.query<{ name: string; src: string }>(
      "select p.proname as name, lower(p.prosrc) as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
        "where n.nspname = 'private'",
    );
    await db.close();
    const strong = /from public\.(workspaces|memberships|subjects|categories|subject_contacts|locations)\b[^;]*\bfor update\b/;
    expect(rows.filter((r) => strong.test(r.src)).map((r) => r.name)).toEqual([]);
    const accept = rows.find((r) => r.name === "accept_invitation")!.src;
    const sessionLock = accept.indexOf("from public.sessions where id = v_inv.session_id for update");
    const workspaceLock = accept.indexOf("from public.workspaces where id = v_inv.workspace_id for no key update");
    expect(sessionLock).toBeGreaterThan(0);
    expect(workspaceLock).toBeGreaterThan(sessionLock);
    for (const fn of ["update_member", "revoke_member"]) {
      expect(rows.find((r) => r.name === fn)!.src).toContain("from public.workspaces where id = p_ws for no key update");
    }
    // Milestone 3 (lock step 6): finding/action writers take the session lock first, then lock their
    // own rows FOR NO KEY UPDATE (never FOR UPDATE), and stamp ordering-relevant times with
    // clock_timestamp() taken after the session lock.
    expect(rows.filter((r) => /from public\.(findings|actions|notifications)\b[^;]*\bfor update\b/.test(r.src)).map((r) => r.name)).toEqual([]);
    for (const fn of ["create_finding", "withdraw_finding", "create_action", "update_action", "transition_action"]) {
      const src = rows.find((r) => r.name === fn)!.src;
      const lock = src.indexOf("private.lock_session(");
      expect(lock, fn).toBeGreaterThan(0);
      const rowLock = src.search(/for no key update/);
      if (rowLock >= 0) expect(rowLock, fn).toBeGreaterThan(lock);
      const clock = src.indexOf("clock_timestamp()");
      expect(clock, fn).toBeGreaterThan(lock);
      expect(src, fn).not.toMatch(/\bnow\(\)/);
    }
    const approve = rows.find((r) => r.name === "approve_session")!.src;
    const approveLock = approve.indexOf("private.lock_session(");
    const clock = approve.indexOf("v_now := pg_catalog.clock_timestamp()");
    expect(approveLock).toBeGreaterThan(0);
    expect(clock).toBeGreaterThan(approveLock);
    expect(approve.indexOf("private.generate_findings(")).toBeGreaterThan(clock);
    expect(approve.indexOf("private.build_inputs(")).toBeGreaterThan(approve.indexOf("private.generate_findings("));
    expect(approve).toContain("approved_by, approver_name, approved_at)");
    // The inbox due sync never references the session row (no wait on session writers).
    const inbox = rows.find((r) => r.name === "get_inbox")!.src;
    expect(inbox).not.toMatch(/insert into public\.notifications \([^)]*session_id/);
    // Directory writers take the advisory directory lock before any row lock.
    for (const fn of ["save_subject", "save_category", "save_subject_contact", "commit_subject_import", "upsert_subject",
      "upsert_location", "create_sample_session"]) {
      const src = rows.find((r) => r.name === fn)!.src;
      const lock = src.indexOf("private.lock_directory(");
      expect(lock, fn).toBeGreaterThan(0);
      const firstRowLock = src.search(/for (no key )?update/);
      if (firstRowLock >= 0) expect(firstRowLock, fn).toBeGreaterThan(lock);
    }
  }, 120_000);
});

describe("database migration and security script", () => {
  it("replays from an empty schema and passes every security expectation", async () => {
    const db = await freshDb();
    const results = await db.exec(read("supabase", "tests", "m1_security.sql"));
    const passed = results.flatMap((r) => r.rows).find((row) => row && "passed" in row) as
      | { passed: number }
      | undefined;
    expect(Number(passed?.passed)).toBeGreaterThanOrEqual(100);
    // The script rolls back: no fixture data remains.
    const left = await db.query<{ n: number }>("select count(*)::int as n from public.workspaces");
    expect(left.rows[0].n).toBe(0);
    await db.close();
  }, 120_000);

  it("ends guest reads when collection ends while keeping reviewer evidence (all closure paths)", async () => {
    const db = await freshDb();
    const results = await db.exec(read("supabase", "tests", "m1_guest_closure.sql"));
    const passed = results.flatMap((r) => r.rows).find((row) => row && "passed" in row) as
      | { passed: number }
      | undefined;
    expect(Number(passed?.passed)).toBe(23);
    const left = await db.query<{ n: number }>("select count(*)::int as n from public.workspaces");
    expect(left.rows[0].n).toBe(0);
    await db.close();
  }, 120_000);

  it("the guest-closure script fails on the initial migration alone (proves it detects the defect)", async () => {
    const db = new PGlite();
    await db.exec(read("tests", "sql", "supabase-stub.sql"));
    await db.exec(read("supabase", "migrations", "20261010202119_m1_core.sql"));
    await expect(db.exec(read("supabase", "tests", "m1_guest_closure.sql"))).rejects.toThrow(/FAIL: manual close: guest loses every read surface/);
    await db.close();
  }, 120_000);

  it("enables RLS on every public table and grants clients no write privileges", async () => {
    const db = await freshDb();
    const noRls = await db.query(
      "select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace " +
        "where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity",
    );
    expect(noRls.rows).toEqual([]);
    const writes = await db.query(
      "select table_name, privilege_type from information_schema.role_table_grants " +
        "where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type <> 'SELECT'",
    );
    expect(writes.rows).toEqual([]);
    const definerInPublic = await db.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
        "where n.nspname = 'public' and p.prosecdef",
    );
    expect(definerInPublic.rows).toEqual([]);
    const unsafeDefiner = await db.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
        "where n.nspname = 'private' and p.prosecdef and not coalesce('search_path=\"\"' = any (p.proconfig), false)",
    );
    expect(unsafeDefiner.rows).toEqual([]);
    const anonExec = await db.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace " +
        "where n.nspname in ('public','private') and (has_function_privilege('anon', p.oid, 'execute'))",
    );
    expect(anonExec.rows).toEqual([]);
    await db.close();
  }, 120_000);
});
