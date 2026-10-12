// Owner-initiated billing flows (checkout, portal, cancellation). The Edge entrypoint validated the
// Supabase JWT with auth.getUser(); each flow first calls the Owner RPC as that user (PostgREST, RLS,
// live membership) and then the billing_gateway functions, which re-check the live Owner by user id
// immediately before any provider call. Provider identifiers, URLs and secrets are never logged.
import { BachsClient, type Transport } from "./bachs-client.ts";
import { DtoError } from "./bachs-dto.ts";
import { dbErrorCode, type ScopedDb } from "./db.ts";
import { logLine } from "./redact.ts";
import { classifyCheckoutCreation } from "./worker-core.ts";

export type UserRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; details?: string | null } | null }>;
export interface OwnerDeps {
  userId: string;
  userRpc: UserRpc;
  gateway: ScopedDb;
  transport: Transport;
  appOrigin: string;
  now: () => Date;
  log: (line: string) => void;
}
export type FlowResult = { kind: "redirect"; url: string } | { kind: "processing"; code: string } | { kind: "done"; data: Record<string, unknown> }
  | { kind: "error"; code: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Provider-hosted pages only: https on bachs.io (never an open redirect). */
export function isProviderUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "bachs.io" || u.hostname.endsWith(".bachs.io")) && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function validateOrigin(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== "https:" || u.pathname !== "/" || u.search || u.hash || u.username) throw new Error("SAVOUR_APP_ORIGIN must be a bare https origin");
  return u.origin;
}

async function client(deps: OwnerDeps, connection: string): Promise<BachsClient> {
  const c = await deps.gateway.call<{ provider_code: string; base_url: string; key_pattern: string; api_key: string }>("platform.get_credential", [["uuid", connection]]);
  if (c.provider_code !== "bachs") throw new Error("adapter_unavailable");
  return new BachsClient({ apiKey: c.api_key, baseUrl: c.base_url, keyPattern: c.key_pattern }, deps.transport);
}

async function rpc(deps: OwnerDeps, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await deps.userRpc(fn, args);
  if (error) throw new Error(/^[a-z_]{3,60}$/.test(error.message) ? error.message : "request_failed");
  return data;
}

function failure(e: unknown): FlowResult {
  return { kind: "error", code: e instanceof DtoError ? "provider_response_invalid" : dbErrorCode(e) };
}

/** Find or create the workspace's provider customer on the intent's connection. */
async function ensureCustomer(deps: OwnerDeps, bachs: BachsClient, ctx: { workspace_id: string; connection_id: string; billing_email: string;
  provider_customer_id: string | null; customer_idempotency_key: string }): Promise<string | FlowResult> {
  if (ctx.provider_customer_id) return ctx.provider_customer_id;
  const found = await bachs.searchCustomers(ctx.billing_email);
  if (found.kind !== "ok") return { kind: "error", code: found.kind === "uncertain" ? "provider_unavailable" : "provider_refused" };
  const exact = found.data.items.filter((c) => c.email.toLowerCase() === ctx.billing_email);
  if (exact.length > 1 || found.data.has_more) {
    await deps.gateway.call("billing.gateway_customer_review", [["uuid", ctx.workspace_id], ["uuid", ctx.connection_id], ["uuid", deps.userId],
      ["text", "customer_lookup_ambiguous"], ["text", null]]);
    return { kind: "error", code: "billing_customer_review" };
  }
  if (exact.length === 1) {
    // Email is unique at Bachs. Adopt only a customer SAVOUR itself created for this workspace and
    // connection (our metadata, written with our secret key); anything else goes to review.
    const c = exact[0];
    if (c.metadata.savour_workspace_id !== ctx.workspace_id || c.metadata.savour_connection_id !== ctx.connection_id) {
      await deps.gateway.call("billing.gateway_customer_review", [["uuid", ctx.workspace_id], ["uuid", ctx.connection_id], ["uuid", deps.userId],
        ["text", "customer_email_exists"], ["text", c.customer_id]]);
      return { kind: "error", code: "billing_customer_review" };
    }
    await deps.gateway.call("billing.gateway_bind_customer", [["uuid", ctx.workspace_id], ["uuid", ctx.connection_id], ["uuid", deps.userId],
      ["text", c.customer_id], ["text", c.email], ["text", "adopted"]]);
    return c.customer_id;
  }
  const created = await bachs.createCustomer({ email: ctx.billing_email,
    metadata: { savour_workspace_id: ctx.workspace_id, savour_connection_id: ctx.connection_id } }, ctx.customer_idempotency_key);
  if (created.kind === "uncertain") return { kind: "processing", code: "customer_creation_uncertain" };
  if (created.kind === "refused") return { kind: "error", code: "provider_refused" };
  await deps.gateway.call("billing.gateway_bind_customer", [["uuid", ctx.workspace_id], ["uuid", ctx.connection_id], ["uuid", deps.userId],
    ["text", created.data.customer_id], ["text", created.data.email], ["text", "created"]]);
  return created.data.customer_id;
}

