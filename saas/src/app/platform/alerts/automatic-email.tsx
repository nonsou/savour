import {
  JOB_LABELS, LEDGER_LABELS, MAILER_STATE_LABELS, MAILER_TERMS, mailerState, RECENT_LIMIT, RUN_LABELS, SCHEDULE_NOTE, type MailerView,
} from "@/lib/operations-mailer";
import { ALERT_TEXT } from "@/lib/operations-alerts";
import { MailerForm } from "./mailer-form";

const utc = (iso: string) => `${iso.replace("T", " ").slice(0, 19)} UTC`;
const at = (iso: string | null) => (iso ? utc(iso) : "never");

// Automatic owner email (development only). Separate from the manual verification test. Shows the worker as it
// reports itself (key present is the worker's own report, never the key), counters and the latest 14 ledger rows.
export function AutomaticEmail({ view }: { view: MailerView | null }) {
  const state = mailerState(view);
  return (
    <section className="card stack" aria-labelledby="auto-mail-h">
      <h2 id="auto-mail-h">Automatic email (development only)</h2>
      <p className={state === "enabled" ? "notice ok" : state === "unavailable" ? "notice error" : "notice sample"} role="status">
        {MAILER_STATE_LABELS[state]}
      </p>
      <ul className="small" style={{ overflowWrap: "anywhere" }}>{MAILER_TERMS.map((x) => <li key={x}>{x}</li>)}</ul>
      {view && (
        <>
          <ul className="small">
            <li>Worker key: {view.worker.key_present === null ? "not reported yet" : view.worker.key_present ? "present (as reported by the worker)" : "missing (as reported by the worker)"}.
              Last worker check (scheduled or by hand): {at(view.worker.last_checked_at)}.</li>
            <li>{JOB_LABELS[view.scheduler.job]} Latest scheduled run: {view.scheduler.last_scheduled_start_at
              ? `${utc(view.scheduler.last_scheduled_start_at)}, ${RUN_LABELS[view.scheduler.last_scheduled_status!]}` : "none recorded"}.
              A worker call by hand never counts as a scheduled run. {SCHEDULE_NOTE}</li>
            <li>Today ({view.today.utc_day} UTC): {view.today.automatic_attempts} of {view.today.automatic_limit} automatic attempts used.</li>
            <li>Waiting {view.queue.pending}, sending {view.queue.leased}, unknown {view.queue.unknown}, needing review {view.queue.review}.</li>
            <li>Latest accepted by Resend: {at(view.last_accepted_at)}. Accepted is not delivered.</li>
            <li>Switched {view.enabled ? "on" : "off"}{view.enabled_changed_at ? ` at ${utc(view.enabled_changed_at)}` : " (never changed)"}.</li>
          </ul>
          {view.enabled ? <MailerForm enable={false} /> : view.ready_to_enable ? <MailerForm enable /> : null}
          <h3>Latest {RECENT_LIMIT} emails</h3>
          {view.recent.length === 0 ? <p className="small">No automatic emails yet.</p> : (
            <ul className="small stack" style={{ overflowWrap: "anywhere" }}>
              {view.recent.map((r, i) => (
                <li key={i}><strong>{ALERT_TEXT[r.code].title}</strong>: {LEDGER_LABELS[r.status]}. Queued {utc(r.created_at)}.
                  {" "}Attempts {r.attempts}{r.first_dispatched_at ? `, first sent ${utc(r.first_dispatched_at)}` : ""}{r.finished_at ? `, last result ${utc(r.finished_at)}` : ""}.</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
