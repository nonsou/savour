// Pre-subscription charge on embedded Postgres through the real webhook intake, worker and SQL, with a
// MOCK Bachs transport. No migration: the worker routes an open purchase charge with no subscription and
// no invoice to the existing absorb_checkout. Fixtures are synthetic and only shaped like the sanitized
// sandbox observation (full payment GET open/purchase/no subscription/no invoice with the checkout_id of
// a SAVOUR intent); they are contract evidence, not evidence of how the sandbox behaves.
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BachsClient, type TransportRequest } from "../../supabase/functions/_shared/bachs-client.ts";
import { startCheckout } from "../../supabase/functions/_shared/owner-core.ts";
import { handleWebhook } from "../../supabase/functions/_shared/webhook-core.ts";
import { absorbPaymentById, processEvents, type WorkerDeps } from "../../supabase/functions/_shared/worker-core.ts";
import { harness, ok } from "./m4-harness";

const iso = (ms: number) => new Date(ms).toISOString();
const addMonth = (ms: number) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); };
const silent = () => undefined;

/** One workspace with an open checkout intent on a fresh database. Provider reads come from `provider`. */
async function setup(tag: string, owner: string, admin: string) {
  const h = await harness();
  const email = `billing-${tag}@m4.savour.test`;
  const org = `acct_${tag}`;
  const label = `Pre ${tag}`;
  const key = `sk_sandbox_TESTONLY${tag}key00000000001`;
  const whsec = `whsec_TESTONLY_${label.replace(/\W/g, "")}_000000`;
  const P1 = Date.now() - 3600_000;
  const P2 = addMonth(P1);
  await h.q("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [owner, `m4-${tag}-owner@savour.test`]);
  const rpc = h.userRpc(owner);
  const ws = (await rpc("create_workspace", { p_name: `Pre ${tag} Co`, p_country: "Nigeria", p_timezone: "Africa/Lagos", p_display_name: "Owner" })).data as string;
  await rpc("set_billing_contact", { p_ws: ws, p_email: email, p_consent: true, p_expected_version: 1 });
  const conn = await h.connection(admin, label, key, org);
  await h.q("select billing.operator_configure_price($1, 'USD', '29.00', 'prod_pre', 'disposable fixture')", [conn]);
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
  const provider = { payments: new Map<string, unknown>(), checkouts: new Map<string, () => unknown>() };
  const checkout = (o: { id?: string; status?: string; amount?: string; reference?: string | null } = {}) => {
    const done = o.status === "completed";
    return { checkout_id: o.id ?? `chk_${tag}`, status: o.status ?? "open", recurring: { interval: "month", interval_count: 1 },
      payment_status: done ? "succeeded" : "requires_payment_method", amount: o.amount ?? "29.00", currency: "USD",
      reference: o.reference === undefined ? reference : o.reference, customer: { id: `cust_${tag}`, email, name: null },
      products: [{ product_id: "prod_pre", product_name: "Business", quantity: 1, unit_amount: o.amount ?? "29.00", currency: "USD", price_type: "fixed",
        line_total: o.amount ?? "29.00" }],
      created_at: iso(P1), updated_at: iso(P1), expires_at: iso(Date.now() + 3600_000), completed_at: done ? iso(P1) : null,
      ...(done ? { charge: { payment_id: `ch_${tag}_paid` } } : {}) };
  };
  const setCheckout = (id: string, body: () => unknown) => {
    h.routes.set(`GET /v1/checkout-sessions/${id}`, () => { const f = provider.checkouts.get(id); return f ? ok(f()) : ok({}, 404); });
    provider.checkouts.set(id, body);
  };
  setCheckout(`chk_${tag}`, () => checkout());
  const subscription = () => ({ id: `sub_${tag}`, customer: { customer_id: `cust_${tag}`, email }, status: "active", currency: "USD", amount: "29.00",
    billing_cycle: { interval: "month", frequency: 1 }, quantity: 1, current_period_start: iso(P1), current_period_end: iso(P2),
    cancel_at_period_end: false, canceled_at: null, created_at: iso(P1), product: { id: "prod_pre", name: "Business" },
    items: [{ id: "il_1", quantity: 1, price: { product_id: "prod_pre" } }], metadata: {} });
  h.routes.set(`GET /v1/subscriptions/sub_${tag}`, () => ok(subscription()));

  /** The sanitized sandbox shape: open, purchase, no subscription, no invoice, the SAVOUR checkout_id. */
  const attempt = (id: string, o: Record<string, unknown> = {}) => ({ payment_id: id, status: "open", billing_reason: "purchase", checkout_id: `chk_${tag}`,
    reference: null, amount: "29.00", amount_paid: null, amount_remaining: "29.00", currency: "USD", customer: { email, name: null },
    subscription_id: null, invoice: null, line_items: null, created_at: iso(P1), updated_at: iso(P1), ...o });
  /** The later successful first payment on the same checkout (existing grant path). */
  const paid = (id: string) => ({ payment_id: id, status: "succeeded", billing_reason: "subscription_create", checkout_id: `chk_${tag}`, reference,
    amount: "29.00", amount_paid: "29.00", amount_remaining: "0.00", currency: "USD", customer: { email, name: null }, subscription_id: `sub_${tag}`,
    invoice: { invoice_id: `inv_${id}`, subscription_id: `sub_${tag}`, period_start: iso(P1), period_end: iso(P2), kind: "cycle" },
    line_items: [{ product_id: "prod_pre", product_name: "Business", quantity: 1, unit_amount: "29.00", currency: "USD", line_total: "29.00" }],
    created_at: iso(P1), updated_at: iso(P1) });
  const setPayment = (id: string, body: unknown) => {
    h.routes.set(`GET /v1/payments/${id}`, () => provider.payments.has(id) ? ok(provider.payments.get(id)) : ok({}, 404));
    provider.payments.set(id, body);
  };

  /** A signed delivery through the real intake. Its body is a hint only. */
  const deliver = async (eventId: string, type: string, data: Record<string, unknown>) => {
    const raw = JSON.stringify({ id: eventId, type, created_at: new Date().toISOString(), organization_id: org, data });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", whsec).update(`${t}.${raw}`).digest("hex");
    const res = await handleWebhook(new Request(`https://edge.test/functions/v1/bachs-webhook?connection=${conn}`, { method: "POST",
      headers: { "content-type": "application/json", "x-bachs-signature-v2": `t=${t},v1=${sig}` }, body: raw }),
    { db: h.scoped("billing_intake"), nowSeconds: () => Math.floor(Date.now() / 1000), log: silent });
    expect(res.status).toBe(200);
  };
  /** collection.failed carrying a deliberately wrong checkout hint: only the full payment GET may name the checkout. */
  const declined = (eventId: string, chargeId: string) =>
    deliver(eventId, "collection.failed", { charge_id: chargeId, checkout_id: "chk_webhook_hint", status: "FAILED", failure_reason: "card_declined" });
  const deps = (): WorkerDeps => ({ db: h.scoped("billing_worker"), transport: h.transport, now: () => new Date(), log: silent, workerId: `pre-${tag}` });
  const client = () => new BachsClient({ apiKey: key, baseUrl: "https://sandbox-api.bachs.io" }, h.transport);
  const inbox = async (eventId: string) => (await h.q<{ status: string; outcome: string | null; last_error_code: string | null }>(
    "select status, outcome, last_error_code from billing.webhook_inbox where event_id = $1", [eventId]))[0];
  const access = async () => ((await rpc("get_billing", { p_ws: ws })).data as { access: Record<string, unknown> }).access;
  const intent = async () => (await h.q<{ status: string; checkout: string | null; error: string | null }>(
    "select status, provider_checkout_id as checkout, last_error_code as error from billing.checkout_intents where workspace_id = $1", [ws]))[0];
  /** Everything a payment or checkout observation could write. */
  const footprint = async () => (await h.q<Record<string, unknown>>(`select
      (select count(*)::int from billing.paid_periods) as periods,
      (select count(*)::int from billing.subscriptions) as subscriptions,
      (select count(*)::int from billing.payment_failures) as failures,
      (select count(*)::int from billing.payment_tombstones) as tombstones,
      (select coalesce(jsonb_agg(kind order by kind), '[]') from billing.review_queue) as reviews,
      (select jsonb_agg(jsonb_build_object('status', status, 'version', version, 'sub', provider_subscription_id, 'checkout', provider_checkout_id)
         order by created_at) from billing.checkout_intents where workspace_id = $1) as intents,
      (select version from billing.workspace_billing where workspace_id = $1) as billing_version`, [ws]))[0];
  return { h, ws, conn, tag, provider, checkout, setCheckout, attempt, paid, setPayment, deliver, declined, deps, client, inbox, access, intent, footprint };
}

describe("pre-subscription attempt, repeat, then success on the same checkout", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  let trial: Record<string, unknown>;
  beforeAll(async () => {
    s = await setup("psa", "eeeeeeee-0000-4000-8000-000000004c01", "eeeeeeee-0000-4000-8000-000000004c02");
    trial = await s.access();
  }, 120_000);
  afterAll(async () => { await s.h.close(); });

  it("absorbs only the re-read checkout: done as pre_subscription:checkout_unchanged, no grant, no grace, no review", async () => {
    const before = await s.footprint();
    expect(trial.state).toBe("trialing");
    s.setPayment("ch_psa1", s.attempt("ch_psa1"));
    await s.declined("evt_psa1", "ch_psa1");
    expect(await processEvents(s.deps(), s.conn)).toEqual({ claimed: 1, done: 1, failed: 0, released: 0 });
    expect(await s.inbox("evt_psa1")).toEqual({ status: "done", outcome: "pre_subscription:checkout_unchanged", last_error_code: null });
    expect(await s.footprint()).toEqual(before);
    expect(before).toMatchObject({ periods: 0, subscriptions: 0, failures: 0, tombstones: 0, reviews: [],
      intents: [{ status: "open", sub: null, checkout: "chk_psa" }] });
    expect(await s.access()).toEqual(trial);
    expect(s.h.seen.some((r) => r.url.includes("chk_webhook_hint"))).toBe(false);
  });

  it("a repeat observation of the same attempt is idempotent; nothing is left to retry", async () => {
    const before = await s.footprint();
    await s.declined("evt_psa2", "ch_psa1");
    await s.deliver("evt_psa3", "invoice.payment_failed", { charge_id: "ch_psa1" });
    expect(await processEvents(s.deps(), s.conn)).toEqual({ claimed: 2, done: 2, failed: 0, released: 0 });
    for (const e of ["evt_psa2", "evt_psa3"]) expect((await s.inbox(e)).outcome, e).toBe("pre_subscription:checkout_unchanged");
    expect(await s.footprint()).toEqual(before);
    expect(await processEvents(s.deps(), s.conn)).toEqual({ claimed: 0, done: 0, failed: 0, released: 0 });
  });

  it("fencing: replaying a finished event's claim, or a forged token, is refused with stale_claim and writes nothing", async () => {
    const before = await s.footprint();
    for (const event of ["evt_psa1", "evt_unclaimed"]) {
      await expect(absorbPaymentById(s.deps(), s.client(), s.conn, "ch_psa1", event, randomUUID())).rejects.toThrow("stale_claim");
    }
    expect(await s.inbox("evt_psa1")).toMatchObject({ status: "done", outcome: "pre_subscription:checkout_unchanged" });
    expect(await s.footprint()).toEqual(before);
  });

  it("a different attempt on the same checkout is routed the same way", async () => {
    const before = await s.footprint();
    s.setPayment("ch_psa2", s.attempt("ch_psa2"));
    await s.declined("evt_psa4", "ch_psa2");
    expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect((await s.inbox("evt_psa4")).outcome).toBe("pre_subscription:checkout_unchanged");
    expect(await s.footprint()).toEqual(before);
  });

  it("the later successful payment on the same checkout grants through the existing path", async () => {
    s.setCheckout("chk_psa", () => s.checkout({ status: "completed" }));
    s.setPayment("ch_psa_paid", s.paid("ch_psa_paid"));
    await s.deliver("evt_psa_paid", "collection.succeeded", { charge_id: "ch_psa_paid" });
    expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect((await s.inbox("evt_psa_paid")).outcome).toBe("granted");
    expect(await s.footprint()).toMatchObject({ periods: 1, subscriptions: 1, failures: 0, reviews: [], intents: [{ status: "paid", sub: "sub_psa" }] });
    expect(await s.access()).toMatchObject({ state: "active", limits: { locations: 3 } });
  });

  it("a late attempt observation after the grant changes nothing", async () => {
    const before = await s.footprint();
    const active = await s.access();
    await s.declined("evt_psa_late", "ch_psa1");
    expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect((await s.inbox("evt_psa_late")).outcome).toBe("pre_subscription:checkout_unchanged");
    expect(await s.footprint()).toEqual(before);
    expect(await s.access()).toEqual(active);
  });
});

