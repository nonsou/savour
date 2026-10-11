"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { describeActionResult, STEP_LABELS, type Assignee, type StepInfo } from "@/lib/corrective";
import { savedStateKey } from "@/lib/form-keys";
import { SEVERITY_LABELS } from "@/lib/labels";
import type { ActionStatus, Severity } from "@/lib/scoring";
import { saveActionStep } from "../commands";

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export interface EditData {
  issue: string; severity: Severity; due_date: string; action_required: string; assignee_id: string; assignee_label: string;
  timezone: string; today: string; assignees: Assignee[];
}

// Step and edit forms for one action. This component is rendered unconditionally (keyed by the
// action ID) and owns the only useActionState for these forms, so a save result survives when the
// page's refresh removes the form that produced it (for example a Verify that lost to a concurrent
// Return). Which steps appear always comes from the fresh server read; nothing stale is kept.
// Each form carries its own server-minted idempotency key and the version it was rendered from.
export function ActionPanel({ ws, actionId, sessionId, version, status, steps, keys, edit }: {
  ws: string; actionId: string; sessionId: string; version: number; status: ActionStatus; steps: StepInfo[];
  keys: Partial<Record<StepInfo["step"], string>>; edit: EditData | null;
}) {
  const [result, save, pending] = useActionState(saveActionStep, null);
  const resultRef = useRef<HTMLDivElement>(null);
  // The submitted form may be gone after the refresh; move focus to the result so keyboard and
  // screen-reader users land on the explanation instead of the top of the page.
  useEffect(() => { if (result) resultRef.current?.focus(); }, [result]);
  const view = describeActionResult(result, { status, version, steps });

  const hidden = (step: StepInfo["step"]) => (
    <>
      <input type="hidden" name="ws" value={ws} /><input type="hidden" name="action" value={actionId} />
      <input type="hidden" name="session" value={sessionId} /><input type="hidden" name="version" value={version} />
      <input type="hidden" name="step" value={step} /><input type="hidden" name="idempotency_key" value={keys[step] ?? ""} />
      {step !== "edit" && <input type="hidden" name="command" value={step} />}
    </>
  );

  return (
    <section className="stack" aria-labelledby="action-steps">
      <h2 id="action-steps">Next steps</h2>
      <div ref={resultRef} id="action-result" className="action-result" tabIndex={-1} role="status" aria-live="polite" aria-atomic="true">
        {view && (
          <div className={`notice ${view.tone}`}>
            <strong>{view.title}</strong>
            {view.lines.map((line, i) => <p key={i} className="small">{line}</p>)}
          </div>
        )}
      </div>
      {steps.length === 0 && <p className="notice small">No further steps are available to you for this action.</p>}
      {steps.map((info) => {
        if (info.step === "edit") {
          return edit ? <EditForm key={`edit-${version}`} save={save} hidden={hidden("edit")} edit={edit} ready={status === "ready_for_verification"} busy={pending} /> : null;
        }
        if (info.blocked) {
          return <div key={info.step} className="card"><h3>{STEP_LABELS[info.step]}</h3><p className="notice warn small">{info.blocked}</p></div>;
        }
        const id = `step-${info.step}`;
        return (
          <form key={`${info.step}-${version}`} action={save} className="card stack">
            {hidden(info.step)}
            <h3>{STEP_LABELS[info.step]}</h3>
            {info.step === "submit" && (
              <div className="field"><label htmlFor={`${id}-ev`}>What was done? (resolution evidence, required)</label>
                <textarea id={`${id}-ev`} name="evidence" required maxLength={2000} /></div>
            )}
            {info.override && info.step !== "verify" && <p className="hint">You are not the assignee. This step is recorded as an override with your reason.</p>}
            {info.override && info.step === "verify" && <p className="notice warn small">You own or resolved this action. As an owner or admin you may verify it only with a recorded override reason.</p>}
            {info.needsReason && (
              <div className="field"><label htmlFor={`${id}-r`}>{info.override ? "Override reason (required)" : "Reason (required)"}</label>
                <input id={`${id}-r`} name="reason" required maxLength={500} /></div>
            )}
            {(info.step === "cancel" || info.step === "verify") && (
              <label className="check"><input type="checkbox" name="confirm" required /> {info.step === "cancel" ? "Cancel this action" : "I checked the resolution evidence"}</label>
            )}
            <StepButton busy={pending} className={`btn${info.step === "verify" || info.step === "submit" ? " primary" : ""}`}>{STEP_LABELS[info.step]}</StepButton>
          </form>
        );
      })}
    </section>
  );
}

