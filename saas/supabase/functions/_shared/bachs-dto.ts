// Faithful parsers for the Bachs OpenAPI v1.0.0 DTOs that SAVOUR reads (schemas named in comments).
// Lenient on unknown fields (the provider adds fields as a compatible change); strict on every field
// SAVOUR relies on: wrong type, missing required value, bad enum or malformed money/time is a DtoError
// and nothing is absorbed. Output "facts" are the snake_case shapes the SQL absorb_* functions bind.
// Money stays a provider decimal string here; SQL converts with billing.to_minor (exact, scale-checked).

export class DtoError extends Error {
  constructor(public readonly path: string, reason: string) {
    super(`dto_invalid: ${path} ${reason}`);
  }
}

type J = Record<string, unknown>;
const ID = /^[A-Za-z0-9_]{1,128}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,14})(\.[0-9]+)?$/;

function obj(x: unknown, path: string): J {
  if (typeof x !== "object" || x === null || Array.isArray(x)) throw new DtoError(path, "must be an object");
  return x as J;
}
function optObj(x: unknown, path: string): J | null {
  return x === null || x === undefined ? null : obj(x, path);
}
function str(x: unknown, path: string, re?: RegExp): string {
  if (typeof x !== "string" || x.length === 0 || x.length > 2048) throw new DtoError(path, "must be a non-empty string");
  if (re && !re.test(x)) throw new DtoError(path, "has an unexpected format");
  return x;
}
function optStr(x: unknown, path: string, re?: RegExp): string | null {
  return x === null || x === undefined ? null : str(x, path, re);
}
function bool(x: unknown, path: string): boolean {
  if (typeof x !== "boolean") throw new DtoError(path, "must be a boolean");
  return x;
}
function int(x: unknown, path: string): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0) throw new DtoError(path, "must be a non-negative integer");
  return x;
}
function oneOf<T extends string>(x: unknown, path: string, values: readonly T[]): T {
  if (typeof x !== "string" || !values.includes(x as T)) throw new DtoError(path, `must be one of ${values.join(", ")}`);
  return x as T;
}
function money(x: unknown, path: string): string {
  return str(x, path, DECIMAL);
}
function optMoney(x: unknown, path: string): string | null {
  return x === null || x === undefined ? null : money(x, path);
}
function time(x: unknown, path: string): string {
  const s = str(x, path);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || Number.isNaN(Date.parse(s))) throw new DtoError(path, "must be an ISO 8601 date-time");
  return s;
}
function optTime(x: unknown, path: string): string | null {
  return x === null || x === undefined ? null : time(x, path);
}
function currency(x: unknown, path: string): string {
  return str(x, path, /^[A-Z]{3}$/);
}
function arr(x: unknown, path: string): unknown[] {
  if (!Array.isArray(x)) throw new DtoError(path, "must be an array");
  return x;
}
function httpsUrl(x: unknown, path: string): string {
  const s = str(x, path);
  let u: URL;
  try { u = new URL(s); } catch { throw new DtoError(path, "must be a URL"); }
  if (u.protocol !== "https:") throw new DtoError(path, "must be https");
  return s;
}

// ---------------------------------------------------------------- webhook envelope
export interface Envelope { id: string; type: string; created_at: string; organization_id: string; account: string | null; data: J }
export function parseEnvelope(x: unknown): Envelope {
  const o = obj(x, "event");
  return {
    id: str(o.id, "event.id", /^evt_[A-Za-z0-9_]{1,120}$/),
    type: str(o.type, "event.type", /^[a-z_]+(\.[a-z_]+){1,3}$/),
    created_at: time(o.created_at, "event.created_at"),
    organization_id: str(o.organization_id, "event.organization_id", /^[A-Za-z0-9_]{1,128}$/),
    account: optStr(o.account, "event.account"),
    data: obj(o.data, "event.data"),
  };
}

