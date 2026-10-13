// M5 development-only automatic owner email on embedded PostgreSQL with every migration applied: the operations_mail
// role grid, admin read/switch gates, source freshness, episode dedupe, quota, leases, the 23-hour window, immutable
// payloads, terminal states and cleanup bounds. Synthetic fixtures only; no network, no key, nothing is sent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validateClaim } from "../../supabase/functions/operations-mailer/core.ts";
import { VERIFICATION_TEXT } from "@/lib/alert-email";
import { validateMailer, type MailerView } from "@/lib/operations-mailer";
import { harness } from "./m4-harness";

type H = Awaited<ReturnType<typeof harness>>;
let h: H;
const ADMIN = "eeeeeeee-5a00-4000-8000-000000000001";
const REVOKED = "eeeeeeee-5a00-4000-8000-000000000002";
const PLAIN = "eeeeeeee-5a00-4000-8000-000000000003";
const SPOOF = "eeeeeeee-5a00-4000-8000-000000000004";
const ADMIN2 = "eeeeeeee-5a00-4000-8000-000000000005";
const C1 = "eeeeeeee-5a00-4000-8000-0000000000c1";
const MSG = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const ROLES = ["public", "anon", "authenticated", "service_role", "billing_intake", "billing_gateway", "billing_worker", "operations_mail"];
const OPS = ["assessment_save", "report_pdf", "report_csv", "analytics_pdf", "analytics_csv", "dashboard_csv"];
const L = "operations.mail_ledger";
const TABLES = [L, "operations.mailer_config", "operations.mailer_heartbeat", "operations.mail_attempt_days"];
const root = join(import.meta.dirname, "..", "..");

const raw = async (uid: string | null, claims: Record<string, unknown>, sql: string, role = "authenticated") => h.serial(async () => {
  await h.pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(uid ? { sub: uid, ...claims } : claims)]);
  await h.pg.exec(`set role ${role}`);
  try { return { rows: (await h.pg.query<{ r: unknown }>(sql)).rows, error: null as string | null }; }
  catch (e) { return { rows: null, error: (e as Error).message }; }
  finally { await h.pg.exec("reset role"); }
});
const as = (uid: string, sql: string, aal = "aal2") => raw(uid, { role: "authenticated", aal }, sql);
const exec = (sql: string) => h.serial(() => h.pg.exec(sql));
const worker = (sql: string) => raw(null, {}, sql, "operations_mail");
interface Item { lease_token: string; idempotency_key: string; from: string; to: string; subject: string; text: string }
const claim = async () => {
  const r = await worker("select operations.mailer_claim() as r");
  if (r.error) throw new Error(r.error);
  return r.rows![0].r as { status: string; items: Item[] };
};
const lit = (v: string | null) => (v === null ? "null" : `'${v}'`);
const finish = async (lease: string | null, outcome: string | null, msg: string | null = null) =>
  worker(`select operations.mailer_finish(${lit(lease)}, ${lit(outcome)}, ${lit(msg)}) as r`);
const finishOk = async (lease: string, outcome: string, msg: string | null = null) => (await finish(lease, outcome, msg)).rows?.[0].r;
const heartbeat = (s: string) => worker(`select operations.mailer_heartbeat('${s}') as r`);
const read = async (uid = ADMIN, aal = "aal1") => {
  const r = await as(uid, "select public.platform_operations_mailer() as r", aal);
  if (r.error) throw new Error(r.error);
  return r.rows![0].r as MailerView;
};
const enable = async () => { await heartbeat("ready"); expect((await as(ADMIN, "select public.platform_enable_operations_mailer() as r")).error).toBeNull(); };
interface Row { id: string; alert_key: string; episode: number; status: string; attempts: number; subject: string; body: string; lease_token: string | null }
/** Owner-only fixture backdating of created_at (normally immutable): the guard trigger is off only for this statement. */
const backdate = async (sql: string) => {
  await h.q(`alter table ${L} disable trigger mail_ledger_guard`);
  try { await h.q(sql); } finally { await h.q(`alter table ${L} enable trigger mail_ledger_guard`); }
};
const ledger = () => h.q<Row>(`select id, alert_key, episode, status, attempts, subject, body, lease_token from ${L} order by created_at, alert_key`);

/** Source heartbeat: both sources read ok `ago` before now. */
const sources = (ago = "0 minutes", app = "ok") => h.q(`update operations.alert_heartbeat set last_attempt_at = now() - $1::interval,
  last_attempt_trigger = 'cron', billing_status = 'ok', app_status = $2, billing_ok_at = now() - $1::interval,
  app_ok_at = case when $2 = 'ok' then now() - $1::interval end, last_cron_attempted_at = now() - $1::interval,
  last_cron_status = case when $2 = 'ok' then 'ok' else 'app_unavailable' end, last_cron_completed_at = case when $2 = 'ok' then now() - $1::interval end`, [ago, app]);
const appAlert = (op: string, o: { episode?: number; seen?: string; active?: boolean } = {}) => h.q(`insert into operations.alert_state
  (alert_key, source, code, op, severity, active, episode_count, first_seen_at, last_seen_at, last_changed_at, cleared_at, observed_count, observed_oldest_at)
  values ('APP_FAILURES_REPORTED:' || $1, 'app_unverified', 'APP_FAILURES_REPORTED', $1, 'warning', $3, $2, now() - interval '2 hours',
    now() - $4::interval, now() - interval '2 hours', case when $3 then null else now() end, 7, now() - interval '3 hours')
  on conflict (alert_key) do update set active = excluded.active, episode_count = excluded.episode_count, last_seen_at = excluded.last_seen_at,
    cleared_at = excluded.cleared_at`, [op, o.episode ?? 1, o.active ?? true, o.seen ?? "1 minute"]);
