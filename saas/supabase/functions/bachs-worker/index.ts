// Billing worker, called by pg_cron/pg_net with a bearer token kept in Vault (see supabase/cron).
// Body: {"mode": "process" | "discover" | "reconcile" | "housekeeping", "trigger": "cron" | "manual"}.
import { fetchTransport } from "../_shared/bachs-client.ts";
import { scopedDb, env, log } from "../_shared/deno/runtime.ts";
import { bearerToken, constantTimeEqual, ENV, json, readJson } from "../_shared/http.ts";
import { runWorker } from "../_shared/worker-core.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const expected = env(ENV.workerToken);
  const token = bearerToken(req);
  if (expected.length < 32 || !token || !constantTimeEqual(token, expected)) return json(401, { error: "unauthorized" });
  const parsed = await readJson(req, 1024);
  if (!parsed.ok) return json(parsed.status, { error: parsed.code });
  const { mode, trigger } = parsed.value;
  if ((mode !== "process" && mode !== "discover" && mode !== "reconcile" && mode !== "housekeeping") || (trigger !== "cron" && trigger !== "manual")) {
    return json(400, { error: "invalid_request" });
  }
  const result = await runWorker({ db: scopedDb("billing_worker", ENV.workerDbUrl), transport: fetchTransport(), now: () => new Date(), log,
    workerId: `edge-${crypto.randomUUID().slice(0, 8)}` }, mode, trigger);
  return json(200, result);
});
