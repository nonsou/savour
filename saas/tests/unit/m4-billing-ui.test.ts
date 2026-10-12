// Billing boundary in the Next app: role-aware banners, consent before checkout, provider-hosted
// redirects only, and no payment secret anywhere in the Next source.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessBanner, isProviderUrl } from "@/lib/billing";

const state = vi.hoisted(() => ({ invoke: vi.fn(), redirect: vi.fn((url: string) => { throw new Error(`REDIRECT ${url}`); }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: state.redirect }));
vi.mock("@/lib/auth", () => ({
  isUuid: (v: string) => /^[0-9a-f-]{36}$/.test(v),
  requireUser: async () => ({ supabase: { functions: { invoke: state.invoke }, rpc: vi.fn() } }),
}));
import { openPortal, startCheckout } from "@/app/w/[ws]/billing/actions";

const WS = "eeeeeeee-0000-4000-8000-000000004601";
const form = (extra: Record<string, string> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ ws: WS, currency: "USD", price_id: WS, ...extra })) f.set(k, v);
  return f;
};
beforeEach(() => { state.invoke.mockReset(); state.redirect.mockClear(); });

describe("role-aware access banner", () => {
  const fmt = (iso: string) => iso.slice(0, 10);
  it("shows nothing to guests and only write state to non-managers", () => {
    expect(accessBanner(null, "guest", fmt)).toBeNull();
    const ro = accessBanner({ state: "read_only", writable: false }, "viewer", fmt)!;
    expect(ro.billingLink).toBe(false);
    expect(ro.text).not.toMatch(/Subscribe|card/);
    expect(accessBanner({ state: "trialing", writable: true, trial_ends_at: "2026-10-25T00:00:00Z" }, "reviewer", fmt)).toBeNull();
  });
  it("gives owners billing timing and a link, and managers capacity warnings", () => {
    expect(accessBanner({ state: "past_due", writable: true, grace_ends_at: "2026-10-18T00:00:00Z" }, "owner", fmt))
      .toMatchObject({ tone: "warn", billingLink: true, text: expect.stringContaining("2026-10-18") });
    expect(accessBanner({ state: "active", writable: true, at_limit: ["subjects"], warnings: [] }, "admin", fmt))
      .toMatchObject({ billingLink: false, text: expect.stringContaining("active subjects") });
    expect(accessBanner({ state: "active", writable: true, at_limit: [], warnings: ["assessments"] }, "owner", fmt)?.text).toMatch(/80%/);
  });
});

describe("billing server actions", () => {
  it("requires explicit consent before any checkout call", async () => {
    expect(await startCheckout(null, form())).toHaveProperty("error");
    expect(state.invoke).not.toHaveBeenCalled();
  });
  it("redirects only to Bachs-hosted pages and never follows another URL", async () => {
    state.invoke.mockResolvedValue({ data: { kind: "redirect", url: "https://checkout.sandbox.bachs.io/c/1" }, error: null });
    await expect(startCheckout(null, form({ consent: "on" }))).rejects.toThrow("REDIRECT https://checkout.sandbox.bachs.io/c/1");
    expect(state.invoke.mock.calls[0]).toEqual(["bachs-checkout", { body: { workspace_id: WS, currency: "USD", price_id: WS, terms_version: "savour-m4-sandbox-terms-1" } }]);
    state.invoke.mockResolvedValue({ data: { kind: "redirect", url: "https://bachs.io.evil.example/steal" }, error: null });
    expect(await openPortal(null, form())).toHaveProperty("error");
    expect(state.redirect).toHaveBeenCalledTimes(1);
    for (const bad of ["http://checkout.bachs.io/x", "https://user:pw@portal.bachs.io/x", "javascript:alert(1)", "https://notbachs.io/x"]) expect(isProviderUrl(bad), bad).toBe(false);
  });
  it("sends processing outcomes to the verified status page instead of claiming success", async () => {
    state.invoke.mockResolvedValue({ data: { kind: "processing", code: "checkout_outcome_uncertain" }, error: null });
    await expect(startCheckout(null, form({ consent: "on" }))).rejects.toThrow(`REDIRECT /w/${WS}/billing/return`);
  });
});

describe("no payment secret in the Next app", () => {
  it("never references provider keys, webhook secrets or the service role", () => {
    const files = execFileSync("git", ["ls-files", "--others", "--cached", "--exclude-standard", "src"]).toString().trim().split("\n");
    for (const f of files.filter((x) => /\.(ts|tsx)$/.test(x))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/BACHS_API_KEY|BACHS_WEBHOOK_SECRET|sk_sandbox_[A-Za-z0-9]|sk_live_|whsec_[A-Za-z0-9]|SERVICE_ROLE|service_role/);
    }
  });
});
