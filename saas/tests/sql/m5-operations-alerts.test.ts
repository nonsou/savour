// M5 internal operational alerts on embedded PostgreSQL with every migration applied: privileges, the owner-only
// evaluator's bounded current state, source isolation, heartbeat provenance, the busy lock path, SQL/TypeScript
// rule parity on shared fixtures, and the guarded read. Synthetic disposable fixtures only. Helper failures and a
// busy lock are simulated by replacing a helper INSIDE a transaction that is always rolled back.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPS, type AppSnapshot, type OpCounts } from "@/lib/application-outcomes";
import type { ConnectionFacts, RunFacts, Snapshot } from "@/lib/operations";
import {
  appAlertFindings, automaticChecksConfirmed, billingAlertFindings, validateAlerts, type AlertFinding, type AlertsView, type FindingsResult,
} from "@/lib/operations-alerts";
import { harness } from "./m4-harness";

type H = Awaited<ReturnType<typeof harness>>;
let h: H;
const ADMIN = "eeeeeeee-5600-4000-8000-000000000001";
const REVOKED = "eeeeeeee-5600-4000-8000-000000000002";
const PLAIN = "eeeeeeee-5600-4000-8000-000000000003";
const SPOOF = "eeeeeeee-5600-4000-8000-000000000004";
const OWNER = "eeeeeeee-5600-4000-8000-000000000005";
let E1: string;
const ROLES = ["public", "anon", "authenticated", "service_role", "billing_intake", "billing_gateway", "billing_worker"];
const root = join(import.meta.dirname, "..", "..");
const STATE = "operations.alert_state";
const HB = "operations.alert_heartbeat";

const raw = async (uid: string | null, claims: Record<string, unknown>, sql: string, role = "authenticated") => h.serial(async () => {
  await h.pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(uid ? { sub: uid, ...claims } : claims)]);
  await h.pg.exec(`set role ${role}`);
  try { return { rows: (await h.pg.query(sql)).rows, error: null as string | null }; }
  catch (e) { return { rows: null, error: (e as Error).message }; }
  finally { await h.pg.exec("reset role"); }
});
const as = (uid: string, sql: string) => raw(uid, { role: "authenticated", aal: "aal2" }, sql);
const read = async (uid = ADMIN) => {
  const r = await h.userRpc(uid)("platform_operations_alerts", {});
  if (r.error) throw new Error(r.error.message);
  return r.data as AlertsView;
};
const evaluate = async (trigger = "cron") => (await h.q<{ r: string }>("select private.evaluate_operations_alerts($1) as r", [trigger]))[0].r;
interface StateRow { alert_key: string; source: string; active: boolean; severity: string; episode_count: number; first_seen_at: Date;
  last_seen_at: Date; last_changed_at: Date; cleared_at: Date | null; unobserved_since: Date | null; observed_count: number; observed_oldest_at: Date }
const rows = () => h.q<StateRow>(`select alert_key, source, active, severity, episode_count, first_seen_at, last_seen_at, last_changed_at, cleared_at,
  unobserved_since, observed_count::int as observed_count, observed_oldest_at from ${STATE} order by alert_key`);
const row = async (key: string) => (await rows()).find((r) => r.alert_key === key);
const hash = (pg: PGlite, table: string, where = "true") =>
  pg.query<{ x: string }>(`select md5(coalesce(string_agg(r::text, '|' order by r::text), '')) as x from ${table} r where ${where}`).then((r) => r.rows[0].x);

/** Runs f inside a transaction that is always rolled back (helper replacements never outlive it). */
const tx = <T>(f: (pg: PGlite) => Promise<T>) => h.serial(async () => {
  await h.pg.exec("begin");
  try { return await f(h.pg); } finally { await h.pg.exec("rollback"); }
});
const readIn = async (pg: PGlite, uid = ADMIN) => {
  await pg.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated", aal: "aal1" })]);
  await pg.exec("set local role authenticated");
  try { return (await pg.query<{ r: AlertsView }>("select public.platform_operations_alerts() as r")).rows[0].r; }
  finally { await pg.exec("reset role"); }
};
const evalIn = async (pg: PGlite, trigger = "cron") => (await pg.query<{ r: string }>("select private.evaluate_operations_alerts($1) as r", [trigger])).rows[0].r;
const breakFn = (pg: PGlite, fn: "operations_snapshot" | "application_outcomes_snapshot", body: string) =>
  pg.exec(`create or replace function private.${fn}() returns jsonb language plpgsql stable set search_path = '' set timezone = 'UTC'
    as $f$ begin ${body} end $f$`);

async function inbox(id: string, status: string, received: string) {
  await h.q(`insert into billing.webhook_inbox (connection_id, event_id, event_type, provider_created_at, organization_id, raw_body, body_sha256,
      signature_timestamp, status, received_at) values ($1, $2, 'MARKER_TYPE', now(), 'MARKER_ORG', convert_to('{"m":"MARKER_BODY"}', 'UTF8'),
      repeat('a', 64), 1, $3, now() - $4::interval)`, [E1, id, status, received]);
}
const bucket = (uid: string, op: string, outcome: string, hoursAgo: number, n: number) => h.q(
  `insert into operations.application_outcome_counts (actor_id, slot, op, outcome, hour_start, count, last_at)
   select $1, extract(hour from hs at time zone 'UTC'), $2, $3, hs, $5, least(hs + interval '1 minute', now())
   from (select date_trunc('hour', now(), 'UTC') - make_interval(hours => $4) as hs) x
   on conflict (actor_id, slot, op, outcome) do update set hour_start = excluded.hour_start, count = excluded.count, last_at = excluded.last_at`,
  [uid, op, outcome, hoursAgo, n]);