const billingAlert = (unobserved = false) => h.q(`insert into operations.alert_state
  (alert_key, source, code, connection_id, severity, active, episode_count, first_seen_at, last_seen_at, last_changed_at, unobserved_since, observed_count, observed_oldest_at)
  values ('WEBHOOK_BACKLOG_STALE:' || $1, 'billing_authoritative', 'WEBHOOK_BACKLOG_STALE', $1::uuid, 'high', true, 1, now() - interval '1 hour',
    now() - interval '1 minute', now() - interval '1 hour', case when $2 then now() end, 3, now() - interval '40 minutes')`, [C1, unobserved]);

beforeAll(async () => {
  h = await harness();
  for (const u of [ADMIN, REVOKED, PLAIN]) await h.q("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [u, `${u}@m5m.test`]);
  await h.q("insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, 'spoof@m5m.test', now(), $2)",
    [SPOOF, JSON.stringify({ platform_admin: true, role: "admin" })]);
  await h.q("insert into platform.admins (user_id, note) values ($1, 'live fixture')", [ADMIN]);
  await h.q("insert into platform.admins (user_id, note, revoked_at) values ($1, 'revoked fixture', now())", [REVOKED]);
  await h.q("insert into auth.users (id, email, email_confirmed_at) values ($1, 'admin2@m5m.test', now())", [ADMIN2]);
  await h.q("insert into platform.admins (user_id, note) values ($1, 'second live fixture')", [ADMIN2]);
  // LOCAL ONLY: a minimal pg_cron catalog (the columns the probe reads). PGlite has no pg_cron.
  await exec(`create schema cron;
    create table cron.job (jobid bigint primary key, jobname text, active boolean not null default true);
    create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text, start_time timestamptz);
    revoke all on schema cron from public`);
}, 180_000);
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  await h.q(`delete from ${L}`);
  await h.q("delete from operations.mail_attempt_days");
  await h.q("delete from operations.alert_state");
  // Five other jobs exist and are never read; the sixth is active by default.
  await exec("delete from cron.job_run_details; delete from cron.job");
  await h.q(`insert into cron.job (jobid, jobname, active) values (1, 'savour-billing-process', true), (2, 'savour-billing-housekeeping', true),
    (3, 'savour-billing-discover', true), (4, 'savour-billing-reconcile', true), (5, 'savour-operations-alerts', true), (6, 'savour-operations-mailer', true)`);
  await h.q("update operations.mailer_config set enabled = false, changed_at = null, changed_by = null");
  await h.q("update operations.mailer_heartbeat set status = null, last_checked_at = null, last_ready_at = null");
  await sources();
});

