// Billing worker: claims durable events per connection (committed before any HTTP), fetches provider
// truth over authenticated GETs outside any transaction, and hands normalized facts to the fenced SQL
// absorb_* functions. Retryable failures back off in SQL; nothing is granted from an event body.
// Modes: process (events), discover (hourly: missed payments found by a bounded, resumable list scan,
// then full detail reads), reconcile (daily: stale checkouts, uncertain creations, subscriptions, recent
// verified payments for missed refunds, recent disputes), housekeeping (notices, retirements).
// Every claimed item is processed only while its lease still covers a worst-case item budget; an item
// that cannot start in time is released without consuming an attempt.
import { BachsClient, type ProviderResult, type Transport } from "./bachs-client.ts";
import { DtoError, extractHints, parseEnvelope, type CheckoutFacts, type PaymentFacts, type SubscriptionFacts } from "./bachs-dto.ts";
import { dbErrorCode, type ScopedDb } from "./db.ts";
import { logLine } from "./redact.ts";

export interface WorkerDeps {
  db: ScopedDb;                      // billing_worker
  transport: Transport;
  now: () => Date;
  log: (line: string) => void;
  workerId: string;
}
export type Mode = "process" | "discover" | "reconcile" | "housekeeping";

/** Worst case per item: up to four provider reads at the 8 s transport timeout plus database calls. */
export const ITEM_BUDGET_MS = 40_000;
export const EVENT_LEASE_SECONDS = 120;
/** Claim no more than the lease can cover at the worst-case budget (commit-before-HTTP, SKIP LOCKED). */
export const EVENT_BATCH = Math.floor((EVENT_LEASE_SECONDS * 1000) / ITEM_BUDGET_MS);
export const DISCOVERY_MAX_PAGES = 5;
export const DISCOVERY_DETAIL_BATCH = 7;
export const DISCOVERY_LEASE_SECONDS = 300;
export type Trigger = "cron" | "manual";

class Retryable extends Error {}
const REFUNDED = new Set(["refunded", "auto_refunded", "partially_refunded"]);

async function clientFor(deps: WorkerDeps, connection: string): Promise<BachsClient> {
  const c = await deps.db.call<{ provider_code: string; base_url: string; key_pattern: string; api_key: string }>("platform.get_credential", [["uuid", connection]]);
  if (c.provider_code !== "bachs") throw new Retryable("adapter_unavailable");
  return new BachsClient({ apiKey: c.api_key, baseUrl: c.base_url, keyPattern: c.key_pattern }, deps.transport);
}

function need<T>(r: ProviderResult<T>, what: string): T {
  if (r.kind === "ok") return r.data;
  if (r.kind === "uncertain") throw new Retryable(`provider_${r.reason}`);
  throw new Retryable(`provider_refused_${what}_${r.status}`);
}

type Absorb = "billing.absorb_checkout" | "billing.absorb_payment" | "billing.absorb_subscription" | "billing.absorb_refund" | "billing.absorb_dispute";
function absorb(deps: WorkerDeps, fn: Absorb, connection: string, event: string | null, token: string | null, facts: unknown): Promise<string> {
  return deps.db.call<string>(fn, [["uuid", connection], ["text", event], ["uuid", token], ["jsonb", JSON.stringify(facts)],
    ["timestamptz", deps.now().toISOString()]]);
}

/** Pre-subscription charge (Bachs sandbox, 2026-10-12): a declined first attempt whose full GET is an
 *  open purchase with no subscription and no invoice. Exact five-field match only; it routes, nothing more. */
export function isPreSubscriptionAttempt(p: PaymentFacts): boolean {
  return p.status === "open" && p.billing_reason === "purchase" && p.subscription_id === null && p.invoice === null && !!p.checkout_id;
}

/** Full payment truth: the payment, its subscription, and the checkout for a first payment. Refunded
 *  statuses go to absorb_refund even when the payment was verified before (missed notifications). */