beforeAll(async () => {
  h = await harness();
  E1 = await h.connection(ADMIN, "MARKER_LABEL_E1", "sk_sandbox_MARKERKEY0000000000056", "MARKERORG56");
  for (const u of [REVOKED, PLAIN, OWNER]) await h.q("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [u, `${u}@m5.test`]);
  await h.q("insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, 'spoof@m5.test', now(), $2)",
    [SPOOF, JSON.stringify({ platform_admin: true, role: "admin" })]);
  await h.q("insert into platform.admins (user_id, note, revoked_at) values ($1, 'revoked fixture', now())", [REVOKED]);
  await h.userRpc(OWNER)("create_workspace", { p_name: "M5 alert fixture", p_country: "Nigeria", p_timezone: "Africa/Lagos", p_display_name: "Owner" });
}, 180_000);
afterAll(async () => { await h?.close(); });

// ---------------------------------------------------------------------------
describe("privileges", () => {
  const PUB = "public.platform_operations_alerts()";
  const GUARD = "private.platform_operations_alerts()";
  const OWNER_ONLY = ["private.evaluate_operations_alerts(text)", "private.operations_alerts_read()", "private.operations_alerts_try_lock()",
    "private.operations_alert_apply(text, text[], jsonb, timestamptz)", "private.operations_alert_billing_findings(jsonb)",
    "private.operations_alert_app_findings(jsonb)", "private.operations_alert_ts(jsonb, boolean)", "private.operations_alert_past_ts(jsonb, timestamptz)",
    "private.operations_alert_count(jsonb)", "private.operations_alert_keys(jsonb, text[])"];

  it("authenticated executes only the read wrapper and its guarded entry; evaluator and helpers are owner-only", async () => {
    const grid = await h.q<{ f: string; r: string; ok: boolean }>(`select f, r, has_function_privilege(r, f, 'execute') as ok
      from unnest($1::text[]) f, unnest($2::text[]) r`, [[PUB, GUARD, ...OWNER_ONLY], ROLES]);
    expect(grid.filter((g) => g.ok).map((g) => `${g.f} ${g.r}`).sort()).toEqual([`${GUARD} authenticated`, `${PUB} authenticated`]);
  });

  it("wrapper is an invoker that only calls the guard; the guard checks the live admin first; only the guard is a definer", async () => {
    const meta = await h.q<{ name: string; secdef: boolean; vol: string; cfg: string[] }>(`
      select n.nspname || '.' || p.proname as name, p.prosecdef as secdef, p.provolatile as vol, p.proconfig as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname in ('platform_operations_alerts', 'evaluate_operations_alerts', 'operations_alerts_read', 'operations_alerts_try_lock')
         or p.proname like 'operations\\_alert\\_%' order by 1`);
    expect(meta.map((m) => [m.name, m.secdef, m.vol])).toEqual([
      ["private.evaluate_operations_alerts", false, "v"], ["private.operations_alert_app_findings", false, "s"],
      ["private.operations_alert_apply", false, "v"], ["private.operations_alert_billing_findings", false, "s"],
      ["private.operations_alert_count", false, "i"], ["private.operations_alert_keys", false, "i"], ["private.operations_alert_past_ts", false, "s"], ["private.operations_alert_ts", false, "s"],
      ["private.operations_alerts_read", false, "s"], ["private.operations_alerts_try_lock", false, "v"],
      ["private.platform_operations_alerts", true, "s"], ["public.platform_operations_alerts", false, "s"]]);
    for (const m of meta) expect(m.cfg, m.name).toContain('search_path=""');
    expect(meta.find((m) => m.name === "private.platform_operations_alerts")!.cfg.slice().sort())
      .toEqual(["lock_timeout=2s", 'search_path=""', "statement_timeout=5s", "TimeZone=UTC"].sort());
    const src = Object.fromEntries((await h.q<{ k: string; s: string }>(`select n.nspname || '.' || p.proname as k, p.prosrc as s from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where p.proname in ('platform_operations_alerts', 'operations_alerts_try_lock')`)).map((r) => [r.k, r.s]));
    expect(src["public.platform_operations_alerts"].trim()).toBe("select private.platform_operations_alerts()");
    const guard = src["private.platform_operations_alerts"];
    expect(guard.indexOf("private.platform_actor(false)")).toBeGreaterThan(-1);
    expect(guard.indexOf("private.platform_actor(false)")).toBeLessThan(guard.indexOf("private.operations_alerts_read()"));
    expect(src["private.operations_alerts_try_lock"]).toContain("pg_catalog.pg_try_advisory_xact_lock(20261013114038)");
    // Project-wide invariants still hold.
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef`)).toEqual([]);
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private', 'operations') and has_function_privilege('anon', p.oid, 'execute')`)).toEqual([]);
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef and not coalesce('search_path=""' = any (p.proconfig), false)`)).toEqual([]);
  });

  it("no client role can use the schema or touch either table; RLS on, no policy, no grant", async () => {
    for (const r of ROLES.filter((x) => x !== "public")) {
      expect((await h.q<{ ok: boolean }>("select has_schema_privilege($1, 'operations', 'usage') as ok", [r]))[0].ok, r).toBe(false);
      for (const t of [STATE, HB]) for (const p of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
        expect((await h.q<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [r, t, p]))[0].ok, `${r} ${t} ${p}`).toBe(false);
      }
    }
    expect(await h.q("select 1 from information_schema.role_table_grants where table_schema = 'operations' and grantee <> (select current_user)")).toEqual([]);
    expect((await h.q<{ n: number }>(`select count(*)::int as n from pg_class where oid in ('${STATE}'::regclass, '${HB}'::regclass) and relrowsecurity`))[0].n).toBe(2);
    expect(await h.q("select 1 from pg_policies where schemaname = 'operations'")).toEqual([]);
  });

  it("nobody but the owner can evaluate, read helpers or write alert state, including an admin at aal2 and the service/billing roles", async () => {
    const calls = ["select private.evaluate_operations_alerts('cron')", "select private.evaluate_operations_alerts('manual')",
      "select private.operations_alerts_read()", "select private.operations_alerts_try_lock()",
      "select private.operations_alert_billing_findings('{}')", "select private.operations_alert_app_findings('{}')",
      "select private.operations_alert_apply('app_unverified', '{}', '[]', now())",
      `select * from ${STATE}`, `select * from ${HB}`, `update ${HB} set last_attempt_at = now()`, `delete from ${STATE}`,
      `insert into ${STATE} (alert_key, source, code, op, severity, active, episode_count, first_seen_at, last_seen_at, last_changed_at, observed_count, observed_oldest_at)
       values ('APP_FAILURES_REPORTED:report_pdf', 'app_unverified', 'APP_FAILURES_REPORTED', 'report_pdf', 'high', true, 1, now(), now(), now(), 1, now())`];
    for (const sql of calls) {
      for (const uid of [ADMIN, PLAIN]) expect((await as(uid, sql)).error, `${uid} ${sql}`).toMatch(/permission denied/);
      for (const role of ["anon", "service_role", "billing_worker", "billing_gateway", "billing_intake"]) {
        expect((await raw(null, { role }, sql, role)).error, `${role} ${sql}`).toMatch(/permission denied/);
      }
    }
    expect(await rows()).toEqual([]);
  });

  it("the migration schedules nothing: no cron schema, job or extension appears", async () => {
    expect((await h.q<{ c: string | null }>("select to_regnamespace('cron')::text as c"))[0].c).toBeNull();
    expect(await h.q("select 1 from pg_extension where extname in ('pg_cron', 'pg_net')")).toEqual([]);
    const sql = readFileSync(join(root, "supabase/migrations/20261013114038_m5_operations_alerts.sql"), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/cron\.schedule|net\.http|vault\.|http_post|create extension/i);
  });
});

// ---------------------------------------------------------------------------
describe("read RPC", () => {
  it("denies anon, a plain user, a workspace owner, a revoked admin, spoofed metadata and a missing subject (wrapper and guard)", async () => {
    for (const sql of ["select public.platform_operations_alerts()", "select private.platform_operations_alerts()"]) {
      expect((await raw(null, { role: "anon" }, sql, "anon")).error, sql).toMatch(/permission denied/);
      for (const uid of [PLAIN, OWNER, REVOKED]) for (const aal of ["aal1", "aal2"]) {
        expect((await raw(uid, { role: "authenticated", aal }, sql)).error, `${sql} ${uid} ${aal}`).toBe("forbidden");
      }
      expect((await raw(SPOOF, { role: "service_role", aal: "aal2", app_metadata: { platform_admin: true }, user_metadata: { platform_admin: true },
        is_platform_admin: true }, sql)).error).toBe("forbidden");
      expect((await raw(null, { role: "authenticated", aal: "aal2" }, sql)).error).toBe("not_authenticated");
    }
  });

  it("before any run: never checked, schedule not measured (no catalog here), no alerts; a manual run never counts as scheduled", async () => {
    const v = await read();
    expect(validateAlerts(v).ok).toBe(true);
    expect(v.scheduler_job).toBe("not_measured");
    expect(v.heartbeat).toMatchObject({ last_attempt_at: null, billing_status: null, app_status: null, last_cron_attempted_at: null, cron_freshness: "never" });
    expect([v.alerts_total, v.alerts_active, v.alerts_truncated, v.alerts]).toEqual([0, 0, false, []]);
    await tx(async (pg) => {
      expect(await evalIn(pg, "manual")).toBe("ok");
      const m = await readIn(pg);
      expect(validateAlerts(m).ok).toBe(true);
      expect(m.heartbeat).toMatchObject({ last_attempt_trigger: "manual", billing_status: "ok", app_status: "ok", last_manual_status: "ok",
        last_cron_attempted_at: null, last_cron_completed_at: null, cron_freshness: "never" });
    });
  });

  it("rejects an unknown trigger without writing anything", async () => {
    await expect(h.q("select private.evaluate_operations_alerts('client')")).rejects.toThrow(/invalid_trigger/);
    await expect(h.q("select private.evaluate_operations_alerts(null)")).rejects.toThrow(/invalid_trigger/);
    expect((await read()).heartbeat.last_attempt_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("current alert state (deterministic, ordered)", () => {
  const WH = () => `WEBHOOK_BACKLOG_STALE:${E1}`;

  it("first sighting creates one active row with episode 1; repeated runs neither duplicate nor add episodes", async () => {
    await inbox("evt_a1", "pending", "20 minutes");
    await inbox("evt_a2", "pending", "1 minute");
    expect(await evaluate()).toBe("ok");
    const first = (await row(WH()))!;
    expect(first).toMatchObject({ source: "billing_authoritative", active: true, severity: "high", episode_count: 1, cleared_at: null, observed_count: 2 });
    for (let i = 0; i < 3; i++) expect(await evaluate()).toBe("ok");
    const again = (await row(WH()))!;
    expect((await rows()).map((r) => r.alert_key)).toEqual([WH()]);
    expect(again.episode_count).toBe(1);
    expect(again.first_seen_at).toEqual(first.first_seen_at);
    expect(again.last_changed_at).toEqual(first.last_changed_at);
    expect(again.last_seen_at.getTime()).toBeGreaterThanOrEqual(first.last_seen_at.getTime());
  });

  it("matches the TypeScript rule on the same live snapshot", async () => {
    const snap = (await h.userRpc(ADMIN)("platform_operations_snapshot", {})).data;
    const sql = (await h.q<{ r: AlertFinding[] }>("select private.operations_alert_billing_findings($1::jsonb) as r", [JSON.stringify(snap)]))[0].r;
    expect(norm({ ok: true, findings: sql })).toEqual(norm(billingAlertFindings(snap)));
    expect(sql.map((f) => f.code)).toEqual(["WEBHOOK_BACKLOG_STALE"]);
  });

  it("clears only when a validated billing read lacks the condition; the row and its history stay", async () => {
    await h.q("update billing.webhook_inbox set status = 'done' where connection_id = $1 and event_id = 'evt_a1'", [E1]);
    expect(await evaluate()).toBe("ok");
    const cleared = (await row(WH()))!;
    expect(cleared).toMatchObject({ active: false, episode_count: 1 });
    expect(cleared.cleared_at).not.toBeNull();
    expect(cleared.last_changed_at).toEqual(cleared.cleared_at);
    expect(await evaluate()).toBe("ok");
    expect((await row(WH()))!.cleared_at).toEqual(cleared.cleared_at); // stays cleared, unchanged
  });

  it("recurrence reuses the same row and increments the episode count", async () => {
    const before = (await row(WH()))!;
    await inbox("evt_a3", "failed", "30 minutes");
    expect(await evaluate()).toBe("ok");
    const back = (await row(WH()))!;
    expect(back).toMatchObject({ active: true, episode_count: 2, cleared_at: null, observed_count: 2 });
    expect(back.first_seen_at).toEqual(before.first_seen_at);
    expect(back.last_changed_at.getTime()).toBeGreaterThan(before.last_changed_at.getTime());
    expect((await rows()).length).toBe(1);
  });

  it("app failures: one warning per operation, high when two adjacent UTC hours failed, expiry from the window is not recovery", async () => {
    const key = "APP_FAILURES_REPORTED:report_pdf";
    await bucket(PLAIN, "report_pdf", "success", 0, 5);
    await bucket(PLAIN, "report_pdf", "rejected", 0, 3);
    await bucket(PLAIN, "assessment_save", "replayed", 0, 2);
    expect(await evaluate()).toBe("ok");
    expect(await row(key)).toBeUndefined(); // success, rejected and replayed never alert
    await bucket(PLAIN, "report_pdf", "failed", 0, 2);
    expect(await evaluate()).toBe("ok");
    expect(await row(key)).toMatchObject({ source: "app_unverified", active: true, severity: "warning", episode_count: 1, observed_count: 2 });
    await bucket(PLAIN, "report_pdf", "failed", 1, 1);
    expect(await evaluate()).toBe("ok");
    expect(await row(key)).toMatchObject({ active: true, severity: "high", episode_count: 1, observed_count: 3 });
    const counters = (await h.q<{ n: number }>("select count(*)::int as n from operations.application_outcome_counts"))[0].n;
    await bucket(PLAIN, "report_pdf", "failed", 24, 2); // same slots, now outside the window
    await bucket(PLAIN, "report_pdf", "failed", 25, 1);
    expect(await evaluate()).toBe("ok");
    const expired = (await row(key))!;
    expect(expired).toMatchObject({ active: false, severity: "high", episode_count: 1 });
    expect(expired.cleared_at).not.toBeNull();
    expect((await h.q<{ n: number }>("select count(*)::int as n from operations.application_outcome_counts"))[0].n).toBe(counters);
    const v = await read();
    expect(validateAlerts(v).ok).toBe(true);
    expect(v.alerts.find((a) => a.op === "report_pdf")).toMatchObject({ active: false, source: "app_unverified" });
  });

  it("rows stay bounded to 2 x connections + 6 slots however often it runs", async () => {
    await bucket(PLAIN, "assessment_save", "failed", 0, 1);
    for (let i = 0; i < 3; i++) await evaluate();
    const n = (await h.q<{ n: number }>("select count(*)::int as n from platform.provider_connections"))[0].n;
    const keys = (await rows()).map((r) => r.alert_key);
    expect(keys).toEqual([...new Set(keys)]);
    expect(keys.length).toBeLessThanOrEqual(2 * n + OPS.length);
    expect(keys).toEqual(["APP_FAILURES_REPORTED:assessment_save", "APP_FAILURES_REPORTED:report_pdf", `WEBHOOK_BACKLOG_STALE:${E1}`]);
  });

  it("evaluating writes no billing, platform, public, vault or counter row", async () => {
    const tables = ["billing.webhook_inbox", "billing.discovered_payments", "billing.worker_runs", "billing.review_queue", "platform.provider_connections",
      "platform.admins", "platform.admin_audit", "public.workspaces", "vault.secrets", "operations.application_outcome_counts"];
    const snap = () => h.serial(async () => Promise.all(tables.map((t) => hash(h.pg, t))));
    const before = await snap();
    await evaluate();
    await evaluate("manual");
    expect(await snap()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
describe("source isolation (helpers replaced inside rolled-back transactions)", () => {
  const BILLING = "source = 'billing_authoritative'";
  const APP = "source = 'app_unverified'";

  it("a raising billing helper marks billing unavailable, leaves billing rows untouched, still evaluates the app source, stores no error text", async () => {
    await tx(async (pg) => {
      const billingBefore = await hash(pg, STATE, BILLING);
      const hb = (await pg.query<{ b: Date; c: Date }>(`select billing_ok_at as b, last_cron_completed_at as c from ${HB}`)).rows[0];
      await pg.exec(`update billing.webhook_inbox set status = 'done' where connection_id = '${E1}'`); // would clear if read
      await pg.exec(`insert into operations.application_outcome_counts (actor_id, slot, op, outcome, hour_start, count, last_at)
        values ('${PLAIN}', extract(hour from date_trunc('hour', now(), 'UTC') at time zone 'UTC'), 'dashboard_csv', 'failed', date_trunc('hour', now(), 'UTC'), 1, now())`);
      await breakFn(pg, "operations_snapshot", "raise exception 'MARKER_SECRET_ERROR connection refused';");
      expect(await evalIn(pg)).toBe("billing_unavailable");
      expect(await hash(pg, STATE, BILLING)).toBe(billingBefore);
      expect((await pg.query(`select 1 from ${STATE} where alert_key = 'APP_FAILURES_REPORTED:dashboard_csv' and active`)).rows).toHaveLength(1);
      const now = (await pg.query<{ b: Date; c: Date; s: string; a: string; cs: string }>(
        `select billing_ok_at as b, last_cron_completed_at as c, billing_status as s, app_status as a, last_cron_status as cs from ${HB}`)).rows[0];
      expect([now.s, now.a, now.cs]).toEqual(["unavailable", "ok", "billing_unavailable"]);
      expect([now.b, now.c]).toEqual([hb.b, hb.c]);
      const dump = (await pg.query<{ t: string }>(`select (select string_agg(r::text, '|') from ${STATE} r) || (select string_agg(r::text, '|') from ${HB} r) as t`)).rows[0].t;
      expect(dump).not.toMatch(/MARKER|refused|exception/i);
      const v = await readIn(pg);
      expect(validateAlerts(v).ok).toBe(true);
      expect(v.heartbeat.cron_freshness).toBe("unavailable");
      expect(JSON.stringify(v)).not.toContain("MARKER");
    });
  });

  it.each([
    ["null observed_at", "return jsonb_build_object('observed_at', null, 'connections', '[]'::jsonb, 'unassigned_reviews', jsonb_build_object('open', 0, 'oldest_created_at', null));"],
    ["missing queue", `return jsonb_set(private_snap(), '{connections,0}', (private_snap() #> '{connections,0}') - 'webhook');`],
    ["negative count", `return jsonb_set(private_snap(), '{connections,0,webhook,pending}', '-1');`],
    ["string count", `return jsonb_set(private_snap(), '{connections,0,webhook,pending}', '"1"');`],
    ["null count", `return jsonb_set(private_snap(), '{connections,0,discovery,retry}', 'null');`],
    ["count without oldest", `return jsonb_set(private_snap(), '{connections,0,webhook,pending}', '2');`],
    ["non-array connections", "return jsonb_build_object('observed_at', statement_timestamp(), 'connections', '{}'::jsonb, 'unassigned_reviews', '{}'::jsonb);"],
  ])("malformed billing snapshot (%s) is unavailable and changes no billing row", async (_, body) => {
    await tx(async (pg) => {
      // A copy of the real helper under another name lets the broken one start from a genuine snapshot.
      const def = (await pg.query<{ d: string }>("select pg_get_functiondef('private.operations_snapshot()'::regprocedure) as d")).rows[0].d;
      await pg.exec(def.replace(/private\.operations_snapshot\(\)/, "private.private_snap()"));
      await pg.exec(`update billing.webhook_inbox set status = 'done' where connection_id = '${E1}'`);
      await breakFn(pg, "operations_snapshot", body.replace(/private_snap\(\)/g, "private.private_snap()"));
      const before = await hash(pg, STATE, BILLING);
      expect(await evalIn(pg)).toBe("billing_unavailable");
      expect(await hash(pg, STATE, BILLING)).toBe(before);
    });
  });

  it("a real future-dated queue item makes billing unavailable (fail closed), never a quieter result", async () => {
    await tx(async (pg) => {
      await pg.exec(`update billing.webhook_inbox set status = 'done' where connection_id = '${E1}'`);
      await pg.exec(`insert into billing.webhook_inbox (connection_id, event_id, event_type, provider_created_at, organization_id, raw_body, body_sha256,
        signature_timestamp, status, received_at) values ('${E1}', 'evt_future', 'T', now(), 'O', convert_to('{}', 'UTF8'), repeat('a', 64), 1, 'pending', now() + interval '1 hour')`);
      const before = await hash(pg, STATE, BILLING);
      expect(await evalIn(pg)).toBe("billing_unavailable");
      expect(await hash(pg, STATE, BILLING)).toBe(before);
    });
  });

  // Every malformed app snapshot below keeps assessment_save (the active app alert) at zero failures, so accepting it
  // would clear that alert. Each starts from the genuine, empty snapshot (counters deleted) and breaks one thing.
  const R = "private.application_outcomes_snapshot_real()";
  const H = "to_jsonb(date_trunc('hour', statement_timestamp()))";
  const H1 = "to_jsonb(date_trunc('hour', statement_timestamp()) - interval '1 hour')";
  const sets = (...pairs: [string, string][]) => `return ${pairs.reduce((acc, [path, v]) => `jsonb_set(${acc}, '${path}', ${v})`, R)};`;
  /** report_pdf (index 1) with failures, plus one reporting actor so the bounds hold unless a case breaks them. */
  const failing = (hours: string, latest: string, actors = "'1'") => sets(["{operations,1,failed}", "'2'"], ["{operations,1,failed_hours}", hours],
    ["{operations,1,latest_reported_at}", latest], ["{reporting_actors_24h}", actors], ["{stored_buckets}", "'1'"]);
  const OBSERVED = `${R} -> 'observed_at'`;
  const APP_BROKEN: [string, string][] = [
    ["raises", "raise exception 'MARKER_APP';"],
    ["unknown operation", sets(["{operations,0,op}", "'\"billing_sync\"'"])],
    ["null failed", sets(["{operations,0,failed}", "'null'"])],
    ["missing failed hours", `return ${R} #- '{operations,1,failed_hours}';`],
    ["missing success", `return ${R} #- '{operations,0,success}';`],
    ["null success", sets(["{operations,0,success}", "'null'"])],
    ["negative success", sets(["{operations,0,success}", "'-1'"])],
    ["string success", sets(["{operations,0,success}", "'\"3\"'"])],
    ["fractional success", sets(["{operations,0,success}", "'1.5'"])],
    ["null replayed", sets(["{operations,0,replayed}", "'null'"])],
    ["string rejected", sets(["{operations,0,rejected}", "'\"2\"'"])],
    ["negative capped buckets", sets(["{operations,0,capped_buckets}", "'-1'"])],
    ["failures with a null latest report", failing(`jsonb_build_array(${H})`, "'null'")],
    ["failures with zero reporting users", failing(`jsonb_build_array(${H})`, OBSERVED, "'0'")],
    ["failed hours descending", failing(`jsonb_build_array(${H}, ${H1})`, OBSERVED)],
    ["failed hours duplicated", failing(`jsonb_build_array(${H1}, ${H1})`, OBSERVED)],
    ["bucket cap 500", sets(["{bucket_cap}", "'500'"])],
    ["capped beyond the total", sets(["{operations,2,capped_buckets}", "'1'"])],
    ["more users than stored buckets", sets(["{reporting_actors_24h}", "'1'"])],
    ["extra top-level key", sets(["{debug}", "'\"MARKER\"'"])],
    ["extra operation key", sets(["{operations,0,note}", "'\"MARKER\"'"])],
  ];
  const withRealCopy = async (pg: PGlite) => {
    const def = (await pg.query<{ d: string }>("select pg_get_functiondef('private.application_outcomes_snapshot()'::regprocedure) as d")).rows[0].d;
    await pg.exec(def.replace(/private\.application_outcomes_snapshot\(\)/, "private.application_outcomes_snapshot_real()"));
    await pg.exec("delete from operations.application_outcome_counts"); // a valid read would now expire every app warning
    await pg.exec(`update billing.webhook_inbox set status = 'done' where connection_id = '${E1}'`);
  };
  const appActive = async (pg: PGlite) => (await pg.query<{ active: boolean }>(
    `select active from ${STATE} where alert_key = 'APP_FAILURES_REPORTED:assessment_save'`)).rows[0].active;

  it.each(APP_BROKEN)("app source %s: app unavailable, the active app alert stays active, billing still evaluated and able to clear", async (_, body) => {
    await tx(async (pg) => {
      await withRealCopy(pg);
      expect(await appActive(pg)).toBe(true);
      await breakFn(pg, "application_outcomes_snapshot", body);
      const before = await hash(pg, STATE, APP);
      expect(await evalIn(pg)).toBe("app_unavailable");
      expect(await hash(pg, STATE, APP)).toBe(before);
      expect(await appActive(pg)).toBe(true);
      expect((await pg.query<{ active: boolean }>(`select active from ${STATE} where alert_key = 'WEBHOOK_BACKLOG_STALE:${E1}'`)).rows[0].active).toBe(false);
      expect((await pg.query<{ s: string }>(`select app_status as s from ${HB}`)).rows[0].s).toBe("unavailable");
    });
  });

  it("positive control: the genuine empty snapshot (all zero, no users) is a validated read and expires the app alert", async () => {
    await tx(async (pg) => {
      await withRealCopy(pg);
      await breakFn(pg, "application_outcomes_snapshot", `return ${R};`);
      expect(await evalIn(pg)).toBe("ok");
      expect(await appActive(pg)).toBe(false);
    });
  });

  it("both sources down: both unavailable, no alert row changes", async () => {
    await tx(async (pg) => {
      const before = await hash(pg, STATE);
      await breakFn(pg, "operations_snapshot", "raise exception 'x';");
      await breakFn(pg, "application_outcomes_snapshot", "raise exception 'y';");
      expect(await evalIn(pg)).toBe("both_unavailable");
      expect(await hash(pg, STATE)).toBe(before);
    });
  });

  it("a connection no longer listed keeps its warning, marked unobserved, never cleared", async () => {
    await tx(async (pg) => {
      await pg.exec(`update ${STATE} set active = true, cleared_at = null where alert_key = 'WEBHOOK_BACKLOG_STALE:${E1}'`);
      await breakFn(pg, "operations_snapshot",
        "return jsonb_build_object('observed_at', statement_timestamp(), 'worker_connection_ids', '[]'::jsonb, 'connections', '[]'::jsonb, 'unassigned_reviews', jsonb_build_object('open', 0, 'oldest_created_at', null));");
      expect(await evalIn(pg)).toBe("ok");
      const r = (await pg.query<StateRow>(`select * from ${STATE} where alert_key = 'WEBHOOK_BACKLOG_STALE:${E1}'`)).rows[0];
      expect(r.active).toBe(true);
      expect(r.cleared_at).toBeNull();
      expect(r.unobserved_since).not.toBeNull();
      const v = await readIn(pg);
      expect(validateAlerts(v).ok).toBe(true);
      expect(v.alerts.find((a) => a.connection_id === E1)).toMatchObject({ active: true, unobserved_since: expect.any(String) });
    });
  });
});

// ---------------------------------------------------------------------------
describe("heartbeat and lock", () => {
  it("a later successful manual run does not mask a failed scheduled run", async () => {
    await tx(async (pg) => {
      expect(await evalIn(pg)).toBe("ok");
      const okCron = (await pg.query<{ c: Date }>(`select last_cron_completed_at as c from ${HB}`)).rows[0].c;
      const def = (await pg.query<{ d: string }>("select pg_get_functiondef('private.operations_snapshot()'::regprocedure) as d")).rows[0].d;
      await breakFn(pg, "operations_snapshot", "raise exception 'down';");
      expect(await evalIn(pg)).toBe("billing_unavailable");
      await pg.exec(def); // restore the genuine helper
      expect(await evalIn(pg, "manual")).toBe("ok");
      const v = await readIn(pg);
      expect(validateAlerts(v).ok).toBe(true);
      expect(v.heartbeat).toMatchObject({ last_attempt_trigger: "manual", billing_status: "ok", app_status: "ok", last_manual_status: "ok",
        last_cron_status: "billing_unavailable", cron_freshness: "unavailable" });
      expect(Date.parse(v.heartbeat.last_cron_completed_at!)).toBe(okCron.getTime());
      expect(automaticChecksConfirmed({ ...v, scheduler_job: "active" })).toBe(false);
    });
  });

  it("the run clock is read after the lock, from clock_timestamp, not from the statement start", async () => {
    const body = (await h.q<{ s: string }>("select prosrc as s from pg_proc where proname = 'evaluate_operations_alerts'"))[0].s;
    const lock = body.indexOf("private.operations_alerts_try_lock()");
    const clock = body.indexOf("v_now := clock_timestamp()");
    expect(lock).toBeGreaterThan(-1);
    expect(clock).toBeGreaterThan(lock);
    expect(body).not.toMatch(/statement_timestamp\(\)|now\(\)|transaction_timestamp\(\)/);
    expect(body.slice(0, lock)).not.toContain("v_now :=");
  });

  it("regression: a run whose statement started before another run's newer record still commits with a later time", async () => {
    // One statement simulates the reviewed race: after this statement started, another run recorded a successful
    // scheduled run (newer than the statement start); then this run gets the lock with billing failing. With the
    // old statement-start clock its attempt would be older than that record and the heartbeat check would abort it.
    await tx(async (pg) => {
      await breakFn(pg, "operations_snapshot", "raise exception 'down';");
      await pg.exec(`do $d$ begin
        perform pg_sleep(0.02);
        update ${HB} set last_attempt_at = clock_timestamp(), last_attempt_trigger = 'cron', billing_status = 'ok', app_status = 'ok',
          billing_ok_at = clock_timestamp(), app_ok_at = clock_timestamp(), last_cron_attempted_at = clock_timestamp(),
          last_cron_status = 'ok', last_cron_completed_at = clock_timestamp();
        perform pg_sleep(0.02);
        perform private.evaluate_operations_alerts('cron');
      end $d$`);
      const r = (await pg.query<{ s: string; later: boolean; kept: boolean }>(`select last_cron_status as s,
        last_cron_attempted_at > last_cron_completed_at as later, billing_ok_at = last_cron_completed_at as kept from ${HB}`)).rows[0];
      expect(r).toEqual({ s: "billing_unavailable", later: true, kept: true });
      const v = await readIn(pg);
      expect(validateAlerts(v).ok).toBe(true); // the older successful billing read stays valid next to the newer failure
      expect(v.heartbeat).toMatchObject({ billing_status: "unavailable", last_cron_status: "billing_unavailable", cron_freshness: "unavailable" });
    });
    // PGlite has one connection: this proves the ordering inside a run, not behaviour under real concurrent sessions.
  });

  it("alert times move forward across normal runs and are never later than the next read", async () => {
    await tx(async (pg) => {
      const seen = async () => (await pg.query<{ t: Date }>(`select max(last_seen_at) as t from ${STATE} where active`)).rows[0].t.getTime();
      await evalIn(pg);
      const a = await seen();
      await evalIn(pg);
      const b = await seen();
      expect(b).toBeGreaterThan(a);
      const v = await readIn(pg);
      expect(validateAlerts(v).ok).toBe(true);
      for (const x of v.alerts) expect(Date.parse(x.last_seen_at)).toBeLessThanOrEqual(Date.parse(v.observed_at));
    });
  });

  it("a busy lock returns busy and writes nothing, not even the heartbeat", async () => {
    await tx(async (pg) => {
      await pg.exec(`update billing.webhook_inbox set status = 'done' where connection_id = '${E1}'`);
      const before = [await hash(pg, STATE), await hash(pg, HB)];
      await pg.exec("create or replace function private.operations_alerts_try_lock() returns boolean language sql volatile set search_path = '' as $f$ select false $f$");
      expect(await evalIn(pg)).toBe("busy");
      expect(await evalIn(pg, "manual")).toBe("busy");
      expect([await hash(pg, STATE), await hash(pg, HB)]).toEqual(before);
    });
  });

  it("freshness: stale after more than 10 minutes without a scheduled run; fresh only when the latest scheduled run read both sources", async () => {
    await tx(async (pg) => {
      const set = (ago: string, status: string) => pg.exec(`update ${HB} set last_attempt_at = now() - interval '${ago}', last_attempt_trigger = 'cron',
        billing_status = 'ok', app_status = 'ok', billing_ok_at = now() - interval '${ago}', app_ok_at = now() - interval '${ago}',
        last_cron_attempted_at = now() - interval '${ago}', last_cron_status = '${status}',
        last_cron_completed_at = now() - interval '${ago}', last_manual_attempted_at = null, last_manual_status = null`);
      await set("11 minutes", "ok");
      expect((await readIn(pg)).heartbeat.cron_freshness).toBe("stale");
      await set("9 minutes", "ok");
      const fresh = await readIn(pg);
      expect(validateAlerts(fresh).ok).toBe(true);
      expect(fresh.heartbeat.cron_freshness).toBe("fresh");
      expect(automaticChecksConfirmed(fresh)).toBe(false); // job catalog not measured here
    });
  });

  it("scheduler probe reads only the fixed job name: absent, active, inactive; ambiguous is not measured", async () => {
    await tx(async (pg) => {
      await pg.exec("create schema cron; create table cron.job (jobid bigserial primary key, jobname text, command text, active boolean not null default true)");
      await pg.exec("insert into cron.job (jobname, command) values ('savour-billing-process', 'MARKER_OTHER_JOB')");
      expect((await readIn(pg)).scheduler_job).toBe("absent");
      await pg.exec("insert into cron.job (jobname, command) values ('savour-operations-alerts', 'select 1')");
      const v = await readIn(pg);
      expect(v.scheduler_job).toBe("active");
      expect(JSON.stringify(v)).not.toContain("MARKER");
      await pg.exec("update cron.job set active = false where jobname = 'savour-operations-alerts'");
      expect((await readIn(pg)).scheduler_job).toBe("inactive");
      await pg.exec("insert into cron.job (jobname, command) values ('savour-operations-alerts', 'select 2')");
      expect((await readIn(pg)).scheduler_job).toBe("not_measured");
    });
  });
});

// ---------------------------------------------------------------------------
describe("read response cap and privacy", () => {
  it("returns at most 100 rows, active and high first, with full totals and an explicit truncation flag", async () => {
    await tx(async (pg) => {
      await pg.exec(`insert into ${STATE} (alert_key, source, code, connection_id, severity, active, episode_count, first_seen_at, last_seen_at,
          last_changed_at, cleared_at, observed_count, observed_oldest_at)
        select 'DISCOVERY_BACKLOG_STALE:' || id, 'billing_authoritative', 'DISCOVERY_BACKLOG_STALE', id, 'high', false, 1, now() - interval '2 hours',
          now() - interval '1 hour', now() - interval '1 minute', now() - interval '1 minute', 1, now() - interval '3 hours'
        from (select gen_random_uuid() as id from generate_series(1, 125)) g`);
      await pg.exec(`insert into ${STATE} (alert_key, source, code, op, severity, active, episode_count, first_seen_at, last_seen_at, last_changed_at,
          observed_count, observed_oldest_at)
        select 'APP_FAILURES_REPORTED:' || o, 'app_unverified', 'APP_FAILURES_REPORTED', o, 'warning', true, 1, now() - interval '3 hours', now(),
          now() - interval '3 hours', 2, date_trunc('hour', now()) from unnest(array['analytics_pdf', 'analytics_csv']) o`);
      const total = (await pg.query<{ n: number }>(`select count(*)::int as n from ${STATE}`)).rows[0].n;
      const active = (await pg.query<{ n: number }>(`select count(*)::int as n from ${STATE} where active`)).rows[0].n;
      const v = await readIn(pg);
      expect(validateAlerts(v).ok).toBe(true);
      expect([v.alerts_total, v.alerts_active, v.alerts_truncated, v.alerts.length, v.alert_limit]).toEqual([total, active, true, 100, 100]);
      const flags = v.alerts.map((a) => `${a.active ? "A" : "i"}${a.severity === "high" ? "H" : "w"}`);
      expect(flags.slice(0, active).every((f) => f[0] === "A")).toBe(true);
      expect(flags.slice(active).every((f) => f[0] === "i")).toBe(true);
      expect(flags.indexOf("Aw")).toBeGreaterThan(flags.lastIndexOf("AH"));
      const leaves: unknown[] = [];
      const walk = (x: unknown) => { if (x && typeof x === "object") Object.values(x).forEach(walk); else leaves.push(x); };
      walk(v);
      const allowed = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T[\d:.]+\+00:00|WEBHOOK_BACKLOG_STALE|DISCOVERY_BACKLOG_STALE|APP_FAILURES_REPORTED|billing_authoritative|app_unverified|high|warning|ok|unavailable|billing_unavailable|app_unavailable|both_unavailable|cron|manual|never|fresh|stale|active|inactive|absent|not_measured|assessment_save|report_pdf|report_csv|analytics_pdf|analytics_csv|dashboard_csv)$/;
      for (const l of leaves) {
        if (typeof l === "string") expect(l).toMatch(allowed);
        else if (typeof l === "number") expect(Number.isSafeInteger(l) && l >= 0).toBe(true);
        else expect(l === null || typeof l === "boolean").toBe(true);
      }
      expect(JSON.stringify(v)).not.toMatch(/MARKER|@|sk_sandbox|whsec|evt_/);
    });
  });
});

