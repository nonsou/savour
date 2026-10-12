import { createHash } from 'node:crypto';

// Domain-separated so label hashes cannot be confused with the input checksum.
const LABEL_DOMAIN = 'savour-legacy-preflight/label/v1\u0000';

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Pseudonymous, deterministic label for any source string that may carry PII
// (map keys, vendorIds, unknown field names, unknown enum values). Truncated
// to 64 bits. This is NOT anonymisation: a low-entropy value can be confirmed
// by anyone who hashes a guess, so reports stay confidential.
export function hashLabel(value) {
  const digest = createHash('sha256').update(LABEL_DOMAIN + String(value), 'utf8').digest('hex');
  return `h:${digest.slice(0, 16)}`;
}