// Disabled while any save on this panel is pending (one change at a time per action page).
function StepButton({ children, className, busy }: { children: React.ReactNode; className: string; busy: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={busy} aria-busy={pending}>
      {pending ? "Saving…" : children}
    </button>
  );
}

function EditForm({ save, hidden, edit, ready, busy }: {
  save: (f: FormData) => void; hidden: React.ReactNode; edit: EditData; ready: boolean; busy: boolean;
}) {
  // Submitted evidence answers the work as it stands: while it awaits verification only the due
  // date can change (the database refuses anything else with return_required).
  if (ready) {
    return (
      <details className="card">
        <summary><strong>Change the due date</strong></summary>
        <form action={save} className="stack">
          {hidden}
          <p className="hint">To change the work, severity or assignee, first use “Return for more work” with a reason. That clears the submitted
            evidence (it stays in the history) so the old evidence can never close different work.</p>
          <div className="field"><label htmlFor="e-due">Due date ({edit.timezone})</label>
            <input id="e-due" name="due_date" type="date" defaultValue={edit.due_date} required /></div>
          <div className="field"><label htmlFor="e-r">Reason <span className="hint">(optional, kept in history)</span></label><input id="e-r" name="reason" maxLength={500} /></div>
          <StepButton busy={busy} className="btn">Save due date</StepButton>
        </form>
      </details>
    );
  }
  const current = edit.assignees.some((x) => x.user_id === edit.assignee_id);
  return (
    <details className="card">
      <summary><strong>{STEP_LABELS.edit}</strong></summary>
      <form action={save} className="stack">
        {hidden}
        <div key={savedStateKey(edit.issue, edit.severity, edit.due_date, edit.assignee_id)} className="grid">
          <div className="field"><label htmlFor="e-issue">Issue</label><input id="e-issue" name="issue" defaultValue={edit.issue} maxLength={300} required /></div>
          <div className="field"><label htmlFor="e-sev">Severity</label>
            <select id="e-sev" name="severity" defaultValue={edit.severity}>{SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>)}</select></div>
          <div className="field"><label htmlFor="e-due">Due date ({edit.timezone})</label><input id="e-due" name="due_date" type="date" defaultValue={edit.due_date} required />
            <div className="hint">A changed due date must be today ({edit.today}) or later.</div></div>
          <div className="field"><label htmlFor="e-as">Assignee</label>
            <select id="e-as" name="assignee" defaultValue={current ? edit.assignee_id : ""}>
              {!current && <option value="">{edit.assignee_label} (no longer eligible) — choose someone</option>}
              {edit.assignees.map((x) => <option key={x.user_id} value={x.user_id}>{x.display_name} ({x.role})</option>)}
            </select></div>
        </div>
        <div className="field"><label htmlFor="e-req">Action required</label><textarea id="e-req" name="action_required" defaultValue={edit.action_required} maxLength={2000} required /></div>
        <div className="field"><label htmlFor="e-r">Reason for the change <span className="hint">(optional, kept in history)</span></label><input id="e-r" name="reason" maxLength={500} /></div>
        <StepButton busy={busy} className="btn">Save changes</StepButton>
      </form>
    </details>
  );
}
