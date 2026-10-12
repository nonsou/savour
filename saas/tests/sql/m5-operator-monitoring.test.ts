// M5 OPS01: the read-only billing operations snapshot on embedded PostgreSQL with every migration applied.
// Synthetic disposable fixtures only (made-up IDs, markers and keys); no provider transport is called.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assess, validateSnapshot, type Snapshot } from "@/lib/operations";
import { harness } from "./m4-harness";

type H = Awaited<ReturnType<typeof harness>>;
let h: H;
const ADMIN = "eeeeeeee-5000-4000-8000-000000000001";
const ADMIN2 = "eeeeeeee-5000-4000-8000-000000000002";
const REVOKED = "eeeeeeee-5000-4000-8000-000000000003";
const PLAIN = "eeeeeeee-5000-4000-8000-000000000004";
const OWNER = "eeeeeeee-5000-4000-8000-000000000005";
const SPOOF = "eeeeeeee-5000-4000-8000-000000000006";
const RUN = (n: number) => `eeeeeeee-5100-4000-8000-${String(n).padStart(12, "0")}`;
const TIE_LOW = "00000000-0000-4000-8000-000000000001";
const TIE_HIGH = "ffffffff-0000-4000-8000-000000000001";
let E1: string; // enabled (real admin path)
let D1: string; // disabled, credential stored, no pinned subscription
let N1: string; // draft, no credential
let N2: string; // disabled, no credential

const snap = async (uid = ADMIN, aal = "aal1") => {
  const r = await h.userRpc(uid, aal)("platform_operations_snapshot", {});
  if (r.error) throw new Error(r.error.message);
  return r.data as Snapshot;
};
const conn = (s: Snapshot, id: string) => s.connections.find((c) => c.id === id)!;
const at = async (sql: string) => Date.parse((await h.q<{ t: string }>(`select to_char((${sql}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`))[0].t);
const raw = async (uid: string | null, claims: Record<string, unknown>, sql: string, role = "authenticated") => h.serial(async () => {
  await h.pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(uid ? { sub: uid, ...claims } : claims)]);
  await h.pg.exec(`set role ${role}`);
  try { return { rows: (await h.pg.query(sql)).rows, error: null as string | null }; }
  catch (e) { return { rows: null, error: (e as Error).message }; }
  finally { await h.pg.exec("reset role"); }
});

async function inbox(conn: string, id: string, status: string, received: string, extra: Record<string, string> = {}) {
  const cols = { status: `'${status}'`, received_at: `now() - interval '${received}'`, next_attempt_at: "now() + interval '1 hour'", ...extra };
  await h.q(`insert into billing.webhook_inbox (connection_id, event_id, event_type, provider_created_at, organization_id, raw_body, body_sha256,
      signature_timestamp, ${Object.keys(cols).join(", ")})
    values ($1, $2, 'MARKER_TYPE', now(), 'MARKER_ORG_ID', convert_to('{"marker":"MARKER_BODY"}', 'UTF8'), repeat('a', 64), 1, ${Object.values(cols).join(", ")})`,
  [conn, id]);
}
async function discovered(conn: string, id: string, state: string, firstSeen: string, extra: Record<string, string> = {}) {
  const cols = { state: `'${state}'`, first_seen_at: `now() - interval '${firstSeen}'`, next_attempt_at: "now() + interval '1 hour'", ...extra };
  await h.q(`insert into billing.discovered_payments (connection_id, provider_payment_id, list_status, outcome, last_error_code, ${Object.keys(cols).join(", ")})
    values ($1, $2, 'MARKER_LS', 'MARKER_OUT', 'MARKER_ERR', ${Object.values(cols).join(", ")})`, [conn, id]);
}
async function run(id: string, conn: string | null, mode: string, trigger: string, started: string, finished: string | null, failed = 0, error: string | null = null) {
  await h.q(`insert into billing.worker_runs (id, connection_id, mode, trigger, worker, started_at, finished_at, failed, error_code)
    values ($1, $2, $3, $4, 'MARKER_WORKER', now() - $5::interval, now() - $6::interval, $7, $8)`, [id, conn, mode, trigger, started, finished, failed, error]);
}
async function review(conn: string | null, key: string, created: string, resolved = false) {
  await h.q(`insert into billing.review_queue (connection_id, kind, dedupe_key, provider_refs, detail, source_event_id, created_at, resolved_at, resolution_note)
    values ($1, 'marker_kind', $2, '{"ref":"MARKER_REF"}', '{"d":"MARKER_DETAIL"}', 'evt_MARKER_SRC', now() - $3::interval,
      case when $4 then now() else null end, case when $4 then 'MARKER_NOTE' end)`, [conn, key, created, resolved]);
}

