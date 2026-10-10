import { describe, expect, it } from "vitest";
import { resolveOrigin } from "@/lib/origin";
import { safeNext } from "@/lib/safe-next";

describe("safeNext (open-redirect defence)", () => {
  it.each([
    ["/\t/evil.example", "slash-tab-slash"],
    ["/\n/evil.example", "slash-newline-slash"],
    ["/\r\n/evil.example", "slash-CRLF-slash"],
    ["/\\evil.example", "slash-backslash"],
    ["\\/evil.example", "backslash-slash"],
    ["//evil.example", "protocol-relative"],
    ["https://evil.example/w", "absolute URL"],
    ["javascript:alert(1)", "javascript scheme"],
    ["w/abc", "relative without slash"],
    ["", "empty"],
    ["/\u0000/evil.example", "NUL"],
  ])("rejects %j (%s)", (input) => {
    expect(safeNext(input)).toBe("/workspaces");
  });

  it("rejects non-strings and oversize values", () => {
    expect(safeNext(null)).toBe("/workspaces");
    expect(safeNext(["/w"])).toBe("/workspaces");
    expect(safeNext(`/${"a".repeat(3000)}`)).toBe("/workspaces");
  });

  it("allows ordinary in-app paths and keeps encoded query parameters", () => {
    expect(safeNext("/w/7c9e6679-7425-40de-944b-e07fc1f90ae7/sessions")).toBe("/w/7c9e6679-7425-40de-944b-e07fc1f90ae7/sessions");
    expect(safeNext("/invite/abc123")).toBe("/invite/abc123");
    expect(safeNext("/w/x/report?revision=2&redact=1#top")).toBe("/w/x/report?revision=2&redact=1#top");
    expect(safeNext("/search?q=%2F%2Fevil.example%20x")).toBe("/search?q=%2F%2Fevil.example%20x");
    expect(safeNext("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example");
  });

  it("every accepted value resolves to the same origin when used as a redirect", () => {
    for (const v of ["/w/x", "/%2F%2Fevil.example", "/search?q=%2F%2F"]) {
      expect(new URL(safeNext(v), "https://app.example").origin).toBe("https://app.example");
    }
  });
});

describe("resolveOrigin (invitation link origin)", () => {
  it.each([
    [{ host: "127.0.0.1:3100" }, "http://127.0.0.1:3100"],
    [{ host: "127.0.0.1:3100", proto: "https" }, "http://127.0.0.1:3100"],
    [{ host: "localhost:3000" }, "http://localhost:3000"],
    [{ host: "[::1]:3000" }, "http://[::1]:3000"],
    [{ host: "savour-dev.vercel.app" }, "https://savour-dev.vercel.app"],
    [{ host: "savour-dev.vercel.app", proto: "https,http" }, "https://savour-dev.vercel.app"],
    [{ host: "example.test", proto: "javascript" }, "https://example.test"],
    [{ siteUrl: "https://app.example/", host: "evil.example" }, "https://app.example"],
  ])("%j -> %s", (input, expected) => {
    expect(resolveOrigin(input)).toBe(expected);
  });
});
