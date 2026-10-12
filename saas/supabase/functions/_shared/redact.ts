// Redaction for anything that might reach a log line or an error response. Provider keys, webhook
// secrets, bearer tokens, URLs (portal and checkout URLs carry session credentials) and email
// addresses are replaced. Logs should carry codes and IDs only; this is the last line of defence.
const PATTERNS: [RegExp, string][] = [
  [/\bsk_(?:live|sandbox|test)_[A-Za-z0-9_-]+/g, "[redacted-key]"],
  [/\bwhsec_[A-Za-z0-9_]+/g, "[redacted-secret]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[redacted-jwt]"],
  [/https?:\/\/[^\s"'<>]+/g, "[redacted-url]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
];

export function redact(input: unknown): string {
  let s = typeof input === "string" ? input : (() => { try { return JSON.stringify(input); } catch { return String(input); } })();
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}

/** Structured log line with redaction applied to every value. */
export function logLine(event: string, fields: Record<string, unknown> = {}): string {
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) safe[k] = redact(v);
  return JSON.stringify({ event, ...safe });
}
