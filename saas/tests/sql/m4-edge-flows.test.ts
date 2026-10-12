// End-to-end Edge flows on embedded Postgres: the real webhook, worker, owner and platform cores call
// the real SQL through each scoped role (SET ROLE billing_intake / billing_gateway / billing_worker),
// with a MOCK Bachs transport returning official-schema-shaped bodies. This proves the contracts and
// wiring locally; it is not evidence that the Bachs sandbox behaves this way.
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { TransportRequest, TransportResponse } from "../../supabase/functions/_shared/bachs-client.ts";
import { assertAllowed, callSql, type ArgType, type ScopedDb, type ScopedRole } from "../../supabase/functions/_shared/db.ts";
import { cancelSubscription, openPortal, startCheckout, type UserRpc } from "../../supabase/functions/_shared/owner-core.ts";
import { runConnectionTest, storeSecret } from "../../supabase/functions/_shared/platform-core.ts";
import { handleWebhook } from "../../supabase/functions/_shared/webhook-core.ts";
import { processEvents, reconcile, runWorker } from "../../supabase/functions/_shared/worker-core.ts";

const root = join(import.meta.dirname, "..", "..");
const OWNER = "eeeeeeee-0000-4000-8000-000000004501";
const ADMIN = "eeeeeeee-0000-4000-8000-000000004502";
const STRANGER = "eeeeeeee-0000-4000-8000-000000004503";
const KEY = "sk_sandbox_TESTONLY-flowkey000000001";
const WHSEC = "whsec_TESTONLYflowsecret00000001";
const ORG = "acct_flow_test";
const logs: string[] = [];
const log = (l: string) => { logs.push(l); };

let pg: PGlite;
let queue: Promise<unknown> = Promise.resolve();
// PGlite has one connection: serialize role switches so concurrent awaits never interleave.
function serial<T>(f: () => Promise<T>): Promise<T> {
  const next = queue.then(f, f);
  queue = next.catch(() => undefined);
  return next;
}

function scoped(role: ScopedRole): ScopedDb {
  const run = (fn: string, args: [ArgType, unknown][], set: boolean) => serial(async () => {
    assertAllowed(role, fn);
    await pg.exec(`set role ${role}`);
    try {
      return (await pg.query<Record<string, unknown>>(callSql(fn, args, set), args.map(([, v]) => v ?? null))).rows;
    } finally {
      await pg.exec("reset role");
    }
  });
  return { role, call: async <T>(fn: string, a: [ArgType, unknown][]) => (await run(fn, a, false))[0]?.r as T,
    rows: async <T>(fn: string, a: [ArgType, unknown][]) => (await run(fn, a, true)) as T[] };
}

function userRpc(uid: string, aal = "aal1"): UserRpc {
  return (fn, args) => serial(async () => {
    const keys = Object.keys(args);
    await pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: uid, role: "authenticated", aal })]);
    await pg.exec("set role authenticated");
    try {
      const r = await pg.query<{ r: unknown }>(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
      return { data: r.rows[0].r, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    } finally {
      await pg.exec("reset role");
    }
  });
}
const owner = () => userRpc(OWNER);
const ownerQ = async <T>(fn: string, args: Record<string, unknown>) => { const r = await owner()(fn, args); if (r.error) throw new Error(r.error.message); return r.data as T; };

// ---------------------------------------------------------------- mock Bachs (official schema shapes)
type Handler = (req: TransportRequest) => TransportResponse | Promise<TransportResponse>;
const routes = new Map<string, Handler>();
const seen: TransportRequest[] = [];
const transport = async (req: TransportRequest) => {
  seen.push(req);
  const u = new URL(req.url);
  const key = `${req.method} ${u.pathname}`;
  const h = routes.get(key);
  if (!h) return { status: 404, bodyText: JSON.stringify({ detail: "not found", error_code: "NOT_FOUND" }) };
  return h(req);
};
const ok = (body: unknown, status = 200) => ({ status, bodyText: JSON.stringify(body) });