async function tableHashes() {
  const tables = await h.q<{ s: string; t: string }>(
    "select schemaname as s, tablename as t from pg_tables where schemaname in ('billing', 'platform', 'public', 'vault') order by 1, 2");
  const out: Record<string, string> = {};
  for (const { s, t } of tables) {
    out[`${s}.${t}`] = (await h.q<{ x: string }>(`select md5(coalesce(string_agg(r::text, '|' order by r::text), '')) as x from ${s}.${t} r`))[0].x;
  }
  return out;
}

beforeAll(async () => {
  h = await harness();
  E1 = await h.connection(ADMIN, "MARKER_LABEL_E1", "sk_sandbox_MARKERKEY0000000000001", "MARKERORG1");
  const mk = async (label: string, status: string, credential: boolean) => (await h.q<{ id: string }>(
    `insert into platform.provider_connections (provider_code, label, status, credential_secret_id, credential_fingerprint, created_by)
     values ('bachs', $1, $2, case when $3 then gen_random_uuid() end, case when $3 then 'abcdef123456' end, $4) returning id`,
    [label, status, credential, ADMIN]))[0].id;
  D1 = await mk("MARKER_LABEL_D1", "disabled", true);
  N1 = await mk("MARKER_LABEL_N1", "draft", false);
  N2 = await mk("MARKER_LABEL_N2", "disabled", false);
  for (const [u, note, revoked] of [[ADMIN2, "MARKER_ADMIN_NOTE", false], [REVOKED, "revoked fixture", true]] as const) {
    await h.q("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [u, `${u}@marker-email.test`]);
    await h.q("insert into platform.admins (user_id, note, revoked_at) values ($1, $2, case when $3 then now() end)", [u, note, revoked]);
  }
  for (const u of [PLAIN, OWNER]) await h.q("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [u, `${u}@m5.test`]);
  await h.q("insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, 'spoof@m5.test', now(), $2)",
    [SPOOF, JSON.stringify({ platform_admin: true, role: "admin" })]);
  await h.userRpc(OWNER)("create_workspace", { p_name: "M5 owner fixture", p_country: "Nigeria", p_timezone: "Africa/Lagos", p_display_name: "Owner" });

  // Webhook inbox (E1).
  await inbox(E1, "evt_MARKER_p1", "pending", "20 minutes");
  await inbox(E1, "evt_p2", "pending", "1 minute");
  await inbox(E1, "evt_pr1", "processing", "30 minutes", { claim_token: "gen_random_uuid()", lease_until: "now() - interval '1 minute'", claimed_by: "'MARKER_WORKER'" });
  await inbox(E1, "evt_pr2", "processing", "2 minutes", { claim_token: "gen_random_uuid()", lease_until: "now() + interval '5 minutes'" });
  await inbox(E1, "evt_f1", "failed", "5 minutes", { last_error_code: "'MARKER_ERR'" });
  await inbox(E1, "evt_d1", "dead", "3 days", { outcome: "'MARKER_OUT'" });
  await inbox(E1, "evt_q1", "quarantined", "3 days", { quarantine_reason: "'MARKER_QR'" });
  await inbox(E1, "evt_done", "done", "2 days");
  // Discovery queue (E1).
  await discovered(E1, "MARKERPAY1", "pending", "3 minutes");
  await discovered(E1, "pay_retry", "retry", "40 minutes");
  await discovered(E1, "pay_exp", "processing", "10 minutes", { claim_token: "gen_random_uuid()", lease_until: "now() - interval '1 second'" });
  await discovered(E1, "pay_live", "processing", "1 minute", { claim_token: "gen_random_uuid()", lease_until: "now() + interval '10 minutes'" });
  await discovered(E1, "pay_abs", "absorbed", "3 days");
  await discovered(E1, "pay_dead", "dead", "3 days");
  await discovered(E1, "pay_unrel", "unrelated", "3 days");
  // Reviews: two open on E1, one resolved on E1, one open and one resolved without a connection.
  await review(E1, "MARKER_DEDUPE_1", "1 hour");
  await review(E1, "k2", "10 minutes");
  await review(E1, "k3", "5 days", true);
  await review(null, "k4", "2 hours");
  await review(null, "k5", "3 days", true);
  // Collisions: one recent, one outside 24 hours.
  await h.q(`insert into billing.inbox_collisions (connection_id, event_id, body_sha256, received_at) values
    ($1, 'evt_MARKER_COLL', repeat('b', 64), now() - interval '1 hour'), ($1, 'evt_old', repeat('c', 64), now() - interval '25 hours')`, [E1]);
  // Runs. E1 process: older success, newer failure, newer unfinished, an even newer manual success, a stuck run.
  await run(RUN(1), E1, "process", "cron", "11 minutes", "10 minutes");
  await run(RUN(2), E1, "process", "cron", "4 minutes", "3 minutes", 1, "MARKER_RUN_ERR");
  await run(RUN(3), E1, "process", "cron", "1 minute", null);
  await run(RUN(4), E1, "process", "manual", "40 seconds", "30 seconds");
  await run(RUN(5), E1, "process", "cron", "8 minutes", null);
  await run(RUN(6), E1, "process", "cron", "2 days", "2 days", 0, "MARKER_RUN_ERR");
  // E1 discover: latest is partial and no success ever. E1 reconcile: only a manual success.
  await run(RUN(7), E1, "discover", "cron", "61 minutes", "1 hour", 2, null);
  await run(RUN(8), E1, "reconcile", "manual", "5 minutes", "4 minutes");
  // D1 process: two cron runs with the same finished_at; the higher id (failure) wins the tie.
  await h.q(`insert into billing.worker_runs (id, connection_id, mode, trigger, worker, started_at, finished_at, error_code) values
    ($1, $3, 'process', 'cron', 'w', now() - interval '2 minutes', now() - interval '1 minute', null),
    ($2, $3, 'process', 'cron', 'w', now() - interval '2 minutes', now() - interval '1 minute', 'boom')`, [TIE_LOW, TIE_HIGH, D1]);
  // N1 (not required): an old successful run must never make it look measured.
  await run(RUN(9), N1, "process", "cron", "3 days", "3 days");
  // Housekeeping has no connection and is not part of the per-connection snapshot.
  await run(RUN(10), null, "housekeeping", "cron", "1 minute", "30 seconds");
}, 180_000);
afterAll(async () => { await h?.close(); });

describe("privileges and entry point", () => {
  const PUB = "public.platform_operations_snapshot()";
  const GUARD = "private.platform_operations_snapshot()";
  const DATA = "private.operations_snapshot()";
  const ENTRIES = [`select ${PUB}`, `select ${GUARD}`];

  it("established pattern: public invoker wrapper, guarded private definer, owner-only invoker data helper", async () => {
    const rows = await h.q<{ f: string; role: string; ok: boolean }>(`
      select f, r as role, has_function_privilege(r, f, 'execute') as ok
      from unnest(array['${PUB}', '${GUARD}', '${DATA}']) f,
           unnest(array['public', 'anon', 'authenticated', 'service_role', 'billing_intake', 'billing_gateway', 'billing_worker']) r`);
    const grid = Object.fromEntries(rows.map((r) => [`${r.f} ${r.role}`, r.ok]));
    for (const f of [PUB, GUARD, DATA]) {
      for (const r of ["public", "anon", "service_role", "billing_intake", "billing_gateway", "billing_worker"]) expect(grid[`${f} ${r}`], `${f} ${r}`).toBe(false);
    }
    expect([grid[`${PUB} authenticated`], grid[`${GUARD} authenticated`], grid[`${DATA} authenticated`]]).toEqual([true, true, false]);
    const meta = await h.q<{ name: string; secdef: boolean; vol: string; nargs: number; cfg: string[] }>(`
      select n.nspname || '.' || p.proname as name, p.prosecdef as secdef, p.provolatile as vol, p.pronargs as nargs, p.proconfig as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname, p.proname) in (('public', 'platform_operations_snapshot'), ('private', 'platform_operations_snapshot'),
        ('private', 'operations_snapshot')) order by 1`);
    expect(meta.map((m) => [m.name, m.secdef, m.vol, m.nargs])).toEqual([
      ["private.operations_snapshot", false, "s", 0], ["private.platform_operations_snapshot", true, "s", 0],
      ["public.platform_operations_snapshot", false, "s", 0]]);
    for (const m of meta) expect(m.cfg).toContain('search_path=""');
    expect(meta[1].cfg.slice().sort()).toEqual(['lock_timeout=2s', 'search_path=""', "statement_timeout=5s", "TimeZone=UTC"].sort());
    // The project-wide invariants of migration.test.ts: no definer in public, safe private definers, nothing for anon.
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef`)).toEqual([]);
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef and not coalesce('search_path=""' = any (p.proconfig), false)`)).toEqual([]);
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')`)).toEqual([]);
    // No schema or table grant was broadened: authenticated still reads no billing/platform table.
    expect(await h.q(`select schemaname, tablename from pg_tables where schemaname in ('billing', 'platform')
      and has_table_privilege('authenticated', format('%I.%I', schemaname, tablename), 'select')`)).toEqual([]);
    // The wrapper only calls the guard; the guard checks the actor before it touches the data helper.
    const src = Object.fromEntries((await h.q<{ n: string; s: string }>(`select n.nspname as n, p.prosrc as s from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace where p.proname = 'platform_operations_snapshot'`)).map((r) => [r.n, r.s]));
    expect(src.public.trim()).toBe("select private.platform_operations_snapshot()");
    expect(src.private.indexOf("private.platform_actor(false)")).toBeGreaterThan(-1);
    expect(src.private.indexOf("private.platform_actor(false)")).toBeLessThan(src.private.indexOf("private.operations_snapshot()"));
  });

  it("denies anon, a plain user, a workspace owner, a revoked admin, spoofed metadata and missing subject, through the wrapper and the guard directly", async () => {
    for (const sql of ENTRIES) {
      expect((await raw(null, { role: "anon" }, sql, "anon")).error, sql).toMatch(/permission denied/);
      for (const uid of [PLAIN, OWNER, REVOKED]) {
        for (const aal of ["aal1", "aal2"]) expect((await raw(uid, { role: "authenticated", aal }, sql)).error, `${sql} ${uid} ${aal}`).toBe("forbidden");
      }
      const spoofed = await raw(SPOOF, { role: "service_role", aal: "aal2", app_metadata: { platform_admin: true, role: "platform_admin" },
        user_metadata: { platform_admin: true }, is_platform_admin: true }, sql);
      expect(spoofed.error, sql).toBe("forbidden");
      expect((await raw(null, { role: "authenticated", aal: "aal2" }, sql)).error, sql).toBe("not_authenticated");
    }
    expect((await h.userRpc(PLAIN)("platform_operations_snapshot", {})).error?.message).toBe("forbidden");
    // A spoofed sub of a real admin is a different matter (a forged JWT); PostgREST verifies the signature before claims reach SQL.
  });

  it("an enrolled admin reads it at aal1 and aal2 through the wrapper or the guard; the data helper stays denied even for that admin", async () => {
    for (const [uid, aal] of [[ADMIN, "aal1"], [ADMIN, "aal2"], [ADMIN2, "aal1"]]) expect(validateSnapshot(await snap(uid, aal)).ok).toBe(true);
    for (const aal of ["aal1", "aal2"]) {
      const direct = await raw(ADMIN, { role: "authenticated", aal }, `select ${GUARD} as r`);
      expect(direct.error).toBeNull();
      expect(validateSnapshot((direct.rows![0] as { r: unknown }).r).ok).toBe(true);
    }
    expect((await raw(ADMIN, { role: "authenticated", aal: "aal2" }, `select ${DATA}`)).error).toMatch(/permission denied/);
    expect((await raw(ADMIN, { role: "authenticated", aal: "aal2" }, "select billing.worker_connections()")).error).toMatch(/permission denied/);
  });
});

