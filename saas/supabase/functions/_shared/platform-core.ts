// Founder-only provider administration flows.
// * storeSecret: the browser posts the secret straight to the Edge function with the admin's JWT; the
//   function checks the shape locally and forwards it to public.platform_store_secret AS THE ADMIN
//   (PostgREST), where SQL re-verifies the platform admin row, aal2 and the registry key pattern and
//   writes it to Vault. Next.js never sees the value; responses carry only a fingerprint.
// * runConnectionTest: read-only provider calls with the connection's credential (pending key first):
//   account identity, organization match, adaptive pricing off, and each proposed/configured product
//   read back (currency, exact amount, monthly cadence). A pass proves credentials and catalogue only;
//   it is not evidence that subscriptions, renewals or webhooks work.
import { BachsClient, type Transport } from "./bachs-client.ts";
import { DtoError } from "./bachs-dto.ts";
import { dbErrorCode, type ScopedDb } from "./db.ts";
import { toMinor } from "./money.ts";
import { logLine } from "./redact.ts";
import type { UserRpc } from "./owner-core.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function storeSecret(deps: { userRpc: UserRpc; log: (l: string) => void },
  input: { connectionId: unknown; kind: unknown; secret: unknown; expectedVersion: unknown }): Promise<{ status: number; body: Record<string, unknown> }> {
  const { connectionId, kind, secret, expectedVersion } = input;
  if (typeof connectionId !== "string" || !UUID.test(connectionId) || (kind !== "api_key" && kind !== "webhook_secret")
      || typeof secret !== "string" || secret.length < 16 || secret.length > 512 || !Number.isInteger(expectedVersion)) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  if (kind === "api_key" && !/^sk_sandbox_[A-Za-z0-9_-]{16,200}$/.test(secret)) return { status: 400, body: { error: "invalid_credential_format" } };
  const { data, error } = await deps.userRpc("platform_store_secret", { p_conn: connectionId, p_kind: kind, p_secret: secret, p_expected_version: expectedVersion });
  if (error) {
    const code = /^[a-z_]{3,60}$/.test(error.message) ? error.message : "request_failed";
    deps.log(logLine("platform.secret_refused", { code, kind }));
    // The overlap refusal carries only the UTC time when the next rotation becomes possible.
    const retryAfter = code === "rotation_overlap_active" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/.test(error.details ?? "") ? error.details : undefined;
    return { status: code === "forbidden" ? 403 : code === "mfa_required" ? 401 : code === "rotation_overlap_active" ? 409 : 400,
      body: retryAfter ? { error: code, retry_after: retryAfter } : { error: code } };
  }
  const d = data as { fingerprint: string; pending_test: boolean };
  deps.log(logLine("platform.secret_stored", { kind, fingerprint: d.fingerprint }));
  return { status: 200, body: { fingerprint: d.fingerprint, pending_test: d.pending_test } };
}

export async function runConnectionTest(deps: { userId: string; userRpc: UserRpc; gateway: ScopedDb; transport: Transport; log: (l: string) => void },
  input: { connectionId: unknown }): Promise<{ status: number; body: Record<string, unknown> }> {
  if (typeof input.connectionId !== "string" || !UUID.test(input.connectionId)) return { status: 400, body: { error: "invalid_request" } };
  const begun = await deps.userRpc("platform_begin_test", { p_conn: input.connectionId });
  if (begun.error) {
    const code = /^[a-z_]{3,60}$/.test(begun.error.message) ? begun.error.message : "request_failed";
    return { status: code === "forbidden" ? 403 : code === "mfa_required" ? 401 : 400, body: { error: code } };
  }
  const testId = begun.data as string;
  const checks: Record<string, string> = {};
  const priceResults: { price_id: string; matched: boolean }[] = [];
  let passed = false;
  let orgMatched = false;
  try {
    const ctx = await deps.gateway.call<{ provider_code: string; base_url: string; key_pattern: string; api_key: string; expected_organization_id: string;
      prices: { price_id: string; currency: string; amount: string; provider_product_id: string }[] }>("platform.gateway_test_context", [["uuid", testId], ["uuid", deps.userId]]);
    if (ctx.provider_code !== "bachs") {
      checks.adapter = "unavailable";
    } else {
      const bachs = new BachsClient({ apiKey: ctx.api_key, baseUrl: ctx.base_url, keyPattern: ctx.key_pattern }, deps.transport);
      const account = await bachs.getAccount();
      if (account.kind !== "ok") {
        checks.account = account.kind === "refused" ? `refused_${account.status}` : `uncertain_${account.reason}`;
      } else {
        checks.account = "ok";
        orgMatched = account.data.id === ctx.expected_organization_id;
        checks.organization = orgMatched ? "matched" : "mismatch";
        checks.active = account.data.is_active ? "yes" : "no";
        // No adaptive (FX) pricing: SAVOUR pins one billing currency per subscription.
        checks.adaptive_pricing = account.data.adaptive_pricing ? "on_refused" : "off";
        for (const p of ctx.prices) {
          const product = await bachs.getProduct(p.provider_product_id);
          let matched = false;
          if (product.kind === "ok") {
            const want = toMinor(p.amount, p.currency);
            matched = product.data.status === "active" && product.data.interval === "month" && product.data.frequency === 1
              && product.data.prices.some((x) => x.currency === p.currency && (() => { try { return toMinor(x.amount, p.currency) === want; } catch { return false; } })());
          }
          checks[`product_${p.currency}`] = product.kind === "ok" ? (matched ? "matched" : "mismatch") : "unavailable";
          priceResults.push({ price_id: p.price_id, matched });
        }
        passed = account.data.is_active && orgMatched && !account.data.adaptive_pricing;
      }
    }
  } catch (e) {
    checks.error = e instanceof DtoError ? "provider_response_invalid" : dbErrorCode(e);
  }
  try {
    const outcome = await deps.gateway.call<string>("platform.gateway_record_test", [["uuid", testId], ["uuid", deps.userId], ["boolean", passed],
      ["boolean", orgMatched], ["jsonb", JSON.stringify(checks)], ["jsonb", JSON.stringify(priceResults)]]);
    deps.log(logLine("platform.test_recorded", { outcome, connection: input.connectionId }));
    return { status: 200, body: { outcome, checks } };
  } catch (e) {
    return { status: 500, body: { error: dbErrorCode(e) } };
  }
}