export async function startCheckout(deps: OwnerDeps, input: { workspaceId: string; currency: string; priceId: string; termsVersion: string }): Promise<FlowResult> {
  if (!UUID.test(input.workspaceId) || !UUID.test(input.priceId) || !["NGN", "USD"].includes(input.currency)) return { kind: "error", code: "invalid_request" };
  try {
    const begun = (await rpc(deps, "begin_checkout", { p_ws: input.workspaceId, p_currency: input.currency, p_price_id: input.priceId,
      p_terms_version: input.termsVersion })) as { intent_id: string };
    const ctx = await deps.gateway.call<{ intent_id: string; workspace_id: string; connection_id: string; billing_email: string;
      provider_customer_id: string | null; customer_idempotency_key: string; provider_product_id: string; currency: string;
      card_corridor: string; reference: string; idempotency_key: string }>("billing.gateway_checkout_context", [["uuid", begun.intent_id], ["uuid", deps.userId]]);
    const bachs = await client(deps, ctx.connection_id);
    const customer = await ensureCustomer(deps, bachs, ctx);
    if (typeof customer !== "string") return customer;
    const origin = validateOrigin(deps.appOrigin);
    const body = JSON.stringify({
      product_cart: [{ product_id: ctx.provider_product_id, quantity: 1 }],
      customer: { customer_id: customer },
      billing_currency: ctx.currency,
      payment_method_types: [ctx.card_corridor],
      success_url: `${origin}/w/${ctx.workspace_id}/billing/return?intent=${ctx.intent_id}`,
      cancel_url: `${origin}/w/${ctx.workspace_id}/billing?checkout=cancelled`,
      reference: ctx.reference,
      metadata: { savour_workspace_id: ctx.workspace_id, savour_intent_id: ctx.intent_id },
      expires_in_minutes: 60,
    });
    await deps.gateway.call("billing.gateway_mark_requesting", [["uuid", ctx.intent_id], ["uuid", deps.userId], ["text", body]]);
    const r = await bachs.createCheckout(body, ctx.idempotency_key);
    const k = classifyCheckoutCreation(r);
    const created = r.kind === "ok" ? r.data : null;
    const recorded = await deps.gateway.call<string>("billing.gateway_record_checkout", [["uuid", ctx.intent_id], ["uuid", deps.userId], ["text", k.outcome],
      ["text", created?.checkout_id ?? null], ["text", created?.checkout_url ?? null], ["timestamptz", created?.expires_at ?? null],
      ["text", created?.reference ?? null], ["text", k.error]]);
    deps.log(logLine("checkout.recorded", { intent: ctx.intent_id, outcome: recorded }));
    if (recorded === "open" && created && isProviderUrl(created.checkout_url)) return { kind: "redirect", url: created.checkout_url };
    if (recorded === "failed") return { kind: "error", code: "checkout_refused" };
    if (recorded === "review") return { kind: "processing", code: "checkout_review" };
    return { kind: "processing", code: "checkout_outcome_uncertain" };
  } catch (e) {
    deps.log(logLine("checkout.failed", { code: dbErrorCode(e) }));
    return failure(e);
  }
}

