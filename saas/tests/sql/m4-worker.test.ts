// Worker behaviour on embedded Postgres with a MOCK Bachs transport (official schema shapes):
// bounded missed-payment discovery, lease-safe event batches, and per-connection run accounting.
// Contract and wiring evidence only, not Bachs sandbox evidence; single connection (no real races).
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TransportRequest } from "../../supabase/functions/_shared/bachs-client.ts";
import { startCheckout } from "../../supabase/functions/_shared/owner-core.ts";
import { discoverPayments, EVENT_BATCH, ITEM_BUDGET_MS, processEvents, runWorker, type WorkerDeps } from "../../supabase/functions/_shared/worker-core.ts";
import { harness, ok, timeout } from "./m4-harness";

const OWNER = "eeeeeeee-0000-4000-8000-000000004701";
const ADMIN = "eeeeeeee-0000-4000-8000-000000004702";
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const addMonth = (ms: number) => { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + 1); return d.getTime(); };
const silent = () => undefined;

describe("missed-payment discovery (no webhook)", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let conn = "";
  let ws = "";
  let reference = "";
  const NOW = Date.now();
  const P1 = NOW - 40 * DAY;
  const P2 = addMonth(P1);           // about ten days ago: the renewal period now in force
  const P3 = addMonth(P2);
  let listing: { id: string | null; status: string; transaction_date: string | null }[] = [];
  let pageSize = 10;
  let listFails = false;
  const details = new Map<string, () => unknown>();
  const deps = (): WorkerDeps => ({ db: h.scoped("billing_worker"), transport: h.transport, now: () => new Date(), log: silent, workerId: "disc" });
  const subscription = (id = "sub_d1", customer = "cust_d1") => ({ id, customer: { customer_id: customer, email: "billing-disc@m4.savour.test" },
    status: "active", currency: "USD", amount: "29.00", billing_cycle: { interval: "month", frequency: 1 }, quantity: 1,
    current_period_start: iso(P2), current_period_end: iso(P3), cancel_at_period_end: false, canceled_at: null, created_at: iso(P1),
    product: { id: "prod_disc", name: "Business" }, items: [{ id: "il_1", quantity: 1, price: { product_id: "prod_disc" } }], metadata: {} });
  const payment = (id: string, o: Partial<{ status: string; reason: string; sub: string | null; ref: string | null; checkout: string | null;
    start: number; end: number; paid: string | null; invoice: string }> = {}) => ({
    payment_id: id, status: o.status ?? "succeeded", billing_reason: o.reason ?? "subscription_cycle", checkout_id: o.checkout ?? null,
    reference: o.ref ?? null, amount: "29.00", ...(o.paid === null ? {} : { amount_paid: o.paid ?? "29.00" }), amount_remaining: o.paid === null ? null : "0.00",
    currency: "USD", customer: { email: "billing-disc@m4.savour.test", name: null }, subscription_id: o.sub === undefined ? "sub_d1" : o.sub,
    invoice: o.sub === null ? null : { invoice_id: o.invoice ?? `inv_${id}`, subscription_id: o.sub ?? "sub_d1", period_start: iso(o.start ?? P2),
      period_end: iso(o.end ?? P3), kind: "cycle" },
    line_items: [{ product_id: "prod_disc", product_name: "Business", quantity: 1, unit_amount: "29.00", currency: "USD", line_total: "29.00" }],
    created_at: iso(o.start ?? P2), updated_at: iso(o.start ?? P2) });
  const state = async (id: string) => (await h.q<{ state: string; outcome: string | null; attempts: number; last_error_code: string | null }>(
    "select state, outcome, attempts, last_error_code from billing.discovered_payments where provider_payment_id = $1", [id]))[0];
  const access = async () => ((await h.userRpc(OWNER)("get_billing", { p_ws: ws })).data as { access: { state: string } }).access.state;

  beforeAll(async () => {
    h = await harness();
    await h.q(`insert into auth.users (id, email, email_confirmed_at) values ($1, 'm4-disc-owner@savour.test', now())`, [OWNER]);
    const owner = h.userRpc(OWNER);
    ws = (await owner("create_workspace", { p_name: "Discovery Co", p_country: "Nigeria", p_timezone: "Africa/Lagos", p_display_name: "Owner" })).data as string;
    await owner("set_billing_contact", { p_ws: ws, p_email: "billing-disc@m4.savour.test", p_consent: true, p_expected_version: 1 });
    conn = await h.connection(ADMIN, "Discovery sandbox", "sk_sandbox_TESTONLYdisckey0000000001", "acct_disc");
    await h.q("select billing.operator_configure_price($1, 'USD', '29.00', 'prod_disc', 'disposable fixture')", [conn]);
    h.routes.set("GET /v1/customers", () => ok({ items: [], pagination: { has_more: false } }));
    h.routes.set("POST /v1/customers", (r: TransportRequest) => ok({ customer_id: "cust_d1", email: JSON.parse(r.body!).email, metadata: {},
      created_at: iso(P1), updated_at: iso(P1) }, 201));
    h.routes.set("POST /v1/checkout-sessions", (r: TransportRequest) => ok({ checkout_id: "chk_d1", checkout_url: "https://checkout.sandbox.bachs.io/c/d1",
      status: "open", expires_at: iso(NOW + 3600_000), reference: JSON.parse(r.body!).reference }, 201));
    const billing = (await owner("get_billing", { p_ws: ws })).data as { prices: { currency: string; price_id: string }[]; terms_version: string };
    const r = await startCheckout({ userId: OWNER, userRpc: owner, gateway: h.scoped("billing_gateway"), transport: h.transport,
      appOrigin: "https://preview.savour.test", now: () => new Date(), log: silent },
      { workspaceId: ws, currency: "USD", priceId: billing.prices.find((p) => p.currency === "USD")!.price_id, termsVersion: billing.terms_version });
    expect(r.kind).toBe("redirect");
    reference = (await h.q<{ reference: string }>("select reference from billing.checkout_intents where workspace_id = $1", [ws]))[0].reference;

    // Mock: newest-first list honouring offset, with this mock's own page size.
    h.routes.set("GET /v1/payments", (req: TransportRequest) => {
      if (listFails) return { status: 503, bodyText: "{}" };
      const offset = Number(new URL(req.url).searchParams.get("offset"));
      const page = listing.slice(offset, offset + pageSize);
      return ok({ items: page.map((x) => ({ ...x, amount: "29.00", currency: "USD", customer_name: "", customer_email: "" })),
        pagination: { has_more: offset + pageSize < listing.length, limit: 100, offset, returned: page.length, total: listing.length } });
    });
    for (const path of ["ch_first", "ch_bad", "ch_other", "ch_orphan", "ch_renew", "ch_slow", "ch_new1", "ch_new2", "ch_new3"]) {
      h.routes.set(`GET /v1/payments/${path}`, () => { const f = details.get(path); if (!f) return ok({}, 404); return ok(f()); });
    }
    h.routes.set("GET /v1/subscriptions/sub_d1", () => ok(subscription()));
    h.routes.set("GET /v1/subscriptions/sub_d2", () => ok(subscription("sub_d2")));
    h.routes.set("GET /v1/subscriptions/sub_foreign", () => ok(subscription("sub_foreign", "cust_someone_else")));
    h.routes.set("GET /v1/checkout-sessions/chk_d1", () => ok({ checkout_id: "chk_d1", status: "completed", recurring: { interval: "month", interval_count: 1 },
      payment_status: "succeeded", amount: "29.00", currency: "USD", reference, customer: { id: "cust_d1", email: "billing-disc@m4.savour.test", name: null },
      products: [{ product_id: "prod_disc", product_name: "Business", quantity: 1, unit_amount: "29.00", currency: "USD", price_type: "fixed", line_total: "29.00" }],
      created_at: iso(P1), updated_at: iso(P1), expires_at: iso(P1 + 3600_000), completed_at: iso(P1) }));
  }, 120_000);
  afterAll(async () => { await h.close(); });

  it("discovers the missed first payment, defers an unbound SAVOUR subscription, ignores unrelated payments and retries failures", async () => {
    listing = [
      { id: "ch_slow", status: "succeeded", transaction_date: iso(NOW - DAY) },
      { id: "ch_renew", status: "processing", transaction_date: iso(NOW - 10 * DAY) },
      { id: "ch_other", status: "succeeded", transaction_date: iso(NOW - 20 * DAY) },
      { id: null, status: "succeeded", transaction_date: iso(NOW - 22 * DAY) },
      { id: "ch_bad", status: "succeeded", transaction_date: iso(NOW - 25 * DAY) },
      { id: "ch_orphan", status: "succeeded", transaction_date: iso(NOW - 30 * DAY) },
      { id: "ch_first", status: "succeeded", transaction_date: iso(P1) },
    ];
    details.set("ch_first", () => payment("ch_first", { reason: "subscription_create", checkout: "chk_d1", ref: reference, start: P1, end: P2 }));
    details.set("ch_bad", () => payment("ch_bad", { paid: null, invoice: "inv_bad" }));            // incomplete facts: never granted
    details.set("ch_other", () => payment("ch_other", { sub: "sub_foreign", reason: "subscription_cycle" }));
    details.set("ch_orphan", () => payment("ch_orphan", { sub: "sub_d2" }));                        // SAVOUR customer, subscription not bound
    details.set("ch_renew", () => payment("ch_renew", { status: "processing" }));
    details.set("ch_slow", timeout);
    const r = await discoverPayments(deps(), conn);
    expect(r).toMatchObject({ pages: 1, scan: "complete" });
    expect(await state("ch_first")).toMatchObject({ state: "absorbed", outcome: "granted" });
    expect(await state("ch_bad")).toMatchObject({ state: "absorbed", outcome: "review:payment_mismatch" });
    expect(await state("ch_other")).toMatchObject({ state: "unrelated", outcome: "not_savour" });
    expect(await state("ch_orphan")).toMatchObject({ state: "retry", outcome: "awaiting_subscription_binding" });
    expect(await state("ch_renew")).toMatchObject({ state: "retry", outcome: "payment_pending" });
    expect(await state("ch_slow")).toMatchObject({ state: "retry", attempts: 1, last_error_code: "provider_timeout" });
    expect((await h.q("select 1 from billing.discovered_payments")).length).toBe(6);       // the item without an ID cannot be fetched
    expect((await h.q<{ n: number }>("select count(*)::int as n from billing.paid_periods"))[0].n).toBe(1);
    expect((await h.q("select 1 from billing.review_queue where provider_refs ->> 'payment_id' in ('ch_other', 'ch_orphan')")).length).toBe(0);
    expect((await h.q("select 1 from billing.subscriptions where provider_subscription_id in ('sub_foreign', 'sub_d2')")).length).toBe(0);
    expect((await h.q("select 1 from billing.webhook_inbox")).length).toBe(0);
    expect(await access()).toBe("trialing");   // the first month (P1) is over; no renewal verified yet
  });

  it("grants the missed renewal only once complete verified payment and subscription facts arrive", async () => {
    details.set("ch_renew", () => payment("ch_renew"));
    details.set("ch_slow", () => payment("ch_slow", { sub: null, reason: "purchase" }));
    await h.q("update billing.discovered_payments set next_attempt_at = now() - interval '1 second' where state = 'retry'");
    const r = await discoverPayments(deps(), conn);
    expect(r.scan).toBe("complete");
    expect(await state("ch_renew")).toMatchObject({ state: "absorbed", outcome: "granted" });
    expect(await state("ch_slow")).toMatchObject({ state: "unrelated" });
    expect(await state("ch_orphan")).toMatchObject({ state: "retry", outcome: "awaiting_subscription_binding" });
    expect(await access()).toBe("active");
    const periods = await h.q<{ provider_payment_id: string; amount_minor: number }>("select provider_payment_id, amount_minor::int from billing.paid_periods order by period_start");
    expect(periods).toEqual([{ provider_payment_id: "ch_first", amount_minor: 2900 }, { provider_payment_id: "ch_renew", amount_minor: 2900 }]);
  });

  it("is bounded and resumable: the cursor advances only with recorded pages, survives a failed list call, and refuses stale pages", async () => {
    listing = [{ id: "ch_new3", status: "failed", transaction_date: iso(NOW - 0.1 * DAY) }, { id: "ch_new2", status: "failed", transaction_date: iso(NOW - 0.2 * DAY) },
      { id: "ch_new1", status: "failed", transaction_date: iso(NOW - 0.3 * DAY) }, ...listing];
    for (const id of ["ch_new1", "ch_new2", "ch_new3"]) details.set(id, () => payment(id, { sub: null, reason: "purchase", status: "failed" }));
    pageSize = 2;
    const offsets = () => h.seen.filter((s) => s.url.includes("/v1/payments?")).map((s) => Number(new URL(s.url).searchParams.get("offset")));
    const before = offsets().length;
    expect((await discoverPayments(deps(), conn, { maxPages: 1 })).scan).toBe("continue");
    const cursor = async () => (await h.q<{ scan_offset: number; scan_id: string | null }>("select scan_offset, scan_id::text from billing.payment_discovery_state where connection_id = $1", [conn]))[0];
    expect((await cursor()).scan_offset).toBe(2);
    listFails = true;
    expect((await discoverPayments(deps(), conn, { maxPages: 1 })).scan).toBe("error");
    expect((await cursor()).scan_offset).toBe(2);
    listFails = false;
    expect((await discoverPayments(deps(), conn, { maxPages: 1 })).scan).toBe("continue");
    expect((await discoverPayments(deps(), conn, { maxPages: 5 })).scan).toBe("complete");
    expect(offsets().slice(before)).toEqual([0, 2, 2, 4]);
    expect((await cursor()).scan_id).toBeNull();
    const scan = await h.scoped("billing_worker").call<{ scan_id: string; offset: number }>("billing.discovery_begin", [["uuid", conn]]);
    expect(await h.scoped("billing_worker").call("billing.discovery_record_page", [["uuid", conn], ["uuid", scan.scan_id], ["integer", 7], ["jsonb", "[]"],
      ["integer", 0], ["boolean", true]])).toBe("stale_page");
    expect(await state("ch_new1")).toMatchObject({ state: "unrelated" });
  });
});

