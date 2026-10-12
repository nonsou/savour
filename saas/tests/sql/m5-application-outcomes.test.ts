// M5 OPS02: bounded user-session-reported outcome counters and the admin-only aggregate snapshot, on embedded
// PostgreSQL with every migration applied. Synthetic disposable fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessApp, OPS, validateAppSnapshot, type AppSnapshot } from "@/lib/application-outcomes";
import { harness } from "./m4-harness";

type H = Awaited<ReturnType<typeof harness>>;
let h: H;
const ADMIN = "eeeeeeee-5400-4000-8000-000000000001";
const REVOKED = "eeeeeeee-5400-4000-8000-000000000002";
const PLAIN = "eeeeeeee-5400-4000-8000-000000000003";
const OTHER = "eeeeeeee-5400-4000-8000-000000000004";
const SPOOF = "eeeeeeee-5400-4000-8000-000000000005";
const OWNER = "eeeeeeee-5400-4000-8000-000000000006";
const T = "operations.application_outcome_counts";
const CLIENT_ROLES = ["public", "anon", "authenticated", "service_role", "billing_intake", "billing_gateway", "billing_worker"];

const raw = async (uid: string | null, claims: Record<string, unknown>, sql: string, role = "authenticated") => h.serial(async () => {
  await h.pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(uid ? { sub: uid, ...claims } : claims)]);
  await h.pg.exec(`set role ${role}`);
  try { return { rows: (await h.pg.query(sql)).rows, error: null as string | null }; }
  catch (e) { return { rows: null, error: (e as Error).message }; }
  finally { await h.pg.exec("reset role"); }
});
const as = (uid: string, sql: string) => raw(uid, { role: "authenticated", aal: "aal1" }, sql);
const log = (uid: string, op: string, outcome: string) => h.userRpc(uid)("record_application_outcome", { p_op: op, p_outcome: outcome });
const snap = async (uid = ADMIN) => {
  const r = await h.userRpc(uid)("platform_application_outcomes", {});
  if (r.error) throw new Error(r.error.message);
  return r.data as AppSnapshot;
};
const rows = (uid?: string) => h.q<{ actor_id: string; slot: number; op: string; outcome: string; count: number; hour_start: string; cur: boolean }>(
  `select actor_id, slot, op, outcome, count, hour_start::text, hour_start = date_trunc('hour', now(), 'UTC') as cur from ${T}
   ${uid ? "where actor_id = $1" : ""} order by op, outcome`, uid ? [uid] : []);
/** Owner-side fixture: a bucket `hoursAgo` whole UTC hours before the current one. */
const bucket = (uid: string, op: string, outcome: string, hoursAgo: number, count: number) => h.q(
  `insert into ${T} (actor_id, slot, op, outcome, hour_start, count, last_at)
   select $1, extract(hour from hs at time zone 'UTC'), $2, $3, hs, $5, hs + interval '1 minute'
   from (select date_trunc('hour', now(), 'UTC') - make_interval(hours => $4) as hs) x
   on conflict (actor_id, slot, op, outcome) do update set hour_start = excluded.hour_start, count = excluded.count, last_at = excluded.last_at`,
  [uid, op, outcome, hoursAgo, count]);
async function tableHashes(schemas: string[]) {
  const tables = await h.q<{ s: string; t: string }>(`select schemaname as s, tablename as t from pg_tables where schemaname = any($1) order by 1, 2`, [schemas]);
  const out: Record<string, string> = {};
  for (const { s, t } of tables) out[`${s}.${t}`] = (await h.q<{ x: string }>(`select md5(coalesce(string_agg(r::text, '|' order by r::text), '')) as x from ${s}.${t} r`))[0].x;
  return out;
}