export async function absorbPaymentById(deps: WorkerDeps, client: BachsClient, connection: string, paymentId: string,
  event: string | null, token: string | null): Promise<string> {
  const payment: PaymentFacts = need(await client.getPayment(paymentId), "payment");
  if (REFUNDED.has(payment.status)) return absorb(deps, "billing.absorb_refund", connection, event, token, { payment });
  if (isPreSubscriptionAttempt(payment)) {
    // A checkout observation, not a payment absorption: the payment's checkout_id (from the full GET,
    // never the webhook) is re-read in full and only that checkout is absorbed. No payment rows, no
    // grant, no grace. A failed, malformed or mismatched read throws for the normal retry.
    const checkout = need(await client.getCheckout(payment.checkout_id!), "checkout");
    if (checkout.checkout_id !== payment.checkout_id) throw new Retryable("provider_checkout_id_mismatch");
    const out = await absorb(deps, "billing.absorb_checkout", connection, event, token, { checkout });
    return out.startsWith("review:") ? out : `pre_subscription:${out}`;
  }
  const subscription = payment.subscription_id ? need(await client.getSubscription(payment.subscription_id), "subscription") : null;
  let checkout: CheckoutFacts | null = null;
  if (payment.billing_reason === "subscription_create" && payment.checkout_id) checkout = need(await client.getCheckout(payment.checkout_id), "checkout");
  return absorb(deps, "billing.absorb_payment", connection, event, token, { payment, subscription, checkout });
}

async function processOne(deps: WorkerDeps, client: BachsClient, connection: string, ev: { event_id: string; body: string; claim_token: string }): Promise<string> {
  const envelope = parseEnvelope(JSON.parse(ev.body));
  const h = extractHints(envelope);
  const [family] = envelope.type.split(".");
  const t = envelope.type;
  if (family === "checkout") {
    if (!h.checkoutId) return "ignored:no_checkout_id";
    const checkout = need(await client.getCheckout(h.checkoutId), "checkout");
    const out = await absorb(deps, "billing.absorb_checkout", connection, ev.event_id, ev.claim_token, { checkout });
    if (checkout.status === "completed" && checkout.charge_payment_id) {
      return absorbPaymentById(deps, client, connection, checkout.charge_payment_id, ev.event_id, ev.claim_token);
    }
    return out;
  }
  if (family === "collection" || family === "invoice") {
    if (h.paymentId) return absorbPaymentById(deps, client, connection, h.paymentId, ev.event_id, ev.claim_token);
    if (h.subscriptionId) {
      const subscription = need(await client.getSubscription(h.subscriptionId), "subscription");
      return absorb(deps, "billing.absorb_subscription", connection, ev.event_id, ev.claim_token, { subscription });
    }
    return "ignored:no_payment_id";
  }
  if (t.startsWith("customer.subscription.")) {
    if (!h.subscriptionId) return "ignored:no_subscription_id";
    const subscription = need(await client.getSubscription(h.subscriptionId), "subscription");
    return absorb(deps, "billing.absorb_subscription", connection, ev.event_id, ev.claim_token, { subscription });
  }
  if (family === "refund") {
    const chargeId = h.paymentId ?? (h.refundId ? need(await client.getRefund(h.refundId), "refund").charge_id : null);
    if (!chargeId) return "ignored:no_charge_id";
    return absorbPaymentById(deps, client, connection, chargeId, ev.event_id, ev.claim_token);
  }
  if (family === "dispute") {
    if (!h.disputeId) return "ignored:no_dispute_id";
    const dispute = need(await client.getDispute(h.disputeId), "dispute");
    return absorb(deps, "billing.absorb_dispute", connection, ev.event_id, ev.claim_token, { dispute });
  }
  return `ignored:${t}`.slice(0, 80);
}

const hasTime = (deps: WorkerDeps, leaseUntil: string | Date) => deps.now().getTime() + ITEM_BUDGET_MS <= new Date(leaseUntil).getTime();
const errorCode = (e: unknown) => e instanceof Retryable ? e.message : e instanceof DtoError ? "dto_invalid" : e instanceof SyntaxError ? "malformed_body" : dbErrorCode(e);

