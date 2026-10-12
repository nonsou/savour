// Checkout preparation (before any checkout request) over the real SQL through the scoped gateway role,
// with a MOCK Bachs transport. Only the customer lookup (200, empty) has been observed in the sandbox; no
// POST /v1/customers response has been observed, and what stopped the witnessed attempt is unknown. These
// tests cover every early preparation stop generically: the reason stays visible on the pending intent,
// the consenting Owner retries the same intent with the same customer idempotency key, an uncertain
// creation is never sent concurrently or outside its retry window, and late outcomes from an expired claim
// are fenced. All refusal status codes and error codes here are synthetic.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TransportRequest, TransportResponse } from "../../supabase/functions/_shared/bachs-client.ts";
import { resumeCheckout, startCheckout } from "../../supabase/functions/_shared/owner-core.ts";
import { harness, ok, timeout } from "./m4-harness";

const ADMIN = "eeeeeeee-0000-4000-8000-000000004800";
const OWNERS = { a: "eeeeeeee-0000-4000-8000-000000004801", b: "eeeeeeee-0000-4000-8000-000000004802", c: "eeeeeeee-0000-4000-8000-000000004803",
  d: "eeeeeeee-0000-4000-8000-000000004804", e: "eeeeeeee-0000-4000-8000-000000004805", f: "eeeeeeee-0000-4000-8000-000000004806",
  g: "eeeeeeee-0000-4000-8000-000000004807" };
const STRANGER = "eeeeeeee-0000-4000-8000-000000004809";
const email = (k: string) => `billing-prep-${k}@m4.savour.test`;
const logs: string[] = [];
const log = (l: string) => { logs.push(l); };

type Prep = { error_code: string | null; detail: string | null; retry_allowed: boolean; customer_uncertain: boolean };
type Billing = { prices: { currency: string; price_id: string }[]; terms_version: string;
  pending_checkout: { id: string; status: string; preparation: Prep | null } | null };

let h: Awaited<ReturnType<typeof harness>>;
const ws: Record<string, string> = {};
const deps = (uid: string) => ({ userId: uid, userRpc: h.userRpc(uid), gateway: h.scoped("billing_gateway"), transport: h.transport,
  appOrigin: "https://preview.savour.test", now: () => new Date(), log });
const billing = async (k: keyof typeof OWNERS) => (await h.userRpc(OWNERS[k])("get_billing", { p_ws: ws[k] })).data as Billing;
const begin = async (k: keyof typeof OWNERS) => {
  const b = await billing(k);
  return startCheckout(deps(OWNERS[k]), { workspaceId: ws[k], currency: "USD", priceId: b.prices.find((p) => p.currency === "USD")!.price_id,
    termsVersion: b.terms_version });
};
const retry = (k: keyof typeof OWNERS, intentId: string, uid = OWNERS[k]) => resumeCheckout(deps(uid), { workspaceId: ws[k], intentId });
const intents = (k: string) => h.q<{ id: string; status: string; last_error_code: string | null; prepare_error_detail: string | null;
  request_attempts: number; provider_checkout_id: string | null; version: number }>(
  "select id, status, last_error_code, prepare_error_detail, request_attempts, provider_checkout_id, version from billing.checkout_intents where workspace_id = $1 order by created_at", [ws[k]]);
const pendingCount = async (k: string) => (await intents(k)).filter((i) => ["created", "requesting", "open", "uncertain", "completed_unpaid", "review"].includes(i.status)).length;
const customerPosts = (k: string) => h.seen.filter((r) => r.method === "POST" && new URL(r.url).pathname === "/v1/customers"
  && JSON.parse(r.body!).email === email(k));

// Mock Bachs: customer search answers per email; creation behaviour per email; checkout creation echoes.
const existing = new Map<string, unknown>();
const createWith = new Map<string, (req: TransportRequest) => TransportResponse | Promise<TransportResponse>>();
// A provider call that stays in flight until the test answers it (a stalled Edge invocation).
const held: { req: TransportRequest; answer: (r: TransportResponse) => void }[] = [];
const hold = (req: TransportRequest) => new Promise<TransportResponse>((answer) => { held.push({ req, answer }); });
const until = async (cond: () => boolean) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); expect(cond()).toBe(true); };
const claimRow = (k: string) => h.q<{ token: string | null; live: boolean }>(
  "select create_claim_token as token, coalesce(create_lease_until > clock_timestamp(), false) as live from billing.provider_customers where workspace_id = $1", [ws[k]]);
