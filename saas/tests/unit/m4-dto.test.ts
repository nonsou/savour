// Parsers against shapes taken from the official Bachs OpenAPI v1.0.0 schemas and documented examples.
// Contract fixtures only: they prove faithful parsing, not that the sandbox behaves this way.
import { describe, expect, it } from "vitest";
import {
  DtoError, extractHints, parseCheckout, parseCreateCheckoutResponse, parseEnvelope, parsePayment, parsePortalSession, parseProduct, parseSubscription,
} from "../../supabase/functions/_shared/bachs-dto.ts";

// SubscriptionResponse example from the official subscriptions guide.
const SUBSCRIPTION = {
  id: "sub_1a2b3c4d5e6f", customer: { customer_id: "cust_xyz789", email: "customer@example.com", name: "Jane Doe" },
  payment_method_id: "pm_7h8i9j0k", status: "active", collection_method: "charge_automatically", currency: "USD", amount: "10.00",
  billing_cycle: { interval: "month", frequency: 1 }, quantity: 1, current_period_start: "2026-07-13T12:00:00Z",
  current_period_end: "2026-08-13T12:00:00Z", previously_billed_at: "2026-07-13T12:00:00Z", next_billed_at: "2026-08-13T12:00:00Z",
  trial_end: null, cancel_at_period_end: false, canceled_at: null, created_at: "2026-07-13T12:00:00Z",
  product: { id: "prod_abc123", name: "Pro plan", billing_cycle: { interval: "month", frequency: 1 } },
  items: [{ id: "il_11aa22bb", status: "active", quantity: 1, recurring: true, price_type: "fixed", unit_amount: "10.00", currency: "USD",
    previously_billed_at: "2026-07-13T12:00:00Z", next_billed_at: "2026-08-13T12:00:00Z", price: { id: "price_1", product_id: "prod_abc123" } }],
  metadata: { plan: "pro" },
};
// PaymentResponse with the subscription fields documented in the API changelog.
const PAYMENT = {
  payment_id: "ch_1a2b3c4d5e6f", status: "succeeded", billing_reason: "subscription_create", checkout_id: "chk_6R7s8T9u0V1w2X3y",
  reference: "savour_ck_0123456789abcdef0123456789abcdef", amount: "10.00", amount_paid: "10.00", amount_remaining: "0.00", currency: "USD",
  customer: { name: "Jane Doe", email: "customer@example.com" }, subscription_id: "sub_1a2b3c4d5e6f",
  invoice: { invoice_id: "inv_1a2b3c4d5e", number: null, subscription_id: "sub_1a2b3c4d5e6f", period_start: "2026-07-13T12:00:00Z",
    period_end: "2026-08-13T12:00:00Z", kind: "cycle" },
  line_items: [{ product_id: "prod_abc123", product_name: "Pro plan", quantity: 1, unit_amount: "10.00", currency: "USD", line_total: "10.00" }],
  created_at: "2026-07-13T12:00:00Z", updated_at: "2026-07-13T12:00:01Z", fee_usd: null, some_future_field: { nested: true },
};
const CHECKOUT = {
  checkout_id: "chk_6R7s8T9u0V1w2X3y", status: "completed", recurring: { interval: "month", interval_count: 1 }, payment_status: "succeeded",
  amount: "10.00", currency: "USD", reference: "savour_ck_0123456789abcdef0123456789abcdef", charge: PAYMENT,
  customer: { id: "cust_xyz789", email: "customer@example.com", name: null }, customer_details: null,
  products: [{ product_id: "prod_abc123", product_name: "Pro plan", quantity: 1, unit_amount: "10.00", currency: "USD", price_type: "fixed", line_total: "10.00" }],
  created_at: "2026-07-13T11:58:00Z", updated_at: "2026-07-13T12:00:01Z", expires_at: "2026-07-13T12:58:00Z", completed_at: "2026-07-13T12:00:01Z",
};

