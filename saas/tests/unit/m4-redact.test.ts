import { describe, expect, it } from "vitest";
import { logLine, redact } from "../../supabase/functions/_shared/redact.ts";

describe("log redaction", () => {
  it("removes keys, webhook secrets, bearer tokens, JWTs, URLs and emails", () => {
    const s = redact("key sk_sandbox_abcDEF123456789012 live sk_live_zzz whsec_abc123 Bearer abc.def-ghi " +
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig portal https://portal.bachs.io/s/6Yc0nQ mail owner@example.com");
    for (const leak of ["sk_sandbox_", "sk_live_", "whsec_abc", "abc.def-ghi", "eyJhbGci", "portal.bachs.io", "owner@example.com"]) expect(s).not.toContain(leak);
    expect(JSON.parse(logLine("x", { url: "https://checkout.sandbox.bachs.io/c/1", code: "ok" }))).toEqual({ event: "x", url: "[redacted-url]", code: "ok" });
  });
});
