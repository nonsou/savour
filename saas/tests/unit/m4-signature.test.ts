// Bachs webhook signature verification over raw bytes (official V2 scheme). Contract tests with locally
// generated secrets and signatures; not evidence from the Bachs sandbox.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSignatureV2, verifyBachsSignature } from "../../supabase/functions/_shared/signature.ts";

const SECRET = "whsec_unit_test_secret_value_0001";
const OTHER = "whsec_unit_test_secret_value_0002";
const NOW = 1_790_000_000;
const body = new TextEncoder().encode('{"id":"evt_1","type":"collection.succeeded","created_at":"2026-10-11T00:00:00Z","organization_id":"acct_1","data":{}}');
const sign = (secret: string, t: number, raw: Uint8Array) =>
  createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${t}.`), Buffer.from(raw)])).digest("hex");
const verify = (signatureV2: string | null, opts: Partial<Parameters<typeof verifyBachsSignature>[0]> = {}) =>
  verifyBachsSignature({ rawBody: body, signatureV2, legacyTimestamp: null, legacySignature: null, secrets: [SECRET], nowSeconds: NOW, ...opts });

describe("X-Bachs-Signature-V2 verification", () => {
  it("accepts a correct signature computed over timestamp + '.' + raw bytes", async () => {
    expect(await verify(`t=${NOW},v1=${sign(SECRET, NOW, body)}`)).toEqual({ ok: true, timestamp: NOW });
  });

  it("accepts any matching v1 during rotation and any configured secret, in any order", async () => {
    expect((await verify(`t=${NOW},v1=${sign(OTHER, NOW, body)},v1=${sign(SECRET, NOW, body)}`)).ok).toBe(true);
    expect((await verify(`t=${NOW},v1=${sign(OTHER, NOW, body)}`, { secrets: [SECRET, OTHER] })).ok).toBe(true);
  });

  it("rejects a tampered body (one changed byte, re-serialized whitespace) and a wrong secret", async () => {
    const tampered = new Uint8Array(body); tampered[10] ^= 1;
    expect(await verify(`t=${NOW},v1=${sign(SECRET, NOW, body)}`, { rawBody: tampered })).toEqual({ ok: false, reason: "signature_mismatch" });
    const reserialized = new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(body)), null, 1));
    expect((await verify(`t=${NOW},v1=${sign(SECRET, NOW, body)}`, { rawBody: reserialized })).ok).toBe(false);
    expect(await verify(`t=${NOW},v1=${sign(OTHER, NOW, body)}`)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("enforces the 300-second tolerance in both directions before trusting anything", async () => {
    for (const [t, ok] of [[NOW - 300, true], [NOW + 300, true], [NOW - 301, false], [NOW + 301, false]] as const) {
      expect((await verify(`t=${t},v1=${sign(SECRET, t, body)}`)).ok, String(t - NOW)).toBe(ok);
    }
    expect(await verify(`t=${NOW - 301},v1=${sign(SECRET, NOW - 301, body)}`)).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(await verify(`t=${NOW + 301},v1=${sign(SECRET, NOW + 301, body)}`)).toEqual({ ok: false, reason: "future_timestamp" });
  });

  it("rejects malformed headers strictly", () => {
    const good = sign(SECRET, NOW, body);
    for (const h of [`v1=${good}`, `t=${NOW}`, `t=${NOW},t=${NOW},v1=${good}`, `t=${NOW},v1=${good.toUpperCase()}`, `t=${NOW},v1=${good.slice(1)}`,
      `t=1e9,v1=${good}`, `t=-5,v1=${good}`, `t=${NOW},,v1=${good}`, `t=${NOW},v1=${good},x=1`, `t=${NOW};v1=${good}`, "", "a".repeat(3000)]) {
      expect(parseSignatureV2(h), h.slice(0, 40)).toBeNull();
    }
    expect(parseSignatureV2(`t=${NOW},v1=${good},v2=futureScheme`)).toEqual({ timestamp: NOW, signatures: [good] });
  });

  it("does not accept the legacy headers alone and rejects legacy headers contradicting V2", async () => {
    const good = sign(SECRET, NOW, body);
    expect(await verify(null, { legacyTimestamp: String(NOW), legacySignature: good })).toEqual({ ok: false, reason: "legacy_signature_only" });
    expect(await verify(null)).toEqual({ ok: false, reason: "missing_signature" });
    expect(await verify(`t=${NOW},v1=${good}`, { legacyTimestamp: String(NOW - 1) })).toEqual({ ok: false, reason: "contradictory_headers" });
    expect(await verify(`t=${NOW},v1=${good}`, { legacySignature: sign(OTHER, NOW, body) })).toEqual({ ok: false, reason: "contradictory_headers" });
    expect((await verify(`t=${NOW},v1=${good}`, { legacyTimestamp: String(NOW), legacySignature: good })).ok).toBe(true);
  });

  it("fails closed without a configured secret", async () => {
    expect(await verify(`t=${NOW},v1=${sign(SECRET, NOW, body)}`, { secrets: [] })).toEqual({ ok: false, reason: "no_secret" });
  });
});
