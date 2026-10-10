// Post-login destinations must stay on this site. Browsers and URL parsers strip tabs/newlines
// and treat "\" like "/", so "/\t/evil.example" or "/\\evil.example" can become protocol-relative
// external URLs. Reject control characters and backslashes outright, then confirm the parsed
// destination keeps a fixed placeholder origin.
const BASE = "https://savour.invalid";

export function safeNext(next: unknown, fallback = "/workspaces"): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return fallback;
  if (/[\u0000-\u001F\u007F\\]/.test(next)) return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  let url: URL;
  try { url = new URL(next, BASE); } catch { return fallback; }
  if (url.origin !== BASE) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