export async function processEvents(deps: WorkerDeps, connection: string, limit = EVENT_BATCH): Promise<{ claimed: number; done: number; failed: number; released: number }> {
  // Claim first, in its own committed call; HTTP happens afterwards with no transaction open.
  const claimed = await deps.db.rows<{ event_id: string; event_type: string; body: string; claim_token: string; attempts: number; lease_until: string }>(
    "billing.claim_events", [["uuid", connection], ["text", deps.workerId], ["integer", Math.min(limit, EVENT_BATCH)], ["integer", EVENT_LEASE_SECONDS]]);
  let done = 0;
  let failed = 0;
  let released = 0;
  if (claimed.length === 0) return { claimed: 0, done, failed, released };
  let client: BachsClient | null = null;
  for (const ev of claimed) {
    if (!hasTime(deps, ev.lease_until)) {
      // Not enough lease left to process safely: give it back untouched (no attempt consumed).
      try { await deps.db.call("billing.release_event", [["uuid", connection], ["text", ev.event_id], ["uuid", ev.claim_token]]); released++; }
      catch (e) { deps.log(logLine("worker.release_failed", { event: ev.event_id, code: dbErrorCode(e) })); }
      continue;
    }
    try {
      client ??= await clientFor(deps, connection);
      const outcome = await processOne(deps, client, connection, ev);
      await deps.db.call("billing.complete_event", [["uuid", connection], ["text", ev.event_id], ["uuid", ev.claim_token], ["text", outcome]]);
      deps.log(logLine("worker.event_done", { event: ev.event_id, outcome }));
      done++;
    } catch (e) {
      const code = errorCode(e);
      failed++;
      if (code === "stale_claim") { deps.log(logLine("worker.fenced_out", { event: ev.event_id })); continue; }
      try {
        await deps.db.call("billing.fail_event", [["uuid", connection], ["text", ev.event_id], ["uuid", ev.claim_token], ["text", code]]);
      } catch (inner) {
        deps.log(logLine("worker.fail_record_failed", { event: ev.event_id, code: dbErrorCode(inner) }));
      }
      deps.log(logLine("worker.event_failed", { event: ev.event_id, code }));
    }
  }
  return { claimed: claimed.length, done, failed, released };
}

/** Absorbs one discovered payment from full server reads, but only if it is SAVOUR's on this connection. */
async function absorbDiscovered(deps: WorkerDeps, client: BachsClient, connection: string, paymentId: string): Promise<{ state: "absorbed" | "unrelated" | "retry"; outcome: string }> {
  const payment: PaymentFacts = need(await client.getPayment(paymentId), "payment");
  const classify = (customer: string | null) => deps.db.call<string>("billing.discovery_classify", [["uuid", connection],
    ["text", payment.subscription_id], ["text", payment.reference], ["text", customer]]);
  let subscription: SubscriptionFacts | null = null;
  if ((await classify(null)) !== "savour") {
    // Not bound here yet: only a server-read subscription of a SAVOUR customer keeps it in play.
    if (!payment.subscription_id) return { state: "unrelated", outcome: "not_savour" };
    subscription = need(await client.getSubscription(payment.subscription_id), "subscription");
    const kind = await classify(subscription.customer_id);
    if (kind === "unrelated") return { state: "unrelated", outcome: "not_savour" };
    if (kind === "savour_customer") return { state: "retry", outcome: "awaiting_subscription_binding" };
  }
  if (REFUNDED.has(payment.status)) return { state: "absorbed", outcome: await absorb(deps, "billing.absorb_refund", connection, null, null, { payment }) };
  subscription ??= payment.subscription_id ? need(await client.getSubscription(payment.subscription_id), "subscription") : null;
  let checkout: CheckoutFacts | null = null;
  if (payment.billing_reason === "subscription_create" && payment.checkout_id) checkout = need(await client.getCheckout(payment.checkout_id), "checkout");
  const outcome = await absorb(deps, "billing.absorb_payment", connection, null, null, { payment, subscription, checkout });
  // A payment still in flight is looked at again later; everything else has reached its decision.
  return outcome === "payment_pending" ? { state: "retry", outcome } : { state: "absorbed", outcome };
}