describe("worker selector parity", () => {
  it("required is exactly billing.worker_connections(): credential stored, whatever the status or pinned subscriptions", async () => {
    const worker = (await h.scoped("billing_worker").call<string[]>("billing.worker_connections", [])).slice().sort();
    const s = await snap();
    expect(s.worker_connection_ids.slice().sort()).toEqual(worker);
    expect(s.connections.filter((c) => c.worker_required).map((c) => c.id).sort()).toEqual(worker);
    expect(worker).toEqual([E1, D1].sort());
    expect(conn(s, D1)).toMatchObject({ status: "disabled", worker_required: true });
    expect((await h.q<{ n: number }>("select count(*)::int as n from billing.subscriptions where connection_id = $1", [D1]))[0].n).toBe(0);
    expect(conn(s, N1).worker_required).toBe(false);
    expect(conn(s, N2).worker_required).toBe(false);
    await expect(h.q("insert into platform.provider_connections (provider_code, label, status, created_by) values ('bachs', 'x', 'enabled', $1)", [ADMIN]))
      .rejects.toThrow(/check/);
  });
});

describe("snapshot content", () => {
  it("counts the webhook backlog, expired leases, dead and quarantined separately; done rows and the old collision are excluded", async () => {
    const s = await snap();
    const c = conn(s, E1);
    expect(c.webhook).toMatchObject({ pending: 2, processing: 2, failed: 1, expired_leases: 1 });
    expect(Date.parse(c.webhook.oldest_received_at!)).toBe(await at("select received_at from billing.webhook_inbox where event_id = 'evt_pr1'"));
    expect([c.webhook_dead, c.webhook_quarantined, c.collisions_24h]).toEqual([1, 1, 1]);
  });

  it("counts discovery pending, retry (future retry delay), processing and expired leases; terminal states excluded", async () => {
    const c = conn(await snap(), E1);
    expect(c.discovery).toMatchObject({ pending: 1, processing: 2, retry: 1, expired_leases: 1 });
    expect(Date.parse(c.discovery.oldest_first_seen_at!)).toBe(await at("select first_seen_at from billing.discovered_payments where provider_payment_id = 'pay_retry'"));
    expect(c.discovery_dead).toBe(1);
  });

  it("counts unresolved reviews per connection and globally without a connection; resolved rows are ignored", async () => {
    const s = await snap();
    expect(conn(s, E1).reviews.open).toBe(2);
    expect(Date.parse(conn(s, E1).reviews.oldest_created_at!)).toBe(await at("select created_at from billing.review_queue where dedupe_key = 'MARKER_DEDUPE_1'"));
    expect(s.unassigned_reviews.open).toBe(1);
    expect(Date.parse(s.unassigned_reviews.oldest_created_at!)).toBe(await at("select created_at from billing.review_queue where dedupe_key = 'k4'"));
    expect(conn(s, D1).reviews).toEqual({ open: 0, oldest_created_at: null });
  });

  it("reports the latest finished cron failure even with an older success, a newer unfinished run and a newer manual success", async () => {
    const r = conn(await snap(), E1).runs;
    expect(r.process.latest_outcome).toBe("failure");
    expect(Date.parse(r.process.latest_finished_at!)).toBe(await at(`select finished_at from billing.worker_runs where id = '${RUN(2)}'`));
    expect(Date.parse(r.process.latest_success_at!)).toBe(await at(`select finished_at from billing.worker_runs where id = '${RUN(1)}'`));
    expect(r.process.unfinished).toBe(2);
    expect(Date.parse(r.process.oldest_unfinished_started_at!)).toBe(await at(`select started_at from billing.worker_runs where id = '${RUN(5)}'`));
    expect([r.process.failed_24h, r.process.partial_24h]).toEqual([1, 0]);
    expect(r.discover).toMatchObject({ latest_outcome: "partial", latest_success_at: null, partial_24h: 1, failed_24h: 0 });
    expect(r.reconcile).toEqual({ latest_finished_at: null, latest_outcome: "none", latest_success_at: null, unfinished: 0,
      oldest_unfinished_started_at: null, failed_24h: 0, partial_24h: 0 });
  });

  it("breaks finished_at ties by id descending", async () => {
    expect(conn(await snap(), D1).runs.process.latest_outcome).toBe("failure");
  });

  it("evaluates the live snapshot: attention, with not-measured connections and no healthy claim", async () => {
    const ev = assess(await snap());
    expect(ev.status).toBe("attention");
    const codes = ev.findings.map((f) => `${f.code}${f.connection_id === E1 ? ":E1" : f.connection_id === D1 ? ":D1" : f.connection_id ? ":N" : ""}${f.mode ? `:${f.mode}` : ""}`);
    for (const c of ["RUN_LATEST_FAILED:E1:process", "RUN_STUCK:E1:process", "RUN_LATEST_PARTIAL:E1:discover", "RUN_NEVER_FINISHED:E1:reconcile",
      "WEBHOOK_BACKLOG_STALE:E1", "WEBHOOK_LEASE_EXPIRED:E1", "WEBHOOK_DEAD:E1", "WEBHOOK_QUARANTINED:E1",
      "WEBHOOK_COLLISIONS_24H:E1", "DISCOVERY_BACKLOG_STALE:E1", "DISCOVERY_LEASE_EXPIRED:E1", "DISCOVERY_DEAD:E1", "REVIEWS_OPEN:E1",
      "REVIEWS_UNASSIGNED_OPEN", "RUN_LATEST_FAILED:D1:process", "WORKER_NOT_REQUIRED:N"]) expect(codes, c).toContain(c);
    // Process finished 3 minutes ago (limit 5), discover 1 hour ago (limit 2 hours): neither is stale.
    expect(codes).not.toContain("RUN_STALE:E1:process");
    expect(codes).not.toContain("RUN_STALE:E1:discover");
    expect(codes.filter((c) => c.startsWith("RUN_") && c.includes(":N"))).toEqual([]);
  });
});

