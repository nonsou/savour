// Bounded request bodies for every Edge entrypoint: bytes (not UTF-16 characters), early Content-Length
// refusal, enforced streamed length, and deterministic code-only failures.
import { describe, expect, it } from "vitest";
import { readBodyLimited, readJson } from "../../supabase/functions/_shared/http.ts";

const stream = (chunks: (Uint8Array | Error)[]) => new ReadableStream<Uint8Array>({
  start(c) { for (const x of chunks) { if (x instanceof Error) { c.error(x); return; } c.enqueue(x); } c.close(); },
});
const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://edge.test/f", { method: "POST", body, headers, duplex: "half" } as RequestInit);

describe("bounded body reading", () => {
  it("refuses an oversized declared Content-Length before reading anything", async () => {
    let pulled = false;
    const body = new ReadableStream({ pull() { pulled = true; } }, { highWaterMark: 0 });
    expect(await readBodyLimited(req(body, { "content-length": "20000" }), 16 * 1024)).toEqual({ ok: false, status: 413, code: "payload_too_large" });
    expect(pulled).toBe(false);
    expect(await readBodyLimited(req("{}", { "content-length": "12x" }), 1024)).toEqual({ ok: false, status: 400, code: "invalid_request" });
  });

  it("counts streamed bytes, not characters, even without or with a false Content-Length", async () => {
    const euros = "€".repeat(6000); // 6000 UTF-16 characters, 18000 UTF-8 bytes
    expect(euros.length).toBeLessThan(16 * 1024);
    expect(await readJson(req(JSON.stringify({ x: euros })), 16 * 1024)).toEqual({ ok: false, status: 413, code: "payload_too_large" });
    const big = new Uint8Array(9000).fill(0x20);
    expect(await readBodyLimited(req(stream([big, big])), 16 * 1024)).toEqual({ ok: false, status: 413, code: "payload_too_large" });
  });

  it("maps unreadable streams, invalid UTF-8, invalid JSON and non-objects to 400 codes", async () => {
    expect(await readJson(req(stream([new Uint8Array([0x7b]), new Error("socket reset")])))).toEqual({ ok: false, status: 400, code: "body_unreadable" });
    expect(await readJson(req(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])))).toEqual({ ok: false, status: 400, code: "invalid_encoding" });
    expect(await readJson(req("{not json"))).toEqual({ ok: false, status: 400, code: "invalid_json" });
    expect(await readJson(req("[1,2]"))).toEqual({ ok: false, status: 400, code: "invalid_request" });
  });

  it("returns the parsed object within the limit and never echoes the body in failures", async () => {
    expect(await readJson(req(JSON.stringify({ secret: "sk_sandbox_TESTONLYxxxxxxxxxxxxxxxx", n: 1 })))).toEqual({ ok: true,
      value: { secret: "sk_sandbox_TESTONLYxxxxxxxxxxxxxxxx", n: 1 } });
    const fail = await readJson(req("{\"secret\":\"sk_sandbox_TESTONLYxxxxxxxxxxxxxxxx\""));
    expect(JSON.stringify(fail)).not.toContain("sk_sandbox_");
  });
});
