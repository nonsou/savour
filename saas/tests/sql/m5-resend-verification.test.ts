// M5 Stage 1 owner email verification ledger on embedded PostgreSQL with every migration applied: privileges, the
// admin + aal2 gate before any table access, one reservation per UTC day (serial and duplicate), outcome recording
// once, stale rows shown as unknown, the 14-day sanitized read and the 90-day prune. Synthetic fixtures only; no
// network, no key and no email is involved anywhere.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validateReservation, validateVerifications, VERIFICATION_FROM, VERIFICATION_SUBJECT, VERIFICATION_TEXT, VERIFICATION_TO,
  type VerificationsView } from "@/lib/alert-email";

// Self-contained (does not need the Edge Function sources the M4 harness imports): stub + every migration in order.
async function setup() {
  const pg = new PGlite();
  await pg.exec(readFileSync(join(root, "tests/sql/supabase-stub.sql"), "utf8"));
  for (const f of readdirSync(join(root, "supabase/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(root, "supabase/migrations", f), "utf8"));
  }
  let queue: Promise<unknown> = Promise.resolve();
  // PGlite has one connection: serialize role switches so concurrent awaits never interleave.
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = queue.then(f, f);
    queue = next.catch(() => undefined);
    return next;
  };
  const q = <T>(sql: string, params: unknown[] = []) => serial(async () => (await pg.query<T>(sql, params)).rows);
  return { pg, serial, q, close: () => pg.close() };
}
let h: Awaited<ReturnType<typeof setup>>;
const ADMIN = "eeeeeeee-5700-4000-8000-000000000001";
const REVOKED = "eeeeeeee-5700-4000-8000-000000000002";
const PLAIN = "eeeeeeee-5700-4000-8000-000000000003";
const SPOOF = "eeeeeeee-5700-4000-8000-000000000004";
const OWNER = "eeeeeeee-5700-4000-8000-000000000005";
const MSG_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";
const ROLES = ["public", "anon", "authenticated", "service_role", "billing_intake", "billing_gateway", "billing_worker"];
const T = "operations.alert_email_verifications";
const root = join(import.meta.dirname, "..", "..");

const raw = async (uid: string | null, claims: Record<string, unknown>, sql: string, role = "authenticated") => h.serial(async () => {
  await h.pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(uid ? { sub: uid, ...claims } : claims)]);
  await h.pg.exec(`set role ${role}`);
  try { return { rows: (await h.pg.query<{ r: unknown }>(sql)).rows, error: null as string | null }; }
  catch (e) { return { rows: null, error: (e as Error).message }; }
  finally { await h.pg.exec("reset role"); }
});
const as = (uid: string, sql: string, aal = "aal2") => raw(uid, { role: "authenticated", aal }, sql);
const reserve = (uid = ADMIN, aal = "aal2") => as(uid, "select public.platform_reserve_alert_email_verification() as r", aal);
const finish = (id: string, outcome: string | null, msg: string | null = null, uid = ADMIN, aal = "aal2") =>
  as(uid, `select public.platform_finish_alert_email_verification(${lit(id)}, ${lit(outcome)}, ${lit(msg)}) as r`, aal);
const lit = (v: string | null) => (v === null ? "null" : `'${v.replace(/'/g, "''")}'`);
const read = async (uid = ADMIN, aal = "aal1") => {
  const r = await as(uid, "select public.platform_alert_email_verifications() as r", aal);
  if (r.error) throw new Error(r.error);
  return r.rows![0].r as VerificationsView;
};
interface Row { id: string; utc_day: string; status: string; requested_at: Date; finished_at: Date | null; provider_message_id: string | null }
const rows = () => h.q<Row>(`select id, utc_day::text as utc_day, status, requested_at, finished_at, provider_message_id from ${T} order by utc_day`);
const today = async () => (await h.q<{ d: string }>("select (statement_timestamp() at time zone 'UTC')::date::text as d"))[0].d;
/** Owner-only fixture row n days before today (bypasses the RPCs on purpose). */
const seed = (daysAgo: number, status = "accepted") => h.q(`insert into ${T} (utc_day, status, requested_at, finished_at, provider_message_id)
  select d, $2, d + interval '12 hours', case when $2 = 'reserved' then null else d + interval '12 hours 1 second' end,
    case when $2 = 'accepted' then gen_random_uuid() end
  from (select (statement_timestamp() at time zone 'UTC')::date - $1::int as d) x`, [daysAgo, status]);

