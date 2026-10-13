import { HISTORY_DAYS, STATUS_LABELS, type VerificationsView } from "@/lib/alert-email";
import { VerificationForm } from "./verification-form";

const utc = (iso: string) => `${iso.replace("T", " ").slice(0, 19)} UTC`;

// Manual email verification (Stage 1). Shows whether the server has a key (a boolean only), the fixed destination and
// the latest 14 UTC days. One button, one email per UTC day; this is never automatic alert delivery.
export function EmailVerification({ view, configured }: { view: VerificationsView | null; configured: boolean }) {
  return (
    <section className="card stack" aria-labelledby="verify-h">
      <h2 id="verify-h">Email verification (manual test)</h2>
      <p className="small">This sends one fixed test email by hand to check that the email service works. It contains no alert or customer information.
        It is <strong>not</strong> alert delivery: warnings on this page are still never emailed automatically.</p>
      <p className={configured ? "notice ok" : "notice sample"} role="status">
        {configured ? "Email key: present on this server (Preview deployment). The key is never shown."
          : "Email key: not available on this deployment (sending works only on a Preview deployment with the key set). Nothing can be sent here."}
      </p>
      {view === null ? (
        <p className="notice error" role="status">Verification history could not be read, so sending is not offered right now. Reload to try again.</p>
      ) : (
        <>
          {view.used_today
            ? <p className="small"><strong>Today&apos;s verification ({view.utc_day} UTC) has been used.</strong> The next one is possible after 00:00 UTC.</p>
            : configured && <VerificationForm />}
          <h3>Last {HISTORY_DAYS} UTC days</h3>
          {view.history.length === 0 ? <p className="small">No verification attempts.</p> : (
            <ul className="small stack" style={{ overflowWrap: "anywhere" }}>
              {view.history.map((r) => (
                <li key={r.utc_day}>
                  <strong>{r.utc_day}</strong>: {STATUS_LABELS[r.status]} Started {utc(r.requested_at)}.
                  {r.finished_at && <> Recorded {utc(r.finished_at)}.</>}
                  {r.provider_message_id && <> Resend id <code className="mono">{r.provider_message_id}</code>.</>}
                </li>
              ))}
            </ul>
          )}
          <p className="small muted">Statuses are reported by the admin session that pressed the button, so they are not proof. Confirm arrival in the owner inbox.</p>
        </>
      )}
    </section>
  );
}