// ---------------------------------------------------------------------------
describe("privileges", () => {
  const WORKER = ["operations.mailer_claim()", "operations.mailer_finish(uuid, text, uuid)", "operations.mailer_heartbeat(text)"];
  const ADMIN_FNS = ["public.platform_operations_mailer()", "public.platform_enable_operations_mailer()", "public.platform_disable_operations_mailer()",
    "private.platform_operations_mailer()", "private.platform_enable_operations_mailer()", "private.platform_disable_operations_mailer()"];
  const OWNER_ONLY = ["private.operations_mail_target()", "private.operations_mail_message(operations.alert_state)",
    "private.operations_mail_eligible(timestamptz)", "private.operations_mailer_read()", "private.operations_mail_ledger_guard()",
    "private.operations_mailer_scheduler()", "private.operations_mailer_worker_fresh(timestamptz, timestamptz)",
    "private.alert_email_verification_message()"];

  it("operations_mail holds exactly three application EXECUTE grants (PUBLIC's baseline aside); authenticated only the admin entries", async () => {
    const grid = await h.q<{ f: string; r: string; ok: boolean }>(`select f, r, has_function_privilege(r, f, 'execute') as ok
      from unnest($1::text[]) f, unnest($2::text[]) r`, [[...WORKER, ...ADMIN_FNS, ...OWNER_ONLY], ROLES]);
    expect(grid.filter((g) => g.ok).map((g) => `${g.f} ${g.r}`).sort())
      .toEqual([...WORKER.map((f) => `${f} operations_mail`), ...ADMIN_FNS.map((f) => `${f} authenticated`)].sort());
    // Across every function in the app schemas, operations_mail reaches only its three (plus PUBLIC-executable built-ins elsewhere).
    const reach = await h.q<{ f: string }>(`select n.nspname || '.' || p.proname as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private', 'operations', 'billing', 'platform', 'vault') and has_function_privilege('operations_mail', p.oid, 'execute')
      order by 1`);
    expect(reach.map((r) => r.f)).toEqual(["operations.mailer_claim", "operations.mailer_finish", "operations.mailer_heartbeat"]);
  });

  it("operations_mail is NOLOGIN NOINHERIT, member of nothing, with no table privilege anywhere in the app schemas", async () => {
    const [r] = await h.q<{ login: boolean; inherit: boolean; su: boolean; bypass: boolean; createrole: boolean }>(`select rolcanlogin as login,
      rolinherit as inherit, rolsuper as su, rolbypassrls as bypass, rolcreaterole as createrole from pg_roles where rolname = 'operations_mail'`);
    expect(r).toEqual({ login: false, inherit: false, su: false, bypass: false, createrole: false });
    expect(await h.q("select 1 from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'operations_mail'")).toEqual([]);
    expect(await h.q(`select 1 from information_schema.role_table_grants where grantee = 'operations_mail'`)).toEqual([]);
    for (const s of ["billing", "platform", "vault", "private"]) {
      expect((await h.q<{ ok: boolean }>("select has_schema_privilege('operations_mail', $1, 'usage') as ok", [s]))[0].ok, s).toBe(false);
    }
  });

  it("the mailer tables: RLS on, no policy, no grant to any role", async () => {
    for (const t of TABLES) {
      expect((await h.q<{ s: boolean }>(`select relrowsecurity as s from pg_class where oid = '${t}'::regclass`))[0].s, t).toBe(true);
      for (const r of ROLES.filter((x) => x !== "public")) for (const p of ["select", "insert", "update", "delete", "truncate"]) {
        expect((await h.q<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [r, t, p]))[0].ok, `${r} ${t} ${p}`).toBe(false);
      }
    }
    expect(await h.q("select 1 from pg_policies where schemaname = 'operations'")).toEqual([]);
    expect(await h.q("select 1 from information_schema.role_table_grants where table_schema = 'operations' and grantee <> (select current_user)")).toEqual([]);
  });

  it("wrappers are invokers calling only the guard; guards are definers whose first statement is the actor check; no public definer", async () => {
    const meta = await h.q<{ name: string; secdef: boolean; cfg: string[]; src: string }>(`select n.nspname || '.' || p.proname as name,
      p.prosecdef as secdef, p.proconfig as cfg, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname like '%operations\\_mailer' or p.proname like 'mailer\\_%' order by 1`);
    const by = Object.fromEntries(meta.map((m) => [m.name, m]));
    for (const f of ["operations_mailer", "enable_operations_mailer", "disable_operations_mailer"]) {
      expect(by[`public.platform_${f}`].secdef).toBe(false);
      expect(by[`public.platform_${f}`].src.trim()).toBe(`select private.platform_${f}()`);
      expect(by[`private.platform_${f}`].secdef).toBe(true);
      // The actor check is the first statement; declarations run nothing; the switches bind its returned id.
      const src = by[`private.platform_${f}`].src;
      const at = src.search(/\bbegin\b/);
      expect(src.slice(0, at), f).not.toMatch(/:=|\(/);
      const first = f === "operations_mailer" ? "perform private.platform_actor(false);" : "v_actor := private.platform_actor(true);";
      expect(src.slice(at + "begin".length).trimStart().startsWith(first), f).toBe(true);
    }
    for (const f of ["mailer_claim", "mailer_finish", "mailer_heartbeat"]) expect(by[`operations.${f}`].secdef).toBe(true);
    for (const m of meta.filter((x) => x.secdef)) expect(m.cfg, m.name).toContain('search_path=""');
    const claimSrc = by["operations.mailer_claim"].src;
    expect(claimSrc.indexOf("pg_try_advisory_xact_lock(20261013203437)")).toBeGreaterThan(-1);
    expect(claimSrc.indexOf("pg_try_advisory_xact_lock")).toBeLessThan(claimSrc.indexOf("v_now := clock_timestamp()"));
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef`)).toEqual([]);
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private', 'operations') and has_function_privilege('anon', p.oid, 'execute')`)).toEqual([]);
  });

  it("operations_mail cannot read or write tables, call admin or owner helpers, or run the evaluator", async () => {
    for (const sql of [`select * from ${L}`, `update ${L} set status = 'accepted'`, "select * from operations.alert_state",
      "select private.operations_mail_target()", "select public.platform_operations_mailer()", "select private.platform_enable_operations_mailer()",
      "select private.evaluate_operations_alerts('manual')", "select * from vault.decrypted_secrets", "select platform.get_credential(null, null)"]) {
      expect((await worker(sql)).error, sql).toMatch(/permission denied/);
    }
    for (const sql of ["select operations.mailer_claim()", "select operations.mailer_heartbeat('ready')"]) {
      expect((await as(ADMIN, sql)).error, sql).toMatch(/permission denied/);
      for (const role of ["anon", "service_role", "billing_worker"]) expect((await raw(null, { role }, sql, role)).error).toMatch(/permission denied/);
    }
  });

  it("the migration sends nothing, schedules nothing and never touches pg_net, Vault, HTTP or extensions; it only reads the cron catalog", () => {
    const sql = readFileSync(join(root, "supabase/migrations/20261013203437_m5_operations_mailer.sql"), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/net\.|vault\.|http|extension|login password|with password|api\.resend\.com/i);
    expect([...sql.matchAll(/cron\.[a-z_]+/g)].map((m) => m[0]).sort()).toEqual(["cron.job", "cron.job", "cron.job", "cron.job_run_details", "cron.job_run_details"].sort());
    expect(sql).not.toMatch(/\b(insert|update|delete)\b[^;]*cron\./i);
    expect(sql).not.toMatch(/\bgrant\b[^;]*\bnet\b/i);
  });
});