beforeAll(async () => {
  h = await setup();
  for (const u of [ADMIN, REVOKED, PLAIN, OWNER]) await h.q("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [u, `${u}@m5r.test`]);
  await h.q("insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, 'spoof@m5r.test', now(), $2)",
    [SPOOF, JSON.stringify({ platform_admin: true, role: "admin" })]);
  await h.q("insert into platform.admins (user_id, note) values ($1, 'live fixture')", [ADMIN]);
  await h.q("insert into platform.admins (user_id, note, revoked_at) values ($1, 'revoked fixture', now())", [REVOKED]);
  // A workspace owner is still not a platform admin.
  const ws = await as(OWNER, "select public.create_workspace(p_name => 'M5 email fixture', p_country => 'Nigeria', p_timezone => 'Africa/Lagos', p_display_name => 'Owner') as r", "aal1");
  expect(ws.error).toBeNull();
}, 180_000);
afterAll(async () => { await h?.close(); });
beforeEach(async () => { await h.q(`delete from ${T}`); });

// ---------------------------------------------------------------------------
describe("privileges", () => {
  const PUB = ["public.platform_reserve_alert_email_verification()", "public.platform_finish_alert_email_verification(uuid, text, uuid)",
    "public.platform_alert_email_verifications()"];
  const GUARD = PUB.map((f) => f.replace("public.", "private."));
  const OWNER_ONLY = ["private.alert_email_verification_message()", "private.alert_email_verifications_read()"];

  it("authenticated executes only the three wrappers and their guarded entries; helpers are owner-only; no other role executes anything", async () => {
    const grid = await h.q<{ f: string; r: string; ok: boolean }>(`select f, r, has_function_privilege(r, f, 'execute') as ok
      from unnest($1::text[]) f, unnest($2::text[]) r`, [[...PUB, ...GUARD, ...OWNER_ONLY], ROLES]);
    expect(grid.filter((g) => g.ok).map((g) => `${g.f} ${g.r}`).sort()).toEqual([...PUB, ...GUARD].map((f) => `${f} authenticated`).sort());
  });

  it("wrappers are invokers that only call the guard; guards are definers that check the admin (aal2 for writes) before anything else", async () => {
    const meta = await h.q<{ name: string; secdef: boolean; cfg: string[]; src: string }>(`
      select n.nspname || '.' || p.proname as name, p.prosecdef as secdef, p.proconfig as cfg, p.prosrc as src
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.proname like '%alert\\_email\\_verification%' order by 1`);
    expect(meta.map((m) => [m.name, m.secdef])).toEqual([
      ["private.alert_email_verification_message", false], ["private.alert_email_verifications_read", false],
      ["private.platform_alert_email_verifications", true], ["private.platform_finish_alert_email_verification", true],
      ["private.platform_reserve_alert_email_verification", true],
      ["public.platform_alert_email_verifications", false], ["public.platform_finish_alert_email_verification", false],
      ["public.platform_reserve_alert_email_verification", false]]);
    for (const m of meta) expect(m.cfg, m.name).toContain('search_path=""');
    const src = Object.fromEntries(meta.map((m) => [m.name, m.src.trim()]));
    expect(src["public.platform_reserve_alert_email_verification"]).toBe("select private.platform_reserve_alert_email_verification()");
    expect(src["public.platform_finish_alert_email_verification"]).toBe("select private.platform_finish_alert_email_verification(p_id, p_outcome, p_provider_message_id)");
    expect(src["public.platform_alert_email_verifications"]).toBe("select private.platform_alert_email_verifications()");
    // The gate is the first statement: nothing (prune, insert, select, validation) runs before it.
    for (const [fn, gate] of [["private.platform_reserve_alert_email_verification", "private.platform_actor(true)"],
      ["private.platform_finish_alert_email_verification", "private.platform_actor(true)"],
      ["private.platform_alert_email_verifications", "private.platform_actor(false)"]]) {
      const at = src[fn].search(/\bbegin\b/);
      expect(src[fn].slice(0, at), `${fn} declarations run nothing`).not.toMatch(/[(:]=|\(/);
      expect(src[fn].slice(at + "begin".length).trimStart().startsWith(`perform ${gate};`), fn).toBe(true);
    }
    for (const m of meta.filter((x) => x.secdef)) {
      expect(m.cfg.slice().sort()).toEqual(["lock_timeout=2s", 'search_path=""', "statement_timeout=5s", "TimeZone=UTC"].sort());
    }
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosecdef`)).toEqual([]);
    expect(await h.q(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private', 'operations') and has_function_privilege('anon', p.oid, 'execute')`)).toEqual([]);
  });

  it("the ledger: RLS on, no policy, no grant to any client role, and no column for actor, recipient, body, error or key", async () => {
    for (const r of ROLES.filter((x) => x !== "public")) {
      for (const p of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
        expect((await h.q<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [r, T, p]))[0].ok, `${r} ${p}`).toBe(false);
      }
    }
    expect((await h.q<{ s: boolean }>(`select relrowsecurity as s from pg_class where oid = '${T}'::regclass`))[0].s).toBe(true);
    expect(await h.q("select 1 from pg_policies where schemaname = 'operations' and tablename = 'alert_email_verifications'")).toEqual([]);
    expect(await h.q("select 1 from information_schema.role_table_grants where table_schema = 'operations' and grantee <> (select current_user)")).toEqual([]);
    const cols = (await h.q<{ c: string }>(`select attname as c from pg_attribute where attrelid = '${T}'::regclass and attnum > 0 and not attisdropped order by attnum`)).map((x) => x.c);
    expect(cols).toEqual(["id", "utc_day", "status", "requested_at", "finished_at", "provider_message_id"]);
  });

  it("an aal2 admin, a plain user and every service role cannot touch the ledger or the owner helpers directly", async () => {
    const calls = [`select * from ${T}`, `insert into ${T} (utc_day, status, requested_at) values (current_date, 'reserved', now())`,
      `update ${T} set status = 'accepted'`, `delete from ${T}`,
      "select private.alert_email_verification_message()", "select private.alert_email_verifications_read()"];
    for (const sql of calls) {
      for (const uid of [ADMIN, PLAIN]) expect((await as(uid, sql)).error, `${uid} ${sql}`).toMatch(/permission denied/);
      for (const role of ["anon", "service_role", "billing_worker", "billing_gateway", "billing_intake"]) {
        expect((await raw(null, { role }, sql, role)).error, `${role} ${sql}`).toMatch(/permission denied/);
      }
    }
    expect(await rows()).toEqual([]);
  });

  it("the migration sends nothing, schedules nothing and never touches pg_net, Vault or HTTP", () => {
    const sql = readFileSync(join(root, "supabase/migrations/20261013201621_m5_resend_owner_alerts.sql"), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/cron\.|net\.|vault\.|http|create extension|api\.resend\.com/i);
  });
});

