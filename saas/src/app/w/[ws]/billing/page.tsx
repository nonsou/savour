import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms";
import { requireWorkspace } from "@/lib/auth";
import {
  CHECKOUT_STATUS_LABELS, formatMinor, formatPrice, KIND_LABELS, KINDS, preparationText, STATE_LABELS, TERMS_VERSION, UNAVAILABLE_REASONS,
  type MemberBilling, type OwnerBilling,
} from "@/lib/billing";
import { friendlyError } from "@/lib/errors";
import { formatDateTime } from "@/lib/report";
import { cancelSubscription, openPortal, retryCheckout, setBillingContact, startCheckout } from "./actions";

export const metadata = { title: "Billing — SAVOUR" };

export default async function BillingPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const { supabase, ctx } = await requireWorkspace(ws);
  if (ctx.role === "guest") notFound();
  const { data, error } = await supabase.rpc("get_billing", { p_ws: ws });
  if (error) return <p className="notice error">{friendlyError(error)}</p>;
  const tz = ctx.workspace.timezone;
  const when = (iso: string | null | undefined) => formatDateTime(iso, tz);

  if ((data as MemberBilling).view === "member") {
    const a = (data as MemberBilling).access;
    return (
      <section className="card stack">
        <h1>Billing</h1>
        <p>Status: <strong>{a ? STATE_LABELS[a.state] : "Unknown"}</strong>. {a?.writable ? "New work can be started." : "New work is paused; existing records and accepted work stay available."}</p>
        <p className="small muted">Only the business owner can see or manage billing.</p>
      </section>
    );
  }

  const b = data as OwnerBilling;
  const a = b.access;
  const hidden = <input type="hidden" name="ws" value={ws} />;
  const available = b.prices.filter((p) => !p.unavailable_reason && p.price_id);
  const sub = b.subscription;
  const pending = b.pending_checkout;
  // A checkout that never reached Bachs: the consenting Owner may retry it, or it no longer blocks a new one.
  const prep = pending?.status === "created" ? pending.preparation ?? null : null;
  const blocking = pending && !(prep && !prep.retry_allowed) ? pending : null;
  const prepText = prep && preparationText(prep, (code) => friendlyError({ message: code }));
  return (
    <>
      <h1>Billing</h1>
      <p className="notice sample">Sandbox only. Payments use the Bachs sandbox: no real money moves, and prices shown are test proposals, not approved commercial prices.</p>
      {b.review_required && <p className="notice warn" role="alert">A billing event for this business needs review by SAVOUR support. Nothing is granted or charged automatically while it is reviewed.</p>}

      <section className="card stack" aria-labelledby="status-h">
        <h2 id="status-h">Status: {STATE_LABELS[a.state]}</h2>
        {a.state === "trialing" && <p>Free trial until <strong>{when(a.trial_ends_at)}</strong> (workspace time, {tz}). No card is needed for the trial.</p>}
        {(a.state === "active" || a.state === "cancel_scheduled") && <p>Paid through <strong>{when(a.paid_through)}</strong>.</p>}
        {a.state === "past_due" && <p>The renewal payment failed. Paid access continues until <strong>{when(a.grace_ends_at)}</strong>. Bachs retries the card on its own schedule and emails your billing contact; SAVOUR never charges you itself.</p>}
        {a.state === "read_only" && <p>Read-only. Records, reports and exports stay available and accepted work can be completed. New work needs an active subscription.</p>}
        {a.state === "suspended" && <p>Suspended by SAVOUR. Records stay readable.</p>}
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Usage against the current limits</caption>
            <thead><tr><th scope="col">Limit</th><th scope="col">Used</th><th scope="col">Allowed</th><th scope="col">Share</th></tr></thead>
            <tbody>
              {KINDS.map((k) => (
                <tr key={k}>
                  <td>{KIND_LABELS[k]}</td><td>{a.usage?.[k] ?? 0}</td><td>{a.limits?.[k] ?? "—"}</td>
                  <td>{a.percent?.[k] ?? 0}%{a.at_limit?.includes(k) ? " · limit reached" : a.warnings?.includes(k) ? " · over 80%" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">Trial: {b.trial_limits.locations} location, {b.trial_limits.subjects} subjects, {b.trial_limits.staff} staff, {b.trial_limits.assessments} first submissions.
          Business plan: {b.plan.limits.locations} locations, {b.plan.limits.subjects} subjects, {b.plan.limits.staff} staff including owners, {b.plan.limits.assessments} first submissions per paid month.
          Guests are not staff seats; archived items and frozen reports do not count; there are no overage charges.</p>
      </section>

      {blocking && !prep && (
        <section className="card stack">
          <h2>Checkout in progress</h2>
          <p>{CHECKOUT_STATUS_LABELS[blocking.status] ?? blocking.status}: {blocking.amount} {blocking.currency}, started {when(blocking.created_at)}.
            Access changes only after SAVOUR verifies the payment with Bachs.</p>
          {blocking.checkout_url && <p><a className="btn primary" href={blocking.checkout_url} rel="noopener noreferrer">Continue to the Bachs payment page</a></p>}
        </section>
      )}

      {blocking && prep && (
        <section className="card stack" aria-labelledby="prep-h">
          <h2 id="prep-h">{prepText ? "Checkout not started" : "Preparing checkout"}</h2>
          <p>{blocking.amount} {blocking.currency} per month, consented {when(blocking.created_at)}. Bachs has not been asked for a payment page yet, so nothing was charged.</p>
          {prepText ? <p className="notice error" role="alert">{prepText}</p> : <p>SAVOUR is setting up the billing customer with Bachs. If this does not change, try again.</p>}
          {prep.customer_uncertain && <p className="small muted">A billing customer request to Bachs is unconfirmed. Trying again repeats the same request, so no second customer is created.</p>}
          <ActionForm action={retryCheckout}>
            {hidden}<input type="hidden" name="intent" value={blocking.id} />
            <SubmitButton pendingText="Contacting Bachs…">Try again</SubmitButton>
          </ActionForm>
        </section>
      )}

      {!sub && !blocking && (
        <section className="card stack" aria-labelledby="buy-h">
          <h2 id="buy-h">Business plan, monthly</h2>
          {prepText && <p className="notice warn" role="status">Your last checkout attempt did not start: {prepText} You can start again below.</p>}
          <fieldset>
            <legend>Billing currency</legend>
            {b.prices.map((p) => (
              <div key={p.currency} className="field">
                <strong>{p.currency === "NGN" ? "Naira (NGN)" : "US dollars (USD)"}</strong>{" "}
                {formatPrice(p) && <span>{formatPrice(p)} per month · <em>{p.label}</em></span>}
                {p.unavailable_reason && <p className="hint">{UNAVAILABLE_REASONS[p.unavailable_reason] ?? "Unavailable."}</p>}
              </div>
            ))}
          </fieldset>
          {!b.billing_contact && <p className="notice">Nominate a billing email below before subscribing.</p>}
          {available.length > 0 && b.billing_contact && (
            <>
              <div className="notice">
                <p><strong>Before you continue</strong></p>
                <ul>
                  <li>Plan: SAVOUR Business, billed monthly in the currency you choose. The currency stays fixed for this subscription.</li>
                  <li>Price: as shown above (sandbox proposal, not an approved price). Bachs shows the final amount, including any taxes or fees it applies, before you pay. SAVOUR adds no fees.</li>
                  <li>Renewal: charged automatically every month to the card you enter at Bachs until you cancel.</li>
                  <li>Cancellation: cancel any time here or in Manage billing; access continues until the end of the paid month and nothing further is charged.</li>
                  <li>Refunds: no partial refunds for unused time. Contact SAVOUR support about a billing problem.</li>
                  <li>Your free trial is not shortened; paid access starts when Bachs confirms the payment.</li>
                </ul>
                <p className="small muted">Terms version {TERMS_VERSION}.</p>
              </div>
              {available.map((p) => (
                // One form per currency: each pins the exact price row the Owner reviewed (a changed price is refused).
                <ActionForm key={p.currency} action={startCheckout}>
                  {hidden}<input type="hidden" name="currency" value={p.currency} /><input type="hidden" name="price_id" value={p.price_id ?? ""} />
                  <label className="check"><input type="checkbox" name="consent" required /> I have read the terms above and want to subscribe in {p.currency} at {formatPrice(p)} per month.</label>
                  <SubmitButton pendingText="Opening Bachs…">Continue to secure payment ({p.currency})</SubmitButton>
                </ActionForm>
              ))}
            </>
          )}
          {available.length === 0 && <p className="notice warn">Subscribing is not available yet. See the reasons above; no payment can be started.</p>}
        </section>
      )}

      {sub && (
        <section className="card stack" aria-labelledby="sub-h">
          <h2 id="sub-h">Subscription</h2>
          <p>{sub.amount} {sub.currency} per month · Bachs status {sub.status}, last checked {when(sub.status_observed_at)}.</p>
          {sub.cancellation === "pending" && <p className="notice warn">Cancellation requested and waiting for Bachs to confirm. Until then the subscription may still renew.</p>}
          {sub.cancellation === "confirmed" && <p className="notice ok">Cancellation confirmed by Bachs. Access continues until {when(sub.current_period_end)}; no further renewal.</p>}
          <div className="row">
            <ActionForm action={openPortal}>{hidden}<SubmitButton className="btn" pendingText="Opening…">Manage billing (cards and invoices)</SubmitButton></ActionForm>
          </div>
          {sub.cancellation === "none" && (
            <ActionForm action={cancelSubscription}>
              {hidden}<input type="hidden" name="version" value={b.version} />
              <label className="check"><input type="checkbox" name="confirm" /> Cancel at the end of the paid month (no refund for the remaining days).</label>
              <SubmitButton className="btn danger" pendingText="Cancelling…">Cancel subscription</SubmitButton>
            </ActionForm>
          )}
        </section>
      )}
      {!sub && b.customer_bound && (
        <ActionForm action={openPortal}>{hidden}<SubmitButton className="btn" pendingText="Opening…">Manage billing (cards and invoices)</SubmitButton></ActionForm>
      )}

      <section className="card stack" aria-labelledby="contact-h">
        <h2 id="contact-h">Billing contact</h2>
        {b.billing_contact && <p>{b.billing_contact.email} · consent recorded {when(b.billing_contact.consent_at)}</p>}
        {b.billing_contact?.locked
          ? <p className="small muted">Linked to Bachs. Change it in Manage billing.</p>
          : (
            <ActionForm action={setBillingContact}>
              {hidden}<input type="hidden" name="version" value={b.version} />
              <div className="field">
                <label htmlFor="billing-email">Billing email for this business</label>
                <input id="billing-email" name="email" type="email" required maxLength={254} autoComplete="email" inputMode="email" />
                <p className="hint">Use an address dedicated to this business. Each SAVOUR business needs its own billing email (Bachs keeps one customer per email).</p>
              </div>
              <label className="check"><input type="checkbox" name="consent" required /> Bachs may send receipts and payment-recovery emails to this address.</label>
              <SubmitButton>Save billing contact</SubmitButton>
            </ActionForm>
          )}
      </section>

      {b.ledger.length > 0 && (
        <section className="card stack" aria-labelledby="ledger-h">
          <h2 id="ledger-h">Verified payments</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Period</th><th scope="col">Amount</th><th scope="col">Notes</th></tr></thead>
              <tbody>
                {b.ledger.map((l) => (
                  <tr key={`${l.period_start}-${l.amount_minor}`}>
                    <td>{when(l.period_start)} – {when(l.period_end)}</td>
                    <td>{formatMinor(l.amount_minor, l.currency)}</td>
                    <td>{[l.revoked ? "revoked" : null, l.refund_state !== "none" ? `${l.refund_state} refund` : null,
                      l.dispute_state !== "none" ? `dispute ${l.dispute_state}` : null, l.review_flag ? "under review" : null].filter(Boolean).join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">Totals per currency (never added across currencies): {b.totals_by_currency.map((t) => formatMinor(t.paid_minor, t.currency)).join(" · ") || "—"}</p>
        </section>
      )}
    </>
  );
}