export interface Hints { checkoutId: string | null; paymentId: string | null; subscriptionId: string | null; refundId: string | null; disputeId: string | null }
const hint = (x: unknown): string | null => (typeof x === "string" && ID.test(x) ? x : null);
/** IDs an event points at. Hints only: the worker fetches every object over authenticated HTTP. */
export function extractHints(e: Envelope): Hints {
  const d = e.data;
  const charge = typeof d.charge === "object" && d.charge !== null ? (d.charge as J) : {};
  const sub = typeof d.subscription === "object" && d.subscription !== null ? (d.subscription as J) : {};
  const id = hint(d.id);
  return {
    checkoutId: hint(d.checkout_id) ?? (id?.startsWith("chk_") ? id : null),
    paymentId: hint(d.charge_id) ?? hint(d.payment_id) ?? hint(charge.payment_id) ?? hint(charge.charge_id),
    subscriptionId: hint(d.subscription_id) ?? hint(sub.subscription_id) ?? (id?.startsWith("sub_") ? id : null),
    refundId: hint(d.refund_id),
    disputeId: hint(d.dispute_id),
  };
}

// ---------------------------------------------------------------- checkout (CreateCheckoutSessionResponse / CheckoutSessionApiResponse)
const CHECKOUT_STATUS = ["open", "completed", "expired", "cancelled"] as const;
export interface CreatedCheckout { checkout_id: string; checkout_url: string; status: string; expires_at: string; reference: string | null }
export function parseCreateCheckoutResponse(x: unknown): CreatedCheckout {
  const o = obj(x, "checkout");
  return {
    checkout_id: str(o.checkout_id, "checkout.checkout_id", ID),
    checkout_url: httpsUrl(o.checkout_url, "checkout.checkout_url"),
    status: oneOf(o.status, "checkout.status", CHECKOUT_STATUS),
    expires_at: time(o.expires_at, "checkout.expires_at"),
    reference: optStr(o.reference, "checkout.reference"),
  };
}

export interface CheckoutFacts {
  checkout_id: string; status: string; payment_status: string | null; reference: string | null; amount: string; currency: string;
  customer_id: string | null; recurring: { interval: string; interval_count: number } | null; product_ids: string[] | null;
  expires_at: string | null; completed_at: string | null; charge_payment_id: string | null;
}
export function parseCheckout(x: unknown): CheckoutFacts {
  const o = obj(x, "checkout");
  const customer = obj(o.customer, "checkout.customer");
  const rec = optObj(o.recurring, "checkout.recurring");
  const charge = optObj(o.charge, "checkout.charge");
  const products = o.products === null || o.products === undefined ? null : arr(o.products, "checkout.products").map((p, i) => {
    const po = obj(p, `checkout.products[${i}]`);
    const productId = str(po.product_id, `checkout.products[${i}].product_id`, ID);
    const q = int(po.quantity, `checkout.products[${i}].quantity`);
    money(po.unit_amount, `checkout.products[${i}].unit_amount`);
    currency(po.currency, `checkout.products[${i}].currency`);
    // A quantity other than 1 can never match the one-seat Business plan.
    return q === 1 ? productId : `${productId}#quantity=${q}`;
  });
  time(o.created_at, "checkout.created_at");
  time(o.updated_at, "checkout.updated_at");
  return {
    checkout_id: str(o.checkout_id, "checkout.checkout_id", ID),
    status: oneOf(o.status, "checkout.status", CHECKOUT_STATUS),
    payment_status: o.payment_status === null || o.payment_status === undefined ? null
      : oneOf(o.payment_status, "checkout.payment_status", ["requires_payment_method", "requires_confirmation", "requires_action", "processing", "succeeded", "failed", "canceled"] as const),
    reference: optStr(o.reference, "checkout.reference"),
    amount: money(o.amount, "checkout.amount"),
    currency: currency(o.currency, "checkout.currency"),
    customer_id: optStr(customer.id, "checkout.customer.id", ID),
    recurring: rec ? { interval: oneOf(rec.interval, "checkout.recurring.interval", ["day", "week", "month", "year"] as const),
      interval_count: rec.interval_count === undefined ? 1 : int(rec.interval_count, "checkout.recurring.interval_count") } : null,
    product_ids: products,
    expires_at: optTime(o.expires_at, "checkout.expires_at"),
    completed_at: optTime(o.completed_at, "checkout.completed_at"),
    charge_payment_id: charge ? optStr(charge.payment_id, "checkout.charge.payment_id", ID) : null,
  };
}

