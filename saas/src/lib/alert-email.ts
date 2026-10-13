// Milestone 5, Stage 1: owner-initiated email verification through Resend. Pure functions and fixed text only; the
// single network call lives in sendVerification, which takes the key and fetch as arguments (no env read here).
// * The message is fixed in SQL (private.alert_email_verification_message) and repeated here; the server action
//   sends only when the reservation matches these constants exactly, so neither side can change it alone.
// * Outcomes are what the calling admin session saw: "accepted" means Resend accepted the request, never delivered.
// * Automatic alert email is NOT built: it needs a separately reviewed worker and its own key.

export const RESEND_URL = "https://api.resend.com/emails";
export const VERIFICATION_FROM = "onboarding@resend.dev";
export const VERIFICATION_TO = "nonsou@gmail.com";
export const VERIFICATION_SUBJECT = "SAVOUR email verification test";
export const VERIFICATION_TEXT = "This is a SAVOUR email verification test, requested by hand from the platform admin page. "
  + "It contains no alert and no customer information. Automatic alert emails are not connected. No action is needed.";
export const DAILY_LIMIT = 1;
export const TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 4096;
export const HISTORY_DAYS = 14;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_ANY_CASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sending is possible only on a Vercel Preview deployment that has the key. Production, development and a
 *  missing or empty key all fail closed. Returns a boolean only; the key itself never leaves the server action. */
export const sendingConfigured = (env: Record<string, string | undefined>) =>
  env.VERCEL_ENV === "preview" && typeof env.SAVOUR_ALERT_RESEND_API_KEY === "string" && env.SAVOUR_ALERT_RESEND_API_KEY.length > 0;

// ---------------------------------------------------------------------------
// Reservation (output of public.platform_reserve_alert_email_verification)
// ---------------------------------------------------------------------------
export interface Reservation { id: string }

/** Exactly {id, from, to, subject, text} with the fixed values; anything else means nothing is sent. */
export function validateReservation(raw: unknown): Reservation | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "from,id,subject,text,to") return null;
  if (typeof o.id !== "string" || !UUID.test(o.id)) return null;
  if (o.from !== VERIFICATION_FROM || o.to !== VERIFICATION_TO || o.subject !== VERIFICATION_SUBJECT || o.text !== VERIFICATION_TEXT) return null;
  return { id: o.id };
}

// ---------------------------------------------------------------------------
// The one Resend call
// ---------------------------------------------------------------------------
export type Outcome = "accepted" | "rejected" | "unknown";
export interface SendResult { outcome: Outcome; messageId: string | null }

/** Reads at most MAX_RESPONSE_BYTES; a longer or unreadable body is null. */
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

/** 2xx with a valid uuid id: accepted. 4xx except 409: rejected. A 409 may mean a concurrent request; it is unknown. Anything else (5xx, 3xx, timeout, network error, an
 *  oversized or invalid body): unknown. Nothing from the response or the error is returned except the id. */
export async function sendVerification(key: string, r: Reservation, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetchImpl(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `savour-verify-${r.id}` },
      body: JSON.stringify({ from: VERIFICATION_FROM, to: [VERIFICATION_TO], subject: VERIFICATION_SUBJECT, text: VERIFICATION_TEXT }),
      redirect: "error", // never follow a redirect with the Authorization header
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { outcome: "unknown", messageId: null };
  }
  if (res.status >= 200 && res.status < 300) {
    const text = await boundedText(res);
    let id: unknown = null;
    try { id = text === null ? null : (JSON.parse(text) as { id?: unknown })?.id; } catch { id = null; }
    return typeof id === "string" && UUID_ANY_CASE.test(id) ? { outcome: "accepted", messageId: id.toLowerCase() } : { outcome: "unknown", messageId: null };
  }
  await res.body?.cancel().catch(() => {});
  return res.status >= 400 && res.status < 500 && res.status !== 409 ? { outcome: "rejected", messageId: null } : { outcome: "unknown", messageId: null };
}