describe("privacy allowlist", () => {
  it("emits only allowlisted keys and only UUID, enum, boolean, count and timestamp values; no fixture marker leaks", async () => {
    const s = await snap(ADMIN2);
    expect(validateSnapshot(s).ok).toBe(true); // exact key allowlist at every level
    const text = JSON.stringify(s);
    for (const m of ["MARKER", "marker", "abcdef123456", "sk_sandbox", "whsec_", "evt_", "@", "pay_", "boom", "fixture"]) expect(text, m).not.toContain(m);
    const leaves: unknown[] = [];
    const walk = (v: unknown) => { if (v && typeof v === "object") Object.values(v).forEach(walk); else leaves.push(v); };
    walk(s);
    const allowed = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T[\d:.]+\+00:00|bachs|paystack|stripe|draft|tested|enabled|disabled|success|failure|partial|none)$/;
    for (const l of leaves) {
      if (typeof l === "string") expect(l).toMatch(allowed);
      else if (typeof l === "number") expect(Number.isSafeInteger(l) && l >= 0).toBe(true);
      else expect(l === null || typeof l === "boolean").toBe(true);
    }
  });
});

describe("read-only", () => {
  it("leaves every billing, platform, public and vault table byte-identical (no audit row, no claim, no run)", async () => {
    const before = await tableHashes();
    for (let i = 0; i < 3; i++) await snap(i % 2 ? ADMIN : ADMIN2, i % 2 ? "aal2" : "aal1");
    await h.userRpc(PLAIN)("platform_operations_snapshot", {});
    await raw(ADMIN, { role: "authenticated", aal: "aal1" }, "select private.platform_operations_snapshot()");
    await raw(PLAIN, { role: "authenticated", aal: "aal2" }, "select private.platform_operations_snapshot()");
    expect(await tableHashes()).toEqual(before);
  });
});