describe("pre-subscription attempt: intent states, provider failures and unchanged fall-through", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  let trial: Record<string, unknown>;
  beforeAll(async () => {
    s = await setup("psb", "eeeeeeee-0000-4000-8000-000000004c11", "eeeeeeee-0000-4000-8000-000000004c12");
    trial = await s.access();
  }, 120_000);
  afterAll(async () => { await s.h.close(); });

  it("an intent still in requesting becomes open (pre_subscription:checkout_open)", async () => {
    await s.h.q("update billing.checkout_intents set status = 'requesting' where workspace_id = $1", [s.ws]);
    s.setPayment("ch_psb1", s.attempt("ch_psb1"));
    await s.declined("evt_psb1", "ch_psb1");
    expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect((await s.inbox("evt_psb1")).outcome).toBe("pre_subscription:checkout_open");
    expect(await s.intent()).toMatchObject({ status: "open", checkout: "chk_psb" });
    expect(await s.footprint()).toMatchObject({ periods: 0, subscriptions: 0, failures: 0, reviews: [] });
  });

  it("an unavailable or malformed checkout GET fails the event for retry and writes nothing", async () => {
    const before = await s.footprint();
    const cases: [string, () => void, string][] = [
      ["missing", () => s.provider.checkouts.delete("chk_psb"), "provider_refused_checkout_404"],
      ["unknown status", () => s.setCheckout("chk_psb", () => ({ ...s.checkout(), status: "processing" })), "dto_invalid"],
      ["another checkout", () => s.setCheckout("chk_psb", () => s.checkout({ id: "chk_psb_other" })), "provider_checkout_id_mismatch"],
    ];
    for (const [i, [label, arrange, code]] of cases.entries()) {
      arrange();
      await s.declined(`evt_psb_fail${i}`, "ch_psb1");
      expect(await processEvents(s.deps(), s.conn), label).toEqual({ claimed: 1, done: 0, failed: 1, released: 0 });
      expect(await s.inbox(`evt_psb_fail${i}`), label).toMatchObject({ status: "failed", outcome: null, last_error_code: code });
    }
    expect(await s.footprint()).toEqual(before);
    expect(await s.access()).toEqual(trial);
    s.setCheckout("chk_psb", () => s.checkout());
  });

  it("a payment naming an unknown checkout is queued as review:unknown_checkout", async () => {
    s.setCheckout("chk_ghost", () => s.checkout({ id: "chk_ghost", reference: "not-a-savour-reference" }));
    s.setPayment("ch_psb_ghost", s.attempt("ch_psb_ghost", { checkout_id: "chk_ghost" }));
    await s.declined("evt_psb_ghost", "ch_psb_ghost");
    expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect((await s.inbox("evt_psb_ghost")).outcome).toBe("review:unknown_checkout");
    expect(await s.footprint()).toMatchObject({ periods: 0, subscriptions: 0, reviews: ["unknown_checkout"], intents: [{ status: "open" }] });
  });

  it("other shapes keep the existing path: a declined purchase with no subscription is still review:payment_not_subscription", async () => {
    for (const [i, patch] of [{ status: "failed" }, { billing_reason: null }].entries()) {
      s.setPayment(`ch_psb_old${i}`, s.attempt(`ch_psb_old${i}`, patch));
      await s.declined(`evt_psb_old${i}`, `ch_psb_old${i}`);
      expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
      expect((await s.inbox(`evt_psb_old${i}`)).outcome).toBe("review:payment_not_subscription");
    }
    expect(await s.footprint()).toMatchObject({ periods: 0, subscriptions: 0, reviews: ["payment_not_subscription", "payment_not_subscription", "unknown_checkout"] });
    expect(await s.access()).toEqual(trial);
  });

  it("a tampered checkout amount is review:checkout_mismatch and marks the intent; a later attempt leaves it in review", async () => {
    s.setCheckout("chk_psb", () => s.checkout({ amount: "1.00" }));
    s.setPayment("ch_psb2", s.attempt("ch_psb2"));
    await s.declined("evt_psb_tamper", "ch_psb2");
    expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect((await s.inbox("evt_psb_tamper")).outcome).toBe("review:checkout_mismatch");
    expect(await s.intent()).toMatchObject({ status: "review", error: "checkout_mismatch" });

    s.setCheckout("chk_psb", () => s.checkout());
    const before = await s.footprint();
    await s.declined("evt_psb_after", "ch_psb2");
    expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect((await s.inbox("evt_psb_after")).outcome).toBe("pre_subscription:checkout_unchanged");
    expect(await s.footprint()).toEqual(before);
    expect(await s.intent()).toMatchObject({ status: "review" });
    expect(await s.access()).toEqual(trial);
  });
});

