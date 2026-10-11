import { randomUUID } from "node:crypto";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import type { ActionList, Assignee, FindingRow } from "@/lib/corrective";
import { ACTION_STATUS_LABELS, DUE_STATE_LABELS, FINDING_STATE_LABELS, SEVERITY_LABELS } from "@/lib/labels";
import { formatLocalDate } from "@/lib/report";
import { createAction, createFinding, withdrawFinding } from "../../actions/commands";
import type { loadSession } from "./data";

type Data = Awaited<ReturnType<typeof loadSession>>;
const SEVERITIES = ["critical", "high", "medium", "low"] as const;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Reviewer view of a session's findings and corrective actions. Action management continues after
// approval and never changes the approved report; new approvals freeze the action state.
export async function FindingsPanel({ ws, data }: { ws: string; data: Data }) {
  const { session, template } = data;
  if (session.status === "draft") return null;
  const [fRes, aRes, pRes] = await Promise.all([
    data.supabase.rpc("get_findings", { p_session: session.id }),
    data.supabase.rpc("get_actions", { p_ws: ws, p_session: session.id }),
    data.supabase.rpc("get_action_assignees", { p_session: session.id }),
  ]);
  const findings = (fRes.data ?? []) as FindingRow[];
  const list = aRes.data as ActionList | null;
  const assignees = (pRes.data ?? []) as Assignee[];
  const writable = !session.is_sample && ["open", "in_review", "approved"].includes(session.status);
  const today = list?.today ?? session.local_date;
  const current = findings.filter((f) => f.current || f.state === "withdrawn" || f.active_actions > 0);
  const historical = findings.filter((f) => !current.includes(f));
  const base = (<><input type="hidden" name="ws" value={ws} /><input type="hidden" name="session" value={session.id} /></>);

  const card = (f: FindingRow) => {
    const actions = (list?.actions ?? []).filter((a) => a.finding_id === f.id);
    return (
      <article key={f.id} className="card stack">
        <div className="row between">
          <h4 className="action-title"><span className={`badge sev-${f.severity}`}>{SEVERITY_LABELS[f.severity]}</span> {f.title}</h4>
          <span className="badge">{FINDING_STATE_LABELS[f.state]}</span>
        </div>
        <p className="small muted">{f.subject_name} · {f.kind === "generated" ? `Template trigger at approval of revision ${f.revision}` : `Raised by ${f.created_by_label} (revision ${f.revision})`}
          {!f.current && f.state !== "withdrawn" && " · historical evidence from an earlier revision"}</p>
        {f.detail.note && <p className="small">Note: {f.detail.note}</p>}
        {f.detail.repeat && <p className="small">Repeat check: {f.detail.repeat.status.replace(/_/g, " ")} ({f.detail.repeat.prior_sessions_checked} of {f.detail.repeat.window} previous sessions checked{f.detail.repeat.sources_withheld ? `; ${f.detail.repeat.sources_withheld} outside your access` : ""})</p>}
        {f.detail.rule && <p className="hint">Rule: {f.detail.rule}</p>}
        {f.withdraw_reason && <p className="small notice">Withdrawn: {f.withdraw_reason}</p>}
        {actions.length > 0 && (
          <ul className="small">{actions.map((a) => (
            <li key={a.id}><Link href={`/w/${ws}/actions/${a.id}`}>{a.issue}</Link> — {ACTION_STATUS_LABELS[a.status]}, {a.assignee_label},
              {" "}{a.due_state === "done" ? "finished" : `${DUE_STATE_LABELS[a.due_state].toLowerCase()} (${formatLocalDate(a.due_date)})`}</li>
          ))}</ul>
        )}
        {writable && f.state !== "withdrawn" && (
          <details>
            <summary className="btn">Assign a corrective action</summary>
            {assignees.length === 0 ? <p className="notice warn small">Nobody active holds this session&apos;s location, so no one can be assigned.</p> : (
              <ActionForm action={createAction} className="stack">
                {base}
                <input type="hidden" name="finding" value={f.id} />
                <input type="hidden" name="idempotency_key" value={randomUUID()} />
                <div className="grid">
                  <div className="field"><label htmlFor={`ai-${f.id}`}>Issue</label><input id={`ai-${f.id}`} name="issue" defaultValue={f.title.slice(0, 300)} required maxLength={300} /></div>
                  <div className="field"><label htmlFor={`as-${f.id}`}>Severity</label>
                    <select id={`as-${f.id}`} name="severity" defaultValue={f.severity}>{SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>)}</select></div>
                  <div className="field"><label htmlFor={`aa-${f.id}`}>Assign to</label>
                    <select id={`aa-${f.id}`} name="assignee" required defaultValue="">
                      <option value="" disabled>Choose…</option>
                      {assignees.map((x) => <option key={x.user_id} value={x.user_id}>{x.display_name} ({x.role})</option>)}
                    </select></div>
                  <div className="field"><label htmlFor={`ad-${f.id}`}>Due date ({data.ctx.workspace.timezone})</label>
                    <input id={`ad-${f.id}`} name="due_date" type="date" min={today} defaultValue={addDays(today, 7)} required /></div>
                </div>
                <div className="field"><label htmlFor={`ar-${f.id}`}>Action required</label><textarea id={`ar-${f.id}`} name="action_required" required maxLength={2000} /></div>
                <SubmitButton className="btn primary">Assign action</SubmitButton>
              </ActionForm>
            )}
          </details>
        )}
        {writable && f.state !== "withdrawn" && f.actions === 0 && (
          <details>
            <summary className="btn">Withdraw finding</summary>
            <ActionForm action={withdrawFinding}>
              {base}
              <input type="hidden" name="finding" value={f.id} /><input type="hidden" name="version" value={f.version} />
              <div className="field"><label htmlFor={`wf-${f.id}`}>Reason (required)</label><input id={`wf-${f.id}`} name="reason" required maxLength={500} /></div>
              <SubmitButton className="btn danger">Withdraw</SubmitButton>
            </ActionForm>
          </details>
        )}
      </article>
    );
  };

  return (
    <section className="stack">
      <h2>Findings and corrective actions</h2>
      {(fRes.error || aRes.error) && <p className="notice error">Findings or actions could not be loaded. Reload to try again.</p>}
      {session.is_sample && <p className="notice sample">SAMPLE sessions cannot have findings or corrective actions.</p>}
      {session.status === "cancelled" && <p className="notice">This session is cancelled; no new findings or actions.</p>}
      {session.status === "approved" && <p className="small muted">The approved report keeps the findings and action state frozen at approval. Changes made now appear only in the report&apos;s dated current-actions appendix.</p>}
      {writable && (
        <details className="card">
          <summary><strong>Raise a finding</strong></summary>
          <ActionForm action={createFinding} className="stack" resetOnSuccess>
            {base}
            <input type="hidden" name="idempotency_key" value={randomUUID()} />
            <div className="grid">
              <div className="field"><label htmlFor="nf-subject">Subject</label>
                <select id="nf-subject" name="subject" required defaultValue="">
                  <option value="" disabled>Choose…</option>
                  {data.roster.map((r) => <option key={r.subject_id} value={r.subject_id}>{r.subject_name}</option>)}
                </select></div>
              <div className="field"><label htmlFor="nf-sev">Severity</label>
                <select id="nf-sev" name="severity" defaultValue="medium">{SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>)}</select></div>
              <div className="field"><label htmlFor="nf-crit">Criterion <span className="hint">(optional)</span></label>
                <select id="nf-crit" name="criterion_key" defaultValue="">
                  <option value="">None</option>
                  {(template?.criteria ?? []).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select></div>
            </div>
            <div className="field"><label htmlFor="nf-title">Finding</label><input id="nf-title" name="title" required maxLength={200} /></div>
            <div className="field"><label htmlFor="nf-note">Note <span className="hint">(optional; avoid personal details)</span></label><textarea id="nf-note" name="note" maxLength={2000} /></div>
            <SubmitButton className="btn">Record finding</SubmitButton>
          </ActionForm>
        </details>
      )}
      {findings.length === 0 && !fRes.error && <p className="muted small">No findings yet.{template?.criteria.some((c) => c.critical || c.trigger_at_or_below) ? " This template version raises findings automatically at approval when a score is at or below its trigger." : ""}</p>}
      {current.map(card)}
      {historical.length > 0 && (
        <details>
          <summary>{historical.length} finding(s) from earlier revisions (historical evidence)</summary>
          <div className="stack">{historical.map(card)}</div>
        </details>
      )}
    </section>
  );
}
