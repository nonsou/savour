// Sandbox-only adapter behaviour over a mock transport (no network, no real provider).
import { describe, expect, it } from "vitest";
import { BachsClient, ConfigError, type TransportRequest } from "../../supabase/functions/_shared/bachs-client.ts";
import { DtoError } from "../../supabase/functions/_shared/bachs-dto.ts";
import { classifyCheckoutCreation } from "../../supabase/functions/_shared/worker-core.ts";

const KEY = "sk_sandbox_TESTONLY-unitkey00000001";
const mk = (status: number, body: unknown, seen: TransportRequest[] = []) =>
  new BachsClient({ apiKey: KEY, baseUrl: "https://sandbox-api.bachs.io" }, async (req) => { seen.push(req); return { status, bodyText: JSON.stringify(body) }; });

describe("Bachs sandbox adapter", () => {
  it("refuses live keys, malformed keys and any non-sandbox base URL", () => {
    const t = async () => ({ status: 200, bodyText: "{}" });
    expect(() => new BachsClient({ apiKey: "sk_live_TESTONLYunitkey00000001", baseUrl: "https://sandbox-api.bachs.io" }, t)).toThrow(ConfigError);
    for (const suffix of ["TESTONLY.unitkey00000001", "TESTONLY unitkey00000001", "TESTONLY–unitkey00000001"]) {
      expect(() => new BachsClient({ apiKey: `sk_sandbox_${suffix}`, baseUrl: "https://sandbox-api.bachs.io" }, t)).toThrow(ConfigError);
    }
    expect(() => new BachsClient({ apiKey: "sk_sandbox_short", baseUrl: "https://sandbox-api.bachs.io" }, t)).toThrow(ConfigError);
    expect(() => new BachsClient({ apiKey: KEY, baseUrl: "https://api.bachs.io" }, t)).toThrow(ConfigError);
    expect(() => new BachsClient({ apiKey: KEY, baseUrl: "https://sandbox-api.bachs.io.evil.test" }, t)).toThrow(ConfigError);
  });

  it("sends bearer auth and the idempotency key, and refuses path injection", async () => {
    const seen: TransportRequest[] = [];
    const c = mk(201, { checkout_id: "chk_1", checkout_url: "https://checkout.sandbox.bachs.io/c/1", status: "open", expires_at: "2026-10-11T12:00:00Z", reference: "r" }, seen);
    const r = await c.createCheckout('{"reference":"r"}', "savour-checkout-1");
    expect(r.kind).toBe("ok");
    expect(seen[0]).toMatchObject({ method: "POST", url: "https://sandbox-api.bachs.io/v1/checkout-sessions", body: '{"reference":"r"}',
      headers: { Authorization: `Bearer ${KEY}`, "Idempotency-Key": "savour-checkout-1", "Content-Type": "application/json" } });
    expect(() => c.getPayment("../admin")).toThrow(ConfigError);
  });

  it("classifies outcomes: 5xx/408/timeouts/in-progress are uncertain, other 4xx are refusals, 409 conflict is a duplicate reference", async () => {
    expect((await mk(503, {}).getPayment("ch_1")).kind).toBe("uncertain");
    expect((await mk(408, {}).getPayment("ch_1")).kind).toBe("uncertain");
    expect(await mk(409, { detail: "x", error_code: "IDEMPOTENCY_IN_PROGRESS" }).createCheckout("{}", "k")).toEqual({ kind: "uncertain", reason: "in_progress", status: 409 });
    expect(await mk(404, { detail: "x", error_code: "NOT_FOUND" }).getPayment("ch_1")).toEqual({ kind: "refused", status: 404, errorCode: "NOT_FOUND" });
    const timeout = new BachsClient({ apiKey: KEY, baseUrl: "https://sandbox-api.bachs.io" }, async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; });
    expect(await timeout.getPayment("ch_1")).toEqual({ kind: "uncertain", reason: "timeout" });
    expect(classifyCheckoutCreation({ kind: "refused", status: 409, errorCode: "CONFLICT" })).toEqual({ outcome: "conflict", error: "CONFLICT" });
    expect(classifyCheckoutCreation({ kind: "refused", status: 400, errorCode: "VALIDATION_ERROR" }).outcome).toBe("refused");
    expect(classifyCheckoutCreation({ kind: "uncertain", reason: "timeout" }).outcome).toBe("uncertain");
  });

  it("never accepts a 2xx body that does not match the official schema", async () => {
    await expect(mk(200, { payment_id: "ch_1", status: "succeeded" }).getPayment("ch_1")).rejects.toThrow(DtoError);
  });
});
