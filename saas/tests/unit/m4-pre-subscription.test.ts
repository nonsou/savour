// Worker routing for the pre-subscription charge (an open purchase with no subscription and no invoice),
// over a recording fake database and a MOCK Bachs transport. Routing evidence only; the SQL effects are
// covered in tests/sql/m4-pre-subscription.test.ts. Fixtures are synthetic, shaped like the sanitized
// sandbox observation; no provider or network is involved.
import { describe, expect, it } from "vitest";
import { BachsClient, type TransportRequest, type TransportResponse } from "../../supabase/functions/_shared/bachs-client.ts";
import { parsePayment } from "../../supabase/functions/_shared/bachs-dto.ts";
import type { ArgType, ScopedDb } from "../../supabase/functions/_shared/db.ts";
import { absorbPaymentById, isPreSubscriptionAttempt, processEvents, type WorkerDeps } from "../../supabase/functions/_shared/worker-core.ts";

const KEY = "sk_sandbox_TESTONLY-presubkey0000001";
const CONN = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const T = "2026-10-12T10:00:00Z";
const ok = (body: unknown, status = 200): TransportResponse => ({ status, bodyText: JSON.stringify(body) });

/** The sandbox shape: full GET open, purchase, no subscription, no invoice, checkout_id of a SAVOUR checkout. */
const PAYMENT = { payment_id: "ch_pre1", status: "open", billing_reason: "purchase", checkout_id: "chk_pre1", reference: null, amount: "29.00",
  amount_paid: null, amount_remaining: "29.00", currency: "USD", customer: { email: "billing-pre@m4.savour.test", name: null },
  subscription_id: null, invoice: null, line_items: null, created_at: T, updated_at: T };
const INVOICE = { invoice_id: "inv_pre1", subscription_id: "sub_pre1", period_start: T, period_end: "2026-11-12T10:00:00Z", kind: "cycle" };
const CHECKOUT = { checkout_id: "chk_pre1", status: "open", payment_status: "requires_payment_method", recurring: { interval: "month", interval_count: 1 },
  amount: "29.00", currency: "USD", reference: "savour-ref", customer: { id: "cust_pre1", email: "billing-pre@m4.savour.test", name: null },
  products: [{ product_id: "prod_pre", product_name: "Business", quantity: 1, unit_amount: "29.00", currency: "USD", price_type: "fixed", line_total: "29.00" }],
  created_at: T, updated_at: T, expires_at: "2026-10-12T11:00:00Z", completed_at: null };
const SUBSCRIPTION = { id: "sub_pre1", customer: { customer_id: "cust_pre1", email: "billing-pre@m4.savour.test" }, status: "active", currency: "USD",
  amount: "29.00", billing_cycle: { interval: "month", frequency: 1 }, quantity: 1, current_period_start: T, current_period_end: "2026-11-12T10:00:00Z",
  cancel_at_period_end: false, canceled_at: null, created_at: T, product: { id: "prod_pre", name: "Business" },
  items: [{ id: "il_1", quantity: 1, price: { product_id: "prod_pre" } }], metadata: {} };