describe("lease-safe event batches", () => {
  let h: Awaited<ReturnType<typeof harness>>;
  let conn = "";
  let skew = 0;
  const unrelatedPayment = (id: string) => ({ payment_id: id, status: "succeeded", amount: "1.00", currency: "USD", subscription_id: null,
    created_at: iso(Date.now()), updated_at: iso(Date.now()) });
  const ingest = (id: string, charge: string) => {
    const at = iso(Date.now());
    const body = JSON.stringify({ id, type: "collection.succeeded", created_at: at, organization_id: "acct_lease", data: { charge_id: charge } });
    return h.scoped("billing_intake").call("billing.ingest_event", [["uuid", conn], ["text", id], ["text", "collection.succeeded"], ["timestamptz", at],
      ["text", "acct_lease"], ["bytea_hex", Buffer.from(body).toString("hex")], ["text", createHash("sha256").update(body).digest("hex")],
      ["bigint", Math.floor(Date.now() / 1000)], ["text", null]]);
  };
  const deps = (): WorkerDeps => ({ db: h.scoped("billing_worker"), transport: h.transport, now: () => new Date(Date.now() + skew), log: silent, workerId: "lease" });
  const row = async (id: string) => (await h.q<{ status: string; attempts: number; outcome: string | null }>(
    "select status, attempts, outcome from billing.webhook_inbox where event_id = $1", [id]))[0];

  beforeAll(async () => {
    h = await harness();
    conn = await h.connection(ADMIN, "Lease sandbox", "sk_sandbox_TESTONLYleasekey000000001", "acct_lease");
  }, 120_000);
  afterAll(async () => { await h.close(); });

  it("claims only what the lease covers and releases trailing events without consuming attempts", async () => {
    expect(EVENT_BATCH).toBe(3);
    expect(EVENT_BATCH * ITEM_BUDGET_MS).toBeLessThanOrEqual(120_000);
    for (let i = 1; i <= 4; i++) await ingest(`evt_lease_${i}`, `ch_lease_${i}`);
    // The first event's provider read is slow: by the time it returns, too little lease is left for the rest.
    h.routes.set("GET /v1/payments/ch_lease_1", () => { skew += 90_000; return ok(unrelatedPayment("ch_lease_1")); });
    const r = await processEvents(deps(), conn);
    expect(r).toEqual({ claimed: 3, done: 1, failed: 0, released: 2 });
    expect(await row("evt_lease_1")).toMatchObject({ status: "done" });
    expect(await row("evt_lease_2")).toEqual({ status: "pending", attempts: 0, outcome: null });
    expect(await row("evt_lease_3")).toEqual({ status: "pending", attempts: 0, outcome: null });
    expect(await row("evt_lease_4")).toEqual({ status: "pending", attempts: 0, outcome: null });    // never claimed beyond the batch
    skew = 0;
  });

  it("never completes an event whose lease expired during the provider call; it is retried later", async () => {
    h.routes.set("GET /v1/payments/ch_lease_2", async () => {
      await h.q("update billing.webhook_inbox set lease_until = clock_timestamp() - interval '1 second' where event_id = 'evt_lease_2'");
      return ok(unrelatedPayment("ch_lease_2"));
    });
    for (const id of ["ch_lease_3", "ch_lease_4"]) h.routes.set(`GET /v1/payments/${id}`, () => ok(unrelatedPayment(id)));
    const r = await processEvents(deps(), conn);
    expect(r.claimed).toBe(3);
    expect(await row("evt_lease_2")).toMatchObject({ status: "processing", outcome: null });      // fenced out, not falsely done
    h.routes.set("GET /v1/payments/ch_lease_2", () => ok(unrelatedPayment("ch_lease_2")));
    const again = await processEvents(deps(), conn);
    expect(again).toMatchObject({ claimed: 1, done: 1 });
    expect(await row("evt_lease_2")).toMatchObject({ status: "done", attempts: 2 });
  });
});