// ---------------------------------------------------------------- payment (PaymentResponse)
export const PAYMENT_STATUS = ["created", "processing", "succeeded", "accepted", "failed", "expired", "cancelled", "refunded",
  "partially_refunded", "auto_refunded", "underpaid", "overpaid"] as const;
export interface PaymentFacts {
  payment_id: string; status: string; billing_reason: string | null; checkout_id: string | null; reference: string | null;
  amount: string; amount_paid: string | null; amount_remaining: string | null; currency: string; subscription_id: string | null;
  customer_email: string | null;
  invoice: { invoice_id: string; subscription_id: string | null; period_start: string; period_end: string; kind: string } | null;
  line_items: { product_id: string; quantity: number; unit_amount: string; currency: string }[] | null;
}
export function parsePayment(x: unknown): PaymentFacts {
  const o = obj(x, "payment");
  const inv = optObj(o.invoice, "payment.invoice");
  const cust = optObj(o.customer, "payment.customer");
  time(o.created_at, "payment.created_at");
  time(o.updated_at, "payment.updated_at");
  return {
    payment_id: str(o.payment_id, "payment.payment_id", ID),
    status: oneOf(o.status, "payment.status", PAYMENT_STATUS),
    billing_reason: o.billing_reason === null || o.billing_reason === undefined ? null
      : oneOf(o.billing_reason, "payment.billing_reason", ["purchase", "subscription_create", "subscription_cycle", "subscription_update"] as const),
    checkout_id: optStr(o.checkout_id, "payment.checkout_id", ID),
    reference: optStr(o.reference, "payment.reference"),
    amount: money(o.amount, "payment.amount"),
    amount_paid: optMoney(o.amount_paid, "payment.amount_paid"),
    amount_remaining: optMoney(o.amount_remaining, "payment.amount_remaining"),
    currency: currency(o.currency, "payment.currency"),
    subscription_id: optStr(o.subscription_id, "payment.subscription_id", ID),
    customer_email: cust ? optStr(cust.email, "payment.customer.email") : null,
    invoice: inv ? {
      invoice_id: str(inv.invoice_id, "payment.invoice.invoice_id", ID),
      subscription_id: optStr(inv.subscription_id, "payment.invoice.subscription_id", ID),
      period_start: time(inv.period_start, "payment.invoice.period_start"),
      period_end: time(inv.period_end, "payment.invoice.period_end"),
      kind: oneOf(inv.kind, "payment.invoice.kind", ["cycle", "proration"] as const),
    } : null,
    line_items: o.line_items === null || o.line_items === undefined ? null : arr(o.line_items, "payment.line_items").map((li, i) => {
      const l = obj(li, `payment.line_items[${i}]`);
      return { product_id: str(l.product_id, `payment.line_items[${i}].product_id`, ID), quantity: int(l.quantity, `payment.line_items[${i}].quantity`),
        unit_amount: money(l.unit_amount, `payment.line_items[${i}].unit_amount`), currency: currency(l.currency, `payment.line_items[${i}].currency`) };
    }),
  };
}

