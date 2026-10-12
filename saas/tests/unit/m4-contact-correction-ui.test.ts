// The billing contact section must offer only the action the server accepts for the contact state
// returned by get_billing: the normal edit before any customer request, correction while no Bachs
// customer can exist for the email, and an explanation (no form) in every locked state. Previously the page
// offered the edit form whenever no customer was bound, and the server always refused it once a customer
// request existed. The page is rendered on the server; forms are identified by the action they are bound to.
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContactState, OwnerBilling, Preparation } from "@/lib/billing";
import { friendlyError } from "@/lib/errors";

const WS = "eeeeeeee-0000-4000-8000-000000005101";
const INTENT = "eeeeeeee-0000-4000-8000-000000005102";
const state = vi.hoisted(() => ({ invoke: vi.fn(), rpc: vi.fn(), revalidate: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: state.revalidate }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); }, notFound: () => { throw new Error("NOT_FOUND"); },
  useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/auth", () => ({
  isUuid: (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v),
  requireUser: async () => ({ supabase: { functions: { invoke: state.invoke }, rpc: state.rpc } }),
  requireWorkspace: async () => ({ supabase: { rpc: state.rpc }, ctx: { role: "owner", workspace: { timezone: "Africa/Lagos" } } }),
}));
import { correctBillingContact, retryCheckout, setBillingContact } from "@/app/w/[ws]/billing/actions";
import BillingPage from "@/app/w/[ws]/billing/page";
import { ActionForm } from "@/components/forms";

const LOCKED: ContactState[] = ["bound", "in_progress", "uncertain", "review", "unverified", "request_sent"];
const billing = (contact: ContactState | null, preparation: Preparation | null = null): OwnerBilling => ({
  view: "owner", version: 4, access: { state: "trialing", writable: true, trial_ends_at: "2026-10-26T00:00:00Z" },
  plan: { name: "Business", interval: "month", limits: { locations: 3, subjects: 200, staff: 15, assessments: 2000 } },
  trial_limits: { locations: 1, subjects: 25, staff: 3, assessments: 100 }, terms_version: "savour-m4-sandbox-terms-1", environment: "sandbox",
  prices: [{ currency: "USD", exponent: 2, provider: "Bachs", price_id: WS, version: 1, amount_minor: 2900, amount: "29.00", label: "Sandbox proposal",
    recurring_capability: "documented", environment: "sandbox", unavailable_reason: null }],
  billing_currency: null,
  billing_contact: contact && { email: "billing@example.test", consent_at: "2026-10-12T00:00:00Z", state: contact,
    locked: contact !== "editable" && contact !== "correctable", correctable: contact === "correctable" },
  customer_bound: contact === "bound", subscription: null,
  pending_checkout: preparation && { id: INTENT, status: "created", currency: "USD", amount: "29.00", created_at: "2026-10-12T10:00:00Z", checkout_url: null,
    checkout_expires_at: null, preparation },
  recent_checkouts: [], ledger: [], totals_by_currency: [], review_required: false,
});
const forms = (node: ReactNode): unknown[] => {
  if (Array.isArray(node)) return node.flatMap(forms);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  const inner = forms(node.props.children as ReactNode);
  return node.type === ActionForm ? [node.props.action, ...inner] : inner;
};
const render = async (b: OwnerBilling) => {
  state.rpc.mockResolvedValue({ data: b, error: null });
  const tree = await BillingPage({ params: Promise.resolve({ ws: WS }) });
  return { actions: forms(tree), html: renderToStaticMarkup(tree) };
};
const refused: Preparation = { error_code: "customer_create_refused", detail: "http_422:VALIDATION_ERROR", retry_allowed: true, customer_uncertain: false };
beforeEach(() => { state.invoke.mockReset(); state.rpc.mockReset(); state.revalidate.mockReset(); });

describe("billing contact section follows the server's contact state", () => {
  it("before any customer request the normal edit form is offered, and no correction", async () => {
    for (const b of [billing(null), billing("editable")]) {
      const { actions } = await render(b);
      expect(actions).toContain(setBillingContact);
      expect(actions).not.toContain(correctBillingContact);
    }
  });

  it("while no Bachs customer can exist for the email, only the correction form is offered", async () => {
    const { actions, html } = await render(billing("correctable"));
    expect(actions).toContain(correctBillingContact);
    expect(actions).not.toContain(setBillingContact);
    expect(html).toContain("Correct billing email");
    expect(html).toContain('name="version" value="4"');
  });

  it("every locked state explains itself and offers no email form at all", async () => {
    const seen = new Set<string>();
    for (const s of LOCKED) {
      const { actions, html } = await render(billing(s));
      expect(actions, s).not.toContain(setBillingContact);
      expect(actions, s).not.toContain(correctBillingContact);
      expect(html, s).not.toContain('name="email"');
      const reason = /<p class="small muted">([^<]+)<\/p>/.exec(html.slice(html.indexOf('id="contact-h"')))?.[1];
      expect(reason, s).toBeTruthy();
      seen.add(reason!);
    }
    // Each state gets its own explanation; "linked to Bachs" is not used for requests that never bound.
    expect(seen.size).toBe(LOCKED.length);
    expect((await render(billing("uncertain"))).html).not.toMatch(/Linked to Bachs/);
    expect((await render(billing("bound"))).html).toMatch(/Linked to Bachs/);
  });

  it("a definitive refusal with a correctable contact points to correction instead of retrying the rejected request", async () => {
    const { actions, html } = await render(billing("correctable", refused));
    expect(html).toContain("Checkout not started");
    expect(html).toContain('href="#contact-h"');
    expect(html).toContain("(it rejected the address)");
    expect(actions).not.toContain(retryCheckout);
    expect(actions).toContain(correctBillingContact);
  });

  it("a refusal the server does not accept as definitive keeps the retry and offers no correction", async () => {
    const { actions, html } = await render(billing("request_sent", { ...refused, detail: "http_400:INVALID_REQUEST" }));
    expect(actions).toContain(retryCheckout);
    expect(actions).not.toContain(correctBillingContact);
    expect(html).not.toContain('href="#contact-h"');
  });
});

describe("correction action", () => {
  const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };

  it("sends the workspace, email, consent and expected version to the Owner RPC and reports the server's refusal", async () => {
    state.rpc.mockResolvedValue({ data: 5, error: null });
    expect(await correctBillingContact(null, form({ ws: WS, email: " New@Example.test ", consent: "on", version: "4" }))).toHaveProperty("ok");
    expect(state.rpc).toHaveBeenCalledWith("correct_billing_contact", { p_ws: WS, p_email: "New@Example.test", p_consent: true, p_expected_version: 4 });
    expect(state.revalidate).toHaveBeenCalledWith(`/w/${WS}/billing`);

    state.rpc.mockResolvedValue({ data: null, error: { message: "customer_request_uncertain" } });
    expect(await correctBillingContact(null, form({ ws: WS, email: "a@example.test", version: "4" })))
      .toEqual({ error: friendlyError({ message: "customer_request_uncertain" }) });
    expect(state.rpc.mock.calls[1][1]).toMatchObject({ p_consent: false });
  });

  it("rejects a malformed workspace id without calling the database", async () => {
    expect(await correctBillingContact(null, form({ ws: "../other", email: "a@example.test", consent: "on", version: "4" }))).toHaveProperty("error");
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