// ---------------------------------------------------------------------------
// Parity: the SQL findings helpers and the TypeScript mirrors on the same fixtures
// ---------------------------------------------------------------------------
const norm = (r: FindingsResult) => r.ok
  ? { ok: true, findings: r.findings.map((f) => ({ ...f, oldest_at: Date.parse(f.oldest_at) }))
    .sort((a, b) => `${a.code}${a.connection_id ?? a.op}`.localeCompare(`${b.code}${b.connection_id ?? b.op}`)) }
  : { ok: false };
const sqlFindings = async (fn: "billing" | "app", fixture: unknown): Promise<FindingsResult> => {
  try {
    const r = await h.q<{ r: AlertFinding[] }>(`select private.operations_alert_${fn}_findings($1::jsonb) as r`, [JSON.stringify(fixture)]);
    return { ok: true, findings: r[0].r };
  } catch (e) {
    expect((e as Error).message).toMatch(/invalid_snapshot|out of range|invalid input syntax/);
    return { ok: false };
  }
};

const C1 = "eeeeeeee-5700-4000-8000-000000000001";
const C2 = "eeeeeeee-5700-4000-8000-000000000002";
const OBS = Date.parse("2026-10-12T22:00:00.000Z");
const iso = (msAgo: number) => new Date(OBS - msAgo).toISOString().replace("Z", "+00:00");
const B = 15 * 60_000;
const fresh = (): RunFacts => ({ latest_finished_at: iso(60_000), latest_outcome: "success", latest_success_at: iso(60_000),
  unfinished: 0, oldest_unfinished_started_at: null, failed_24h: 0, partial_24h: 0 });