let ws = "";
let conn = "";
let intent = "";
let reference = "";
const periodStart = new Date(Date.now() - 3600_000);
const periodEnd = new Date(periodStart.getTime()); periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
const subscriptionBody = (cancel = false) => ({
  id: "sub_flow1", customer: { customer_id: "cust_flow1", email: "billing-flow@m4.savour.test" }, status: "active", collection_method: "charge_automatically",
  currency: "USD", amount: "29.00", billing_cycle: { interval: "month", frequency: 1 }, quantity: 1, current_period_start: periodStart.toISOString(),
  current_period_end: periodEnd.toISOString(), cancel_at_period_end: cancel, canceled_at: null, created_at: periodStart.toISOString(),
  product: { id: "prod_flowusd", name: "Business" }, items: [{ id: "il_1", quantity: 1, price: { product_id: "prod_flowusd" } }], metadata: {},
});
const paymentBody = (status = "succeeded") => ({
  payment_id: "ch_flow1", status, billing_reason: "subscription_create", checkout_id: "chk_flow1", reference, amount: "29.00", amount_paid: "29.00",
  amount_remaining: "0.00", currency: "USD", customer: { email: "billing-flow@m4.savour.test", name: null }, subscription_id: "sub_flow1",
  invoice: { invoice_id: "inv_flow1", subscription_id: "sub_flow1", period_start: periodStart.toISOString(), period_end: periodEnd.toISOString(), kind: "cycle" },
  line_items: [{ product_id: "prod_flowusd", product_name: "Business", quantity: 1, unit_amount: "29.00", currency: "USD", line_total: "29.00" }],
  created_at: periodStart.toISOString(), updated_at: periodStart.toISOString(),
});
const checkoutBody = () => ({
  checkout_id: "chk_flow1", status: "completed", recurring: { interval: "month", interval_count: 1 }, payment_status: "succeeded", amount: "29.00",
  currency: "USD", reference, charge: paymentBody(), customer: { id: "cust_flow1", email: "billing-flow@m4.savour.test", name: null },
  products: [{ product_id: "prod_flowusd", product_name: "Business", quantity: 1, unit_amount: "29.00", currency: "USD", price_type: "fixed", line_total: "29.00" }],
  created_at: periodStart.toISOString(), updated_at: periodStart.toISOString(), expires_at: periodEnd.toISOString(), completed_at: periodStart.toISOString(),
});

