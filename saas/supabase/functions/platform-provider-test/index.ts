// Founder-only platform administration (provider-test), called from the admin's browser with their Supabase JWT.
// The request body is never logged. SQL re-verifies the platform admin and aal2 for every write.
import { fetchTransport } from "../_shared/bachs-client.ts";
import { authenticatedUser, scopedDb, env, log } from "../_shared/deno/runtime.ts";
import { corsHeaders, ENV, json, readJson } from "../_shared/http.ts";
import { runConnectionTest } from "../_shared/platform-core.ts";

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"), env(ENV.appOrigin));
  if (req.method === "OPTIONS") return new Response(null, { status: cors["access-control-allow-origin"] ? 204 : 403, headers: cors });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, cors);
  const user = await authenticatedUser(req);
  if (!user) return json(401, { error: "not_authenticated" }, cors);
  const parsed = await readJson(req);
  if (!parsed.ok) return json(parsed.status, { error: parsed.code }, cors);
  const body = parsed.value;
  const result = await runConnectionTest({ userId: user.userId, userRpc: user.userRpc, gateway: scopedDb("billing_gateway", ENV.gatewayDbUrl), transport: fetchTransport(), log }, { connectionId: body.connection_id });
  return json(result.status, result.body, cors);
});