describe("per-connection run accounting", () => {
  it("records each connection's own counts and aggregates only in the invocation summary", async () => {
    const h = await harness();
    try {
      const a = await h.connection(ADMIN, "Run A", "sk_sandbox_TESTONLYrunakey0000000001", "acct_run_a");
      const b = await h.connection(ADMIN, "Run B", "sk_sandbox_TESTONLYrunbkey0000000001", "acct_run_b", false);
      const ingest = (conn: string, id: string, charge: string, org: string) => {
        const at = iso(Date.now());
        const body = JSON.stringify({ id, type: "collection.succeeded", created_at: at, organization_id: org, data: { charge_id: charge } });
        return h.scoped("billing_intake").call("billing.ingest_event", [["uuid", conn], ["text", id], ["text", "collection.succeeded"], ["timestamptz", at],
          ["text", org], ["bytea_hex", Buffer.from(body).toString("hex")], ["text", createHash("sha256").update(body).digest("hex")],
          ["bigint", Math.floor(Date.now() / 1000)], ["text", null]]);
      };
      await ingest(a, "evt_run_a1", "ch_run_a1", "acct_run_a");
      await ingest(a, "evt_run_a2", "ch_run_a2", "acct_run_a");
      await ingest(b, "evt_run_b1", "ch_run_b1", "acct_run_b");
      for (const id of ["ch_run_a1", "ch_run_a2"]) h.routes.set(`GET /v1/payments/${id}`, () => ok({ payment_id: id, status: "succeeded", amount: "1.00",
        currency: "USD", subscription_id: null, created_at: iso(Date.now()), updated_at: iso(Date.now()) }));
      h.routes.set("GET /v1/payments/ch_run_b1", timeout);
      const summary = await runWorker({ db: h.scoped("billing_worker"), transport: h.transport, now: () => new Date(), log: silent, workerId: "runs" }, "process", "cron");
      expect(summary).toEqual({ connections: 2, done: 2, failed: 1 });
      const runs = await h.q<{ connection_id: string; claimed: number; done: number; failed: number; trigger: string; finished: boolean }>(
        "select connection_id::text, claimed, done, failed, trigger, finished_at is not null as finished from billing.worker_runs order by started_at");
      expect(runs).toEqual([{ connection_id: a, claimed: 2, done: 2, failed: 0, trigger: "cron", finished: true },
        { connection_id: b, claimed: 1, done: 0, failed: 1, trigger: "cron", finished: true }]);
    } finally {
      await h.close();
    }
  }, 120_000);
});
