// Regression for the observed sandbox return-page defect: the payment was verified on the second billing
// worker run (once a minute, batch of 3), but the page had stopped re-reading after 60 s and kept
// showing "Waiting for payment". Automatic checks must outlast two worker runs, stay bounded, and the page
// shows only the server-verified state (the poller never decides what was paid).
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { OwnerBilling } from "@/lib/billing";

const WS = "eeeeeeee-0000-4000-8000-000000004a01";
const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({
  requireWorkspace: async () => ({ supabase: { rpc: state.rpc }, ctx: { role: "owner", workspace: { timezone: "Africa/Lagos" } } }),
}));
import { nextCheckDelay, RefreshPoller } from "@/app/w/[ws]/billing/refresh-poller";
import BillingReturnPage from "@/app/w/[ws]/billing/return/page";

const billing = (access: OwnerBilling["access"], pending: OwnerBilling["pending_checkout"]) => ({
  view: "owner", access, pending_checkout: pending, subscription: null, recent_checkouts: [], ledger: [],
}) as unknown as OwnerBilling;
const open = { id: WS, status: "open", currency: "USD", amount: "29.00", created_at: "2026-10-12T10:00:00Z", checkout_url: null,
  checkout_expires_at: null, preparation: null } as NonNullable<OwnerBilling["pending_checkout"]>;
const render = async (b: OwnerBilling) => {
  state.rpc.mockResolvedValue({ data: b, error: null });
  return renderToStaticMarkup(await BillingReturnPage({ params: Promise.resolve({ ws: WS }) }));
};

describe("return page automatic checks", () => {
  const schedule = () => {
    const delays: number[] = [];
    for (let a = 0; a < 1000; a++) { const d = nextCheckDelay(a); if (d === null) break; delays.push(d); }
    return delays;
  };
  it("keep re-reading for longer than two once-a-minute worker runs plus their processing time", () => {
    expect(schedule().reduce((s, d) => s + d, 0)).toBeGreaterThanOrEqual(3 * 60_000);
  });
  it("are bounded and never more often than every 5 s", () => {
    const delays = schedule();
    expect(delays.length).toBeLessThan(1000);
    expect(nextCheckDelay(delays.length + 1)).toBeNull();
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(5_000);
    expect(delays.reduce((s, d) => s + d, 0)).toBeLessThanOrEqual(10 * 60_000);
  });
});

describe("return page shows only the server-verified state", () => {
  it("a pending checkout shows its status and that the page is checking", async () => {
    const html = await render(billing({ state: "trialing", writable: true }, open));
    expect(html).toContain("Waiting for payment");
    expect(html).toContain("Checking with Bachs");
    expect(html).not.toContain("Payment confirmed");
  });
  it("once the server reports paid access, no waiting or checking copy remains", async () => {
    const html = await render(billing({ state: "active", writable: true, paid_through: "2026-11-12T10:00:00Z" }, null));
    expect(html).toContain("Payment confirmed by Bachs");
    for (const stale of ["Waiting for payment", "Checking with Bachs", "not confirmed", "Check again"]) expect(html).not.toContain(stale);
  });
  it("active access with a checkout still pending is not shown as paid", async () => {
    const html = await render(billing({ state: "active", writable: true, paid_through: "2026-11-12T10:00:00Z" }, open));
    expect(html).not.toContain("Payment confirmed");
    expect(html).toContain("Checking with Bachs");
  });
  it("an inactive poller renders nothing", () => {
    expect(renderToStaticMarkup(createElement(RefreshPoller, { active: false }))).toBe("");
  });
});