// ---------------------------------------------------------------------------
describe("gate before any table access", () => {
  it("anon, non-admins, a revoked admin, spoofed metadata and a missing subject are refused, and an aal1 admin gets mfa_required for writes", async () => {
    await seed(120); // a prunable row: a refused reserve must not prune it
    const before = await rows();
    const writes = ["select public.platform_reserve_alert_email_verification()",
      `select public.platform_finish_alert_email_verification('${before[0].id}', 'rejected')`,
      "select private.platform_reserve_alert_email_verification()",
      `select private.platform_finish_alert_email_verification('${before[0].id}', 'rejected', null)`];
    for (const sql of [...writes, "select public.platform_alert_email_verifications()", "select private.platform_alert_email_verifications()"]) {
      expect((await raw(null, { role: "anon" }, sql, "anon")).error, sql).toMatch(/permission denied/);
      for (const uid of [PLAIN, OWNER, REVOKED]) for (const aal of ["aal1", "aal2"]) {
        expect((await as(uid, sql, aal)).error, `${sql} ${uid} ${aal}`).toBe("forbidden");
      }
      expect((await raw(SPOOF, { role: "service_role", aal: "aal2", app_metadata: { platform_admin: true }, user_metadata: { platform_admin: true } }, sql)).error).toBe("forbidden");
      expect((await raw(null, { role: "authenticated", aal: "aal2" }, sql)).error).toBe("not_authenticated");
    }
    for (const sql of writes) expect((await as(ADMIN, sql, "aal1")).error, sql).toBe("mfa_required");
    // An invalid outcome from an aal1 admin still hits the gate first.
    expect((await finish(before[0].id, "bogus", null, ADMIN, "aal1")).error).toBe("mfa_required");
    expect(await rows()).toEqual(before);
  });

  it("an aal1 admin can read; the read needs no aal2", async () => {
    const v = await read(ADMIN, "aal1");
    expect(validateVerifications(v)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("reservation: one per UTC day", () => {
  it("returns only the id and the fixed message, which match the server action's constants exactly", async () => {
    const r = await reserve();
    expect(r.error).toBeNull();
    const out = r.rows![0].r as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(["from", "id", "subject", "text", "to"]);
    expect(out).toMatchObject({ from: VERIFICATION_FROM, to: VERIFICATION_TO, subject: VERIFICATION_SUBJECT, text: VERIFICATION_TEXT });
    expect(validateReservation(out)).toEqual({ id: out.id });
    const [row] = await rows();
    expect(row).toMatchObject({ id: out.id, utc_day: await today(), status: "reserved", finished_at: null, provider_message_id: null });
  });

  it("a second reservation the same day is refused, serially and when issued together, and changes nothing", async () => {
    expect((await reserve()).error).toBeNull();
    const after = await rows();
    expect((await reserve()).error).toBe("verification_daily_limit");
    const both = await Promise.all([reserve(), reserve()]);
    expect(both.map((b) => b.error)).toEqual(["verification_daily_limit", "verification_daily_limit"]);
    expect(await rows()).toEqual(after);
  });

  it("two first reservations for an empty day issued together: exactly one wins; the unique day is the concurrency guard", async () => {
    // PGlite has one connection, so these are serialized; true concurrency rests on the unique (utc_day) index below.
    const both = await Promise.all([reserve(), reserve()]);
    expect(both.filter((b) => b.error === null)).toHaveLength(1);
    expect(both.filter((b) => b.error === "verification_daily_limit")).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
    await expect(h.q(`insert into ${T} (utc_day, status, requested_at) select utc_day, 'reserved', now() from ${T}`)).rejects.toThrow(/unique|duplicate/);
  });

  it("the day stays used whatever the outcome, including after a finished attempt", async () => {
    const id = ((await reserve()).rows![0].r as { id: string }).id;
    expect((await finish(id, "rejected")).rows![0].r).toBe("recorded");
    expect((await reserve()).error).toBe("verification_daily_limit");
  });

  it("an earlier day never blocks today; rows older than 90 days are pruned on reserve, newer ones kept", async () => {
    await seed(1, "unknown");
    await seed(2, "reserved");
    await seed(90);
    await seed(91);
    await seed(200);
    expect((await reserve()).error).toBeNull();
    const days = await h.q<{ n: number }>(`select ((statement_timestamp() at time zone 'UTC')::date - utc_day) as n from ${T} order by n`);
    expect(days.map((d) => d.n)).toEqual([0, 1, 2, 90]);
  });
});

// ---------------------------------------------------------------------------
describe("finish: self-reported outcome, once", () => {
  const fresh = async () => ((await reserve()).rows![0].r as { id: string }).id;

  it("rejects unknown outcomes, a provider id outside accepted, a missing id on accepted, a bad or unknown id; nothing changes", async () => {
    const id = await fresh();
    const before = await rows();
    for (const o of ["delivered", "ACCEPTED", "reserved", "", null]) expect((await finish(id, o)).error, String(o)).toBe("invalid_verification_outcome");
    expect((await finish(id, "accepted")).error).toBe("invalid_verification_outcome");
    expect((await finish(id, "rejected", MSG_ID)).error).toBe("invalid_verification_outcome");
    expect((await finish(id, "unknown", MSG_ID)).error).toBe("invalid_verification_outcome");
    expect((await finish("not-a-uuid", "rejected")).error).toMatch(/invalid input syntax for type uuid/);
    expect((await finish(id, "accepted", "not-a-uuid")).error).toMatch(/invalid input syntax for type uuid/);
    expect((await finish("eeeeeeee-5700-4000-8000-0000000000ff", "rejected")).error).toBe("not_found");
    expect(await rows()).toEqual(before);
  });

  it("records accepted with the provider id once; a duplicate or conflicting second call changes nothing", async () => {
    const id = await fresh();
    expect((await finish(id, "accepted", MSG_ID)).rows![0].r).toBe("recorded");
    const done = await rows();
    expect(done[0]).toMatchObject({ status: "accepted", provider_message_id: MSG_ID });
    expect(done[0].finished_at).not.toBeNull();
    expect((await finish(id, "accepted", MSG_ID)).rows![0].r).toBe("already_recorded");
    expect((await finish(id, "rejected")).rows![0].r).toBe("already_recorded");
    expect(await rows()).toEqual(done);
  });

  it("rejected and unknown are recorded without a provider id", async () => {
    for (const o of ["rejected", "unknown"]) {
      await h.q(`delete from ${T}`);
      const id = await fresh();
      expect((await finish(id, o)).rows![0].r).toBe("recorded");
      expect((await rows())[0]).toMatchObject({ status: o, provider_message_id: null });
    }
  });

  it("a reservation older than 15 minutes is expired: not recorded, shown as unknown, and the day stays used", async () => {
    const id = await fresh();
    await h.q(`update ${T} set requested_at = requested_at - interval '16 minutes' where id = $1`, [id]);
    expect((await finish(id, "accepted", MSG_ID)).rows![0].r).toBe("expired");
    expect((await rows())[0]).toMatchObject({ status: "reserved", finished_at: null });
    const v = await read();
    expect(v.history[0]).toMatchObject({ status: "unknown", reported: false, finished_at: null, provider_message_id: null });
    expect((await reserve()).error).toBe("verification_daily_limit");
  });
});

// ---------------------------------------------------------------------------
describe("read: sanitized, latest 14 UTC days", () => {
  it("shows in-progress, then the reported outcome; exact keys; no ledger id, actor or message content", async () => {
    const empty = await read();
    expect(validateVerifications(empty)).not.toBeNull();
    expect(empty).toMatchObject({ daily_limit: 1, used_today: false, history: [], utc_day: await today() });
    const id = ((await reserve()).rows![0].r as { id: string }).id;
    const mid = await read();
    expect(mid.used_today).toBe(true);
    expect(mid.history[0]).toMatchObject({ status: "in_progress", reported: false });
    await finish(id, "accepted", MSG_ID);
    const v = await read();
    expect(validateVerifications(v)).not.toBeNull();
    expect(Object.keys(v).sort()).toEqual(["daily_limit", "history", "observed_at", "used_today", "utc_day"]);
    expect(Object.keys(v.history[0]).sort()).toEqual(["finished_at", "provider_message_id", "reported", "requested_at", "status", "utc_day"]);
    expect(v.history[0]).toMatchObject({ status: "accepted", reported: true, provider_message_id: MSG_ID });
    const json = JSON.stringify(v);
    for (const s of [id, ADMIN, VERIFICATION_TO, VERIFICATION_TEXT, VERIFICATION_SUBJECT]) expect(json).not.toContain(s);
  });

  it("lists at most the 14 latest UTC days, newest first, and never 'delivered'", async () => {
    for (let d = 1; d <= 20; d++) await seed(d, d % 3 === 0 ? "rejected" : "accepted");
    const v = await read();
    expect(validateVerifications(v)).not.toBeNull();
    expect(v.history).toHaveLength(13); // today unused: yesterday back to 13 days ago
    expect(v.used_today).toBe(false);
    await reserve();
    const w = await read();
    expect(w.history).toHaveLength(14);
    expect(w.history.map((r) => r.utc_day)).toEqual([...w.history.map((r) => r.utc_day)].sort().reverse());
    expect(JSON.stringify(w)).not.toMatch(/deliver/i);
  });
});
