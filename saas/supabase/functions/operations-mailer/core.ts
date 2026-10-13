// operations-mailer: pure request handling for the development-only automatic owner email worker. No Deno globals;
// unit-tested under Node with a mocked database and fetch. The Deno entry (index.ts) only wires the environment, its
// own operations_mail database adapter and the global fetch.
//
// Gates, in order: POST only; a bearer token equal (constant time) to SAVOUR_MAIL_TRIGGER_TOKEN; SUPABASE_URL exactly
// the development project. Only the Authorization header is read: no body, query, recipient or text comes from the
// request. The provider key is read before any claim; without it the worker records not_configured and sends nothing.
// Recipient, sender, text and idempotency key come from the claim and must match the fixed values exactly. Responses
// are a static status plus counts; nothing (key, URL, provider body, database error) is logged or returned.

export const DEV_PROJECT_URL = "https://ilhutasrxnbtssswmgam.supabase.co";
export const RESEND_URL = "https://api.resend.com/emails";
export const MAIL_FROM = "onboarding@resend.dev";
export const MAIL_TO = "nonsou@gmail.com";
export const TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 4096;
export const MAX_CLAIM_ITEMS = 3;
export const MAIL_ENV = {
  projectUrl: "SUPABASE_URL",
  databaseUrl: "SAVOUR_MAIL_DATABASE_URL",
  triggerToken: "SAVOUR_MAIL_TRIGGER_TOKEN",
  resendKey: "SAVOUR_MAIL_RESEND_API_KEY",
} as const;

export type Outcome = "accepted" | "rejected" | "unknown";

/** The three database calls the operations_mail role may make. */
export interface MailerDb {
  heartbeat(status: "ready" | "not_configured"): Promise<unknown>;
  claim(): Promise<unknown>;
  finish(lease: string, outcome: Outcome, providerMessageId: string | null): Promise<unknown>;
}
export interface MailerDeps {
  env: (name: string) => string | undefined;
  /** Opens the scoped database (only after the request is authorized and the project checked). */
  db: () => MailerDb;
  fetch: typeof fetch;
}
export interface ClaimItem { lease_token: string; idempotency_key: string; subject: string; text: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_ANY_CASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reply = (status: number, body: Record<string, string | number>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Constant-time comparison (a length difference still scans the longer input). */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function authorized(req: Request, expected: string | undefined): boolean {
  if (!expected || expected.length < 32) return false;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{16,4096})$/.exec(req.headers.get("authorization") ?? "");
  return m !== null && constantTimeEqual(m[1], expected);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).sort().join(",") === [...keys].sort().join(",");

/** Exactly {status, items}; each item exactly the fixed shape and target. Anything else: null (send nothing). */
export function validateClaim(raw: unknown): { status: "busy" | "disabled" | "ok"; items: ClaimItem[] } | null {
  if (!isObj(raw) || !exactKeys(raw, ["status", "items"]) || !Array.isArray(raw.items) || raw.items.length > MAX_CLAIM_ITEMS) return null;
  if (raw.status !== "busy" && raw.status !== "disabled" && raw.status !== "ok") return null;
  if (raw.status !== "ok" && raw.items.length > 0) return null;
  const items: ClaimItem[] = [];
  for (const i of raw.items) {
    if (!isObj(i) || !exactKeys(i, ["lease_token", "idempotency_key", "from", "to", "subject", "text"])) return null;
    if (typeof i.lease_token !== "string" || !UUID.test(i.lease_token)) return null;
    if (typeof i.idempotency_key !== "string" || !/^savour-alert-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(i.idempotency_key)) return null;
    if (i.from !== MAIL_FROM || i.to !== MAIL_TO) return null;
    if (typeof i.subject !== "string" || i.subject.length < 1 || i.subject.length > 200) return null;
    if (typeof i.text !== "string" || i.text.length < 1 || i.text.length > 2000) return null;
    items.push({ lease_token: i.lease_token, idempotency_key: i.idempotency_key, subject: i.subject, text: i.text });
  }
  return { status: raw.status, items };
}

/** Reads at most MAX_RESPONSE_BYTES; a longer or undecodable body is null. */
async function boundedText(res: Response): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } catch { return null; }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(all); } catch { return null; }
}

/** 2xx with a uuid id: accepted (not delivered). 409, 5xx, other statuses, redirect, timeout, network error or a
 *  malformed/oversized body: unknown. Any other 4xx: rejected. Only the id leaves this function. */
export async function sendOne(key: string, item: ClaimItem, fetchImpl: typeof fetch): Promise<{ outcome: Outcome; messageId: string | null }> {
  let res: Response;
  try {
    res = await fetchImpl(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": item.idempotency_key },
      body: JSON.stringify({ from: MAIL_FROM, to: [MAIL_TO], subject: item.subject, text: item.text }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { outcome: "unknown", messageId: null };
  }
  if (res.status >= 200 && res.status < 300) {
    const text = await boundedText(res);
    let id: unknown = null;
    try { id = text === null ? null : (JSON.parse(text) as { id?: unknown } | null)?.id; } catch { id = null; }
    return typeof id === "string" && UUID_ANY_CASE.test(id) ? { outcome: "accepted", messageId: id.toLowerCase() } : { outcome: "unknown", messageId: null };
  }
  await res.body?.cancel().catch(() => {});
  return res.status >= 400 && res.status < 500 && res.status !== 409 ? { outcome: "rejected", messageId: null } : { outcome: "unknown", messageId: null };
}

export async function handle(req: Request, deps: MailerDeps): Promise<Response> {
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });
  if (!authorized(req, deps.env(MAIL_ENV.triggerToken))) return reply(401, { error: "unauthorized" });
  if (deps.env(MAIL_ENV.projectUrl) !== DEV_PROJECT_URL) return reply(503, { error: "wrong_project" });
  const key = deps.env(MAIL_ENV.resendKey) ?? "";
  const counts = { claimed: 0, accepted: 0, rejected: 0, unknown: 0, unrecorded: 0 };
  try {
    const db = deps.db();
    if (key.length === 0) {
      await db.heartbeat("not_configured");
      return reply(200, { status: "not_configured", ...counts });
    }
    await db.heartbeat("ready");
    const claim = validateClaim(await db.claim());
    if (!claim) return reply(502, { error: "invalid_claim" }); // nothing sent; leases expire to unknown in 15 minutes
    for (const item of claim.items) {
      counts.claimed++;
      const r = await sendOne(key, item, deps.fetch);
      counts[r.outcome]++;
      let done: unknown = null;
      try { done = await db.finish(item.lease_token, r.outcome, r.messageId); } catch { done = null; }
      if (done !== "recorded") counts.unrecorded++;
    }
    return reply(200, { status: claim.status, ...counts });
  } catch {
    return reply(500, { error: "failed", ...counts });
  }
}
