// Owner-only billing checkout. Called by the SAVOUR server with the signed-in user's Supabase JWT
// (functions.invoke); verify_jwt = true and the JWT is validated again with auth.getUser().
// With intent_id, the consenting Owner retries the same pending intent instead of starting a new one.
import { fetchTransport } from "../_shared/bachs-client.ts";
import { authenticatedUser, scopedDb, env, log } from "../_shared/deno/runtime.ts";
import { ENV, json, readJson } from "../_shared/http.ts";
import { resumeCheckout, startCheckout } from "../_shared/owner-core.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const user = await authenticatedUser(req);
  if (!user) return json(401, { error: "not_authenticated" });
  const parsed = await readJson(req);
  if (!parsed.ok) return json(parsed.status, { error: parsed.code });
  const body = parsed.value;
  const deps = { userId: user.userId, userRpc: user.userRpc, gateway: scopedDb("billing_gateway", ENV.gatewayDbUrl),
    transport: fetchTransport(), appOrigin: env(ENV.appOrigin), now: () => new Date(), log };
  const workspaceId = String(body.workspace_id ?? "");
  if (body.intent_id !== undefined) return json(200, await resumeCheckout(deps, { workspaceId, intentId: String(body.intent_id) }));
  return json(200, await startCheckout(deps, { workspaceId, currency: String(body.currency ?? ""), priceId: String(body.price_id ?? ""), termsVersion: String(body.terms_version ?? "") }));
});
