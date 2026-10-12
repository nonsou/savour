// Observed payment status 'open' (migration 20261012164322) on embedded Postgres through the real webhook
// intake, worker and SQL, with a MOCK Bachs transport. The fixtures are synthetic and only shaped like the
// sandbox observation (GET /v1/payments/{id} said 'open' after a declined test card while a signed
// collection.failed was recorded); they are contract evidence, not evidence of how the sandbox behaves.
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TransportRequest } from "../../supabase/functions/_shared/bachs-client.ts";
import { startCheckout } from "../../supabase/functions/_shared/owner-core.ts";
import { handleWebhook } from "../../supabase/functions/_shared/webhook-core.ts";
import { processEvents, type WorkerDeps } from "../../supabase/functions/_shared/worker-core.ts";
import { harness, ok } from "./m4-harness";

const iso = (ms: number) => new Date(ms).toISOString();
const addMonth = (ms: number) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); };
const silent = () => undefined;
const MIGRATION = "20261012164322_m4_observed_open_payment.sql";

type H = Awaited<ReturnType<typeof harness>>;

/** One workspace with an open checkout intent on a fresh database. Provider reads come from `provider`. */
async function setup(tag: string, owner: string, admin: string) {
  const h = await harness();
  const email = `billing-${tag}@m4.savour.test`;
  const org = `acct_${tag}`;
  const label = `Open ${tag}`;
  const whsec = `whsec_TESTONLY_${label.replace(/\W/g, "")}_000000`;
  const P1 = Date.now() - 3600_000;
  const P2 = addMonth(P1);
  const P3 = addMonth(P2);
  await h.q("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [owner, `m4-${tag}-owner@savour.test`]);
  const rpc = h.userRpc(owner);
  const ws = (await rpc("create_workspace", { p_name: `Open ${tag} Co`, p_country: "Nigeria", p_timezone: "Africa/Lagos", p_display_name: "Owner" })).data as string;
  await rpc("set_billing_contact", { p_ws: ws, p_email: email, p_consent: true, p_expected_version: 1 });
  const conn = await h.connection(admin, label, `sk_sandbox_TESTONLY${tag}key00000000001`, org);
  await h.q("select billing.operator_configure_price($1, 'USD', '29.00', 'prod_open', 'disposable fixture')", [conn]);
  h.routes.set("GET /v1/customers", () => ok({ items: [], pagination: { has_more: false } }));
  h.routes.set("POST /v1/customers", (r: TransportRequest) => ok({ customer_id: `cust_${tag}`, email: JSON.parse(r.body!).email, metadata: {},
    created_at: iso(P1), updated_at: iso(P1) }, 201));
  h.routes.set("POST /v1/checkout-sessions", (r: TransportRequest) => ok({ checkout_id: `chk_${tag}`, checkout_url: `https://checkout.sandbox.bachs.io/c/${tag}`,
    status: "open", expires_at: iso(Date.now() + 3600_000), reference: JSON.parse(r.body!).reference }, 201));
  const billing = (await rpc("get_billing", { p_ws: ws })).data as { prices: { currency: string; price_id: string }[]; terms_version: string };
  const started = await startCheckout({ userId: owner, userRpc: rpc, gateway: h.scoped("billing_gateway"), transport: h.transport,
    appOrigin: "https://preview.savour.test", now: () => new Date(), log: silent },
    { workspaceId: ws, currency: "USD", priceId: billing.prices.find((p) => p.currency === "USD")!.price_id, termsVersion: billing.terms_version });
  expect(started.kind).toBe("redirect");
  const reference = (await h.q<{ reference: string }>("select reference from billing.checkout_intents where workspace_id = $1", [ws]))[0].reference;

  // Mutable provider truth: each test sets what the full GETs return.
  const provider = { payments: new Map<string, unknown>(), checkoutStatus: "open" };
  const subscription = () => ({ id: `sub_${tag}`, customer: { customer_id: `cust_${tag}`, email }, status: "active", currency: "USD", amount: "29.00",
    billing_cycle: { interval: "month", frequency: 1 }, quantity: 1, current_period_start: iso(P1), current_period_end: iso(P2),
    cancel_at_period_end: false, canceled_at: null, created_at: iso(P1), product: { id: "prod_open", name: "Business" },
    items: [{ id: "il_1", quantity: 1, price: { product_id: "prod_open" } }], metadata: {} });
  const completed = () => provider.checkoutStatus === "completed";
  h.routes.set(`GET /v1/subscriptions/sub_${tag}`, () => ok(subscription()));
  h.routes.set(`GET /v1/checkout-sessions/chk_${tag}`, () => ok({ checkout_id: `chk_${tag}`, status: provider.checkoutStatus,
    recurring: { interval: "month", interval_count: 1 }, payment_status: completed() ? "succeeded" : "requires_payment_method", amount: "29.00",
    currency: "USD", reference, customer: { id: `cust_${tag}`, email, name: null },
    products: [{ product_id: "prod_open", product_name: "Business", quantity: 1, unit_amount: "29.00", currency: "USD", price_type: "fixed", line_total: "29.00" }],
    created_at: iso(P1), updated_at: iso(P1), expires_at: iso(Date.now() + 3600_000), completed_at: completed() ? iso(P1) : null }));
  const route = (id: string) => h.routes.set(`GET /v1/payments/${id}`, () => provider.payments.has(id) ? ok(provider.payments.get(id)) : ok({}, 404));

  /** PaymentResponse. 'open' is shaped like the sandbox charge: nothing collected, everything remaining, no invoice. */
  const payment = (id: string, status: string, o: { reason?: string; start?: number; end?: number } = {}) => {
    const settled = status === "succeeded";
    const first = (o.reason ?? "subscription_create") === "subscription_create";
    return { payment_id: id, status, billing_reason: o.reason ?? "subscription_create", checkout_id: first ? `chk_${tag}` : null,
      reference: first ? reference : null, amount: "29.00", amount_paid: settled ? "29.00" : null, amount_remaining: settled ? "0.00" : "29.00",
      currency: "USD", customer: { email, name: null }, subscription_id: `sub_${tag}`,
      invoice: status === "open" && first ? null : { invoice_id: `inv_${id}`, subscription_id: `sub_${tag}`, period_start: iso(o.start ?? P1),
        period_end: iso(o.end ?? P2), kind: "cycle" },
      line_items: [{ product_id: "prod_open", product_name: "Business", quantity: 1, unit_amount: "29.00", currency: "USD", line_total: "29.00" }],
      created_at: iso(o.start ?? P1), updated_at: iso(o.start ?? P1) };
  };
  const setPayment = (id: string, body: unknown) => { route(id); provider.payments.set(id, body); };

  /** A signed collection.failed delivery through the real intake. Its body is a hint only. */
  const deliver = async (eventId: string, chargeId: string, type = "collection.failed") => {
    const raw = JSON.stringify({ id: eventId, type, created_at: new Date().toISOString(), organization_id: org,
      data: { charge_id: chargeId, status: "FAILED", failure_reason: "card_declined" } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", whsec).update(`${t}.${raw}`).digest("hex");
    const res = await handleWebhook(new Request(`https://edge.test/functions/v1/bachs-webhook?connection=${conn}`, { method: "POST",
      headers: { "content-type": "application/json", "x-bachs-signature-v2": `t=${t},v1=${sig}` }, body: raw }),
    { db: h.scoped("billing_intake"), nowSeconds: () => Math.floor(Date.now() / 1000), log: silent });
    expect(res.status).toBe(200);
  };
  const deps = (): WorkerDeps => ({ db: h.scoped("billing_worker"), transport: h.transport, now: () => new Date(), log: silent, workerId: `open-${tag}` });
  const inbox = async (eventId: string) => (await h.q<{ status: string; outcome: string | null; last_error_code: string | null; claimed: boolean; attempts: number }>(
    "select status, outcome, last_error_code, claim_token is not null as claimed, attempts from billing.webhook_inbox where event_id = $1", [eventId]))[0];
  const access = async () => ((await rpc("get_billing", { p_ws: ws })).data as { access: Record<string, unknown> }).access;
  /** Everything a payment observation could write for this workspace. */
  const footprint = async () => (await h.q<Record<string, unknown>>(`select
      (select count(*)::int from billing.paid_periods) as periods,
      (select count(*)::int from billing.subscriptions) as subscriptions,
      (select count(*)::int from billing.payment_failures) as failures,
      (select count(*)::int from billing.payment_tombstones) as tombstones,
      (select count(*)::int from billing.review_queue) as reviews,
      (select jsonb_agg(jsonb_build_object('status', status, 'version', version, 'sub', provider_subscription_id) order by created_at)
         from billing.checkout_intents where workspace_id = $1) as intents,
      (select version from billing.workspace_billing where workspace_id = $1) as billing_version`, [ws]))[0];
  return { h, ws, conn, tag, P1, P2, P3, provider, payment, setPayment, deliver, deps, inbox, access, footprint };
}

describe("observed 'open': first payment, then succeeded", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  let trial: Record<string, unknown>;
  beforeAll(async () => {
    s = await setup("opa", "eeeeeeee-0000-4000-8000-000000004b01", "eeeeeeee-0000-4000-8000-000000004b02");
    trial = await s.access();
  }, 120_000);
  afterAll(async () => { await s.h.close(); });

  it("collection.failed whose full GET says 'open' completes as payment_pending: no access, no grace, no retry", async () => {
    s.setPayment("ch_opa1", s.payment("ch_opa1", "open"));
    await s.deliver("evt_opa_failed1", "ch_opa1");
    expect(await processEvents(s.deps(), s.conn)).toEqual({ claimed: 1, done: 1, failed: 0, released: 0 });
    expect(await s.inbox("evt_opa_failed1")).toEqual({ status: "done", outcome: "payment_pending", last_error_code: null, claimed: false, attempts: 1 });
    expect(await s.footprint()).toMatchObject({ periods: 0, subscriptions: 0, failures: 0, tombstones: 0, reviews: 0,
      intents: [{ status: "open", version: expect.any(Number), sub: null }] });
    expect(await s.access()).toEqual(trial);
    expect(trial.state).toBe("trialing");
    // Nothing is left to retry: a later run claims nothing.
    expect(await processEvents(s.deps(), s.conn)).toEqual({ claimed: 0, done: 0, failed: 0, released: 0 });
  });

  it("observing the same open payment again is idempotent and writes nothing", async () => {
    const before = await s.footprint();
    await s.deliver("evt_opa_failed2", "ch_opa1");
    await s.deliver("evt_opa_invoice", "ch_opa1", "invoice.payment_failed");
    expect(await processEvents(s.deps(), s.conn)).toEqual({ claimed: 2, done: 2, failed: 0, released: 0 });
    for (const e of ["evt_opa_failed2", "evt_opa_invoice"]) expect((await s.inbox(e)).outcome, e).toBe("payment_pending");
    expect(await s.footprint()).toEqual(before);
    expect(await s.access()).toEqual(trial);
  });

  it("a later full GET of the same payment as succeeded grants normally; the pending observations did not block it", async () => {
    s.setPayment("ch_opa1", s.payment("ch_opa1", "succeeded"));
    s.provider.checkoutStatus = "completed";
    await s.deliver("evt_opa_paid", "ch_opa1", "collection.succeeded");
    expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect((await s.inbox("evt_opa_paid")).outcome).toBe("granted");
    expect(await s.footprint()).toMatchObject({ periods: 1, subscriptions: 1, failures: 0, reviews: 0, intents: [{ status: "paid", sub: "sub_opa" }] });
    expect(await s.access()).toMatchObject({ state: "active", limits: { locations: 3 } });
  });

  it("renewal: an open subscription_cycle charge records no payment failure; a later failed GET records it as before", async () => {
    const renewal = (status: string) => s.payment("ch_opa_cycle", status, { reason: "subscription_cycle", start: s.P2, end: s.P3 });
    const active = await s.access();
    s.setPayment("ch_opa_cycle", renewal("open"));
    await s.deliver("evt_opa_cycle_failed1", "ch_opa_cycle");
    expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect((await s.inbox("evt_opa_cycle_failed1")).outcome).toBe("payment_pending");
    expect(await s.footprint()).toMatchObject({ periods: 1, failures: 0, reviews: 0 });
    expect(await s.access()).toEqual(active);

    s.setPayment("ch_opa_cycle", renewal("failed"));
    await s.deliver("evt_opa_cycle_failed2", "ch_opa_cycle");
    expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect((await s.inbox("evt_opa_cycle_failed2")).outcome).toBe("renewal_failed");
    const failures = await s.h.q<{ provider_invoice_id: string; observations: number; period_start: string; resolved: boolean }>(
      "select provider_invoice_id, observations, period_start::text, resolved_at is not null as resolved from billing.payment_failures");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ provider_invoice_id: "inv_ch_opa_cycle", observations: 1, resolved: false });
    expect(new Date(failures[0].period_start).getTime()).toBe(s.P2);
    expect(await s.footprint()).toMatchObject({ periods: 1, failures: 1 });
  });
});

