// Billing presentation helpers. Every value shown comes from the database (get_billing /
// workspace_context.access); nothing here decides access or trusts a redirect.
import { displayMoney, isCurrency } from "../../supabase/functions/_shared/money.ts";

/** Must equal billing.terms_version() in the database; checkout refuses any other consent. */
export const TERMS_VERSION = "savour-m4-sandbox-terms-1";

export type AccessState = "trialing" | "active" | "cancel_scheduled" | "past_due" | "read_only" | "suspended";
export type Kind = "locations" | "subjects" | "staff" | "assessments";
export const KINDS: Kind[] = ["locations", "subjects", "staff", "assessments"];
export const KIND_LABELS: Record<Kind, string> = {
  locations: "Active locations", subjects: "Active subjects", staff: "Staff seats (incl. pending invitations)", assessments: "First submissions this period",
};

export interface AccessSummary {
  state: AccessState; writable: boolean;
  limits?: Record<Kind, number>; usage?: Record<Kind, number>; percent?: Record<Kind, number>;
  warnings?: Kind[]; at_limit?: Kind[]; trial_ends_at?: string; paid_through?: string | null; grace_ends_at?: string | null;
  cancel_at_period_end?: boolean; pending_checkout?: boolean; timezone?: string; billing?: boolean;
}

export interface PriceOffer {
  currency: "NGN" | "USD"; exponent: number; provider: string | null; price_id: string | null; version: number | null;
  amount_minor: number | null; amount: string | null; label: string; recurring_capability: string | null; environment: string;
  unavailable_reason: string | null;
}

export interface OwnerBilling {
  view: "owner"; version: number; access: AccessSummary & { window_start?: string; window_end?: string | null; last_allocation?: string };
  plan: { name: string; interval: string; limits: Record<Kind, number> }; trial_limits: Record<Kind, number>;
  terms_version: string; environment: string; prices: PriceOffer[]; billing_currency: string | null;
  billing_contact: { email: string; consent_at: string; locked: boolean } | null; customer_bound: boolean;
  subscription: { status: string; currency: string; amount: string; cancellation: "none" | "pending" | "confirmed" | "ended";
    current_period_end: string | null; status_observed_at: string } | null;
  pending_checkout: { id: string; status: string; currency: string; amount: string; created_at: string; checkout_url: string | null;
    checkout_expires_at: string | null; preparation?: Preparation | null } | null;
  recent_checkouts: { id: string; status: string; currency: string; amount: string; created_at: string }[];
  ledger: { currency: string; amount_minor: number; amount: string; period_start: string; period_end: string; refund_state: string;
    dispute_state: string; review_flag: boolean; revoked: boolean }[];
  totals_by_currency: { currency: string; paid_minor: number; paid: string }[];
  review_required: boolean;
}
export type MemberBilling = { view: "member"; access: AccessSummary | null };

/** State of a checkout that has not reached Bachs yet (intent status "created"). */
export interface Preparation { error_code: string | null; detail: string | null; retry_allowed: boolean; customer_uncertain: boolean }

const DETAIL = /^(?:http_(\d{3})(?::([A-Z_]{2,60}))?|timeout|network|response_invalid)$/;

/** Plain-language reason a checkout stopped before reaching Bachs, with the sanitized provider status. */
export function preparationText(p: Preparation, message: (code: string) => string): string | null {
  if (!p.error_code) return null;
  const m = p.detail ? DETAIL.exec(p.detail) : null;
  const detail = !m ? "" : m[1] ? ` (Bachs response: HTTP ${m[1]}${m[2] ? `, ${m[2]}` : ""})`
    : p.detail === "timeout" ? " (no response from Bachs in time)" : p.detail === "network" ? " (network error)" : " (unexpected response)";
  return `${message(p.error_code)}${detail}`;
}

export const STATE_LABELS: Record<AccessState, string> = {
  trialing: "Free trial", active: "Active (paid)", cancel_scheduled: "Active, cancellation confirmed", past_due: "Payment failed: grace period",
  read_only: "Read-only", suspended: "Suspended",
};

export const UNAVAILABLE_REASONS: Record<string, string> = {
  provider_not_connected: "No payment provider is connected yet. Billing is being set up in the Bachs sandbox; nothing can be paid.",
  provider_unavailable: "The payment provider is not accepting new subscriptions right now.",
  price_not_configured: "No price is configured for this currency yet. No commercial price has been approved.",
  recurring_not_verified: "Monthly naira card billing has not yet been verified for this payment account, so NGN subscriptions are unavailable.",
  currency_pinned: "This business is billed in its original currency; switching currency is not offered.",
};

export const CHECKOUT_STATUS_LABELS: Record<string, string> = {
  created: "Preparing", requesting: "Contacting Bachs", open: "Waiting for payment", uncertain: "Confirming with Bachs",
  completed_unpaid: "Payment being confirmed", review: "Needs review by SAVOUR", paid: "Paid", failed: "Not started",
  expired: "Expired", abandoned: "Abandoned", mismatch: "Needs review by SAVOUR",
};

export function formatPrice(offer: Pick<PriceOffer, "amount_minor" | "currency">): string | null {
  return offer.amount_minor !== null && isCurrency(offer.currency) ? displayMoney(offer.amount_minor, offer.currency) : null;
}
export function formatMinor(minor: number, currency: string): string {
  return isCurrency(currency) ? displayMoney(minor, currency) : `${currency} ${minor}`;
}

/** Hosted provider pages only (checkout and portal); never an open redirect. */
export function isProviderUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "bachs.io" || u.hostname.endsWith(".bachs.io")) && !u.username && !u.password;
  } catch {
    return false;
  }
}

export interface Banner { tone: "warn" | "error" | "info"; text: string; billingLink: boolean }

/** Role-aware banner from workspace_context.access (owners: billing detail and link; admins: capacity;
 *  everyone else: only whether new work is possible). Guests receive no access summary at all. */
export function accessBanner(access: AccessSummary | null | undefined, role: string, fmt: (iso: string) => string): Banner | null {
  if (!access) return null;
  const owner = role === "owner";
  const manager = owner || role === "admin";
  if (access.state === "suspended") return { tone: "error", text: "This business is suspended. Records stay readable; new work is paused.", billingLink: owner };
  if (access.state === "read_only") {
    return { tone: "error", billingLink: owner, text: owner
      ? "Read-only: the trial or paid period has ended. Existing records, reports and exports stay available, and accepted work can be completed. Subscribe to start new work."
      : "Read-only: new work is paused for this business. Existing records, reports and accepted work stay available." };
  }
  if (access.state === "past_due" && owner && access.grace_ends_at) {
    return { tone: "warn", billingLink: true, text: `The renewal payment failed. Paid access continues until ${fmt(access.grace_ends_at)}. Update your card in Manage billing.` };
  }
  if (manager && access.at_limit && access.at_limit.length > 0) {
    return { tone: "warn", billingLink: owner, text: `Plan limit reached: ${access.at_limit.map((k) => KIND_LABELS[k].toLowerCase()).join(", ")}. Accepted work continues; new additions are blocked.` };
  }
  if (manager && access.warnings && access.warnings.length > 0) {
    return { tone: "info", billingLink: owner, text: `Over 80% of the plan limit: ${access.warnings.map((k) => KIND_LABELS[k].toLowerCase()).join(", ")}.` };
  }
  if (owner && access.state === "trialing" && access.trial_ends_at) {
    return { tone: "info", billingLink: true, text: `Free trial until ${fmt(access.trial_ends_at)}. No card needed.` };
  }
  return null;
}
