// Public webhook receiver (Supabase Edge, verify_jwt = false). Order: method/size/type checks, raw
// bytes, signature over the raw bytes (before parsing), envelope validation, account check, durable
// insert, then 2xx. A database failure returns 500 so Bachs retries; nothing slow happens before the
// acknowledgement (the worker fetches and reconciles later).
import { parseEnvelope, DtoError } from "./bachs-dto.ts";
import { dbErrorCode, type ScopedDb } from "./db.ts";
import { readBodyLimited } from "./http.ts";
import { logLine } from "./redact.ts";
import { verifyBachsSignature } from "./signature.ts";

export const MAX_WEBHOOK_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface WebhookDeps { db: ScopedDb; nowSeconds: () => number; log: (line: string) => void }

const reply = (status: number, code: string) =>
  new Response(JSON.stringify({ result: code }), { status, headers: { "content-type": "application/json" } });

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return reply(405, "method_not_allowed");
  const connection = new URL(req.url).searchParams.get("connection") ?? "";
  if (!UUID.test(connection)) return reply(404, "unknown_connection");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return reply(415, "unsupported_media_type");
  const body = await readBodyLimited(req, MAX_WEBHOOK_BYTES);
  if (!body.ok) return reply(body.status, body.code);
  const raw = body.bytes;

  let config: { secrets: string[]; expected_organization_id: string };
  try {
    config = await deps.db.call("platform.get_webhook_secrets", [["uuid", connection]]);
  } catch (e) {
    const code = dbErrorCode(e);
    deps.log(logLine("webhook.config_unavailable", { code }));
    // Unknown connection is a permanent refusal; anything else is retryable.
    return code === "unknown_connection" ? reply(404, code) : reply(500, "temporarily_unavailable");
  }
  const verdict = await verifyBachsSignature({
    rawBody: raw, signatureV2: req.headers.get("x-bachs-signature-v2"), legacyTimestamp: req.headers.get("x-bachs-timestamp"),
    legacySignature: req.headers.get("x-bachs-signature"), secrets: config.secrets, nowSeconds: deps.nowSeconds(),
  });
  if (!verdict.ok) {
    deps.log(logLine("webhook.rejected", { reason: verdict.reason, connection }));
    return reply(400, verdict.reason);
  }
  let envelope;
  try {
    envelope = parseEnvelope(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
  } catch (e) {
    deps.log(logLine("webhook.malformed", { reason: e instanceof DtoError ? e.path : "json", connection }));
    return reply(400, "malformed_event");
  }
  const quarantine = envelope.account !== null ? "connected_account_event"
    : envelope.organization_id !== config.expected_organization_id ? "organization_mismatch" : null;
  try {
    const outcome = await deps.db.call<string>("billing.ingest_event", [["uuid", connection], ["text", envelope.id], ["text", envelope.type],
      ["timestamptz", envelope.created_at], ["text", envelope.organization_id], ["bytea_hex", Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("")],
      ["text", await sha256Hex(raw)], ["bigint", verdict.timestamp], ["text", quarantine]]);
    deps.log(logLine("webhook.stored", { outcome, event: envelope.id, type: envelope.type, connection }));
    return reply(200, outcome);
  } catch (e) {
    deps.log(logLine("webhook.store_failed", { code: dbErrorCode(e), event: envelope.id, connection }));
    return reply(500, "temporarily_unavailable");
  }
}