describe("observed 'open': first payment, then failed", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => { s = await setup("opb", "eeeeeeee-0000-4000-8000-000000004b11", "eeeeeeee-0000-4000-8000-000000004b12"); }, 120_000);
  afterAll(async () => { await s.h.close(); });

  it("open then failed takes the existing no-access path: no period, no binding, no grace", async () => {
    const trial = await s.access();
    s.setPayment("ch_opb1", s.payment("ch_opb1", "open"));
    await s.deliver("evt_opb_failed1", "ch_opb1");
    expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect((await s.inbox("evt_opb_failed1")).outcome).toBe("payment_pending");

    s.setPayment("ch_opb1", s.payment("ch_opb1", "failed"));
    await s.deliver("evt_opb_failed2", "ch_opb1");
    expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect((await s.inbox("evt_opb_failed2")).outcome).toBe("payment_failed_no_access");
    expect(await s.footprint()).toMatchObject({ periods: 0, subscriptions: 0, failures: 0, tombstones: 0, reviews: 0, intents: [{ status: "open", sub: null }] });
    expect(await s.access()).toEqual(trial);
  });

  it("an undocumented status other than exact 'open' is still dto_invalid and retried, never absorbed", async () => {
    const before = await s.footprint();
    const trial = await s.access();
    for (const [i, status] of ["OPEN", "pending", "authorized"].entries()) {
      s.setPayment("ch_opb2", { ...s.payment("ch_opb2", "open"), status });
      await s.deliver(`evt_opb_unknown${i}`, "ch_opb2");
      expect(await processEvents(s.deps(), s.conn), status).toEqual({ claimed: 1, done: 0, failed: 1, released: 0 });
      expect(await s.inbox(`evt_opb_unknown${i}`), status).toMatchObject({ status: "failed", outcome: null, last_error_code: "dto_invalid" });
    }
    expect(await s.footprint()).toEqual(before);
    expect(await s.access()).toEqual(trial);
  });
});

describe("migration 20261012164322 replaces absorb_payment with exactly one changed branch", () => {
  let h: H;
  beforeAll(async () => { h = await harness({ stopBefore: MIGRATION }); }, 120_000);
  afterAll(async () => { await h.close(); });

  it("keeps the body, security, search_path, owner and grants; only 'open' joins the pending branch", async () => {
    const def = async () => (await h.q<{ src: string; secdef: boolean; config: string[] | null; owner: string; acl: string | null }>(
      `select pg_get_functiondef(p.oid) as src, p.prosecdef as secdef, p.proconfig as config, pg_get_userbyid(p.proowner) as owner, p.proacl::text as acl
       from pg_proc p where p.oid = 'billing.absorb_payment(uuid, text, uuid, jsonb, timestamptz)'::regprocedure`))[0];
    const before = await def();
    await h.migrateRest();
    const after = await def();
    expect({ ...after, src: "" }).toEqual({ ...before, src: "" });
    const added = "  -- 'open' is the observed, undocumented non-final status (see the header): pending, never failure.\n";
    expect(after.src).toContain(added);
    expect(after.src.replace(added, "").replace("in ('created', 'processing', 'open')", "in ('created', 'processing')")).toBe(before.src);
  });
});