/** Bounded, resumable discovery: at most DISCOVERY_MAX_PAGES list pages (the cursor advances with the
 *  IDs it durably recorded) and DISCOVERY_DETAIL_BATCH leased detail reads per run. */
export async function discoverPayments(deps: WorkerDeps, connection: string, opts: { maxPages?: number; detailBatch?: number } = {}):
  Promise<{ pages: number; scan: "continue" | "complete" | "stale" | "error"; done: number; failed: number; released: number }> {
  const client = await clientFor(deps, connection);
  const maxPages = opts.maxPages ?? DISCOVERY_MAX_PAGES;
  let pages = 0;
  let scan: "continue" | "complete" | "stale" | "error" = "continue";
  const cursor = await deps.db.call<{ scan_id: string; offset: number }>("billing.discovery_begin", [["uuid", connection]]);
  let offset = cursor.offset;
  while (pages < maxPages && scan === "continue") {
    const page = await client.listPayments(offset);
    if (page.kind !== "ok") { scan = "error"; deps.log(logLine("worker.discovery_list_failed", { reason: page.kind === "uncertain" ? page.reason : page.status })); break; }
    const items = page.data.items.map((x) => ({ id: x.id, status: x.status, transaction_date: x.transaction_date }));
    const r = await deps.db.call<string>("billing.discovery_record_page", [["uuid", connection], ["uuid", cursor.scan_id], ["integer", offset],
      ["jsonb", JSON.stringify(items)], ["integer", page.data.items.length], ["boolean", page.data.has_more]]);
    pages++;
    if (r === "stale_page") { scan = "stale"; break; }
    if (r === "complete") { scan = "complete"; break; }
    offset += page.data.items.length;
  }
  const claimed = await deps.db.rows<{ provider_payment_id: string; claim_token: string; lease_until: string }>("billing.discovery_claim",
    [["uuid", connection], ["text", deps.workerId], ["integer", Math.min(opts.detailBatch ?? DISCOVERY_DETAIL_BATCH, DISCOVERY_DETAIL_BATCH)],
      ["integer", DISCOVERY_LEASE_SECONDS]]);
  let done = 0;
  let failed = 0;
  let released = 0;
  for (const c of claimed) {
    const finish = (state: string, outcome: string | null, error: string | null) => deps.db.call("billing.discovery_finish", [["uuid", connection],
      ["text", c.provider_payment_id], ["uuid", c.claim_token], ["text", state], ["text", outcome], ["text", error]]);
    if (!hasTime(deps, c.lease_until)) { await finish("released", null, null); released++; continue; }
    try {
      const r = await absorbDiscovered(deps, client, connection, c.provider_payment_id);
      await finish(r.state, r.outcome, null);
      if (r.state === "retry") failed++; else done++;
    } catch (e) {
      const code = errorCode(e);
      failed++;
      if (code !== "stale_claim") await finish("retry", null, code).catch((inner) => deps.log(logLine("worker.discovery_finish_failed", { code: dbErrorCode(inner) })));
      deps.log(logLine("worker.discovery_item_failed", { payment: c.provider_payment_id, code }));
    }
  }
  return { pages, scan, done, failed, released };
}

/** Classifies a checkout-creation result for record_checkout_result. */
export function classifyCheckoutCreation(r: ProviderResult<{ checkout_id: string; checkout_url: string; expires_at: string; reference: string | null }>):
  { outcome: "created" | "refused" | "uncertain" | "conflict"; error: string | null } {
  if (r.kind === "ok") return { outcome: "created", error: null };
  if (r.kind === "uncertain") return { outcome: "uncertain", error: r.reason };
  if (r.status === 409) return { outcome: "conflict", error: r.errorCode ?? "CONFLICT" };
  return { outcome: "refused", error: r.errorCode ?? `HTTP_${r.status}` };
}

