// Public Bachs webhook receiver: /functions/v1/bachs-webhook?connection=<provider connection id>.
// verify_jwt = false (config.toml); authenticity comes from the signature over the raw body.
import { scopedDb, log } from "../_shared/deno/runtime.ts";
import { ENV } from "../_shared/http.ts";
import { handleWebhook } from "../_shared/webhook-core.ts";

Deno.serve((req) => handleWebhook(req, { db: scopedDb("billing_intake", ENV.intakeDbUrl), nowSeconds: () => Math.floor(Date.now() / 1000), log }));