// ---------------------------------------------------------------- payment list (PaymentListResponse)
// Discovery hints only: id (nullable), status and transaction_date. List items never grant anything;
// every candidate is re-read with GET /v1/payments/{id}.
export interface PaymentListItem { id: string | null; status: string; transaction_date: string | null }
export function parsePaymentList(x: unknown): { items: PaymentListItem[]; has_more: boolean; returned: number } {
  const o = obj(x, "payments");
  const items = arr(o.items, "payments.items").map((it, i) => {
    const io = obj(it, `payments.items[${i}]`);
    return { id: optStr(io.id, `payments.items[${i}].id`, ID), status: str(io.status, `payments.items[${i}].status`, /^[a-z_]{1,40}$/),
      transaction_date: optTime(io.transaction_date, `payments.items[${i}].transaction_date`) };
  });
  const p = obj(o.pagination, "payments.pagination");
  return { items, has_more: bool(p.has_more, "payments.pagination.has_more"), returned: int(p.returned, "payments.pagination.returned") };
}

// ---------------------------------------------------------------- subscription (SubscriptionResponse)
export const SUBSCRIPTION_STATUS = ["trialing", "active", "past_due", "unpaid", "canceled", "paused"] as const;
export interface SubscriptionFacts {
  id: string; customer_id: string; status: string; currency: string; amount: string; interval: string; frequency: number;
  quantity: number; product_id: string | null; item_product_ids: string[]; current_period_start: string; current_period_end: string;
  cancel_at_period_end: boolean; canceled_at: string | null;
}
export function parseSubscription(x: unknown): SubscriptionFacts {
  const o = obj(x, "subscription");
  const customer = obj(o.customer, "subscription.customer");
  const cycle = obj(o.billing_cycle, "subscription.billing_cycle");
  const product = optObj(o.product, "subscription.product");
  const items = arr(o.items, "subscription.items").map((it, i) => {
    const io = obj(it, `subscription.items[${i}]`);
    const price = optObj(io.price, `subscription.items[${i}].price`);
    const prod = optObj(io.product, `subscription.items[${i}].product`);
    return optStr(price?.product_id, `subscription.items[${i}].price.product_id`, ID) ?? optStr(prod?.id, `subscription.items[${i}].product.id`, ID)
      ?? "__product_missing";
  });
  const productId = product ? str(product.id, "subscription.product.id", ID) : items.length === 1 && items[0] !== "__product_missing" ? items[0] : null;
  return {
    id: str(o.id, "subscription.id", ID),
    customer_id: str(customer.customer_id, "subscription.customer.customer_id", ID),
    status: oneOf(o.status, "subscription.status", SUBSCRIPTION_STATUS),
    currency: currency(o.currency, "subscription.currency"),
    amount: money(o.amount, "subscription.amount"),
    interval: oneOf(cycle.interval, "subscription.billing_cycle.interval", ["day", "week", "month", "year"] as const),
    frequency: int(cycle.frequency, "subscription.billing_cycle.frequency"),
    quantity: int(o.quantity, "subscription.quantity"),
    product_id: productId,
    item_product_ids: items,
    current_period_start: time(o.current_period_start, "subscription.current_period_start"),
    current_period_end: time(o.current_period_end, "subscription.current_period_end"),
    cancel_at_period_end: bool(o.cancel_at_period_end, "subscription.cancel_at_period_end"),
    canceled_at: optTime(o.canceled_at, "subscription.canceled_at"),
  };
}

function pagination(x: unknown, path: string): { has_more: boolean } {
  const p = obj(x, path);
  return { has_more: p.has_more === undefined ? false : bool(p.has_more, `${path}.has_more`) };
}
export function parseSubscriptionList(x: unknown): { items: SubscriptionFacts[]; has_more: boolean } {
  const o = obj(x, "subscriptions");
  return { items: arr(o.items, "subscriptions.items").map(parseSubscription), has_more: pagination(o.pagination, "subscriptions.pagination").has_more };
}

