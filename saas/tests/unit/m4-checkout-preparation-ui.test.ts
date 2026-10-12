// Regression for the witnessed checkout defect: after an early stop in checkout preparation (cause not yet
// observed) the page showed only "Preparing", the form that owned any error unmounted, and there was no
// way to retry. The fixtures use a synthetic refusal. The page now
// renders the reason stored on the pending intent (so it survives the re-render) with a retry of the
// same intent; a checkout that can no longer be retried stops blocking fresh consent.
// Also the admin default selector: after a saved default it must show the server's latest default.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { preparationText, type OwnerBilling } from "@/lib/billing";
import { friendlyError } from "@/lib/errors";

const WS = "eeeeeeee-0000-4000-8000-000000004901";
const INTENT = "eeeeeeee-0000-4000-8000-000000004902";
const state = vi.hoisted(() => ({ invoke: vi.fn(), rpc: vi.fn(), redirect: vi.fn((url: string) => { throw new Error(`REDIRECT ${url}`); }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: state.redirect, notFound: () => { throw new Error("NOT_FOUND"); }, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({
  isUuid: (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
  requireUser: async () => ({ supabase: { functions: { invoke: state.invoke }, rpc: state.rpc } }),
  requireWorkspace: async () => ({ supabase: { rpc: state.rpc }, ctx: { role: "owner", workspace: { timezone: "Africa/Lagos" } } }),
}));
import { retryCheckout } from "@/app/w/[ws]/billing/actions";
import BillingPage from "@/app/w/[ws]/billing/page";
import PlatformPage from "@/app/platform/page";

const owner = (pending: OwnerBilling["pending_checkout"]): OwnerBilling => ({
  view: "owner", version: 3, access: { state: "trialing", writable: true, trial_ends_at: "2026-10-26T00:00:00Z" },
  plan: { name: "Business", interval: "month", limits: { locations: 3, subjects: 200, staff: 15, assessments: 2000 } },
  trial_limits: { locations: 1, subjects: 25, staff: 3, assessments: 100 }, terms_version: "savour-m4-sandbox-terms-1", environment: "sandbox",
  prices: [{ currency: "USD", exponent: 2, provider: "Bachs", price_id: WS, version: 1, amount_minor: 2900, amount: "29.00", label: "Sandbox proposal",
    recurring_capability: "documented", environment: "sandbox", unavailable_reason: null }],
  billing_currency: null, billing_contact: { email: "billing@example.test", consent_at: "2026-10-12T00:00:00Z", state: "editable", locked: false, correctable: false }, customer_bound: false,
  subscription: null, pending_checkout: pending, recent_checkouts: [], ledger: [], totals_by_currency: [], review_required: false,
});
const created = (preparation: NonNullable<OwnerBilling["pending_checkout"]>["preparation"]) => ({ id: INTENT, status: "created", currency: "USD",
  amount: "29.00", created_at: "2026-10-12T10:00:00Z", checkout_url: null, checkout_expires_at: null, preparation });
const renderBilling = async (b: OwnerBilling) => {
  state.rpc.mockResolvedValue({ data: b, error: null });
  return renderToStaticMarkup(await BillingPage({ params: Promise.resolve({ ws: WS }) }));
};
beforeEach(() => { state.invoke.mockReset(); state.rpc.mockReset(); state.redirect.mockClear(); });

describe("billing page: checkout that has not reached Bachs", () => {
  it("shows the stored refusal with its sanitized provider status and a retry of the same intent", async () => {
    const html = await renderBilling(owner(created({ error_code: "customer_create_refused", detail: "http_422:VALIDATION_ERROR", retry_allowed: true,
      customer_uncertain: false })));
    expect(html).toContain("Checkout not started");
    expect(html).toContain("Bachs refused to create the billing customer");
    expect(html).toContain("HTTP 422, VALIDATION_ERROR");
    expect(html).toContain(`name="intent" value="${INTENT}"`);
    expect(html).toContain("Try again");
    expect(html).not.toContain("Continue to secure payment");
  });
  it("says what is happening while no reason is recorded yet, and still offers the retry", async () => {
    const html = await renderBilling(owner(created({ error_code: null, detail: null, retry_allowed: true, customer_uncertain: true })));
    expect(html).toContain("Preparing checkout");
    expect(html).toContain("no second customer is created");
    expect(html).toContain("Try again");
  });
  it("a checkout that cannot be retried no longer hides the purchase form, and says why the last attempt stopped", async () => {
    const html = await renderBilling(owner(created({ error_code: "customer_create_unresolved", detail: null, retry_allowed: false, customer_uncertain: true })));
    expect(html).toContain("Your last checkout attempt did not start");
    expect(html).toContain("SAVOUR support needs to review it");
    expect(html).toContain("Continue to secure payment (USD)");
    expect(html).not.toContain("Try again");
  });
  it("other pending states keep the existing in-progress view", async () => {
    const html = await renderBilling(owner({ ...created(null), status: "uncertain" }));
    expect(html).toContain("Checkout in progress");
    expect(html).toContain("Confirming with Bachs");
    expect(html).not.toContain("Continue to secure payment");
  });
  it("never shows provider text that is not in the sanitized status format", () => {
    const text = preparationText({ error_code: "customer_create_refused", detail: "owner@example.test said no", retry_allowed: true, customer_uncertain: false },
      (code) => friendlyError({ message: code }));
    expect(text).toBe(friendlyError({ message: "customer_create_refused" }));
  });
});

describe("retry action", () => {
  it("retries the stored intent only (no new consent, price or currency) and keeps provider-only redirects", async () => {
    const f = new FormData();
    f.set("ws", WS);
    f.set("intent", INTENT);
    state.invoke.mockResolvedValue({ data: { kind: "error", code: "customer_create_refused" }, error: null });
    expect(await retryCheckout(null, f)).toEqual({ error: friendlyError({ message: "customer_create_refused" }) });
    expect(state.invoke.mock.calls[0]).toEqual(["bachs-checkout", { body: { workspace_id: WS, intent_id: INTENT } }]);
    state.invoke.mockResolvedValue({ data: { kind: "redirect", url: "https://evil.example/c" }, error: null });
    expect(await retryCheckout(null, f)).toHaveProperty("error");
    expect(state.redirect).not.toHaveBeenCalled();
    f.set("intent", "not-a-uuid");
    state.invoke.mockClear();
    expect(await retryCheckout(null, f)).toHaveProperty("error");
    expect(state.invoke).not.toHaveBeenCalled();
  });
});

describe("platform default selector", () => {
  const find = (node: ReactNode, pred: (e: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | null => {
    if (Array.isArray(node)) { for (const n of node) { const r = find(n, pred); if (r) return r; } return null; }
    if (!isValidElement<Record<string, unknown>>(node)) return null;
    return pred(node) ? node : find(node.props.children as ReactNode, pred);
  };
  const overview = (def: string | null, version: number) => ({ admin: { aal: "aal2" }, providers: [], default_connection_id: def, settings_version: version, audit: [],
    connections: [{ id: "c1", provider_code: "bachs", label: "Bachs", status: "enabled", accepting_new: true, version: 5,
      credential: { configured: true, version: 1, fingerprint: "f", stored_at: null, pending: false, pending_fingerprint: null, previous_retire_after: null },
      webhook_secret: { configured: true, version: 1, fingerprint: "w", previous_valid_until: null }, expected_organization_id: "acct", ngn_recurring_verified: false,
      last_test_passed_at: null, tests: [], prices: [], pinned_subscriptions: 0, pending_checkouts: 0 }] });
  const select = async (def: string | null, version: number) => {
    state.rpc.mockResolvedValue({ data: overview(def, version), error: null });
    return find(await PlatformPage(), (e) => e.type === "select" && e.props.name === "connection")!;
  };
  it("re-creates the select from the latest server default after a save, so the post-action form reset cannot restore the old choice", async () => {
    const before = await select(null, 7);
    const after = await select("c1", 8);
    expect(before.props.defaultValue).toBe("");
    expect(after.props.defaultValue).toBe("c1");
    expect(after.key).not.toBe(before.key);
  });
});
