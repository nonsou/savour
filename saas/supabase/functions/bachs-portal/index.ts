// Owner-only billing portal. Called by the SAVOUR server with the signed-in user's Supabase JWT
// (functions.invoke); verify_jwt = true and the JWT is validated again with auth.getUser().
import { fetchTransport } from "../_shared/bachs-client.ts";
import { authenticatedUser, scopedDb, env, log } from "../_shared/deno/runtime.ts";
import { ENV, json, readJson } from "../_shared/http.ts";
import { openPortal } from "../_shared/owner-core.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const user = await authenticatedUser(req);
  if (!user) return json(401, { error: "not_authenticated" });
  const parsed = await readJson(req);
  if (!parsed.ok) return json(parsed.status, { error: parsed.code });
  const body = parsed.value;
  const deps = { userId: user.userId, userRpc: user.userRpc, gateway: scopedDb("billing_gateway", ENV.gatewayDbUrl),
    transport: fetchTransport(), appOrigin: env(ENV.appOrigin), now: () => new Date(), log };
  return json(200, await openPortal(deps, { workspaceId: String(body.workspace_id ?? "") }));
});
