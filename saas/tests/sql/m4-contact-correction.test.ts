// Billing contact correction before a provider customer exists, over the real SQL (PGlite) through the
// scoped gateway role and the real owner-core flow, with a MOCK Bachs transport. Every provider status and
// error code here is synthetic. PGlite has a single connection: "concurrent" runs below are interleavings
// of serialized statements (a held mock POST between two transactions), so row-lock contention, lock-order
// deadlocks and real lease timing are not exercised here; they need real Postgres with separate connections.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TransportRequest, TransportResponse } from "../../supabase/functions/_shared/bachs-client.ts";
import { resumeCheckout, startCheckout } from "../../supabase/functions/_shared/owner-core.ts";
import { harness, ok, timeout } from "./m4-harness";

const ADMIN = "eeeeeeee-0000-4000-8000-000000005000";
const KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
type K = (typeof KEYS)[number];
const OWNERS = Object.fromEntries(KEYS.map((k, i) => [k, `eeeeeeee-0000-4000-8000-0000000050${(i + 1).toString().padStart(2, "0")}`])) as Record<K, string>;
const STRANGER = "eeeeeeee-0000-4000-8000-000000005090";
const MEMBER_ADMIN = "eeeeeeee-0000-4000-8000-000000005091";
const email = (k: string, n = 1) => `billing-fix-${k}${n > 1 ? `-v${n}` : ""}@m4.savour.test`;
const VALIDATION_422: TransportResponse = { status: 422, bodyText: JSON.stringify({ detail: "synthetic", error_code: "VALIDATION_ERROR" }) };

type Contact = { email: string; state: string; locked: boolean; correctable: boolean };
type Row = { billing_email: string; customer_idempotency_key: string; customer_request_key: string | null; customer_key_generation: number;
  create_attempts: number; customer_key_attempts_base: number; create_refused_detail: string | null; create_claim_token: string | null;
  live: boolean; uncertain: boolean; provider_customer_id: string | null; history_unknown: boolean };

let h: Awaited<ReturnType<typeof harness>>;
const ws = {} as Record<K, string>;
const logs: string[] = [];
const deps = (uid: string) => ({ userId: uid, userRpc: h.userRpc(uid), gateway: h.scoped("billing_gateway"), transport: h.transport,
  appOrigin: "https://preview.savour.test", now: () => new Date(), log: (l: string) => { logs.push(l); } });
const gw = () => h.scoped("billing_gateway");
const owner = (k: K) => h.userRpc(OWNERS[k]);
const billing = async (k: K) => (await owner(k)("get_billing", { p_ws: ws[k] })).data as { version: number; billing_contact: Contact;
  prices: { currency: string; price_id: string }[]; terms_version: string };
const begin = async (k: K) => {
  const b = await billing(k);
  return startCheckout(deps(OWNERS[k]), { workspaceId: ws[k], currency: "USD", priceId: b.prices.find((p) => p.currency === "USD")!.price_id,
    termsVersion: b.terms_version });
};
const retry = (k: K, intentId: string) => resumeCheckout(deps(OWNERS[k]), { workspaceId: ws[k], intentId });
const correct = async (k: K, to: string, opts: { uid?: string; version?: number; consent?: boolean } = {}) =>
  h.userRpc(opts.uid ?? OWNERS[k])("correct_billing_contact", { p_ws: ws[k], p_email: to, p_consent: opts.consent ?? true,
    p_expected_version: opts.version ?? (await billing(k)).version });
const row = async (k: K) => (await h.q<Row>(`select billing_email, customer_idempotency_key, customer_request_key, customer_key_generation, create_attempts,
  customer_key_attempts_base, create_refused_detail, create_claim_token, coalesce(create_lease_until > clock_timestamp(), false) as live,
  create_uncertain_since is not null as uncertain, provider_customer_id, history_unknown from billing.provider_customers where workspace_id = $1`, [ws[k]]))[0];
const intents = (k: K) => h.q<{ id: string; status: string; last_error_code: string | null; connection_id: string }>(
  "select id, status, last_error_code, connection_id from billing.checkout_intents where workspace_id = $1 order by created_at", [ws[k]]);
const posts = (k: K) => h.seen.filter((r) => r.method === "POST" && new URL(r.url).pathname === "/v1/customers"
  && JSON.parse(r.body!).metadata.savour_workspace_id === ws[k]);