// ---------------------------------------------------------------------------
describe("admin read and switch gates", () => {
  it("anon, non-admins, a revoked admin, spoofed metadata and no subject are refused; aal1 can read but not switch", async () => {
    await heartbeat("ready");
    const fns = ["platform_operations_mailer", "platform_enable_operations_mailer", "platform_disable_operations_mailer"];
    for (const fn of fns) for (const schema of ["public", "private"]) {
      const sql = `select ${schema}.${fn}()`;
      expect((await raw(null, { role: "anon" }, sql, "anon")).error, sql).toMatch(/permission denied/);
      for (const uid of [PLAIN, REVOKED]) for (const aal of ["aal1", "aal2"]) expect((await as(uid, sql, aal)).error, `${sql} ${uid}`).toBe("forbidden");
      expect((await raw(SPOOF, { role: "service_role", aal: "aal2", app_metadata: { platform_admin: true } }, sql)).error).toBe("forbidden");
      expect((await raw(null, { role: "authenticated", aal: "aal2" }, sql)).error).toBe("not_authenticated");
      if (fn !== "platform_operations_mailer") expect((await as(ADMIN, sql, "aal1")).error, sql).toBe("mfa_required");
    }
    expect((await read(ADMIN, "aal1")).enabled).toBe(false);
  });

  it("enable refuses without a fresh ready worker heartbeat; disable always works at aal2", async () => {
    const en = () => as(ADMIN, "select public.platform_enable_operations_mailer() as r");
    expect((await en()).error).toBe("mailer_not_ready");
    await heartbeat("not_configured");
    expect((await en()).error).toBe("mailer_not_ready");
    await heartbeat("ready");
    await h.q("update operations.mailer_heartbeat set last_checked_at = now() - interval '11 minutes', last_ready_at = now() - interval '11 minutes'");
    expect((await en()).error).toBe("mailer_not_ready");
    expect((await read()).worker.freshness).toBe("stale");
    await heartbeat("ready");
    expect((await en()).rows![0].r).toBe("enabled");
    expect((await read()).enabled).toBe(true);
    expect((await as(ADMIN, "select public.platform_disable_operations_mailer() as r")).rows![0].r).toBe("disabled");
    expect((await read()).enabled).toBe(false);
  });

  it("heartbeat accepts only its enum; key presence is the worker's own report", async () => {
    expect((await heartbeat("bogus")).error).toBe("invalid_status");
    await heartbeat("not_configured");
    expect((await read()).worker).toMatchObject({ status: "not_configured", key_present: false, freshness: "fresh" });
    expect((await read()).ready_to_enable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("outbox source and claim", () => {
  it("disabled: nothing is enqueued or leased even with an eligible alert", async () => {
    await appAlert("report_pdf");
    expect(await claim()).toEqual({ status: "disabled", items: [] });
    expect(await ledger()).toEqual([]);
  });

  it("only active, listed, freshly seen alerts whose source read ok recently are enqueued", async () => {
    await enable();
    await appAlert("report_pdf", { seen: "11 minutes" });          // not freshly seen
    await appAlert("report_csv", { active: false });              // cleared
    await billingAlert(true);                                     // unobserved connection
    expect((await claim()).items).toEqual([]);
    await sources("11 minutes");                                  // both sources stale
    await appAlert("analytics_pdf");
    expect((await claim()).items).toEqual([]);
    await sources("0 minutes", "unavailable");                    // app source failing
    expect((await claim()).items).toEqual([]);
    expect(await ledger()).toEqual([]);
    await sources();
    const c = await claim();
    expect(c.items).toHaveLength(1);
    expect((await ledger()).map((r) => [r.alert_key, r.status, r.attempts])).toEqual([["APP_FAILURES_REPORTED:analytics_pdf", "leased", 1]]);
  });

  it("each item is the fixed target with a frozen static body, lease token and idempotency key; the core validator accepts it", async () => {
    await enable();
    await billingAlert();
    const c = await claim();
    expect(validateClaim(c)).not.toBeNull();
    const [i] = c.items;
    const [row] = await ledger();
    expect(i).toEqual({ lease_token: row.lease_token, idempotency_key: `savour-alert-${row.id}`, from: "onboarding@resend.dev", to: "nonsou@gmail.com",
      subject: "SAVOUR development warning: Billing events waiting too long", text: row.body });
    expect(i.text).toContain("Warning: Billing events waiting too long (WEBHOOK_BACKLOG_STALE)");
    expect(i.text).toContain("Count when observed: 3");
    expect(i.text).toMatch(/Observed at: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    expect(i.text).toContain("not a confirmed incident");
    expect(i.text).toContain("does not mean delivered");
    expect(i.text).not.toContain(C1); // no connection id, label, actor or vendor data
    expect(i.text).not.toMatch(/MARKER|@m5m|bachs|sk_/i);
  });

  it("at most 3 leases per run and 5 automatic attempts per UTC day", async () => {
    await enable();
    for (const op of OPS) await appAlert(op);
    expect((await claim()).items).toHaveLength(3);
    expect((await claim()).items).toHaveLength(2);
    expect((await claim()).items).toHaveLength(0);
    expect(await h.q<{ attempts: number }>("select attempts from operations.mail_attempt_days")).toEqual([{ attempts: 5 }]);
    const l = await ledger();
    expect(l.filter((r) => r.status === "leased")).toHaveLength(5);
    expect(l.filter((r) => r.status === "pending")).toHaveLength(1);
    expect((await read()).today).toMatchObject({ automatic_attempts: 5, automatic_limit: 5, manual_limit: 1 });
  });

  it("one ledger row per episode whatever the outcome; no email on clear; a new episode is a new row", async () => {
    await enable();
    await appAlert("report_pdf");
    const [i] = (await claim()).items;
    expect(await finishOk(i.lease_token, "rejected")).toBe("recorded");
    expect((await claim()).items).toEqual([]);
    await appAlert("report_pdf", { active: false });
    expect((await claim()).items).toEqual([]);
    await appAlert("report_pdf", { episode: 2 });
    expect((await claim()).items).toHaveLength(1);
    expect((await ledger()).map((r) => [r.episode, r.status])).toEqual([[1, "rejected"], [2, "leased"]]);
  });

  it("an alert cleared before its first dispatch is cancelled without sending; a merely stale source holds it", async () => {
    await enable();
    await h.q("insert into operations.mail_attempt_days values ((now() at time zone 'UTC')::date, 5)"); // quota full: enqueue only
    await appAlert("report_pdf");
    await appAlert("report_csv");
    expect((await claim()).items).toEqual([]);
    expect((await ledger()).map((r) => r.status)).toEqual(["pending", "pending"]);
    await appAlert("report_pdf", { active: false });
    await claim();
    expect((await ledger()).map((r) => [r.alert_key.split(":")[1], r.status, r.attempts]).sort()).toEqual([["report_csv", "pending", 0], ["report_pdf", "cancelled", 0]]);
    await h.q("delete from operations.mail_attempt_days");
    await sources("11 minutes");
    expect((await claim()).items).toEqual([]); // held, not sent
    await sources();
    expect((await claim()).items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("finish and leases", () => {
  it("validates the outcome enum and provider id; a wrong, replayed or finished lease changes nothing", async () => {
    await enable();
    await appAlert("report_pdf");
    const [i] = (await claim()).items;
    const before = await ledger();
    for (const o of ["delivered", "ACCEPTED", "leased", null]) expect((await finish(i.lease_token, o)).error, String(o)).toBe("invalid_outcome");
    expect((await finish(i.lease_token, "accepted")).error).toBe("invalid_outcome");
    expect((await finish(i.lease_token, "rejected", MSG)).error).toBe("invalid_outcome");
    expect((await finish("not-a-uuid", "rejected")).error).toMatch(/invalid input syntax for type uuid/);
    expect(await finishOk("eeeeeeee-5a00-4000-8000-0000000000ff", "rejected")).toBe("stale");
    expect(await ledger()).toEqual(before);
    expect(await finishOk(i.lease_token, "accepted", MSG)).toBe("recorded");
    expect(await finishOk(i.lease_token, "rejected")).toBe("stale");
    const after = await ledger();
    expect(after[0]).toMatchObject({ status: "accepted", lease_token: null });
    await expect(h.q(`update ${L} set status = 'unknown'`)).rejects.toThrow(/mail_ledger_terminal/);
    const v = await read();
    expect(validateMailer(v)).not.toBeNull();
    expect(v.recent[0].status).toBe("accepted");
    expect(v.last_accepted_at).not.toBeNull();
    expect(JSON.stringify(v)).not.toMatch(/deliver/i);
  });

  it("a stale lease becomes unknown, its token is void, and the retry reuses the same body and idempotency key under a new lease", async () => {
    await enable();
    await appAlert("report_pdf");
    const [first] = (await claim()).items;
    await h.q(`update ${L} set leased_at = leased_at - interval '16 minutes'`);
    expect(await finishOk(first.lease_token, "accepted", MSG)).toBe("stale");
    expect((await claim()).items).toEqual([]); // marked unknown now; not retried within 4 minutes
    expect((await ledger())[0]).toMatchObject({ status: "unknown", lease_token: null, attempts: 1 });
    await h.q(`update ${L} set finished_at = finished_at - interval '5 minutes'`);
    const [second] = (await claim()).items;
    expect(second.lease_token).not.toBe(first.lease_token);
    expect([second.idempotency_key, second.subject, second.text]).toEqual([first.idempotency_key, first.subject, first.text]);
    expect(await finishOk(first.lease_token, "accepted", MSG)).toBe("stale");
    expect(await finishOk(second.lease_token, "unknown")).toBe("recorded");
    expect((await ledger())[0]).toMatchObject({ status: "unknown", attempts: 2 });
  });

  it("an uncertain retry resolves even after the warning cleared (its body says observed at, not current)", async () => {
    await enable();
    await appAlert("report_pdf");
    const [i] = (await claim()).items;
    await finishOk(i.lease_token, "unknown");
    await appAlert("report_pdf", { active: false });
    await h.q(`update ${L} set finished_at = finished_at - interval '5 minutes'`);
    const [retry] = (await claim()).items;
    expect(retry.text).toBe(i.text);
    expect(retry.text).toContain("It may no longer be current");
  });

  it("subject, body, key and episode are immutable for every writer", async () => {
    await enable();
    await appAlert("report_pdf");
    await claim();
    for (const set of ["subject = 'x'", "body = 'x'", "alert_key = 'x'", "episode = 9", "code = 'WEBHOOK_BACKLOG_STALE'"]) {
      await expect(h.q(`update ${L} set ${set}`), set).rejects.toThrow(/mail_ledger_immutable/);
    }
  });

  it("no attempt after 23 hours from the first dispatch or beyond 5 attempts; old pending rows expire to review", async () => {
    await enable();
    for (const op of ["report_pdf", "report_csv"]) await appAlert(op);
    const items = (await claim()).items;
    for (const i of items) await finishOk(i.lease_token, "unknown");
    await backdate(`update ${L} set first_dispatched_at = first_dispatched_at - interval '24 hours', created_at = created_at - interval '24 hours',
      finished_at = finished_at - interval '5 minutes' where alert_key like '%report_pdf'`);
    await h.q(`update ${L} set attempts = 5, finished_at = finished_at - interval '5 minutes' where alert_key like '%report_csv'`);
    expect((await claim()).items).toEqual([]);
    expect((await ledger()).map((r) => r.status)).toEqual(["review", "review"]);
    await h.q(`delete from ${L}`);
    await h.q("insert into operations.mail_attempt_days values ((now() at time zone 'UTC')::date, 5) on conflict (utc_day) do update set attempts = 5");
    await appAlert("analytics_pdf");
    await claim();
    await backdate(`update ${L} set created_at = created_at - interval '24 hours'`);
    await h.q("delete from operations.mail_attempt_days");
    expect((await claim()).items).toEqual([]);
    expect((await ledger())[0].status).toBe("review");
  });

  it("a finish of unknown on the fifth attempt goes straight to review", async () => {
    await enable();
    await appAlert("report_pdf");
    const [i] = (await claim()).items;
    await h.q(`update ${L} set attempts = 5`);
    expect(await finishOk(i.lease_token, "unknown")).toBe("recorded");
    expect((await ledger())[0].status).toBe("review");
  });
});

// ---------------------------------------------------------------------------
describe("read and cleanup bounds", () => {
  it("the read is sanitized and bounded: no body, subject, lease, key or alert slot; at most 14 recent rows", async () => {
    await enable();
    const seed = (n: number) => h.q(`insert into ${L} (alert_key, episode, code, subject, body, status, created_at, attempts, first_dispatched_at, finished_at)
      select 'APP_FAILURES_REPORTED:report_pdf', g, 'APP_FAILURES_REPORTED', 'MARKER_SUBJECT', 'MARKER_BODY', 'rejected', now() - make_interval(hours => g), 1,
        now() - make_interval(hours => g), now() - make_interval(hours => g) from generate_series(1, $1) g`, [n]);
    await seed(20);
    const v = await read();
    expect(validateMailer(v)).not.toBeNull();
    expect(v.recent).toHaveLength(14);
    expect(Object.keys(v.recent[0]).sort()).toEqual(["attempts", "code", "created_at", "finished_at", "first_dispatched_at", "status"]);
    expect(JSON.stringify(v)).not.toMatch(/MARKER|savour-alert|report_pdf|lease_token|nonsou|resend/);
  });

  it("prunes only terminal rows older than 90 days (never the current episode) and day counters older than 90 days", async () => {
    await enable();
    const old = (key: string, status: string, ep = 1) => h.q(`insert into ${L} (alert_key, episode, code, subject, body, status, created_at, attempts,
      first_dispatched_at, finished_at) values ($1, $3, 'APP_FAILURES_REPORTED', 's', 'b', $2, now() - interval '100 days',
      case when $2 = 'cancelled' then 0 else 1 end, case when $2 = 'cancelled' then null else now() - interval '100 days' end, now() - interval '100 days')`,
      [key, status, ep]);
    for (const [k, s] of [["k:a", "accepted"], ["k:r", "rejected"], ["k:v", "review"], ["k:c", "cancelled"]]) {
      if (s === "accepted") await h.q(`insert into ${L} (alert_key, episode, code, subject, body, status, created_at, attempts, first_dispatched_at, finished_at,
        provider_message_id) values ($1, 1, 'APP_FAILURES_REPORTED', 's', 'b', 'accepted', now() - interval '100 days', 1, now() - interval '100 days',
        now() - interval '100 days', $2)`, [k, MSG]);
      else await old(k, s);
    }
    await appAlert("report_pdf", { seen: "20 minutes" }); // current episode 1, not eligible now
    await old("APP_FAILURES_REPORTED:report_pdf", "rejected");
    await h.q(`insert into operations.mail_attempt_days values ((now() at time zone 'UTC')::date - 91, 5), ((now() at time zone 'UTC')::date - 89, 2)`);
    await claim();
    expect((await ledger()).map((r) => r.alert_key)).toEqual(["APP_FAILURES_REPORTED:report_pdf"]);
    expect((await h.q<{ n: number }>("select ((now() at time zone 'UTC')::date - utc_day) as n from operations.mail_attempt_days")).map((r) => r.n)).toEqual([89]);
  });
});

// ---------------------------------------------------------------------------
/** Runs SQL as an admin inside one transaction that is always rolled back (for catalog removal). */
const adminInTx = (setup: string, sql: string, aal = "aal2") => h.serial(async () => {
  await h.pg.exec("begin");
  try {
    await h.pg.exec(setup);
    await h.pg.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN, role: "authenticated", aal })]);
    await h.pg.exec("set local role authenticated");
    try { return { r: (await h.pg.query<{ r: unknown }>(sql)).rows[0].r, error: null as string | null }; }
    catch (e) { return { r: null, error: (e as Error).message }; }
  } finally { await h.pg.exec("rollback"); }
});
const run = (job: number, status: string, ago: string) =>
  h.q("insert into cron.job_run_details (jobid, status, start_time) values ($1, $2, now() - $3::interval)", [job, status, ago]);
const enableErr = async () => (await as(ADMIN, "select public.platform_enable_operations_mailer() as r")).error;

describe("scheduler probe (named sixth job only) and enable gate", () => {
  it("reads the named job and its latest run only; other jobs' runs are ignored; status is a static enum", async () => {
    await run(6, "succeeded", "12 minutes");
    await run(6, "failed", "7 minutes");
    await run(1, "succeeded", "1 minute"); // a billing job: never read
    const v = await read();
    expect(validateMailer(v)).not.toBeNull();
    expect(v.scheduler.job).toBe("active");
    expect(v.scheduler.last_scheduled_status).toBe("failed");
    expect(Date.parse(v.scheduler.last_scheduled_start_at!)).toBeLessThan(Date.now() - 6 * 60_000);
    await run(6, "MARKER weird", "1 minute");
    expect((await read()).scheduler.last_scheduled_status).toBe("other");
  });

  it("a missing catalog is not_measured (never healthy) and enable refuses", async () => {
    await heartbeat("ready");
    const r = await adminInTx("alter schema cron rename to cron_hidden", "select public.platform_operations_mailer() as r", "aal1");
    const v = r.r as MailerView;
    expect(v.scheduler).toEqual({ job: "not_measured", last_scheduled_start_at: null, last_scheduled_status: null });
    expect(v.ready_to_enable).toBe(false);
    expect(validateMailer(v)).not.toBeNull();
    expect((await adminInTx("alter schema cron rename to cron_hidden", "select public.platform_enable_operations_mailer() as r")).error).toBe("mailer_not_scheduled");
  });

  it("an absent, paused or duplicated job refuses enable even with a fresh ready worker; an active one allows it", async () => {
    await heartbeat("ready");
    await h.q("delete from cron.job where jobid = 6");
    expect(await enableErr()).toBe("mailer_not_scheduled");
    expect((await read()).scheduler.job).toBe("absent");
    await h.q("insert into cron.job values (6, 'savour-operations-mailer', false)");
    expect(await enableErr()).toBe("mailer_not_scheduled");
    expect((await read()).scheduler.job).toBe("inactive");
    await h.q("insert into cron.job values (7, 'savour-operations-mailer', true)");
    expect(await enableErr()).toBe("mailer_not_scheduled");
    expect((await read()).scheduler.job).toBe("not_measured");
    await exec("delete from cron.job where jobid = 7; update cron.job set active = true where jobid = 6");
    expect(await enableErr()).toBeNull();
    expect((await h.q<{ enabled: boolean }>("select enabled from operations.mailer_config"))[0].enabled).toBe(true);
  });

  it("a manual worker heartbeat cannot mask a stale schedule: the scheduled start comes only from the catalog", async () => {
    await run(6, "succeeded", "2 hours");
    const before = (await read()).scheduler;
    await heartbeat("ready"); // e.g. the worker invoked by hand
    const v = await read();
    expect(v.worker.freshness).toBe("fresh");
    expect(v.scheduler).toEqual(before);
    expect(Date.parse(v.scheduler.last_scheduled_start_at!)).toBeLessThan(Date.now() - 100 * 60_000);
    expect(validateMailer(v)).not.toBeNull();
  });
});

describe("heartbeat ordering and future times", () => {
  it("locks the singleton before reading the clock; successive calls with different statuses all succeed, newest last", async () => {
    const src = (await h.q<{ s: string }>("select prosrc as s from pg_proc where proname = 'mailer_heartbeat'"))[0].s;
    expect(src.indexOf("for update")).toBeGreaterThan(-1);
    expect(src.indexOf("for update")).toBeLessThan(src.indexOf("v_now := clock_timestamp()"));
    expect(src.slice(0, src.search(/\bbegin\b/))).not.toMatch(/clock_timestamp/);
    const r = await worker("select operations.mailer_heartbeat('ready') as a, operations.mailer_heartbeat('not_configured') as r");
    expect(r.error).toBeNull();
    const hb = (await h.q<{ status: string; c: Date; ready: Date }>("select status, last_checked_at as c, last_ready_at as ready from operations.mailer_heartbeat"))[0];
    expect(hb.status).toBe("not_configured");
    expect(hb.c.getTime()).toBeGreaterThanOrEqual(hb.ready.getTime());
    // Real concurrent transactions are not possible on PGlite's single connection; the root verifies them later.
  });

  it("a future heartbeat is never fresh and cannot enable; a future alert sighting or source success is never eligible", async () => {
    await h.q(`update operations.mailer_heartbeat set status = 'ready', last_checked_at = now() + interval '1 hour', last_ready_at = now() + interval '1 hour'`);
    expect(await enableErr()).toBe("mailer_not_ready");
    const v = await read();
    expect([v.worker.freshness, v.ready_to_enable]).toEqual(["stale", false]);
    expect(validateMailer(v)).toBeNull(); // TypeScript fails closed on a future time
    await enable();
    await appAlert("report_pdf", { seen: "-5 minutes" });
    expect((await claim()).items).toEqual([]);
    await h.q("delete from operations.alert_state");
    await appAlert("report_csv");
    await sources("-5 minutes");
    expect((await claim()).items).toEqual([]);
    expect(await ledger()).toEqual([]);
  });
});

describe("enqueue bound and budgets", () => {
  it("enqueues at most 20 per run, high severity first, then oldest change, then key; leases stay at 3", async () => {
    await enable();
    await h.q(`insert into operations.alert_state (alert_key, source, code, connection_id, severity, active, episode_count, first_seen_at, last_seen_at,
      last_changed_at, observed_count, observed_oldest_at)
      select 'WEBHOOK_BACKLOG_STALE:' || c, 'billing_authoritative', 'WEBHOOK_BACKLOG_STALE', c, 'high', true, 1, now() - interval '3 hours',
        now() - interval '1 minute', now() - make_interval(mins => g), 2, now() - interval '3 hours'
      from (select g, gen_random_uuid() as c from generate_series(1, 22) g) x`);
    await appAlert("report_pdf");
    await appAlert("report_csv");
    const first = await claim();
    expect(first.items).toHaveLength(3);
    let rows = await h.q<{ code: string; n: number }>(`select code, count(*)::int as n from ${L} group by code order by code`);
    expect(rows).toEqual([{ code: "WEBHOOK_BACKLOG_STALE", n: 20 }]);
    // The 20 queued are the oldest-changed high rows.
    const missing = await h.q<{ m: number }>(`select extract(epoch from now() - a.last_changed_at)::int / 60 as m from operations.alert_state a
      where a.code = 'WEBHOOK_BACKLOG_STALE' and not exists (select 1 from ${L} l where l.alert_key = a.alert_key) order by m`);
    expect(missing.map((x) => x.m)).toEqual([1, 2]);
    expect((await claim()).items).toHaveLength(2); // daily budget: 3 + 2 = 5
    rows = await h.q(`select code, count(*)::int as n from ${L} group by code order by code`);
    expect(rows).toEqual([{ code: "APP_FAILURES_REPORTED", n: 2 }, { code: "WEBHOOK_BACKLOG_STALE", n: 22 }]);
  });

  it("a sixth eligible row on one UTC day stays pending, and leases on the next day", async () => {
    await enable();
    for (const op of OPS) await appAlert(op);
    await claim(); await claim();
    expect((await ledger()).filter((r) => r.status === "pending")).toHaveLength(1);
    expect((await claim()).items).toEqual([]);
    await h.q("update operations.mail_attempt_days set utc_day = utc_day - 1"); // the day rolls over
    expect((await claim()).items).toHaveLength(1);
  });

  it("a pending row whose episode advances is cancelled with attempts 0; a lease is untouched at 14 minutes", async () => {
    await enable();
    await h.q("insert into operations.mail_attempt_days values ((now() at time zone 'UTC')::date, 5)");
    await appAlert("report_pdf");
    await claim();
    await appAlert("report_pdf", { episode: 2 });
    await claim();
    expect((await ledger()).map((r) => [r.episode, r.status, r.attempts])).toEqual([[1, "cancelled", 0], [2, "pending", 0]]);
    await h.q("delete from operations.mail_attempt_days");
    const [i] = (await claim()).items;
    await h.q(`update ${L} set leased_at = leased_at - interval '14 minutes' where status = 'leased'`);
    const before = await ledger();
    await claim();
    expect(await ledger()).toEqual(before);
    expect(await finishOk(i.lease_token, "rejected")).toBe("recorded");
  });

  it("budgets are fixed in SQL: 5 automatic plus 1 manual (separate) per UTC day", async () => {
    const v = await read();
    expect(v.today).toMatchObject({ automatic_limit: 5, manual_limit: 1 });
    expect((await h.q<{ c: string }>(`select pg_get_constraintdef(oid) as c from pg_constraint where conrelid = 'operations.mail_attempt_days'::regclass and contype = 'c'`))[0].c)
      .toMatch(/attempts >= 1\) AND \(attempts <= 5/);
  });
});

describe("switch audit and replaced verification text", () => {
  it("records the bound admin as changed_by on enable and disable; the switches take no arguments", async () => {
    await enable();
    expect(await h.q("select enabled, changed_by from operations.mailer_config")).toEqual([{ enabled: true, changed_by: ADMIN }]);
    expect((await as(ADMIN2, "select public.platform_disable_operations_mailer() as r")).error).toBeNull();
    expect(await h.q("select enabled, changed_by from operations.mailer_config")).toEqual([{ enabled: false, changed_by: ADMIN2 }]);
    const args = await h.q<{ f: string; n: number }>(`select n.nspname || '.' || p.proname as f, p.pronargs as n from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where p.proname in ('platform_enable_operations_mailer', 'platform_disable_operations_mailer') order by 1`);
    expect(args.every((a) => a.n === 0)).toBe(true);
    const src = (await h.q<{ s: string }>("select string_agg(prosrc, ' ') as s from pg_proc where proname in ('platform_enable_operations_mailer', 'platform_disable_operations_mailer') and prosecdef"))[0].s;
    expect(src.match(/changed_by = v_actor/g)).toHaveLength(2);
    expect(JSON.stringify(await read())).not.toContain(ADMIN2); // the read never exposes the actor
  });

  it("the replaced verification message matches the TypeScript constant, no longer asserts automatic status, and stays owner-only", async () => {
    const m = (await h.q<{ m: Record<string, string> }>("select private.alert_email_verification_message() as m"))[0].m;
    expect(m.text).toBe(VERIFICATION_TEXT);
    expect(m.text).not.toMatch(/not connected/i);
    expect(m.text).toContain("Automatic email status is shown on the platform alerts page");
    for (const r of ROLES) expect((await h.q<{ ok: boolean }>("select has_function_privilege($1, 'private.alert_email_verification_message()', 'execute') as ok", [r]))[0].ok, r).toBe(false);
  });
});