const conn = (over: Partial<ConnectionFacts> = {}): ConnectionFacts => ({
  id: C1, provider_code: "bachs", status: "enabled", worker_required: true,
  webhook: { pending: 0, processing: 0, failed: 0, expired_leases: 0, oldest_received_at: null }, webhook_dead: 0, webhook_quarantined: 0,
  discovery: { pending: 0, processing: 0, retry: 0, expired_leases: 0, oldest_first_seen_at: null }, discovery_dead: 0,
  reviews: { open: 0, oldest_created_at: null }, collisions_24h: 0, runs: { process: fresh(), discover: fresh(), reconcile: fresh() }, ...over,
});
const snap = (connections: ConnectionFacts[] = [conn()], over: Partial<Snapshot> = {}): Snapshot => ({
  observed_at: iso(0), worker_connection_ids: connections.filter((c) => c.worker_required).map((c) => c.id), connections,
  unassigned_reviews: { open: 0, oldest_created_at: null }, ...over,
});
const wh = (n: number, ago: number | null) => ({ pending: n, processing: 0, failed: 0, expired_leases: 0, oldest_received_at: ago === null ? null : iso(ago) });
const dq = (n: number, ago: number | null) => ({ pending: 0, processing: 0, retry: n, expired_leases: 0, oldest_first_seen_at: ago === null ? null : iso(ago) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- malformed fixtures mutate arbitrary JSON
type Json = Record<string, any>;
const mut = (s: unknown, f: (j: Json) => void) => { const j = JSON.parse(JSON.stringify(s)) as Json; f(j); return j; };

const BILLING_FIXTURES: [string, unknown, number | null][] = [
  ["no connections", snap([]), 0],
  ["quiet connection", snap(), 0],
  ["webhook exactly 15 minutes", snap([conn({ webhook: wh(1, B) })]), 0],
  ["webhook 15 minutes + 1 ms", snap([conn({ webhook: wh(3, B + 1) })]), 1],
  ["discovery exactly 15 minutes", snap([conn({ discovery: dq(1, B) })]), 0],
  ["discovery 15 minutes + 1 ms", snap([conn({ discovery: dq(2, B + 1) })]), 1],
  ["microseconds beyond the millisecond are ignored", snap([conn({ webhook: { ...wh(1, 0), oldest_received_at: "2026-10-12T21:45:00+00:00" } })],
    { observed_at: "2026-10-12T22:00:00.000999+00:00" }), 0],
  ["sub-millisecond older is still compared at milliseconds", snap([conn({ webhook: { ...wh(1, 0), oldest_received_at: "2026-10-12T21:44:59.9995+00:00" } })]), 1],
  ["two connections, both queues, one not served by the worker", snap([conn({ webhook: wh(2, B * 2), discovery: dq(1, B * 3) }),
    conn({ id: C2, worker_required: false, status: "draft", webhook: { pending: 1, processing: 1, failed: 1, expired_leases: 1, oldest_received_at: iso(B + 5) } })]), 3],
  ["future backlog time", snap([conn({ webhook: wh(1, -1) })]), null],
  ["future run time", snap([conn({ runs: { ...conn().runs, reconcile: { ...fresh(), latest_finished_at: iso(-1000), latest_success_at: iso(-1000) } } })]), null],
  ["future unassigned review", snap(undefined, { unassigned_reviews: { open: 1, oldest_created_at: iso(-5) } }), null],
  ["string count", mut(snap([conn({ webhook: wh(1, B + 1) })]), (j) => { j.connections[0].webhook.pending = "1"; }), null],
  ["null count", mut(snap(), (j) => { j.connections[0].discovery.retry = null; }), null],
  ["negative count", mut(snap(), (j) => { j.connections[0].webhook.failed = -1; }), null],
  ["fractional count", mut(snap(), (j) => { j.connections[0].webhook.processing = 0.5; }), null],
  ["missing queue", mut(snap(), (j) => { delete j.connections[0].discovery; }), null],
  ["missing oldest key", mut(snap(), (j) => { delete j.connections[0].webhook.oldest_received_at; }), null],
  ["count without oldest", mut(snap(), (j) => { j.connections[0].webhook.pending = 2; }), null],
  ["missing observed_at", mut(snap(), (j) => { delete j.observed_at; }), null],
  ["non-UTC observed_at", mut(snap(), (j) => { j.observed_at = "2026-10-12T23:00:00+01:00"; }), null],
  ["impossible date", mut(snap([conn({ webhook: wh(1, B + 1) })]), (j) => { j.connections[0].webhook.oldest_received_at = "2026-02-30T12:00:00+00:00"; }), null],
  ["hour 24", mut(snap(), (j) => { j.observed_at = "2026-10-12T24:00:00+00:00"; }), null],
  ["duplicate connection", mut(snap([conn(), conn({ id: C2 })]), (j) => { j.connections[1].id = C1; j.worker_connection_ids = [C1]; }), null],
  ["bad connection id", mut(snap(), (j) => { j.connections[0].id = "not-a-uuid"; j.worker_connection_ids = []; j.connections[0].worker_required = false; }), null],
  ["not an object", [], null],
];

const AOBS = "2026-10-12T22:30:00.123456+00:00";
const FROM = "2026-10-11T23:00:00+00:00";
const zero = (op: OpCounts["op"]): OpCounts => ({ op, success: 0, replayed: 0, rejected: 0, failed: 0, capped_buckets: 0, latest_reported_at: null, failed_hours: [] });
const app = (ops: Partial<Record<OpCounts["op"], Partial<OpCounts>>> = {}, over: Partial<AppSnapshot> = {}): AppSnapshot => ({
  observed_at: AOBS, window_start: FROM, bucket_cap: 1000, stored_buckets: 12, reporting_actors_24h: 2,
  operations: OPS.map((op) => ({ ...zero(op), ...ops[op] })), ...over,
});
const failed = (n: number, hours: string[]) => ({ failed: n, latest_reported_at: "2026-10-12T22:29:00+00:00", failed_hours: hours });
const HOURS = Array.from({ length: 24 }, (_, i) => new Date(Date.parse(FROM) + i * 3_600_000).toISOString().replace(".000Z", "+00:00"));
const fullActor = (over: Partial<OpCounts> = {}, top: Partial<AppSnapshot> = {}) => app({ report_pdf: {
  success: 24_000, replayed: 24_000, rejected: 24_000, failed: 24_000, capped_buckets: 96, latest_reported_at: AOBS, failed_hours: HOURS, ...over,
} }, { reporting_actors_24h: 1, stored_buckets: 96, ...top });

const APP_FIXTURES: [string, unknown, number | null][] = [
  ["nothing reported", app({}, { stored_buckets: 0, reporting_actors_24h: 0 }), 0],
  ["successes, rejections and replays only", app({ report_pdf: { success: 9, rejected: 4, replayed: 2, latest_reported_at: AOBS } }), 0],
  ["one failed hour", app({ report_csv: failed(1, ["2026-10-12T22:00:00+00:00"]) }), 1],
  ["two adjacent failed hours", app({ assessment_save: failed(4, ["2026-10-12T20:00:00+00:00", "2026-10-12T21:00:00+00:00"]) }), 1],
  ["two non-adjacent failed hours", app({ dashboard_csv: failed(2, ["2026-10-12T19:00:00+00:00", "2026-10-12T21:00:00+00:00"]) }), 1],
  ["oldest and newest hours of the window", app({ analytics_pdf: failed(2, [FROM, "2026-10-12T22:00:00+00:00"]) }), 1],
  ["several operations", app({ report_pdf: failed(1, ["2026-10-12T10:00:00+00:00"]),
    analytics_csv: failed(3, ["2026-10-12T21:00:00+00:00", "2026-10-12T22:00:00+00:00"]) }), 2],
  ["unknown operation", mut(app(), (j) => { j.operations[2].op = "billing_sync"; }), null],
  ["operations out of order", mut(app(), (j) => { [j.operations[0], j.operations[1]] = [j.operations[1], j.operations[0]]; }), null],
  ["missing operation", mut(app(), (j) => { j.operations.pop(); }), null],
  ["null failed", mut(app(), (j) => { j.operations[0].failed = null; }), null],
  ["missing failed", mut(app(), (j) => { delete j.operations[0].failed; }), null],
  ["string failed", mut(app({ report_csv: failed(1, ["2026-10-12T22:00:00+00:00"]) }), (j) => { j.operations[2].failed = "1"; }), null],
  ["negative failed", mut(app(), (j) => { j.operations[3].failed = -1; }), null],
  ["failed without hours", mut(app({ report_csv: failed(1, ["2026-10-12T22:00:00+00:00"]) }), (j) => { j.operations[2].failed_hours = []; }), null],
  ["hours without failures", mut(app(), (j) => { j.operations[1].failed_hours = ["2026-10-12T21:00:00+00:00"]; }), null],
  ["future hour", mut(app({ report_csv: failed(1, ["2026-10-12T22:00:00+00:00"]) }), (j) => { j.operations[2].failed_hours = ["2026-10-12T23:00:00+00:00"]; }), null],
  ["hour before the window", mut(app({ report_csv: failed(1, ["2026-10-12T22:00:00+00:00"]) }), (j) => { j.operations[2].failed_hours = ["2026-10-11T22:00:00+00:00"]; }), null],
  ["hour not whole", mut(app({ report_csv: failed(1, ["2026-10-12T22:00:00+00:00"]) }), (j) => { j.operations[2].failed_hours = ["2026-10-12T21:30:00+00:00"]; }), null],
  ["future latest report", mut(app({ report_csv: failed(1, ["2026-10-12T22:00:00+00:00"]) }), (j) => { j.operations[2].latest_reported_at = "2026-10-12T22:31:00+00:00"; }), null],
  ["window not aligned to the observation", mut(app(), (j) => { j.window_start = "2026-10-11T22:00:00+00:00"; }), null],
  ["null observed_at", mut(app(), (j) => { j.observed_at = null; }), null],
  ["not an object", "x", null],
  // Review follow-up: the SQL validator now mirrors validateAppSnapshot, so each of these must agree too.
  ["failures with a null latest report", mut(app({ report_csv: failed(2, ["2026-10-12T22:00:00+00:00"]) }), (j) => { j.operations[2].latest_reported_at = null; }), null],
  ["latest report without any count", mut(app(), (j) => { j.operations[4].latest_reported_at = AOBS; }), null],
  ["latest report before the window", mut(app({ report_csv: failed(1, ["2026-10-12T22:00:00+00:00"]) }), (j) => { j.operations[2].latest_reported_at = "2026-10-11T22:59:59+00:00"; }), null],
  ...(["success", "replayed", "rejected", "capped_buckets"] as const).flatMap((k): [string, unknown, null][] => [
    [`${k} missing`, mut(app(), (j) => { delete j.operations[0][k]; }), null],
    [`${k} null`, mut(app(), (j) => { j.operations[0][k] = null; }), null],
    [`${k} negative`, mut(app(), (j) => { j.operations[0][k] = -1; }), null],
    [`${k} string`, mut(app(), (j) => { j.operations[0][k] = "3"; }), null],
    [`${k} fractional`, mut(app(), (j) => { j.operations[0][k] = 1.5; }), null],
  ]),
  ["failures with zero reporting users", app({ report_csv: failed(1, ["2026-10-12T22:00:00+00:00"]) }, { reporting_actors_24h: 0 }), null],
  ["successes with zero reporting users", app({ report_pdf: { success: 1, latest_reported_at: AOBS } }, { reporting_actors_24h: 0 }), null],
  ["all zero with zero users and stored buckets left (positive control)", app({}, { reporting_actors_24h: 0 }), 0],
  ["more users than stored buckets", app({}, { reporting_actors_24h: 3, stored_buckets: 2 }), null],
  ["bucket cap 500", mut(app(), (j) => { j.bucket_cap = 500; }), null],
  ["bucket cap missing", mut(app(), (j) => { delete j.bucket_cap; }), null],
  ["stored buckets string", mut(app(), (j) => { j.stored_buckets = "12"; }), null],
  ["reporting users null", mut(app(), (j) => { j.reporting_actors_24h = null; }), null],
  ["failed hours descending", app({ report_csv: failed(2, ["2026-10-12T21:00:00+00:00", "2026-10-12T20:00:00+00:00"]) }), null],
  ["failed hours duplicated", app({ report_csv: failed(2, ["2026-10-12T21:00:00+00:00", "2026-10-12T21:00:00+00:00"]) }), null],
  ["more than 24 failed hours", app({ report_csv: failed(25, [...HOURS, "2026-10-12T22:00:00+00:00"]) }), null],
  ["extra top-level key", mut(app(), (j) => { j.actor_ids = []; }), null],
  ["extra operation key", mut(app(), (j) => { j.operations[0].error = "MARKER"; }), null],
  ["capped bucket beyond the total", mut(app(), (j) => { j.operations[2].capped_buckets = 1; }), null],
  // Legal upper bounds: one user, every hour of the window, all four outcomes capped (96 buckets of 1000), ascending.
  ["legal upper bound, one user", fullActor(), 1],
  ["legal upper bound, two users", fullActor({ success: 48_000, capped_buckets: 120 }, { reporting_actors_24h: 2, stored_buckets: 200 }), 1],
  ["one outcome above users x 24 x cap", fullActor({ success: 24_001 }), null],
  ["failures above users x failed hours x cap", fullActor({ failed: 2_001, failed_hours: HOURS.slice(0, 2) }), null],
  ["one failed hour holding more than one bucket", app({ report_csv: { failed: 1_001, latest_reported_at: AOBS, failed_hours: [HOURS[3]] } }, { reporting_actors_24h: 1 }), null],
  ["capped buckets above 24 x 4 per user", fullActor({ capped_buckets: 97 }, { stored_buckets: 200 }), null],
  ["capped buckets above stored buckets", fullActor({}, { stored_buckets: 95 }), null],
];

describe("SQL/TypeScript parity on shared fixtures", () => {
  it.each(BILLING_FIXTURES)("billing: %s", async (_, fixture, expected) => {
    const ts = billingAlertFindings(fixture);
    expect(norm(await sqlFindings("billing", fixture))).toEqual(norm(ts));
    expect(ts.ok ? ts.findings.length : null).toBe(expected);
    if (ts.ok) for (const f of ts.findings) expect([f.source, f.severity, f.op]).toEqual(["billing_authoritative", "high", null]);
  });
  it.each(APP_FIXTURES)("app: %s", async (_, fixture, expected) => {
    const ts = appAlertFindings(fixture);
    expect(norm(await sqlFindings("app", fixture))).toEqual(norm(ts));
    expect(ts.ok ? ts.findings.length : null).toBe(expected);
  });
  it("severity: two adjacent hours are high, otherwise warning (both implementations)", async () => {
    const f = app({ assessment_save: failed(4, ["2026-10-12T20:00:00+00:00", "2026-10-12T21:00:00+00:00"]),
      dashboard_csv: failed(2, ["2026-10-12T19:00:00+00:00", "2026-10-12T21:00:00+00:00"]) });
    for (const r of [appAlertFindings(f), await sqlFindings("app", f)]) {
      expect(r.ok && r.findings.map((x) => [x.op, x.severity, x.count])).toEqual([["assessment_save", "high", 4], ["dashboard_csv", "warning", 2]]);
    }
  });
});

// ---------------------------------------------------------------------------
describe("operator cron files", () => {
  const schedule = readFileSync(join(root, "supabase/cron/operations_alerts_schedule.sql"), "utf8");
  const unschedule = readFileSync(join(root, "supabase/cron/operations_alerts_unschedule.sql"), "utf8");
  const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("the schedule file fails closed without pg_cron and creates nothing", async () => {
    await expect(h.serial(() => h.pg.exec(schedule))).rejects.toThrow(/pg_cron is not enabled/);
    await h.serial(() => h.pg.exec("rollback"));
    expect((await h.q<{ c: string | null }>("select to_regnamespace('cron')::text as c"))[0].c).toBeNull();
  });

  it("schedules and removes only the named job, every 5 minutes, calling only the evaluator with the cron trigger", () => {
    expect(code(schedule).match(/cron\.schedule\(/g)).toHaveLength(1);
    expect(code(schedule)).toContain("cron.schedule('savour-operations-alerts', '*/5 * * * *', $$select private.evaluate_operations_alerts('cron')$$)");
    expect(code(schedule).indexOf("pg_cron is not enabled")).toBeLessThan(code(schedule).indexOf("cron.schedule("));
    expect(code(unschedule).trim()).toBe("select cron.unschedule(jobid) from cron.job where jobname = 'savour-operations-alerts';");
    for (const s of [schedule, unschedule]) expect(code(s)).not.toMatch(/net\.|http|vault|alter system|set_config|savour-billing|unschedule\(jobname\)/i);
  });
});