export async function reconcile(deps: WorkerDeps, connection: string): Promise<{ done: number; failed: number }> {
  const c = await deps.db.call<{ checkouts: { intent_id: string; checkout_id: string }[]; uncertain: { intent_id: string }[];
    subscriptions: string[]; payments: { payment_id: string }[]; disputes_since: string }>("billing.reconcile_candidates", [["uuid", connection], ["integer", 50]]);
  const client = await clientFor(deps, connection);
  let done = 0;
  let failed = 0;
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try { await fn(); done++; } catch (e) {
      failed++;
      deps.log(logLine("worker.reconcile_failed", { step: label, code: e instanceof Retryable ? e.message : e instanceof DtoError ? "dto_invalid" : dbErrorCode(e) }));
    }
  };
  for (const ck of c.checkouts) {
    await step("checkout", async () => {
      const checkout = need(await client.getCheckout(ck.checkout_id), "checkout");
      await absorb(deps, "billing.absorb_checkout", connection, null, null, { checkout });
      if (checkout.status === "completed" && checkout.charge_payment_id) await absorbPaymentById(deps, client, connection, checkout.charge_payment_id, null, null);
    });
  }
  for (const u of c.uncertain) {
    await step("uncertain_checkout", async () => {
      // Identical retry (same key, same stored body) only inside the provider's idempotency window;
      // SQL escalates to manual review after it. The unique reference makes a duplicate creation fail.
      const ctx = await deps.db.call<{ idempotency_key: string; request_body: string } | null>("billing.checkout_retry_context", [["uuid", u.intent_id]]);
      if (!ctx) return;
      const r = await client.createCheckout(ctx.request_body, ctx.idempotency_key);
      const k = classifyCheckoutCreation(r);
      const created = r.kind === "ok" ? r.data : null;
      await deps.db.call("billing.record_checkout_result", [["uuid", u.intent_id], ["text", k.outcome], ["text", created?.checkout_id ?? null],
        ["text", created?.checkout_url ?? null], ["timestamptz", created?.expires_at ?? null], ["text", created?.reference ?? null], ["text", k.error]]);
    });
  }
  for (const id of c.subscriptions) {
    await step("subscription", async () => {
      const subscription = need(await client.getSubscription(id), "subscription");
      await absorb(deps, "billing.absorb_subscription", connection, null, null, { subscription });
    });
  }
  for (const p of c.payments) await step("payment", () => absorbPaymentById(deps, client, connection, p.payment_id, null, null));
  await step("disputes", async () => {
    for (let offset = 0; offset < 500; offset += 100) {
      const page = need(await client.listDisputes(c.disputes_since, offset), "disputes");
      for (const dispute of page.items) if (dispute.charge_id) await absorb(deps, "billing.absorb_dispute", connection, null, null, { dispute });
      if (page.items.length < 100) break;
    }
  });
  return { done, failed };
}

/** One worker invocation. Each connection's durable run row carries only that connection's counts (only
 *  cron rows prove the job path); the returned summary aggregates across connections. */
export async function runWorker(deps: WorkerDeps, mode: Mode, trigger: Trigger): Promise<{ connections: number; done: number; failed: number }> {
  if (mode === "housekeeping") {
    await deps.db.call("billing.housekeeping", []);
    return { connections: 0, done: 1, failed: 0 };
  }
  const connections = (await deps.db.call<string[]>("billing.worker_connections", [])) ?? [];
  let totalDone = 0;
  let totalFailed = 0;
  for (const connection of connections) {
    const run = await deps.db.call<string>("billing.start_run", [["uuid", connection], ["text", mode], ["text", trigger], ["text", deps.workerId]]);
    let claimed = 0;
    let done = 0;
    let failed = 0;
    let error: string | null = null;
    try {
      if (mode === "process") ({ claimed, done, failed } = await processEvents(deps, connection));
      else if (mode === "discover") ({ done, failed } = await discoverPayments(deps, connection));
      else ({ done, failed } = await reconcile(deps, connection));
    } catch (e) {
      error = errorCode(e);
      failed++;
    }
    await deps.db.call("billing.finish_run", [["uuid", run], ["integer", claimed], ["integer", done], ["integer", failed], ["text", error]]);
    totalDone += done;
    totalFailed += failed;
  }
  return { connections: connections.length, done: totalDone, failed: totalFailed };
}