describe("Bachs DTO parsing", () => {
  it("normalizes a subscription, payment and checkout into the facts the database binds", () => {
    expect(parseSubscription(SUBSCRIPTION)).toEqual({ id: "sub_1a2b3c4d5e6f", customer_id: "cust_xyz789", status: "active", currency: "USD",
      amount: "10.00", interval: "month", frequency: 1, quantity: 1, product_id: "prod_abc123", item_product_ids: ["prod_abc123"],
      current_period_start: "2026-07-13T12:00:00Z", current_period_end: "2026-08-13T12:00:00Z", cancel_at_period_end: false, canceled_at: null });
    expect(parsePayment(PAYMENT)).toMatchObject({ payment_id: "ch_1a2b3c4d5e6f", amount_paid: "10.00", customer_email: "customer@example.com",
      invoice: { invoice_id: "inv_1a2b3c4d5e", kind: "cycle" }, line_items: [{ product_id: "prod_abc123", quantity: 1, unit_amount: "10.00", currency: "USD" }] });
    expect(parseCheckout(CHECKOUT)).toMatchObject({ customer_id: "cust_xyz789", product_ids: ["prod_abc123"], charge_payment_id: "ch_1a2b3c4d5e6f",
      recurring: { interval: "month", interval_count: 1 } });
  });

  it("tolerates unknown fields but validates every field SAVOUR relies on", () => {
    expect(() => parsePayment({ ...PAYMENT, extra: [1, 2, 3] })).not.toThrow();
    const bad: [string, () => unknown][] = [
      ["missing status", () => parsePayment({ ...PAYMENT, status: undefined })],
      ["unknown status", () => parsePayment({ ...PAYMENT, status: "paid" })],
      ["numeric amount", () => parsePayment({ ...PAYMENT, amount: 10 })],
      ["exponent amount", () => parsePayment({ ...PAYMENT, amount_paid: "1e1" })],
      ["bad period", () => parsePayment({ ...PAYMENT, invoice: { ...PAYMENT.invoice, period_end: "next month" } })],
      ["missing customer id", () => parseSubscription({ ...SUBSCRIPTION, customer: { email: "x@y.z" } })],
      ["string quantity", () => parseSubscription({ ...SUBSCRIPTION, quantity: "1" })],
      ["missing items", () => parseSubscription({ ...SUBSCRIPTION, items: undefined })],
      ["missing cancel flag", () => parseSubscription({ ...SUBSCRIPTION, cancel_at_period_end: undefined })],
      ["checkout without customer", () => parseCheckout({ ...CHECKOUT, customer: undefined })],
      ["http checkout url", () => parseCreateCheckoutResponse({ checkout_id: "chk_1", checkout_url: "http://x.test", status: "open", expires_at: "2026-07-13T12:58:00Z" })],
      ["portal without psn id", () => parsePortalSession({ id: "x", url: "https://portal.bachs.io/s/1" })],
      ["path-like id", () => parsePayment({ ...PAYMENT, payment_id: "../../v1/admin" })],
    ];
    for (const [label, f] of bad) expect(f, label).toThrow(DtoError);
  });

  it("marks quantities other than one so they can never match the one-seat plan", () => {
    const facts = parseCheckout({ ...CHECKOUT, products: [{ ...CHECKOUT.products[0], quantity: 2 }] });
    expect(facts.product_ids).toEqual(["prod_abc123#quantity=2"]);
    const sub = parseSubscription({ ...SUBSCRIPTION, product: null, items: [{ ...SUBSCRIPTION.items[0], price: null, product: null }] });
    expect(sub.product_id).toBeNull();
  });

  it("extracts only identifier hints from documented event envelopes", () => {
    const collection = parseEnvelope({ id: "evt_3ab4e0d5d27445cf8a52ab3d8cb8f0b1", type: "collection.succeeded", created_at: "2026-09-22T10:41:18.402Z",
      organization_id: "acct_7KpQ2mNv4XbR9dLc", data: { charge_id: "ch_1a2b3c4d5e6f", checkout_id: "chk_6R7s8T9u0V1w2X3y", amount: "75000.00" } });
    expect(extractHints(collection)).toMatchObject({ paymentId: "ch_1a2b3c4d5e6f", checkoutId: "chk_6R7s8T9u0V1w2X3y" });
    const invoice = parseEnvelope({ id: "evt_1a2b3c4d5e6f7g8h", type: "invoice.paid", created_at: "2026-04-27T12:00:00.000000+00:00",
      organization_id: "acct_7KpQ2mNv4XbR9dLc", data: { invoice_id: "inv_1", subscription: { subscription_id: "sub_1a2b3c4d5e" }, charge: null } });
    expect(extractHints(invoice)).toMatchObject({ paymentId: null, subscriptionId: "sub_1a2b3c4d5e" });
    const connect = parseEnvelope({ id: "evt_1a2b3c4d5e6f7g8h", type: "capability.updated", created_at: "2026-08-07T11:06:41.204000+00:00",
      organization_id: "acct_3Wq8ZfT1yHnJ5sVe", account: "acct_3Wq8ZfT1yHnJ5sVe", data: {} });
    expect(connect.account).toBe("acct_3Wq8ZfT1yHnJ5sVe");
    expect(() => parseEnvelope({ id: "nope", type: "x.y", created_at: "2026-01-01T00:00:00Z", organization_id: "a", data: {} })).toThrow(DtoError);
  });

  it("reads products for the connection test (cadence and per-currency prices)", () => {
    expect(parseProduct({ id: "prod_abc123", status: "active", billing_cycle: { interval: "month", frequency: 1 },
      price: { currency: "USD", price_type: "fixed", amount: "29.00" }, prices: [{ currency: "NGN", amount: "25000.00", is_default: false }] }))
      .toEqual({ id: "prod_abc123", status: "active", interval: "month", frequency: 1, prices: [{ currency: "NGN", amount: "25000.00" }, { currency: "USD", amount: "29.00" }] });
  });
});
