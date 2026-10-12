// Pure HTTP helpers shared by the Edge entrypoints (no Deno globals; unit-tested under Node).
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

/** CORS for the browser-called admin functions: only the configured SAVOUR origin, never "*". */
export function corsHeaders(requestOrigin: string | null, allowedOrigin: string): Record<string, string> {
  if (!requestOrigin || requestOrigin !== allowedOrigin) return {};
  return { "access-control-allow-origin": allowedOrigin, "access-control-allow-headers": "authorization, content-type, x-client-info, apikey",
    "access-control-allow-methods": "POST, OPTIONS", vary: "Origin" };
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{16,4096})$/.exec(h);
  return m ? m[1] : null;
}

/** Constant-time string comparison (length difference still scans the longer input). */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export type BodyFailure = { ok: false; status: 400 | 413; code: "payload_too_large" | "body_unreadable" | "invalid_encoding" | "invalid_json" | "invalid_request" };

/** Reads the raw body as bytes with a hard limit: an oversized Content-Length is refused before reading,
 *  and the streamed byte count is enforced too (a missing or false header cannot bypass the limit). */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | BodyFailure> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^[0-9]{1,12}$/.test(declared) || Number(declared) > maxBytes)) {
    return /^[0-9]{1,12}$/.test(declared) ? { ok: false, status: 413, code: "payload_too_large" } : { ok: false, status: 400, code: "invalid_request" };
  }
  if (!req.body) return { ok: true, bytes: new Uint8Array() };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, code: "payload_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, code: "body_unreadable" };
  }
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.byteLength; }
  return { ok: true, bytes };
}

/** A bounded JSON object body. Failures carry only a code (the body is never echoed or logged). */
export async function readJson(req: Request, maxBytes = 16 * 1024): Promise<{ ok: true; value: Record<string, unknown> } | BodyFailure> {
  const body = await readBodyLimited(req, maxBytes);
  if (!body.ok) return body;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes); } catch { return { ok: false, status: 400, code: "invalid_encoding" }; }
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, status: 400, code: "invalid_json" }; }
  return typeof v === "object" && v !== null && !Array.isArray(v) ? { ok: true, value: v as Record<string, unknown> } : { ok: false, status: 400, code: "invalid_request" };
}

/** Environment contract. Values come from Supabase function secrets set by the operator, never source. */
export const ENV = {
  supabaseUrl: "SUPABASE_URL",
  supabaseAnonKey: "SUPABASE_ANON_KEY",
  intakeDbUrl: "SAVOUR_BILLING_INTAKE_DB_URL",
  workerDbUrl: "SAVOUR_BILLING_WORKER_DB_URL",
  gatewayDbUrl: "SAVOUR_BILLING_GATEWAY_DB_URL",
  workerToken: "SAVOUR_BILLING_WORKER_TOKEN",
  appOrigin: "SAVOUR_APP_ORIGIN",
} as const;
