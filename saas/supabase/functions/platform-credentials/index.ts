// Founder-only platform administration (credentials), called from the admin's browser with their Supabase JWT.
// The request body is never logged. SQL re-verifies the platform admin and aal2 for every write.
import { authenticatedUser, env, log } from "../_shared/deno/runtime.ts";
import { corsHeaders, ENV, json, readJson } from "../_shared/http.ts";
import { storeSecret } from "../_shared/platform-core.ts";

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"), env(ENV.appOrigin));
  if (req.method === "OPTIONS") return new Response(null, { status: cors["access-control-allow-origin"] ? 204 : 403, headers: cors });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, cors);
  const user = await authenticatedUser(req);
  if (!user) return json(401, { error: "not_authenticated" }, cors);
  const parsed = await readJson(req);
  if (!parsed.ok) return json(parsed.status, { error: parsed.code }, cors);
  const body = parsed.value;
  const result = await storeSecret({ userRpc: user.userRpc, log }, { connectionId: body.connection_id, kind: body.kind, secret: body.secret, expectedVersion: body.expected_version });
  return json(result.status, result.body, cors);
});