function signedRequest(event: object, opts: { secret?: string; tamper?: boolean; t?: number } = {}) {
  const raw = JSON.stringify(event);
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", opts.secret ?? WHSEC).update(`${t}.${raw}`).digest("hex");
  return new Request(`https://edge.test/functions/v1/bachs-webhook?connection=${conn}`, {
    method: "POST", headers: { "content-type": "application/json", "x-bachs-signature-v2": `t=${t},v1=${sig}` },
    body: opts.tamper ? raw.replace("collection", "collection ") : raw,
  });
}
const envelope = (id: string, type: string, data: object, org = ORG) => ({ id, type, created_at: new Date().toISOString(), organization_id: org, data });
const webhook = (req: Request) => handleWebhook(req, { db: scoped("billing_intake"), nowSeconds: () => Math.floor(Date.now() / 1000), log });
const workerDeps = () => ({ db: scoped("billing_worker"), transport, now: () => new Date(), log, workerId: "test-worker" });

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(join(root, "tests/sql/supabase-stub.sql"), "utf8"));
  for (const f of readdirSync(join(root, "supabase/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(join(root, "supabase/migrations", f), "utf8"));
  }
  await pg.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'm4-flow-owner@savour.test', now()),
    ('${ADMIN}', 'm4-flow-admin@savour.test', now()), ('${STRANGER}', 'm4-flow-stranger@savour.test', now());
    insert into platform.admins (user_id, note) values ('${ADMIN}', 'disposable founder QA fixture');`);
  ws = await ownerQ<string>("create_workspace", { p_name: "Flow Co", p_country: "Nigeria", p_timezone: "Africa/Lagos", p_display_name: "Owner" });
  await ownerQ("set_billing_contact", { p_ws: ws, p_email: "billing-flow@m4.savour.test", p_consent: true, p_expected_version: 1 });
}, 120_000);
afterAll(async () => { await pg.close(); });

describe("M4 Edge flows over the real SQL (mock provider transport)", () => {
  it("keeps the provider registry immutable after the key-format migration", async () => {
    await expect(pg.query("update platform.providers set key_pattern = '.*' where code = 'bachs'")).rejects.toThrow("immutable_record");
  });
  it("clearing the default increments its version once and refuses stale changes", async () => {
    const admin2 = userRpc(ADMIN, "aal2");
    const before = (await pg.query<{ version: number }>("select version from platform.settings where id = true")).rows[0].version;
    const saved = await admin2("platform_set_default", { p_conn: null, p_expected_version: before });
    expect(saved.error).toBeNull();
    expect(saved.data).toBe(before + 1);
    const rows = (await pg.query<{ id: boolean; version: number; default_connection_id: string | null }>("select id, version, default_connection_id from platform.settings")).rows;
    expect(rows).toEqual([{ id: true, version: before + 1, default_connection_id: null }]);
    const stale = await admin2("platform_set_default", { p_conn: null, p_expected_version: before });
    expect(stale.error?.message).toBe("stale_version");
    expect((await pg.query<{ version: number }>("select version from platform.settings where id = true")).rows[0].version).toBe(before + 1);
  });

  it("platform admin: identity, aal2, write-only secrets and a read-only connection test that configures the matching price", async () => {
    const admin2 = userRpc(ADMIN, "aal2");
    expect((await userRpc(OWNER, "aal2")("platform_overview", {})).error?.message).toBe("forbidden");
    conn = (await admin2("platform_create_connection", { p_provider: "bachs", p_label: "Flow sandbox" })).data as string;
    const aal1 = await storeSecret({ userRpc: userRpc(ADMIN, "aal1"), log }, { connectionId: conn, kind: "api_key", secret: KEY, expectedVersion: 1 });
    expect(aal1).toEqual({ status: 401, body: { error: "mfa_required" } });
    expect((await storeSecret({ userRpc: admin2, log }, { connectionId: conn, kind: "api_key", secret: "sk_live_NOT_REAL", expectedVersion: 1 })).status).toBe(400);
    const stored = await storeSecret({ userRpc: admin2, log }, { connectionId: conn, kind: "api_key", secret: KEY, expectedVersion: 1 });
    expect(stored.status).toBe(200);
    expect(JSON.stringify(stored)).not.toContain("sk_sandbox_");
    await storeSecret({ userRpc: admin2, log }, { connectionId: conn, kind: "webhook_secret", secret: WHSEC, expectedVersion: 2 });
    await admin2("platform_set_expected_org", { p_conn: conn, p_org: ORG, p_expected_version: 3 });
    await admin2("platform_propose_price", { p_conn: conn, p_currency: "USD", p_amount: "29.00", p_product_id: "prod_flowusd" });
    await admin2("platform_propose_price", { p_conn: conn, p_currency: "NGN", p_amount: "25000.00", p_product_id: "prod_flowngn" });
    routes.set("GET /v1/accounts/me", () => ok({ id: ORG, adaptive_pricing: false, is_active: true, fee_handling: "account_pays_fee", balance_currencies: ["USD"],
      owner_user_id: "u", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }));
    routes.set("GET /v1/products/prod_flowusd", () => ok({ id: "prod_flowusd", status: "active", billing_cycle: { interval: "month", frequency: 1 },
      price: { currency: "USD", price_type: "fixed", amount: "29.00" }, prices: [] }));
    routes.set("GET /v1/products/prod_flowngn", () => ok({ id: "prod_flowngn", status: "active", billing_cycle: { interval: "year", frequency: 1 },
      price: { currency: "NGN", price_type: "fixed", amount: "25000.00" }, prices: [] }));
    const test = await runConnectionTest({ userId: ADMIN, userRpc: admin2, gateway: scoped("billing_gateway"), transport, log }, { connectionId: conn });
    expect(test).toMatchObject({ status: 200, body: { outcome: "passed", checks: { organization: "matched", adaptive_pricing: "off", product_USD: "matched", product_NGN: "mismatch" } } });
    const overview = (await admin2("platform_overview", {})).data as { connections: { id: string; version: number; prices: { currency: string; status: string }[] }[]; settings_version: number };
    const c = overview.connections.find((x) => x.id === conn)!;
    expect(c.prices.map((p) => `${p.currency}:${p.status}`)).toEqual(["USD:configured"]);
    await admin2("platform_enable", { p_conn: conn, p_expected_version: c.version });
    await admin2("platform_set_default", { p_conn: conn, p_expected_version: overview.settings_version });
    expect(JSON.stringify(overview)).not.toMatch(/sk_sandbox_|whsec_/);
    expect(logs.join("\n")).not.toMatch(/sk_sandbox_|whsec_/);
  });

  it("owner checkout: persists the intent first, creates an isolated customer, sends the exact request and redirects only to Bachs", async () => {
    const billing = await ownerQ<{ prices: { currency: string; price_id: string | null; unavailable_reason: string | null }[]; terms_version: string }>("get_billing", { p_ws: ws });
    const usd = billing.prices.find((p) => p.currency === "USD")!;
    expect(usd.unavailable_reason).toBeNull();
    expect(billing.prices.find((p) => p.currency === "NGN")!.unavailable_reason).toBe("price_not_configured");
    routes.set("GET /v1/customers", () => ok({ items: [], pagination: { has_more: false } }));
    routes.set("POST /v1/customers", (req) => ok({ customer_id: "cust_flow1", email: JSON.parse(req.body!).email, metadata: JSON.parse(req.body!).metadata,
      created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z" }, 201));
    routes.set("POST /v1/checkout-sessions", (req) => ok({ checkout_id: "chk_flow1", checkout_url: "https://checkout.sandbox.bachs.io/c/flow1", status: "open",
      expires_at: new Date(Date.now() + 3600_000).toISOString(), reference: JSON.parse(req.body!).reference }, 201));
    const r = await startCheckout({ userId: OWNER, userRpc: owner(), gateway: scoped("billing_gateway"), transport, appOrigin: "https://preview.savour.test",
      now: () => new Date(), log }, { workspaceId: ws, currency: "USD", priceId: usd.price_id!, termsVersion: billing.terms_version });
    expect(r).toEqual({ kind: "redirect", url: "https://checkout.sandbox.bachs.io/c/flow1" });
    const req = seen.find((s) => s.url.endsWith("/v1/checkout-sessions"))!;
    const body = JSON.parse(req.body!);
    const row = (await pg.query<{ id: string; reference: string; status: string; request_body: string }>("select id, reference, status, request_body from billing.checkout_intents where workspace_id = $1", [ws])).rows[0];
    intent = row.id; reference = row.reference;
    expect(row.status).toBe("open");
    expect(row.request_body).toBe(req.body);
    expect(req.headers["Idempotency-Key"]).toBe(`savour-checkout-${intent}`);
    expect(body).toEqual({ product_cart: [{ product_id: "prod_flowusd", quantity: 1 }], customer: { customer_id: "cust_flow1" }, billing_currency: "USD",
      payment_method_types: ["USD_CARD"], success_url: `https://preview.savour.test/w/${ws}/billing/return?intent=${intent}`,
      cancel_url: `https://preview.savour.test/w/${ws}/billing?checkout=cancelled`, reference, metadata: { savour_workspace_id: ws, savour_intent_id: intent },
      expires_in_minutes: 60 });
    expect(seen.find((s) => s.url.endsWith("/v1/customers") && s.method === "POST")!.headers["Idempotency-Key"]).toMatch(/^savour-customer-/);
    const again = await startCheckout({ userId: OWNER, userRpc: owner(), gateway: scoped("billing_gateway"), transport, appOrigin: "https://preview.savour.test",
      now: () => new Date(), log }, { workspaceId: ws, currency: "USD", priceId: usd.price_id!, termsVersion: billing.terms_version });
    expect(again).toEqual({ kind: "error", code: "checkout_in_progress" });
    const stranger = await startCheckout({ userId: STRANGER, userRpc: userRpc(STRANGER), gateway: scoped("billing_gateway"), transport,
      appOrigin: "https://preview.savour.test", now: () => new Date(), log }, { workspaceId: ws, currency: "USD", priceId: usd.price_id!, termsVersion: billing.terms_version });
    expect(stranger.kind).toBe("error");
    // Redirect alone grants nothing.
    expect((await ownerQ<{ access: { state: string } }>("get_billing", { p_ws: ws })).access.state).toBe("trialing");
  });

  it("webhook: verifies raw bytes before storing, dedupes, quarantines a foreign account, refuses tampering", async () => {
    const ev = envelope("evt_flow_paid", "collection.succeeded", { charge_id: "ch_flow1", checkout_id: "chk_flow1", status: "SUCCEEDED" });
    expect((await webhook(signedRequest(ev))).status).toBe(200);
    expect(await (await webhook(signedRequest(ev))).json()).toEqual({ result: "duplicate" });
    expect((await webhook(signedRequest(ev, { tamper: true }))).status).toBe(400);
    expect((await webhook(signedRequest(ev, { secret: "whsec_wrong_secret_000000000" }))).status).toBe(400);
    expect((await webhook(signedRequest(ev, { t: Math.floor(Date.now() / 1000) - 301 }))).status).toBe(400);
    expect(await (await webhook(signedRequest(envelope("evt_flow_foreign", "collection.succeeded", {}, "acct_other")))).json()).toEqual({ result: "quarantined" });
    const big = new Request(`https://edge.test/functions/v1/bachs-webhook?connection=${conn}`, { method: "POST",
      headers: { "content-type": "application/json", "content-length": String(300 * 1024) }, body: "{}" });
    expect((await webhook(big)).status).toBe(413);
    expect((await pg.query("select 1 from billing.paid_periods")).rows).toHaveLength(0);
  });

  it("worker: fetches provider truth for the stored event and grants exactly one verified period; retries on timeout", async () => {
    routes.set("GET /v1/payments/ch_flow1", () => ok(paymentBody()));
    routes.set("GET /v1/subscriptions/sub_flow1", () => ok(subscriptionBody()));
    routes.set("GET /v1/checkout-sessions/chk_flow1", () => ok(checkoutBody()));
    const r = await processEvents(workerDeps(), conn);
    expect(r).toEqual({ claimed: 1, done: 1, failed: 0, released: 0 });
    expect((await ownerQ<{ access: { state: string; limits: { locations: number } } }>("get_billing", { p_ws: ws })).access).toMatchObject({ state: "active", limits: { locations: 3 } });
    const outcome = (await pg.query<{ outcome: string }>("select outcome from billing.webhook_inbox where event_id = 'evt_flow_paid'")).rows[0].outcome;
    expect(outcome).toBe("granted");
    // A second delivery of different events for the same payment is a no-op; a provider timeout is retryable.
    await webhook(signedRequest(envelope("evt_flow_invoice", "invoice.paid", { invoice_id: "inv_flow1", charge: { payment_id: "ch_flow1" } })));
    await webhook(signedRequest(envelope("evt_flow_timeout", "collection.succeeded", { charge_id: "ch_flow_slow" })));
    routes.set("GET /v1/payments/ch_flow_slow", () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; });
    const r2 = await processEvents(workerDeps(), conn);
    expect(r2).toEqual({ claimed: 2, done: 1, failed: 1, released: 0 });
    const rows = (await pg.query<{ event_id: string; status: string; outcome: string | null; last_error_code: string | null }>(
      "select event_id, status, outcome, last_error_code from billing.webhook_inbox where event_id in ('evt_flow_invoice', 'evt_flow_timeout') order by event_id")).rows;
    expect(rows).toEqual([{ event_id: "evt_flow_invoice", status: "done", outcome: "duplicate", last_error_code: null },
      { event_id: "evt_flow_timeout", status: "failed", outcome: null, last_error_code: "provider_timeout" }]);
    expect((await pg.query("select 1 from billing.paid_periods")).rows).toHaveLength(1);
  });

  it("portal: refuses a customer with a subscription the business does not own, otherwise mints a fresh URL", async () => {
    routes.set("GET /v1/subscriptions", () => ok({ items: [subscriptionBody(), { ...subscriptionBody(), id: "sub_elsewhere" }], pagination: { has_more: false } }));
    const deps = { userId: OWNER, userRpc: owner(), gateway: scoped("billing_gateway"), transport, appOrigin: "https://preview.savour.test", now: () => new Date(), log };
    expect(await openPortal(deps, { workspaceId: ws })).toEqual({ kind: "error", code: "billing_portal_refused" });
    routes.set("GET /v1/subscriptions", () => ok({ items: [subscriptionBody()], pagination: { has_more: false } }));
    routes.set("POST /v1/customers/cust_flow1/portal-sessions", () => ok({ id: "psn_flow1", url: "https://portal.bachs.io/s/flowsession" }));
    expect(await openPortal(deps, { workspaceId: ws })).toEqual({ kind: "redirect", url: "https://portal.bachs.io/s/flowsession" });
    expect(JSON.stringify((await pg.query("select * from billing.review_queue")).rows)).not.toContain("portal.bachs.io");
    expect(logs.join("\n")).not.toContain("flowsession");
  });

  it("cancel: pending until the provider response confirms cancel_at_period_end", async () => {
    routes.set("DELETE /v1/subscriptions/sub_flow1", () => ok(subscriptionBody(true)));
    const version = (await ownerQ<{ version: number }>("get_billing", { p_ws: ws })).version;
    const r = await cancelSubscription({ userId: OWNER, userRpc: owner(), gateway: scoped("billing_gateway"), transport, appOrigin: "https://preview.savour.test",
      now: () => new Date(), log }, { workspaceId: ws, expectedVersion: version });
    expect(r).toEqual({ kind: "done", data: { cancellation: "confirmed" } });
    expect((await ownerQ<{ access: { state: string } }>("get_billing", { p_ws: ws })).access.state).toBe("cancel_scheduled");
  });

  it("refund: a refund event re-reads the payment and revokes only that period; reconciliation finds missed refunds too", async () => {
    routes.set("GET /v1/payments/ch_flow1", () => ok(paymentBody("refunded")));
    routes.set("GET /v1/refunds/ref_flow1", () => ok({ refund_id: "ref_flow1", charge_id: "ch_flow1", status: "success", requested_amount: "29.00",
      refund_fee_amount: "0", fee_bearer: "org", created_at: "2026-10-11T00:00:00Z", updated_at: "2026-10-11T00:00:00Z" }));
    await webhook(signedRequest(envelope("evt_flow_refund", "refund.paid", { refund_id: "ref_flow1" })));
    routes.set("GET /v1/payments/ch_flow_slow", () => ok({ ...paymentBody("processing"), payment_id: "ch_flow_slow" }));
    await pg.exec("update billing.webhook_inbox set next_attempt_at = now() - interval '1 second' where event_id = 'evt_flow_timeout'");
    await processEvents(workerDeps(), conn);
    expect((await pg.query<{ revoked: boolean }>("select revoked_at is not null as revoked from billing.paid_periods where provider_payment_id = 'ch_flow1'")).rows[0].revoked).toBe(true);
    expect((await ownerQ<{ access: { state: string } }>("get_billing", { p_ws: ws })).access.state).toBe("trialing");
    routes.set("GET /v1/disputes", () => ok({ total: 0, items: [] }));
    const rec = await reconcile(workerDeps(), conn);
    expect(rec.failed).toBe(0);
    const runs = await runWorker(workerDeps(), "process", "cron");
    expect(runs.connections).toBe(1);
    expect((await pg.query<{ trigger: string; finished: boolean }>("select trigger, finished_at is not null as finished from billing.worker_runs order by started_at desc limit 1")).rows[0])
      .toEqual({ trigger: "cron", finished: true });
  });

  it("least privilege: each role reaches only its own functions and no table, and function code never reads a service-role key", async () => {
    expect(() => assertAllowed("billing_worker", "billing.gateway_bind_customer")).toThrow();
    expect(() => assertAllowed("billing_intake", "platform.get_credential")).toThrow();
    for (const [role, sql] of [["billing_worker", "select count(*) from billing.paid_periods"], ["billing_gateway", "select count(*) from platform.provider_connections"],
      ["billing_intake", "select count(*) from vault.secrets"], ["billing_worker", "select billing.gateway_portal_context(gen_random_uuid(), gen_random_uuid())"],
      ["billing_intake", "select platform.get_credential(gen_random_uuid())"]] as const) {
      await expect(serial(async () => { await pg.exec(`set role ${role}`); try { await pg.query(sql); } finally { await pg.exec("reset role"); } }), `${role}: ${sql}`)
        .rejects.toThrow(/permission denied/);
    }
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
    for (const file of walk(join(root, "supabase", "functions")).filter((f) => f.endsWith(".ts"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/SERVICE_ROLE|service_role|sb_secret|sk_live_[A-Za-z0-9]/);
    }
  });
});