// ---------------------------------------------------------------------------
// Read validation (public.platform_alert_email_verifications; exact allowlist, fail closed)
// ---------------------------------------------------------------------------
const STATUSES = ["in_progress", "accepted", "rejected", "unknown"] as const;
export type DisplayStatus = (typeof STATUSES)[number];
export interface VerificationRow {
  utc_day: string; status: DisplayStatus; reported: boolean; requested_at: string; finished_at: string | null; provider_message_id: string | null;
}
export interface VerificationsView { observed_at: string; utc_day: string; daily_limit: number; used_today: boolean; history: VerificationRow[] }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00:00$/;
const keysEqual = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).sort().join(",") === [...keys].sort().join(",");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ts = (v: unknown): v is string => typeof v === "string" && TS.test(v) && Number.isFinite(Date.parse(v));

export function validateVerifications(raw: unknown): VerificationsView | null {
  if (!isObj(raw) || !keysEqual(raw, ["observed_at", "utc_day", "daily_limit", "used_today", "history"])) return null;
  const { observed_at, utc_day, daily_limit, used_today, history } = raw;
  if (!ts(observed_at) || typeof utc_day !== "string" || !DAY.test(utc_day) || observed_at.slice(0, 10) !== utc_day) return null;
  if (daily_limit !== DAILY_LIMIT || typeof used_today !== "boolean" || !Array.isArray(history) || history.length > HISTORY_DAYS) return null;
  const rows: VerificationRow[] = [];
  for (const h of history) {
    if (!isObj(h) || !keysEqual(h, ["utc_day", "status", "reported", "requested_at", "finished_at", "provider_message_id"])) return null;
    if (typeof h.utc_day !== "string" || !DAY.test(h.utc_day) || h.utc_day > utc_day) return null;
    if (!STATUSES.includes(h.status as DisplayStatus) || typeof h.reported !== "boolean" || !ts(h.requested_at)) return null;
    if (h.finished_at !== null && !ts(h.finished_at)) return null;
    if (h.provider_message_id !== null && (typeof h.provider_message_id !== "string" || !UUID.test(h.provider_message_id))) return null;
    if (h.reported !== (h.finished_at !== null) || (h.status === "in_progress" && h.reported)) return null;
    if ((h.status === "accepted") !== (h.provider_message_id !== null)) return null;
    if (rows.length > 0 && rows[rows.length - 1].utc_day <= h.utc_day) return null; // newest first, one per day
    rows.push(h as unknown as VerificationRow);
  }
  if (used_today !== (rows[0]?.utc_day === utc_day)) return null;
  return { observed_at, utc_day, daily_limit, used_today, history: rows };
}

// ---------------------------------------------------------------------------
// Static text
// ---------------------------------------------------------------------------
export const STATUS_LABELS: Record<DisplayStatus, string> = {
  in_progress: "In progress (started less than 15 minutes ago)",
  accepted: "Accepted by Resend, as reported by the admin session. Not confirmation of delivery.",
  rejected: "Rejected by Resend, as reported by the admin session.",
  unknown: "Unknown: no clear answer from Resend, or never recorded. The email may or may not have been sent.",
};
export const MESSAGES = {
  confirm: "Tick the confirmation box to send the verification email.",
  notConfigured: "Email sending is not configured on this deployment, so nothing was sent.",
  mfa: "Two-step verification is required to send. Verify with your authenticator on the platform admin page, then try again. Nothing was sent.",
  dailyLimit: "Today's verification (one per UTC day) has already been used. Nothing was sent. Try again after 00:00 UTC.",
  forbidden: "You do not have permission to do that. Nothing was sent.",
  reserveFailed: "The verification could not be started. Nothing was sent.",
  accepted: "Resend accepted the request (as reported by this session). This does not confirm delivery: check the owner inbox.",
  rejected: "Resend rejected the request. Today's verification is used; try again after 00:00 UTC.",
  unknown: "Resend gave no clear answer (timeout, server error or unexpected reply). The email may or may not arrive. Today's verification is used.",
  finishFailed: "The result could not be recorded, so it is uncertain whether Resend accepted the request. Check the owner inbox. Today's verification is used.",
} as const;