const expireClaim = (k: string) => h.q("update billing.provider_customers set create_lease_until = now() - interval '1 second' where workspace_id = $1", [ws[k]]);
let lookup: (req: TransportRequest) => TransportResponse | null = () => null;
const customer = (k: string, metadata: Record<string, string>) => ({ customer_id: `cust_prep_${k}`, email: email(k), metadata,
  created_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z" });

beforeAll(async () => {
  h = await harness();
  const conn = await h.connection(ADMIN, "Preparation sandbox", "sk_sandbox_TESTONLY-prepkey00000000001", "acct_prep");
  await h.q("select billing.operator_configure_price($1, 'USD', '29.00', 'prod_prep', 'disposable fixture')", [conn]);
  for (const [k, uid] of [...Object.entries(OWNERS), ["x", STRANGER]]) {
    await h.q("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [uid, `m4-prep-${k}@savour.test`]);
  }
  for (const [k, uid] of Object.entries(OWNERS)) {
    const owner = h.userRpc(uid);
    ws[k] = (await owner("create_workspace", { p_name: `Prep ${k}`, p_country: "Nigeria", p_timezone: "Africa/Lagos", p_display_name: "Owner" })).data as string;
    expect((await owner("set_billing_contact", { p_ws: ws[k], p_email: email(k), p_consent: true, p_expected_version: 1 })).error).toBeNull();
  }
  h.routes.set("GET /v1/customers", (req) => {
    const pre = lookup(req);
    if (pre) return pre;
    const found = existing.get(new URL(req.url).searchParams.get("search") ?? "");
    return ok({ items: found ? [found] : [], pagination: { has_more: false } });
  });
  h.routes.set("POST /v1/customers", (req) => createWith.get(JSON.parse(req.body!).email)!(req));
  h.routes.set("POST /v1/checkout-sessions", (req) => ok({ checkout_id: `chk_${JSON.parse(req.body!).reference.slice(-12)}`,
    checkout_url: "https://checkout.sandbox.bachs.io/c/prep", status: "open", expires_at: new Date(Date.now() + 3600_000).toISOString(),
    reference: JSON.parse(req.body!).reference }, 201));
}, 120_000);
afterAll(async () => { await h.close(); });

const created = (k: string) => (req: TransportRequest) => ok({ ...customer(k, JSON.parse(req.body!).metadata) }, 201);

describe("checkout preparation recovery (mock provider transport)", () => {
  it("a refused customer creation keeps a precise reason on the pending intent; the retry reuses the same intent and customer key", async () => {
    createWith.set(email("a"), () => ({ status: 422, bodyText: JSON.stringify({ detail: `${email("a")} rejected by synthetic rule`, error_code: "VALIDATION_ERROR" }) }));
    expect(await begin("a")).toEqual({ kind: "error", code: "customer_create_refused" });
    const [first] = await intents("a");
    expect(first).toMatchObject({ status: "created", last_error_code: "customer_create_refused", prepare_error_detail: "http_422:VALIDATION_ERROR",
      request_attempts: 0, provider_checkout_id: null });
    // Visible after any reload: the page reads it from get_billing, not from the form that submitted.
    expect((await billing("a")).pending_checkout).toMatchObject({ id: first.id, status: "created",
      preparation: { error_code: "customer_create_refused", detail: "http_422:VALIDATION_ERROR", retry_allowed: true, customer_uncertain: false } });
    expect(logs.join("\n")).toContain("customer_create_refused");
    expect(logs.join("\n")).not.toMatch(/billing-prep-a@|synthetic rule|sk_sandbox_/);

    createWith.set(email("a"), created("a"));
    expect(await retry("a", first.id)).toEqual({ kind: "redirect", url: "https://checkout.sandbox.bachs.io/c/prep" });
    const posts = customerPosts("a");
    expect(posts).toHaveLength(2);
    expect(posts[1].headers["Idempotency-Key"]).toBe(posts[0].headers["Idempotency-Key"]);
    const rows = await intents("a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, status: "open", last_error_code: null, request_attempts: 1 });
    const checkout = h.seen.filter((r) => r.url.endsWith("/v1/checkout-sessions") && JSON.parse(r.body!).metadata.savour_workspace_id === ws.a);
    expect(checkout.map((r) => r.headers["Idempotency-Key"])).toEqual([`savour-checkout-${first.id}`]);
    expect((await billing("a")).pending_checkout).toMatchObject({ id: first.id, status: "open", preparation: null });
  });

  it("an uncertain creation is never sent while another attempt holds the claim, and a customer it did create is adopted, not created again", async () => {
    createWith.set(email("b"), () => timeout());
    expect(await begin("b")).toEqual({ kind: "error", code: "customer_create_uncertain" });
    const [intent] = await intents("b");
    expect((await billing("b")).pending_checkout!.preparation).toEqual({ error_code: "customer_create_uncertain", detail: "timeout",
      retry_allowed: true, customer_uncertain: true });

    // A concurrent request (another tab) holds the creation claim: the retry does not call Bachs.
    expect(await h.scoped("billing_gateway").call("billing.gateway_customer_claim", [["uuid", intent.id], ["uuid", OWNERS.b]]))
      .toMatchObject({ decision: "proceed", claim: expect.any(String) });
    expect(await retry("b", intent.id)).toEqual({ kind: "error", code: "customer_create_in_progress" });
    expect(customerPosts("b")).toHaveLength(1);

    // That request died without recording a result (lease expired). The timed-out creation did succeed.
    await h.q("update billing.provider_customers set create_lease_until = now() - interval '1 second' where workspace_id = $1", [ws.b]);
    existing.set(email("b"), customer("b", { savour_workspace_id: ws.b, savour_connection_id: (await h.q<{ c: string }>(
      "select connection_id as c from billing.checkout_intents where id = $1", [intent.id]))[0].c }));
    expect(await retry("b", intent.id)).toEqual({ kind: "redirect", url: "https://checkout.sandbox.bachs.io/c/prep" });
    expect(customerPosts("b")).toHaveLength(1);
    expect(await h.q("select provider_customer_id from billing.provider_customers where workspace_id = $1", [ws.b])).toEqual([{ provider_customer_id: "cust_prep_b" }]);
    expect(await pendingCount("b")).toBe(1);
  });

  it("uncertainty that is not resolved within three identical retries goes to review and no further customer request is sent", async () => {
    createWith.set(email("c"), () => timeout());
    expect(await begin("c")).toEqual({ kind: "error", code: "customer_create_uncertain" });
    const [intent] = await intents("c");
    for (let i = 0; i < 3; i++) expect(await retry("c", intent.id)).toEqual({ kind: "error", code: "customer_create_uncertain" });
    expect(await retry("c", intent.id)).toEqual({ kind: "error", code: "customer_create_unresolved" });
    const posts = customerPosts("c");
    expect(posts).toHaveLength(4);
    expect(new Set(posts.map((p) => p.headers["Idempotency-Key"])).size).toBe(1);
    expect((await billing("c")).pending_checkout!.preparation).toMatchObject({ error_code: "customer_create_unresolved", retry_allowed: false });
    expect(await h.q("select kind from billing.review_queue where workspace_id = $1", [ws.c])).toEqual([{ kind: "customer_creation_unresolved" }]);
    expect(await retry("c", intent.id)).toEqual({ kind: "error", code: "checkout_not_retryable" });
    // Fresh consent supersedes the stuck intent, but the customer stays blocked behind the review.
    expect(await begin("c")).toEqual({ kind: "error", code: "customer_create_unresolved" });
    expect(customerPosts("c")).toHaveLength(4);
    expect(await pendingCount("c")).toBe(1);
  });

  it("a late refusal from an expired claim neither releases the newer claim nor overwrites the newer attempt; a third request is denied", async () => {
    createWith.set(email("f"), hold);
    const a = begin("f");                                       // A: claims and stalls inside POST /v1/customers
    await until(() => customerPosts("f").length === 1);
    const [intent] = await intents("f");
    const aToken = (await claimRow("f"))[0].token;
    await expireClaim("f");                                     // A's lease runs out while it is still in flight
    const b = retry("f", intent.id);                            // B: the Owner retries and acquires a new claim
    await until(() => customerPosts("f").length === 2);
    const [bClaim] = await claimRow("f");
    expect(bClaim.live).toBe(true);
    expect(bClaim.token).not.toBe(aToken);

    held[0].answer({ status: 422, bodyText: JSON.stringify({ error_code: "VALIDATION_ERROR" }) });
    expect(await a).toEqual({ kind: "error", code: "customer_create_refused" });
    expect(await claimRow("f")).toEqual([bClaim]);              // B's lease and token survive A's late outcome
    expect((await intents("f"))[0]).toMatchObject({ status: "created", last_error_code: null, prepare_error_detail: null });

    expect(await retry("f", intent.id)).toEqual({ kind: "error", code: "customer_create_in_progress" });   // C
    expect(customerPosts("f")).toHaveLength(2);
    expect(await claimRow("f")).toEqual([bClaim]);

    // B completes with the customer for the shared key; the checkout opens exactly once.
    held[1].answer(ok(customer("f", JSON.parse(held[1].req.body!).metadata), 201));
    expect((await b).kind).toBe("redirect");
    expect(new Set(customerPosts("f").map((p) => p.headers["Idempotency-Key"])).size).toBe(1);
    expect(h.seen.filter((r) => r.url.endsWith("/v1/checkout-sessions") && JSON.parse(r.body!).metadata.savour_workspace_id === ws.f)).toHaveLength(1);
    expect(await intents("f")).toMatchObject([{ id: intent.id, status: "open" }]);
  });

  it("a late success from an expired claim binds only the same customer and never starts a second checkout", async () => {
    held.length = 0;
    createWith.set(email("g"), hold);
    const a = begin("g");
    await until(() => customerPosts("g").length === 1);
    const [intent] = await intents("g");
    await expireClaim("g");
    const b = retry("g", intent.id);
    await until(() => customerPosts("g").length === 2);
    held[1].answer(ok(customer("g", JSON.parse(held[1].req.body!).metadata), 201));
    expect((await b).kind).toBe("redirect");
    // A's identical request returns the same customer late: binding is idempotent, the open checkout stays.
    held[0].answer(ok(customer("g", JSON.parse(held[0].req.body!).metadata), 201));
    expect(await a).toEqual({ kind: "error", code: "checkout_intent_stale" });
    expect(await intents("g")).toMatchObject([{ id: intent.id, status: "open", last_error_code: null }]);
    expect(await h.q("select provider_customer_id from billing.provider_customers where workspace_id = $1", [ws.g])).toEqual([{ provider_customer_id: "cust_prep_g" }]);
    expect(h.seen.filter((r) => r.url.endsWith("/v1/checkout-sessions") && JSON.parse(r.body!).metadata.savour_workspace_id === ws.g)).toHaveLength(1);
    expect(await h.q("select 1 from billing.review_queue where workspace_id = $1", [ws.g])).toHaveLength(0);
  });

  it("an uncertain creation older than the provider's idempotency window is never repeated", async () => {
    createWith.set(email("d"), () => timeout());
    await begin("d");
    const [intent] = await intents("d");
    await h.q("update billing.provider_customers set create_uncertain_since = now() - interval '24 hours' where workspace_id = $1", [ws.d]);
    expect(await retry("d", intent.id)).toEqual({ kind: "error", code: "customer_create_unresolved" });
    expect(customerPosts("d")).toHaveLength(1);
  });

  it("lookup failures and unreadable creation responses never leave Preparing without a reason", async () => {
    lookup = () => ({ status: 503, bodyText: "{}" });
    expect(await begin("e")).toEqual({ kind: "error", code: "customer_lookup_unavailable" });
    const [intent] = await intents("e");
    expect(intent).toMatchObject({ status: "created", last_error_code: "customer_lookup_unavailable", prepare_error_detail: "http_503" });
    lookup = () => ({ status: 401, bodyText: JSON.stringify({ error_code: "UNAUTHORIZED" }) });
    expect(await retry("e", intent.id)).toEqual({ kind: "error", code: "customer_lookup_refused" });
    expect((await intents("e"))[0].prepare_error_detail).toBe("http_401:UNAUTHORIZED");
    expect(customerPosts("e")).toHaveLength(0);
    // A 2xx creation response that does not match the documented shape may still have created the customer.
    lookup = () => null;
    createWith.set(email("e"), () => ok({ id: "not-a-documented-customer" }, 201));
    expect(await retry("e", intent.id)).toEqual({ kind: "error", code: "customer_create_uncertain" });
    expect((await billing("e")).pending_checkout!.preparation).toEqual({ error_code: "customer_create_uncertain", detail: "response_invalid",
      retry_allowed: true, customer_uncertain: true });
    expect(await h.q("select create_lease_until from billing.provider_customers where workspace_id = $1", [ws.e])).toEqual([{ create_lease_until: null }]);
  });

  it("only the consenting Owner retries, only in that workspace, and only while the intent is fresh", async () => {
    const [intent] = await intents("e");
    const before = intent.version;
    expect((await retry("e", intent.id, STRANGER)).kind).toBe("error");
    expect(await resumeCheckout(deps(OWNERS.d), { workspaceId: ws.d, intentId: intent.id })).toEqual({ kind: "error", code: "not_found" });
    expect((await h.userRpc(OWNERS.e)("resume_checkout", { p_ws: ws.e, p_intent: intent.id })).error).toBeNull();
    expect((await intents("e"))[0].version).toBe(before + 1);
    await h.q("update billing.checkout_intents set created_at = now() - interval '16 minutes' where id = $1", [intent.id]);
    expect((await billing("e")).pending_checkout!.preparation!.retry_allowed).toBe(false);
    expect(await retry("e", intent.id)).toEqual({ kind: "error", code: "checkout_intent_stale" });
    // The stale intent no longer blocks fresh consent, and there is still only one pending intent.
    createWith.set(email("e"), created("e"));
    expect((await begin("e")).kind).toBe("redirect");
    expect(await pendingCount("e")).toBe(1);
    expect(logs.join("\n")).not.toMatch(/@m4\.savour\.test|sk_sandbox_|checkout\.sandbox\.bachs\.io/);
  });
});