describe("read-path indexes", () => {
  it("the backlog and run lookups can use the new partial indexes", async () => {
    const plan = async (sql: string) => h.serial(async () => {
      await h.pg.exec("set enable_seqscan = off");
      try { return (await h.pg.query<{ "QUERY PLAN": string }>(`explain ${sql}`)).rows.map((r) => r["QUERY PLAN"]).join("\n"); }
      finally { await h.pg.exec("reset enable_seqscan"); }
    });
    expect(await plan(`select min(received_at) from billing.webhook_inbox where connection_id = '${E1}' and status in ('pending', 'processing', 'failed')`))
      .toMatch(/webhook_inbox_backlog_idx/);
    expect(await plan(`select min(first_seen_at) from billing.discovered_payments where connection_id = '${E1}' and state in ('pending', 'processing', 'retry')`))
      .toMatch(/discovered_payments_backlog_idx/);
    expect(await plan(`select id from billing.worker_runs where connection_id = '${E1}' and mode = 'process' and trigger = 'cron' and finished_at is not null
      order by finished_at desc, id desc limit 1`)).toMatch(/worker_runs_cron_finished_idx/);
    expect(await plan(`select min(started_at) from billing.worker_runs where connection_id = '${E1}' and mode = 'process' and trigger = 'cron' and finished_at is null`))
      .toMatch(/worker_runs_cron_unfinished_idx/);
  });
});
