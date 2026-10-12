// Bachs webhook signature verification (official guide, X-Bachs-Signature-V2):
//   header  t=<unix seconds>,v1=<hex HMAC-SHA256>[,v1=<hex>...]   (one v1 per currently valid secret)
//   signed  "<t>." + the unaltered raw body bytes
// Verified before any JSON parsing or database work. Every v1 is compared against every configured
// secret in constant time (no early exit). The legacy X-Bachs-Timestamp / X-Bachs-Signature pair is
// deliberately NOT accepted on its own; when it accompanies V2 it must agree with it exactly.
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_HEADER = 2048;
const MAX_V1 = 8;

export type VerifyFailure =
  | "missing_signature" | "legacy_signature_only" | "malformed_signature" | "contradictory_headers"
  | "stale_timestamp" | "future_timestamp" | "signature_mismatch" | "no_secret";

export interface ParsedSignature { timestamp: number; signatures: string[] }

export function parseSignatureV2(header: string): ParsedSignature | null {
  if (header.length === 0 || header.length > MAX_HEADER) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const raw of header.split(",")) {
    const part = raw.trim();
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") {
      if (timestamp !== null || !/^[0-9]{1,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/.test(value) || signatures.length >= MAX_V1) return null;
      signatures.push(value);
    } else if (!/^v[0-9]{1,2}$/.test(key) || !/^[0-9A-Za-z+/=_-]{1,512}$/.test(value)) {
      // Future schemes (v2, ...) are named so they can be ignored; anything else is malformed.
      return null;
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

const encoder = new TextEncoder();

export async function hmacSha256Hex(secret: string, data: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, data as BufferSource));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two equal-length lowercase hex strings (length mismatch still scans). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function signedPayload(timestamp: number, rawBody: Uint8Array): Uint8Array {
  const prefix = encoder.encode(`${timestamp}.`);
  const out = new Uint8Array(prefix.length + rawBody.length);
  out.set(prefix, 0);
  out.set(rawBody, prefix.length);
  return out;
}

export async function verifyBachsSignature(input: {
  rawBody: Uint8Array;
  signatureV2: string | null;
  legacyTimestamp: string | null;
  legacySignature: string | null;
  secrets: string[];
  nowSeconds: number;
  toleranceSeconds?: number;
}): Promise<{ ok: true; timestamp: number } | { ok: false; reason: VerifyFailure }> {
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (input.signatureV2 === null) {
    return { ok: false, reason: input.legacySignature !== null || input.legacyTimestamp !== null ? "legacy_signature_only" : "missing_signature" };
  }
  const parsed = parseSignatureV2(input.signatureV2);
  if (!parsed) return { ok: false, reason: "malformed_signature" };
  if (input.legacyTimestamp !== null && input.legacyTimestamp.trim() !== String(parsed.timestamp)) {
    return { ok: false, reason: "contradictory_headers" };
  }
  if (input.legacySignature !== null && !parsed.signatures.includes(input.legacySignature.trim())) {
    return { ok: false, reason: "contradictory_headers" };
  }
  if (input.nowSeconds - parsed.timestamp > tolerance) return { ok: false, reason: "stale_timestamp" };
  if (parsed.timestamp - input.nowSeconds > tolerance) return { ok: false, reason: "future_timestamp" };
  const secrets = input.secrets.filter((s) => typeof s === "string" && s.length > 0);
  if (secrets.length === 0) return { ok: false, reason: "no_secret" };
  const payload = signedPayload(parsed.timestamp, input.rawBody);
  let matched = false;
  for (const secret of secrets) {
    const expected = await hmacSha256Hex(secret, payload);
    for (const candidate of parsed.signatures) matched = timingSafeEqualHex(expected, candidate) || matched;
  }
  return matched ? { ok: true, timestamp: parsed.timestamp } : { ok: false, reason: "signature_mismatch" };
}