type Call = { fn: string; args: [ArgType, unknown][] };
function world(o: { payment?: unknown; checkout?: (req: TransportRequest) => TransportResponse; result?: Record<string, string | Error> } = {}) {
  const seen: string[] = [];
  const calls: Call[] = [];
  const transport = async (req: TransportRequest): Promise<TransportResponse> => {
    const path = new URL(req.url).pathname;
    seen.push(`${req.method} ${path}`);
    if (path === "/v1/payments/ch_pre1") return ok(o.payment ?? PAYMENT);
    if (path === "/v1/checkout-sessions/chk_pre1") return o.checkout ? o.checkout(req) : ok(CHECKOUT);
    if (path === "/v1/subscriptions/sub_pre1") return ok(SUBSCRIPTION);
    return ok({}, 404);
  };
  const db: ScopedDb = {
    role: "billing_worker",
    async call<X>(fn: string, args: [ArgType, unknown][]) {
      calls.push({ fn, args });
      if (fn === "platform.get_credential") return { provider_code: "bachs", base_url: "https://sandbox-api.bachs.io", key_pattern: null, api_key: KEY } as X;
      const r = o.result?.[fn];
      if (r instanceof Error) throw r;
      return (r ?? (fn.startsWith("billing.absorb_") ? "checkout_unchanged" : null)) as X;
    },
    async rows<X>(fn: string, args: [ArgType, unknown][]) {
      calls.push({ fn, args });
      return [{ event_id: "evt_pre1", event_type: "collection.failed", claim_token: TOKEN, attempts: 1, lease_until: "2999-01-01T00:00:00Z",
        body: JSON.stringify({ id: "evt_pre1", type: "collection.failed", created_at: T, organization_id: "acct_pre",
          // The envelope's checkout hint is deliberately wrong: only the full payment GET may name the checkout.
          data: { charge_id: "ch_pre1", checkout_id: "chk_webhook_hint", status: "FAILED" } }) }] as X[];
    },
  };
  const deps: WorkerDeps = { db, transport, now: () => new Date(T), log: () => undefined, workerId: "pre" };
  const client = new BachsClient({ apiKey: KEY, baseUrl: "https://sandbox-api.bachs.io" }, transport);
  const absorbs = () => calls.filter((c) => c.fn.startsWith("billing.absorb_"));
  const facts = (c: Call) => JSON.parse(c.args[3][1] as string);
  return { seen, calls, deps, client, absorbs, facts };
}
const run = (w: ReturnType<typeof world>) => absorbPaymentById(w.deps, w.client, CONN, "ch_pre1", "evt_pre1", TOKEN);

describe("pre-subscription routing in absorbPaymentById", () => {
  it("the exact five-field shape re-reads the checkout and absorbs only that checkout, fenced on event and token", async () => {
    const w = world();
    expect(await run(w)).toBe("pre_subscription:checkout_unchanged");
    expect(w.seen).toEqual(["GET /v1/payments/ch_pre1", "GET /v1/checkout-sessions/chk_pre1"]);
    expect(w.absorbs().map((c) => c.fn)).toEqual(["billing.absorb_checkout"]);
    const [call] = w.absorbs();
    expect(call.args.slice(0, 3)).toEqual([["uuid", CONN], ["text", "evt_pre1"], ["uuid", TOKEN]]);
    // Only the checkout object, exactly as parsed from the full GET; no payment facts ride along.
    expect(Object.keys(w.facts(call))).toEqual(["checkout"]);
    expect(w.facts(call).checkout).toMatchObject({ checkout_id: "chk_pre1", status: "open", amount: "29.00", reference: "savour-ref" });
  });

  it("prefixes every non-review checkout outcome and passes review outcomes through verbatim", async () => {
    for (const out of ["checkout_open", "checkout_unchanged", "checkout_completed", "checkout_closed"]) {
      expect(await run(world({ result: { "billing.absorb_checkout": out } }))).toBe(`pre_subscription:${out}`);
    }
    for (const out of ["review:unknown_checkout", "review:checkout_mismatch", "review:checkout_pointer_conflict"]) {
      expect(await run(world({ result: { "billing.absorb_checkout": out } }))).toBe(out);
    }
  });

  it("predicate: true only for the exact shape", () => {
    expect(isPreSubscriptionAttempt(parsePayment(PAYMENT))).toBe(true);
  });

  // Each field toggled alone falls through to the existing absorb_payment path, unchanged.
  const variants: [string, Record<string, unknown>][] = [
    ...["created", "processing", "failed", "expired", "cancelled", "succeeded", "accepted", "underpaid", "overpaid"]
      .map((status): [string, Record<string, unknown>] => [`status ${status}`, { status }]),
    ...["subscription_create", "subscription_cycle", "subscription_update", null]
      .map((billing_reason): [string, Record<string, unknown>] => [`billing_reason ${billing_reason}`, { billing_reason }]),
    ["subscription_id present", { subscription_id: "sub_pre1" }],
    ["invoice present", { invoice: INVOICE }],
    ["checkout_id null", { checkout_id: null }],
    ["checkout_id absent", { checkout_id: undefined }],
  ];
  for (const [label, patch] of variants) {
    it(`falls through when only ${label} differs`, async () => {
      const w = world({ payment: { ...PAYMENT, ...patch }, result: { "billing.absorb_payment": "existing_path" } });
      expect(isPreSubscriptionAttempt(parsePayment({ ...PAYMENT, ...patch }))).toBe(false);
      expect(await run(w)).toBe("existing_path");
      expect(w.absorbs().map((c) => c.fn)).toEqual(["billing.absorb_payment"]);
      // The existing path reads a checkout only for subscription_create, exactly as before.
      const p = { ...PAYMENT, ...patch } as Record<string, unknown>;
      expect(w.seen.includes("GET /v1/checkout-sessions/chk_pre1")).toBe(p.billing_reason === "subscription_create" && !!p.checkout_id);
    });
  }

  it("the sanitized non-open purchase without subscription still reaches absorb_payment (payment_not_subscription stays SQL's call)", async () => {
    const w = world({ payment: { ...PAYMENT, status: "failed" }, result: { "billing.absorb_payment": "review:payment_not_subscription" } });
    expect(await run(w)).toBe("review:payment_not_subscription");
    expect(w.facts(w.absorbs()[0])).toEqual({ payment: parsePayment({ ...PAYMENT, status: "failed" }), subscription: null, checkout: null });
  });

  for (const status of ["refunded", "auto_refunded", "partially_refunded"]) {
    it(`refund precedence: ${status} with the otherwise matching shape goes to absorb_refund and never reads the checkout`, async () => {
      const w = world({ payment: { ...PAYMENT, status }, result: { "billing.absorb_refund": "refund_recorded" } });
      expect(await run(w)).toBe("refund_recorded");
      expect(w.absorbs().map((c) => c.fn)).toEqual(["billing.absorb_refund"]);
      expect(w.seen).toEqual(["GET /v1/payments/ch_pre1"]);
    });
  }
});