/** A fresh portal session minted on request; the URL is returned once and never stored or logged. */
export async function openPortal(deps: OwnerDeps, input: { workspaceId: string }): Promise<FlowResult> {
  if (!UUID.test(input.workspaceId)) return { kind: "error", code: "invalid_request" };
  try {
    await rpc(deps, "authorize_portal", { p_ws: input.workspaceId });
    const ctx = await deps.gateway.call<{ connection_id: string; provider_customer_id: string; subscription_ids: string[] }>(
      "billing.gateway_portal_context", [["uuid", input.workspaceId], ["uuid", deps.userId]]);
    const bachs = await client(deps, ctx.connection_id);
    const seen: string[] = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const page = await bachs.listSubscriptions(ctx.provider_customer_id, offset);
      if (page.kind !== "ok") return { kind: "error", code: "provider_unavailable" };
      for (const s of page.data.items) {
        if (s.customer_id !== ctx.provider_customer_id) return { kind: "error", code: "provider_response_invalid" };
        seen.push(s.id);
      }
      if (!page.data.has_more) break;
    }
    // Generic portal access is refused if the customer has any subscription this workspace does not own.
    const foreign = seen.filter((id) => !ctx.subscription_ids.includes(id));
    if (foreign.length > 0) {
      await deps.gateway.call("billing.gateway_portal_refused", [["uuid", input.workspaceId], ["uuid", ctx.connection_id], ["uuid", deps.userId], ["text[]", foreign]]);
      return { kind: "error", code: "billing_portal_refused" };
    }
    const session = await bachs.createPortalSession(ctx.provider_customer_id);
    if (session.kind !== "ok" || !isProviderUrl(session.data.url)) return { kind: "error", code: "provider_unavailable" };
    deps.log(logLine("portal.minted", { workspace: input.workspaceId }));
    return { kind: "redirect", url: session.data.url };
  } catch (e) {
    return failure(e);
  }
}

/** Cancel at period end. Confirmed only from the provider's subscription response (or a later read). */
export async function cancelSubscription(deps: OwnerDeps, input: { workspaceId: string; expectedVersion: number }): Promise<FlowResult> {
  if (!UUID.test(input.workspaceId) || !Number.isInteger(input.expectedVersion)) return { kind: "error", code: "invalid_request" };
  try {
    const req = (await rpc(deps, "request_cancellation", { p_ws: input.workspaceId, p_expected_version: input.expectedVersion })) as { cancellation: string };
    if (req.cancellation === "confirmed") return { kind: "done", data: { cancellation: "confirmed" } };
    const ctx = await deps.gateway.call<{ connection_id: string; provider_subscription_id: string }>("billing.gateway_cancel_context",
      [["uuid", input.workspaceId], ["uuid", deps.userId]]);
    const bachs = await client(deps, ctx.connection_id);
    const r = await bachs.cancelAtPeriodEnd(ctx.provider_subscription_id);
    if (r.kind !== "ok") return { kind: "processing", code: r.kind === "uncertain" ? "cancellation_pending" : "cancellation_refused" };
    const applied = await deps.gateway.call<string>("billing.gateway_apply_subscription", [["uuid", input.workspaceId], ["uuid", deps.userId],
      ["jsonb", JSON.stringify({ subscription: r.data })], ["timestamptz", deps.now().toISOString()]]);
    return { kind: "done", data: { cancellation: r.data.cancel_at_period_end && applied === "applied" ? "confirmed" : "pending" } };
  } catch (e) {
    return failure(e);
  }
}