const expire = (k: K) => h.q("update billing.provider_customers set create_lease_until = now() - interval '1 second' where workspace_id = $1", [ws[k]]);

const createWith = new Map<string, (req: TransportRequest) => TransportResponse | Promise<TransportResponse>>();
const lookupWith = new Map<string, () => TransportResponse>();
const held: { req: TransportRequest; answer: (r: TransportResponse) => void }[] = [];
const hold = (req: TransportRequest) => new Promise<TransportResponse>((answer) => { held.push({ req, answer }); });
const until = async (cond: () => boolean) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); expect(cond()).toBe(true); };
const customerFor = (req: TransportRequest, id: string) => {
  const b = JSON.parse(req.body!);
  return ok({ customer_id: id, email: b.email, metadata: b.metadata, created_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" }, 201);
};

// Shared mock Bachs routes for any harness: lookup per email (default empty), creation per email.
function mockBachs(target: Awaited<ReturnType<typeof harness>>) {
  target.routes.set("GET /v1/customers", (req) => {
    const e = new URL(req.url).searchParams.get("search") ?? "";
    return lookupWith.get(e)?.() ?? ok({ items: [], pagination: { has_more: false } });
  });
  target.routes.set("POST /v1/customers", (req) => createWith.get(JSON.parse(req.body!).email)!(req));
  target.routes.set("POST /v1/checkout-sessions", (req) => ok({ checkout_id: `chk_${JSON.parse(req.body!).reference.slice(-12)}`,
    checkout_url: "https://checkout.sandbox.bachs.io/c/fix", status: "open", expires_at: new Date(Date.now() + 3600_000).toISOString(),
    reference: JSON.parse(req.body!).reference }, 201));
}

async function workspaces(target: Awaited<ReturnType<typeof harness>>, keys: readonly K[], prefix: string) {
  const conn = await target.connection(ADMIN, `${prefix} sandbox`, `sk_sandbox_TESTONLY-${prefix}key000000000001`, `acct_${prefix}`);
  await target.q("select billing.operator_configure_price($1, 'USD', '29.00', 'prod_fix', 'disposable fixture')", [conn]);
  for (const k of keys) {
    await target.q("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [OWNERS[k], `m4-${prefix}-${k}@savour.test`]);
    const o = target.userRpc(OWNERS[k]);
    ws[k] = (await o("create_workspace", { p_name: `Fix ${k}`, p_country: "Nigeria", p_timezone: "Africa/Lagos", p_display_name: "Owner" })).data as string;
    expect((await o("set_billing_contact", { p_ws: ws[k], p_email: email(k), p_consent: true, p_expected_version: 1 })).error).toBeNull();
  }
  return conn;
}

beforeAll(async () => {
  h = await harness();
  mockBachs(h);
  await workspaces(h, KEYS, "fix");
  for (const [uid, k] of [[STRANGER, "x"], [MEMBER_ADMIN, "y"]]) {
    await h.q("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [uid, `m4-fix-${k}@savour.test`]);
  }
}, 120_000);
afterAll(async () => { await h.close(); });

describe("billing contact correction (mock provider transport)", () => {
  it("a definitive validation refusal of the current claim allows correction; the old intent cannot proceed and only the new key is used", async () => {
    createWith.set(email("a"), () => VALIDATION_422);
    expect(await begin("a")).toEqual({ kind: "error", code: "customer_create_refused" });
    const [old] = await intents("a");
    expect((await billing("a")).billing_contact).toMatchObject({ state: "correctable", locked: false, correctable: true });
    const before = await row("a");
    expect(before).toMatchObject({ create_refused_detail: "http_422:VALIDATION_ERROR", customer_request_key: null, customer_key_generation: 0 });
    const oldKey = posts("a")[0].headers["Idempotency-Key"];
    expect(oldKey).toBe(before.customer_idempotency_key);
    // The sealed edit path still refuses once a customer request row exists; correction is the only route.
    expect((await owner("a")("set_billing_contact", { p_ws: ws.a, p_email: email("a", 2), p_consent: true,
      p_expected_version: (await billing("a")).version })).error?.message).toBe("billing_contact_locked");

    const version = (await billing("a")).version;
    expect(await correct("a", email("a", 2))).toEqual({ data: version + 1, error: null });
    expect(await intents("a")).toMatchObject([{ id: old.id, status: "abandoned", last_error_code: "contact_corrected" }]);
    const after = await row("a");
    expect(after).toMatchObject({ billing_email: email("a", 2), customer_idempotency_key: oldKey, customer_key_generation: 1,
      create_refused_detail: null, customer_key_attempts_base: before.create_attempts, provider_customer_id: null });
    expect(after.customer_request_key).not.toBe(oldKey);
    const [audit] = await h.q<{ detail: Record<string, unknown> }>(
      "select detail from public.audit_events where workspace_id = $1 and action = 'billing.contact_corrected'", [ws.a]);
    expect(audit.detail).toEqual({ version: version + 1, generation: 1, previous_refusal: "http_422:VALIDATION_ERROR", abandoned_intents: 1 });
    expect(JSON.stringify(audit.detail)).not.toContain("@");

    // A gateway run for the old intent (old email, old key) cannot claim, request, resume or reload it.
    for (const fn of ["billing.gateway_customer_claim", "billing.gateway_checkout_context"]) {
      await expect(gw().call(fn, [["uuid", old.id], ["uuid", OWNERS.a]]), fn).rejects.toThrow("checkout_intent_stale");
    }
    await expect(gw().call("billing.gateway_mark_requesting", [["uuid", old.id], ["uuid", OWNERS.a], ["text", "{}"]])).rejects.toThrow("checkout_intent_stale");
    expect(await retry("a", old.id)).toEqual({ kind: "error", code: "checkout_intent_stale" });
    expect(posts("a")).toHaveLength(1);

    createWith.set(email("a", 2), (req) => customerFor(req, "cust_fix_a2"));
    expect((await begin("a")).kind).toBe("redirect");
    const sent = posts("a");
    expect(sent.map((p) => [JSON.parse(p.body!).email, p.headers["Idempotency-Key"]])).toEqual([[email("a"), oldKey], [email("a", 2), after.customer_request_key]]);
    expect(await row("a")).toMatchObject({ provider_customer_id: "cust_fix_a2", billing_email: email("a", 2), customer_idempotency_key: oldKey });
    expect((await billing("a")).billing_contact).toMatchObject({ state: "bound", locked: true, correctable: false });
    expect((await correct("a", email("a", 3))).error?.message).toBe("billing_contact_locked");
    // Bound: neither the original key nor the corrected identity can change, even for the table owner.
    await expect(h.q("update billing.provider_customers set customer_request_key = null, customer_key_generation = 0 where workspace_id = $1", [ws.a]))
      .rejects.toThrow("immutable_record");
    await expect(h.q("update billing.provider_customers set customer_idempotency_key = 'x' where workspace_id = $1", [ws.a])).rejects.toThrow("immutable_record");
    await expect(h.q("delete from billing.provider_customers where workspace_id = $1", [ws.a])).rejects.toThrow("immutable_record");
  });

  it("late outcomes and a late bind from the pre-correction run cannot overwrite the newer identity or claim", async () => {
    createWith.set(email("b"), hold);
    const first = begin("b");
    await until(() => posts("b").length === 1);
    const oldToken = (await row("b")).create_claim_token!;
    held.shift()!.answer(VALIDATION_422);
    expect(await first).toEqual({ kind: "error", code: "customer_create_refused" });
    const [old] = await intents("b");
    expect((await correct("b", email("b", 2))).error).toBeNull();

    createWith.set(email("b", 2), hold);
    const second = begin("b");
    await until(() => posts("b").length === 2);
    const current = await row("b");
    expect(current).toMatchObject({ live: true, customer_key_generation: 1 });
    expect((await billing("b")).billing_contact.state).toBe("in_progress");
    expect((await correct("b", email("b", 3))).error?.message).toBe("customer_request_in_progress");

    // The old run's late outcomes carry the old claim token: no proof, no release of the new claim.
    expect(await gw().call("billing.gateway_record_preparation", [["uuid", old.id], ["uuid", OWNERS.b], ["uuid", null], ["text", "customer_create_refused"],
      ["text", "http_422:VALIDATION_ERROR"], ["text", "refused"], ["uuid", oldToken]])).toBe("abandoned");
    expect(await row("b")).toMatchObject({ create_claim_token: current.create_claim_token, live: true, create_refused_detail: null });
    // A late uncertain outcome still makes the state stricter (sticky), never looser.
    await gw().call("billing.gateway_record_preparation", [["uuid", old.id], ["uuid", OWNERS.b], ["uuid", null], ["text", "customer_create_uncertain"],
      ["text", "timeout"], ["text", "uncertain"], ["uuid", oldToken]]);
    expect(await row("b")).toMatchObject({ create_claim_token: current.create_claim_token, live: true, uncertain: true });
    // A late success for the old email is refused and binds nothing. (The sealed bind function raises after
    // queueing its review, so that review row does not persist; see the developer report.)
    await expect(gw().call("billing.gateway_bind_customer", [["uuid", ws.b], ["uuid", old.connection_id], ["uuid", OWNERS.b], ["text", "cust_fix_b_old"],
      ["text", email("b")], ["text", "created"]])).rejects.toThrow("billing_customer_review");
    expect(await row("b")).toMatchObject({ provider_customer_id: null, billing_email: email("b", 2), customer_request_key: current.customer_request_key });

    const h2 = held.shift()!;
    expect(h2.req.headers["Idempotency-Key"]).toBe(current.customer_request_key);
    h2.answer(customerFor(h2.req, "cust_fix_b2"));
    expect((await second).kind).toBe("redirect");
    expect(await row("b")).toMatchObject({ provider_customer_id: "cust_fix_b2", billing_email: email("b", 2) });
  });

  it("an expired lease blocks correction, and its late refusal (even with the current token) certifies nothing", async () => {
    createWith.set(email("c"), hold);
    const run = begin("c");
    await until(() => posts("c").length === 1);
    expect((await correct("c", email("c", 2))).error?.message).toBe("customer_request_in_progress");
    await expire("c");
    expect((await billing("c")).billing_contact.state).toBe("uncertain");
    expect((await correct("c", email("c", 2))).error?.message).toBe("customer_request_uncertain");
    held.shift()!.answer(VALIDATION_422);
    expect(await run).toEqual({ kind: "error", code: "customer_create_refused" });
    expect(await row("c")).toMatchObject({ live: false, create_claim_token: null, create_refused_detail: null, customer_key_generation: 0 });
    expect((await billing("c")).billing_contact).toMatchObject({ state: "request_sent", correctable: false });
    expect((await correct("c", email("c", 2))).error?.message).toBe("customer_request_sent");
  });

  it("an uncertain creation stays sticky: a later definitive refusal on the same key does not make it correctable", async () => {
    createWith.set(email("d"), () => timeout());
    expect(await begin("d")).toEqual({ kind: "error", code: "customer_create_uncertain" });
    const [intent] = await intents("d");
    expect((await correct("d", email("d", 2))).error?.message).toBe("customer_request_uncertain");
    createWith.set(email("d"), () => VALIDATION_422);
    expect(await retry("d", intent.id)).toEqual({ kind: "error", code: "customer_create_refused" });
    expect(await row("d")).toMatchObject({ uncertain: true, create_refused_detail: null });
    expect((await billing("d")).billing_contact.state).toBe("uncertain");
    expect((await correct("d", email("d", 2))).error?.message).toBe("customer_request_uncertain");
    expect(await intents("d")).toMatchObject([{ status: "created" }]);
  });

  it("only the exact validation details certify a refusal; other 4xx and malformed details do not, nor does a superseded claim", async () => {
    lookupWith.set(email("e"), () => ({ status: 503, bodyText: "{}" }));
    expect(await begin("e")).toEqual({ kind: "error", code: "customer_lookup_unavailable" });
    const [intent] = await intents("e");
    // A row with no creation attempt for the current identity: nothing was sent, so correction is safe.
    expect((await billing("e")).billing_contact.state).toBe("correctable");
    const claim = async () => (await gw().call<{ decision: string; claim: string }>("billing.gateway_customer_claim", [["uuid", intent.id], ["uuid", OWNERS.e]])).claim;
    const record = (token: string, detail: string | null, outcome = "refused", code = "customer_create_refused") =>
      gw().call("billing.gateway_record_preparation", [["uuid", intent.id], ["uuid", OWNERS.e], ["uuid", null], ["text", code], ["text", detail],
        ["text", outcome], ["uuid", token]]);
    for (const detail of ["http_400:INVALID_REQUEST", "http_409:CONFLICT", "http_429:VALIDATION_ERROR", "http_409:VALIDATION_ERROR",
      "http_401:VALIDATION_ERROR", "http_422", "http_400", "http_422:VALIDATION_ERRORS", "http_4220:VALIDATION_ERROR", "HTTP_422:VALIDATION_ERROR",
      " http_422:VALIDATION_ERROR", "http_422:validation_error", "http_422:VALIDATION_ERROR\n", null]) {
      await record(await claim(), detail);
      expect(await row("e"), String(detail)).toMatchObject({ create_refused_detail: null, live: false });
      expect((await billing("e")).billing_contact.state, String(detail)).toBe("request_sent");
    }
    await record(await claim(), "http_400:VALIDATION_ERROR", "refused", "customer_lookup_refused");
    expect((await row("e")).create_refused_detail).toBeNull();
    expect((await correct("e", email("e", 2))).error?.message).toBe("customer_request_sent");

    const proven = await claim();
    await record(proven, "http_400:VALIDATION_ERROR");
    expect((await billing("e")).billing_contact.state).toBe("correctable");
    // A new claim clears the proof; replaying the earlier claim's refusal does not restore it.
    const next = await claim();
    expect(await row("e")).toMatchObject({ create_refused_detail: null, live: true });
    await record(proven, "http_400:VALIDATION_ERROR");
    expect(await row("e")).toMatchObject({ create_refused_detail: null, live: true, create_claim_token: next });
    await record(next, "http_400:INVALID_REQUEST");
    expect((await billing("e")).billing_contact.state).toBe("request_sent");
    // The column itself only accepts the allowlisted details.
    await expect(h.q("update billing.provider_customers set create_refused_at = now(), create_refused_detail = 'http_409:CONFLICT' where workspace_id = $1",
      [ws.e])).rejects.toThrow(/check constraint/);
  });

  it("an unresolved customer review blocks correction", async () => {
    const twin = (id: string) => ({ customer_id: id, email: email("f"), metadata: {}, created_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" });
    lookupWith.set(email("f"), () => ok({ items: [twin("cust_fix_f1"), twin("cust_fix_f2")], pagination: { has_more: false } }));
    expect(await begin("f")).toEqual({ kind: "error", code: "billing_customer_review" });
    expect(await row("f")).toMatchObject({ create_attempts: 0, provider_customer_id: null });
    expect((await billing("f")).billing_contact).toMatchObject({ state: "review", locked: true });
    expect((await correct("f", email("f", 2))).error?.message).toBe("customer_request_review");
  });

  it("stale version, duplicate email, bad input and non-Owner callers are refused without side effects", async () => {
    createWith.set(email("g"), () => ({ status: 400, bodyText: JSON.stringify({ error_code: "VALIDATION_ERROR" }) }));
    expect(await begin("g")).toEqual({ kind: "error", code: "customer_create_refused" });
    const version = (await billing("g")).version;
    await h.q("insert into public.memberships (workspace_id, user_id, role, display_name, email) values ($1, $2, 'admin', 'Admin', 'm4-fix-y@savour.test')",
      [ws.g, MEMBER_ADMIN]);
    for (const [args, code] of [
      [{ version: version - 1 }, "stale_version"],
      [{ to: email("h") }, "billing_email_in_use"],
      [{ to: email("g") }, "billing_contact_unchanged"],
      [{ to: "not-an-email" }, "invalid_email"],
      [{ consent: false }, "consent_required"],
      [{ uid: MEMBER_ADMIN }, "forbidden"],
      [{ uid: STRANGER }, "not_found"],
      [{ uid: OWNERS.h }, "not_found"],
    ] as [{ to?: string; uid?: string; version?: number; consent?: boolean }, string][]) {
      expect((await correct("g", args.to ?? email("g", 2), { version, ...args })).error?.message, code).toBe(code);
    }
    // The duplicate-email failure happens after the created intent was abandoned: the whole call rolled back.
    expect(await intents("g")).toMatchObject([{ status: "created", last_error_code: "customer_create_refused" }]);
    expect(await row("g")).toMatchObject({ billing_email: email("g"), customer_key_generation: 0, create_refused_detail: "http_400:VALIDATION_ERROR" });
    expect((await billing("g")).version).toBe(version);
    expect(await h.q("select 1 from public.audit_events where workspace_id = $1 and action = 'billing.contact_corrected'", [ws.g])).toHaveLength(0);
    expect((await correct("g", email("g", 2))).error).toBeNull();
  });

  it("correction is an Owner RPC only: no gateway, worker, intake or anonymous access, and gateway functions stay closed to users", async () => {
    const can = async (role: string, fn: string) => (await h.q<{ ok: boolean }>("select has_function_privilege($1, $2, 'execute') as ok", [role, fn]))[0].ok;
    for (const fn of ["public.correct_billing_contact(uuid, text, boolean, integer)", "private.correct_billing_contact(uuid, text, boolean, integer)"]) {
      expect(await can("authenticated", fn), fn).toBe(true);
      for (const role of ["anon", "billing_gateway", "billing_worker", "billing_intake"]) expect(await can(role, fn), `${role} ${fn}`).toBe(false);
    }
    for (const role of ["anon", "authenticated", "billing_gateway", "billing_worker", "billing_intake"]) {
      expect(await can(role, "billing.contact_state(uuid)"), role).toBe(false);
    }
    for (const fn of ["billing.gateway_checkout_context(uuid, uuid)", "billing.gateway_customer_claim(uuid, uuid)",
      "billing.gateway_record_preparation(uuid, uuid, uuid, text, text, text, uuid)", "billing.gateway_bind_customer(uuid, uuid, uuid, text, text, text)"]) {
      expect(await can("billing_gateway", fn), fn).toBe(true);
      for (const role of ["anon", "authenticated", "billing_worker"]) expect(await can(role, fn), `${role} ${fn}`).toBe(false);
    }
    const [intent] = await intents("e");
    await expect(h.serial(async () => {
      await h.pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: OWNERS.e, role: "authenticated" })]);
      await h.pg.exec("set role authenticated");
      try { await h.pg.query("select billing.gateway_customer_claim($1, $2)", [intent.id, OWNERS.e]); } finally { await h.pg.exec("reset role"); }
    })).rejects.toThrow(/permission denied/);
    expect(logs.join("\n")).not.toMatch(/@m4\.savour\.test|sk_sandbox_/);
  });
});

describe("rows written before this migration (history unknown)", () => {
  let legacy: Awaited<ReturnType<typeof harness>>;
  afterAll(async () => { await legacy?.close(); });

  it("stay locked for manual review even when the recorded detail looks definitive or no POST was recorded; checkout is unaffected", async () => {
    legacy = await harness({ stopBefore: "20261012163920" });
    mockBachs(legacy);
    const saved = h;
    h = legacy;
    try {
      await workspaces(legacy, ["a", "b"], "legacy");
      // Under the previous schema: one refusal that looks definitive, one stop before any creation request.
      createWith.set(email("a"), () => VALIDATION_422);
      expect(await begin("a")).toEqual({ kind: "error", code: "customer_create_refused" });
      lookupWith.set(email("b"), () => ({ status: 503, bodyText: "{}" }));
      expect(await begin("b")).toEqual({ kind: "error", code: "customer_lookup_unavailable" });
      const legacyKey = posts("a")[0].headers["Idempotency-Key"];

      await legacy.migrateRest();
      for (const k of ["a", "b"] as const) {
        expect(await row(k), k).toMatchObject({ history_unknown: true, customer_key_generation: 0 });
        expect((await billing(k)).billing_contact, k).toMatchObject({ state: "unverified", locked: true, correctable: false });
        expect((await correct(k, email(k, 2))).error?.message, k).toBe("customer_request_unverified");
      }
      // No override exists: the flag cannot be cleared, even by the table owner.
      await expect(legacy.q("update billing.provider_customers set history_unknown = false where workspace_id = $1", [ws.b])).rejects.toThrow("immutable_record");
      expect(await legacy.q("select proname from pg_proc where proname ~ '(history|unverified)'")).toEqual([]);

      // Checkout continues on the original key, and the existing adoption and binding rules still apply.
      const [intent] = await intents("a");
      createWith.set(email("a"), (req) => customerFor(req, "cust_legacy_a"));
      expect((await retry("a", intent.id)).kind).toBe("redirect");
      expect(posts("a").map((p) => p.headers["Idempotency-Key"])).toEqual([legacyKey, legacyKey]);
      expect((await billing("a")).billing_contact.state).toBe("bound");
    } finally {
      h = saved;
    }
  }, 120_000);
});