beforeAll(async () => {
  h = await harness();
  for (const u of [ADMIN, REVOKED, PLAIN, OTHER, OWNER]) await h.q("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [u, `${u}@m5.test`]);
  await h.q("insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, 'spoof@m5.test', now(), $2)",
    [SPOOF, JSON.stringify({ platform_admin: true })]);
  await h.q("insert into platform.admins (user_id, note) values ($1, 'disposable fixture')", [ADMIN]);
  await h.q("insert into platform.admins (user_id, note, revoked_at) values ($1, 'revoked fixture', now())", [REVOKED]);
  await h.userRpc(OWNER)("create_workspace", { p_name: "M5 outcome fixture", p_country: "Nigeria", p_timezone: "Africa/Lagos", p_display_name: "Owner" });
}, 180_000);
afterAll(async () => { await h?.close(); });

describe("privileges", () => {
  const PUB_LOG = "public.record_application_outcome(text, text)";
  const PRIV_LOG = "private.record_application_outcome(text, text)";
  const PUB_SNAP = "public.platform_application_outcomes()";
  const PRIV_SNAP = "private.platform_application_outcomes()";
  const DATA = "private.application_outcomes_snapshot()";

  it("only authenticated executes the two wrappers and two guarded entries; the data helper is owner-only", async () => {
    const grid = await h.q<{ f: string; r: string; ok: boolean }>(`select f, r, has_function_privilege(r, f, 'execute') as ok
      from unnest($1::text[]) f, unnest($2::text[]) r`, [[PUB_LOG, PRIV_LOG, PUB_SNAP, PRIV_SNAP, DATA], CLIENT_ROLES]);
    const yes = grid.filter((g) => g.ok).map((g) => `${g.f} ${g.r}`).sort();
    expect(yes).toEqual([PRIV_LOG, PRIV_SNAP, PUB_LOG, PUB_SNAP].map((f) => `${f} authenticated`).sort());
  });

  it("wrappers are invokers, guarded entries are definers with an empty search_path, UTC and timeouts", async () => {
    const meta = await h.q<{ name: string; secdef: boolean; vol: string; cfg: string[] }>(`
      select n.nspname || '.' || p.proname as name, p.prosecdef as secdef, p.provolatile as vol, p.proconfig as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname in ('record_application_outcome', 'platform_application_outcomes', 'application_outcomes_snapshot') order by 1`);
    expect(meta.map((m) => [m.name, m.secdef, m.vol])).toEqual([
      ["private.application_outcomes_snapshot", false, "s"], ["private.platform_application_outcomes", true, "s"],
      ["private.record_application_outcome", true, "v"], ["public.platform_application_outcomes", false, "s"],
      ["public.record_application_outcome", false, "v"]]);
    for (const m of meta) expect(m.cfg, m.name).toContain('search_path=""');
    for (const m of meta.filter((x) => x.secdef)) expect(m.cfg, m.name).toEqual(expect.arrayContaining(["TimeZone=UTC", expect.stringMatching(/^statement_timeout=/)]));
    const src = Object.fromEntries((await h.q<{ k: string; s: string }>(`select n.nspname || '.' || p.proname as k, p.prosrc as s from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where p.proname in ('record_application_outcome', 'platform_application_outcomes')`)).map((r) => [r.k, r.s]));
    expect(src["public.record_application_outcome"].trim()).toBe("select private.record_application_outcome(p_op, p_outcome)");
    expect(src["public.platform_application_outcomes"].trim()).toBe("select private.platform_application_outcomes()");
    const guard = src["private.platform_application_outcomes"];
    expect(guard.indexOf("private.platform_actor(false)")).toBeGreaterThan(-1);
    expect(guard.indexOf("private.platform_actor(false)")).toBeLessThan(guard.indexOf("private.application_outcomes_snapshot()"));
    // The logger touches only its own counter table: no inspection, report, billing or platform table.
    const logger = src["private.record_application_outcome"];
    expect(logger).not.toMatch(/\b(public|billing|platform|vault)\.\w/);
    expect(logger).toContain("private.require_uid()");
  });

  it("no client role can use the schema or touch the table; RLS is on with no policy; no zero-arg public definer exists", async () => {
    for (const r of CLIENT_ROLES.filter((x) => x !== "public")) {
      expect((await h.q<{ ok: boolean }>("select has_schema_privilege($1, 'operations', 'usage') as ok", [r]))[0].ok, r).toBe(false);
      for (const p of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
        expect((await h.q<{ ok: boolean }>(`select has_table_privilege($1, '${T}', $2) as ok`, [r, p]))[0].ok, `${r} ${p}`).toBe(false);
      }
    }
    expect(await h.q("select 1 from information_schema.role_table_grants where table_schema = 'operations' and grantee <> (select current_user)")).toEqual([]);
    expect((await h.q<{ rls: boolean }>(`select relrowsecurity as rls from pg_class where oid = '${T}'::regclass`))[0].rls).toBe(true);
    expect(await h.q("select 1 from pg_policies where schemaname = 'operations'")).toEqual([]);
    // Project-wide invariants still hold.
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef`)).toEqual([]);
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private', 'operations') and has_function_privilege('anon', p.oid, 'execute')`)).toEqual([]);
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef and not coalesce('search_path=""' = any (p.proconfig), false)`)).toEqual([]);
  });

  it("direct table reads and writes are denied even for an admin", async () => {
    for (const uid of [PLAIN, ADMIN]) {
      for (const sql of [`select * from ${T}`, `insert into ${T} (actor_id, slot, op, outcome, hour_start, count, last_at) values ('${uid}', 0, 'report_pdf', 'failed', now(), 1, now())`,
        `update ${T} set count = 1`, `delete from ${T}`]) {
        expect((await as(uid, sql)).error, `${uid} ${sql}`).toMatch(/permission denied/);
      }
    }
    expect((await as(ADMIN, "select private.application_outcomes_snapshot()")).error).toMatch(/permission denied/);
  });
});

describe("logger", () => {
  it("anon is denied; a missing subject is not_authenticated; unknown or null enums are rejected", async () => {
    expect((await raw(null, { role: "anon" }, "select public.record_application_outcome('report_pdf', 'success')", "anon")).error).toMatch(/permission denied/);
    expect((await raw(null, { role: "authenticated" }, "select public.record_application_outcome('report_pdf', 'success')")).error).toBe("not_authenticated");
    for (const [op, outcome] of [["report_xls", "success"], ["report_pdf", "ok"], ["REPORT_PDF", "success"], [null, "success"], ["report_pdf", null],
      ["report_pdf'; --", "success"]]) {
      expect((await log(PLAIN, op as string, outcome as string)).error?.message, `${op} ${outcome}`).toBe("invalid_telemetry");
    }
    expect(await rows(PLAIN)).toEqual([]);
  });

  it("stamps the verified subject and the database hour; no actor, workspace or time argument exists", async () => {
    expect((await log(PLAIN, "assessment_save", "success")).error).toBeNull();
    expect((await log(PLAIN, "assessment_save", "success")).error).toBeNull();
    expect((await log(PLAIN, "assessment_save", "failed")).error).toBeNull();
    const mine = await rows(PLAIN);
    expect(mine.map((r) => [r.actor_id, r.op, r.outcome, r.count, r.cur])).toEqual([
      [PLAIN, "assessment_save", "failed", 1, true], [PLAIN, "assessment_save", "success", 2, true]]);
    const hour = (await h.q<{ hr: number }>("select extract(hour from now() at time zone 'UTC')::int as hr"))[0].hr;
    expect(mine.every((r) => r.slot === hour)).toBe(true);
    // Spoofed metadata claims change nothing: the row belongs to the JWT subject only.
    await raw(SPOOF, { role: "service_role", user_metadata: { sub: OTHER }, actor_id: OTHER }, "select public.record_application_outcome('report_csv', 'rejected')");
    expect((await rows(SPOOF)).map((r) => r.op)).toEqual(["report_csv"]);
    expect(await rows(OTHER)).toEqual([]);
    for (const sql of ["select public.record_application_outcome('report_pdf', 'success', now())",
      `select public.record_application_outcome(p_op => 'report_pdf', p_outcome => 'success', p_actor => '${OTHER}')`]) {
      expect((await as(PLAIN, sql)).error).toMatch(/does not exist/);
    }
    const args = await h.q<{ a: string }>(`select pg_get_function_identity_arguments(p.oid) as a from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname = 'record_application_outcome' order by n.nspname`);
    expect(args.map((a) => a.a)).toEqual(["p_op text, p_outcome text", "p_op text, p_outcome text"]);
  });

  it("returns nothing and reads no business table: every public, billing, platform and vault table is unchanged", async () => {
    const before = await tableHashes(["public", "billing", "platform", "vault"]);
    const r = await log(OTHER, "dashboard_csv", "success");
    expect(r.error).toBeNull();
    expect([null, ""]).toContain(r.data); // void: nothing to read back
    expect(await tableHashes(["public", "billing", "platform", "vault"])).toEqual(before);
  });

  it("bounded: a stale bucket in the same hour slot is reused and restarts at 1; the count clamps at 1000; a later hour is never rewound", async () => {
    await bucket(OTHER, "report_pdf", "failed", 24, 57); // same slot, yesterday
    const n = (await h.q<{ n: number }>(`select count(*)::int as n from ${T}`))[0].n;
    await log(OTHER, "report_pdf", "failed");
    expect((await rows(OTHER)).find((r) => r.op === "report_pdf")).toMatchObject({ count: 1, cur: true });
    expect((await h.q<{ n: number }>(`select count(*)::int as n from ${T}`))[0].n).toBe(n);
    await bucket(OTHER, "report_pdf", "failed", 0, 999);
    await log(OTHER, "report_pdf", "failed");
    await log(OTHER, "report_pdf", "failed");
    expect((await rows(OTHER)).find((r) => r.op === "report_pdf")!.count).toBe(1000);
    await bucket(OTHER, "analytics_csv", "success", -24, 5); // a later hour in the same slot (clock moved back)
    await log(OTHER, "analytics_csv", "success");
    const later = (await rows(OTHER)).find((r) => r.op === "analytics_csv")!;
    expect([later.count, later.cur]).toEqual([5, false]);
    await h.q(`delete from ${T} where actor_id = $1 and op = 'analytics_csv'`, [OTHER]);
  });

  it("the table constraint caps rows per actor at 24 slots x 6 ops x 4 outcomes, and counts at 1000", async () => {
    await expect(h.q(`update ${T} set count = 1001 where actor_id = $1`, [OTHER])).rejects.toThrow(/check/);
    await expect(h.q(`update ${T} set slot = 24 where actor_id = $1`, [OTHER])).rejects.toThrow(/check/);
    await expect(h.q(`update ${T} set op = 'other' where actor_id = $1`, [OTHER])).rejects.toThrow(/check/);
    await expect(h.q(`update ${T} set hour_start = hour_start + interval '1 minute' where actor_id = $1`, [OTHER])).rejects.toThrow(/check/);
    for (let i = 0; i < 2; i++) for (const op of OPS) await log(OTHER, op, "replayed");
    expect((await h.q<{ n: number }>(`select count(*)::int as n from ${T} where actor_id = $1 and outcome = 'replayed'`, [OTHER]))[0].n).toBe(6);
  });
});

describe("snapshot", () => {
  it("denies anon, plain users, a workspace owner, a revoked admin, spoofed metadata and a missing subject", async () => {
    for (const sql of ["select public.platform_application_outcomes()", "select private.platform_application_outcomes()"]) {
      expect((await raw(null, { role: "anon" }, sql, "anon")).error, sql).toMatch(/permission denied/);
      for (const uid of [PLAIN, OWNER, REVOKED, OTHER]) expect((await as(uid, sql)).error, `${sql} ${uid}`).toBe("forbidden");
      expect((await raw(SPOOF, { role: "service_role", aal: "aal2", app_metadata: { platform_admin: true }, is_platform_admin: true }, sql)).error).toBe("forbidden");
      expect((await raw(null, { role: "authenticated" }, sql)).error).toBe("not_authenticated");
    }
  });

  it("aggregates the last 24 UTC hours across users with no actor IDs, validates, and flags two consecutive failing hours", async () => {
    await h.q(`delete from ${T}`);
    const empty = await snap();
    expect(validateAppSnapshot(empty).ok).toBe(true);
    expect(empty.operations.map((o) => [o.op, o.success + o.replayed + o.rejected + o.failed, o.latest_reported_at, o.failed_hours])).toEqual(
      OPS.map((op) => [op, 0, null, []]));
    expect([empty.stored_buckets, empty.reporting_actors_24h]).toEqual([0, 0]);
    expect(assessApp(empty).status).toBe("not_measured");

    await bucket(PLAIN, "assessment_save", "failed", 1, 2);
    await bucket(OTHER, "assessment_save", "failed", 0, 1);
    await bucket(OTHER, "assessment_save", "success", 0, 1000);
    await bucket(PLAIN, "assessment_save", "success", 23, 4); // oldest hour inside the window
    await bucket(PLAIN, "report_pdf", "failed", 24, 9); // outside the window: ignored
    await bucket(PLAIN, "report_pdf", "failed", 5, 1);
    await bucket(PLAIN, "report_pdf", "failed", 3, 1);
    await log(ADMIN, "report_csv", "rejected");
    const s = await snap();
    expect(validateAppSnapshot(s).ok).toBe(true);
    const save = s.operations.find((o) => o.op === "assessment_save")!;
    expect([save.success, save.failed, save.capped_buckets, save.failed_hours.length]).toEqual([1004, 3, 1, 2]);
    const pdf = s.operations.find((o) => o.op === "report_pdf")!;
    expect([pdf.failed, pdf.failed_hours.length]).toEqual([2, 2]);
    expect([s.reporting_actors_24h, s.stored_buckets]).toEqual([3, 8]);
    const ev = assessApp(s);
    expect(ev.status).toBe("sustained_failures");
    expect(ev.ops.map((o) => o.status)).toEqual(["sustained_failures", "failures_reported", "no_failures_reported", "not_measured", "not_measured", "not_measured"]);
    const text = JSON.stringify(s);
    for (const id of [ADMIN, PLAIN, OTHER, SPOOF, "@"]) expect(text).not.toContain(id);
    expect(Date.parse(s.window_start)).toBe(Date.parse((await h.q<{ t: string }>(
      `select to_char((date_trunc('hour', now(), 'UTC') - interval '23 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as t`))[0].t));
  });

  it("is read-only", async () => {
    const before = await tableHashes(["public", "billing", "platform", "vault", "operations"]);
    await snap();
    await as(PLAIN, "select public.platform_application_outcomes()");
    expect(await tableHashes(["public", "billing", "platform", "vault", "operations"])).toEqual(before);
  });

  it("deleting a user removes their counters", async () => {
    await h.q("delete from auth.users where id = $1", [SPOOF]);
    expect(await rows(SPOOF)).toEqual([]);
  });
});