describe("pre-subscription branch fails closed through the normal event retry", () => {
  const outcome = async (w: ReturnType<typeof world>) => {
    const r = await processEvents(w.deps, CONN);
    const done = w.calls.find((c) => c.fn === "billing.complete_event");
    const failed = w.calls.find((c) => c.fn === "billing.fail_event");
    return { r, done: done?.args[3][1] ?? null, failed: failed?.args[3][1] ?? null, absorbs: w.absorbs().map((c) => c.fn) };
  };

  it("completes the event with the prefixed outcome; the webhook checkout hint is never used", async () => {
    const w = world({ result: { "billing.absorb_checkout": "checkout_open" } });
    expect(await outcome(w)).toEqual({ r: { claimed: 1, done: 1, failed: 0, released: 0 }, done: "pre_subscription:checkout_open", failed: null,
      absorbs: ["billing.absorb_checkout"] });
    expect(w.seen.some((s) => s.includes("chk_webhook_hint"))).toBe(false);
  });

  const failures: [string, (req: TransportRequest) => TransportResponse, string][] = [
    ["checkout GET 404", () => ok({}, 404), "provider_refused_checkout_404"],
    ["checkout GET 503", () => ok({}, 503), "provider_server"],
    ["checkout GET timeout", () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }, "provider_timeout"],
    ["checkout GET rate limited", () => ok({}, 429), "provider_rate_limited"],
    ["checkout GET malformed body", () => ({ status: 200, bodyText: "not json" }), "dto_invalid"],
    ["checkout GET null body", () => ok(null), "dto_invalid"],
    ["checkout GET unknown status", () => ok({ ...CHECKOUT, status: "processing" }), "dto_invalid"],
    ["checkout GET status case drift", () => ok({ ...CHECKOUT, status: "OPEN" }), "dto_invalid"],
    ["checkout GET for another checkout id", () => ok({ ...CHECKOUT, checkout_id: "chk_other" }), "provider_checkout_id_mismatch"],
  ];
  for (const [label, checkout, code] of failures) {
    it(`${label}: fail_event ${code}, nothing absorbed`, async () => {
      expect(await outcome(world({ checkout }))).toEqual({ r: { claimed: 1, done: 0, failed: 1, released: 0 }, done: null, failed: code, absorbs: [] });
    });
  }

  it("a lost claim (fence) is not recorded as done or failed", async () => {
    const w = world({ result: { "billing.absorb_checkout": new Error("stale_claim") } });
    expect(await outcome(w)).toEqual({ r: { claimed: 1, done: 0, failed: 1, released: 0 }, done: null, failed: null, absorbs: ["billing.absorb_checkout"] });
  });
});