// ---------------------------------------------------------------- customers (CustomerListResponse / CustomerDetailResponse)
export interface CustomerSummary { customer_id: string; email: string; metadata: J }
function customerSummary(x: unknown, path: string): CustomerSummary {
  const o = obj(x, path);
  return { customer_id: str(o.customer_id, `${path}.customer_id`, /^cust_[A-Za-z0-9_]{1,120}$/), email: str(o.email, `${path}.email`),
    metadata: obj(o.metadata ?? {}, `${path}.metadata`) };
}
export function parseCustomerList(x: unknown): { items: CustomerSummary[]; has_more: boolean } {
  const o = obj(x, "customers");
  return { items: arr(o.items, "customers.items").map((c, i) => customerSummary(c, `customers.items[${i}]`)),
    has_more: pagination(o.pagination, "customers.pagination").has_more };
}
export function parseCustomer(x: unknown): CustomerSummary {
  return customerSummary(x, "customer");
}

// ---------------------------------------------------------------- portal (PortalSessionResponse), refund, dispute
export function parsePortalSession(x: unknown): { id: string; url: string } {
  const o = obj(x, "portal");
  return { id: str(o.id, "portal.id", /^psn_[A-Za-z0-9_]{1,120}$/), url: httpsUrl(o.url, "portal.url") };
}
export function parseRefund(x: unknown): { refund_id: string; charge_id: string; status: string } {
  const o = obj(x, "refund");
  return { refund_id: str(o.refund_id, "refund.refund_id", ID), charge_id: str(o.charge_id, "refund.charge_id", ID),
    status: oneOf(o.status, "refund.status", ["processing", "success", "failed"] as const) };
}
export interface DisputeFacts { dispute_id: string; charge_id: string | null; status: string; amount: string; currency: string }
export function parseDispute(x: unknown): DisputeFacts {
  const o = obj(x, "dispute");
  return { dispute_id: str(o.dispute_id, "dispute.dispute_id", ID), charge_id: optStr(o.charge_id, "dispute.charge_id", ID),
    status: oneOf(o.status, "dispute.status", ["needs_response", "under_review", "won", "lost", "closed"] as const),
    amount: money(o.amount, "dispute.amount"), currency: currency(o.currency, "dispute.currency") };
}
export function parseDisputeList(x: unknown): { items: DisputeFacts[]; total: number } {
  const o = obj(x, "disputes");
  return { items: arr(o.items, "disputes.items").map(parseDispute), total: int(o.total, "disputes.total") };
}

// ---------------------------------------------------------------- account and product (connection test)
export function parseOrganization(x: unknown): { id: string; adaptive_pricing: boolean; is_active: boolean } {
  const o = obj(x, "account");
  return { id: str(o.id, "account.id", ID), adaptive_pricing: bool(o.adaptive_pricing, "account.adaptive_pricing"),
    is_active: bool(o.is_active, "account.is_active") };
}
export interface ProductFacts { id: string; status: string; interval: string | null; frequency: number | null; prices: { currency: string; amount: string }[] }
export function parseProduct(x: unknown): ProductFacts {
  const o = obj(x, "product");
  const cycle = optObj(o.billing_cycle, "product.billing_cycle");
  const list = o.prices === undefined || o.prices === null ? [] : arr(o.prices, "product.prices");
  const prices = list.map((p, i) => {
    const po = obj(p, `product.prices[${i}]`);
    return { currency: currency(po.currency, `product.prices[${i}].currency`), amount: money(po.amount, `product.prices[${i}].amount`) };
  });
  const primary = optObj(o.price, "product.price");
  if (primary && primary.amount !== undefined && primary.amount !== null) {
    prices.push({ currency: currency(primary.currency, "product.price.currency"), amount: money(primary.amount, "product.price.amount") });
  }
  return { id: str(o.id, "product.id", ID), status: oneOf(o.status, "product.status", ["active", "archived"] as const),
    interval: cycle ? oneOf(cycle.interval, "product.billing_cycle.interval", ["day", "week", "month", "year"] as const) : null,
    frequency: cycle ? int(cycle.frequency, "product.billing_cycle.frequency") : null, prices };
}

export function parseErrorCode(x: unknown): string | null {
  if (typeof x !== "object" || x === null) return null;
  const code = (x as J).error_code;
  return typeof code === "string" && /^[A-Z_]{2,60}$/.test(code) ? code : null;
}