describe("pre-subscription attempt and checkout.completed commute", () => {
  const runOrder = async (tag: string, ids: [string, string], attemptFirst: boolean) => {
    const s = await setup(tag, ...ids);
    try {
      s.setPayment(`ch_${tag}1`, s.attempt(`ch_${tag}1`));
      // The checkout reads completed, but its charge is not yet paid: only completed_unpaid, never a grant.
      s.setCheckout(`chk_${tag}`, () => s.checkout({ status: "completed" }));
      s.setPayment(`ch_${tag}_paid`, { ...s.paid(`ch_${tag}_paid`), status: "processing", amount_paid: null, amount_remaining: "29.00" });
      const attempt = () => s.declined(`evt_${tag}_attempt`, `ch_${tag}1`);
      const completed = () => s.deliver(`evt_${tag}_completed`, "checkout.completed", { checkout_id: `chk_${tag}` });
      for (const step of attemptFirst ? [attempt, completed] : [completed, attempt]) {
        await step();
        expect(await processEvents(s.deps(), s.conn)).toMatchObject({ claimed: 1, done: 1, failed: 0 });
      }
      return { attempt: (await s.inbox(`evt_${tag}_attempt`)).outcome, intent: await s.intent(), access: (await s.access()).state,
        footprint: { ...(await s.footprint()), billing_version: null, intents: null } };
    } finally { await s.h.close(); }
  };

  it("either order reaches the same final state", async () => {
    const a = await runOrder("psc", ["eeeeeeee-0000-4000-8000-000000004c21", "eeeeeeee-0000-4000-8000-000000004c22"], true);
    const b = await runOrder("psd", ["eeeeeeee-0000-4000-8000-000000004c31", "eeeeeeee-0000-4000-8000-000000004c32"], false);
    expect(a.attempt).toBe("pre_subscription:checkout_completed");
    expect(b.attempt).toBe("pre_subscription:checkout_completed");
    expect(a.intent).toEqual({ status: "completed_unpaid", checkout: "chk_psc", error: null });
    expect(b.intent).toEqual({ status: "completed_unpaid", checkout: "chk_psd", error: null });
    expect(a.access).toBe("trialing");
    expect(b.access).toBe("trialing");
    expect(a.footprint).toEqual(b.footprint);
    expect(a.footprint).toMatchObject({ periods: 0, subscriptions: 0, failures: 0, tombstones: 0, reviews: [] });
  }, 240_000);
});
