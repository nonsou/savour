import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isUuid, requireWorkspace } from "@/lib/auth";
import { availableSteps, EVENT_LABELS, type ActionDetail, type Assignee } from "@/lib/corrective";
import { friendlyError } from "@/lib/errors";
import { ACTION_STATUS_LABELS, DUE_STATE_LABELS, FINDING_STATE_LABELS, SEVERITY_LABELS } from "@/lib/labels";
import { formatDateTime, formatLocalDate } from "@/lib/report";
import { ActionPanel } from "./action-panel";

export const metadata = { title: "Action — SAVOUR" };

export default async function ActionPage({ params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws, id } = await params;
  if (!isUuid(id)) notFound();
  const { supabase, ctx } = await requireWorkspace(ws);
  if (!["owner", "admin", "reviewer", "assessor"].includes(ctx.role)) notFound();
  const { data, error } = await supabase.rpc("get_action", { p_action: id });
  if (error || !data) {
    return (
      <section className="card stack">
        <h1>Action</h1>
        <p className="notice error">{friendlyError(error)}</p>
        <Link className="btn" href={`/w/${ws}/actions`}>Back to actions</Link>
      </section>
    );
  }
  const d = data as ActionDetail;
  // An action from another business the user also belongs to is never shown under this business.
  if (d.action.workspace_id !== ws) notFound();
  const a = d.action;
  const f = d.finding;
  const tz = d.timezone;
  const steps = availableSteps(d);
  const assignees = d.permissions.review
    ? ((await supabase.rpc("get_action_assignees", { p_session: a.session_id })).data as Assignee[] | null) ?? []
    : [];
  // One idempotency key per rendered form: a double submit replays; a fresh render gets new keys.
  const keys = Object.fromEntries(steps.map((st) => [st.step, randomUUID()]));
  const edit = steps.some((st) => st.step === "edit") ? {
    issue: a.issue, severity: a.severity, due_date: a.due_date, action_required: a.action_required, assignee_id: a.assignee_id,
    assignee_label: a.assignee_label, timezone: d.timezone, today: d.today, assignees,
  } : null;

  return (
    <>
      <Link className="btn no-print" href={`/w/${ws}/actions`}>Back to actions</Link>
      <section className={`card stack action-card ${a.due_state}`}>
        <div className="row between">
          <h1>{a.issue}</h1>
          <span className={`badge sev-${a.severity}`}>{SEVERITY_LABELS[a.severity]}</span>
        </div>
        <p className="small muted">{a.subject_name} · {a.session_name} ({formatLocalDate(a.session_date)}) · {a.location_name}
          {d.permissions.review && <> · <Link href={`/w/${ws}/sessions/${a.session_id}`}>Open session</Link></>}</p>
        <p>
          <span className={`badge status-${a.status}`}>{ACTION_STATUS_LABELS[a.status]}</span>{" "}
          <span className={`badge due-${a.due_state}`}>{a.due_state === "done" ? "Finished" : DUE_STATE_LABELS[a.due_state]}</span>{" "}
          Due {formatLocalDate(a.due_date)} <span className="hint">(end of that day, {tz})</span>
        </p>
        <dl className="small">
          <div><strong>Action required:</strong> {a.action_required}</div>
          <div><strong>Assigned to:</strong> {a.is_mine ? "You" : a.assignee_label}
            {!a.assignee_in_scope && <span className="notice warn small"> This person no longer has access to this location. Reassign the action.</span>}</div>
          <div><strong>Created by:</strong> {a.created_by_label}, {formatDateTime(a.created_at, tz)}</div>
          {a.resolution_evidence && <div><strong>Resolution evidence</strong> ({a.resolved_by_label}, {formatDateTime(a.resolved_at, tz)}): {a.resolution_evidence}</div>}
          {a.verified_at && <div><strong>Verified by:</strong> {a.verified_by_label}, {formatDateTime(a.verified_at, tz)}</div>}
          {a.cancel_reason && <div><strong>Cancelled:</strong> {a.cancel_reason}</div>}
          {a.reopen_count > 0 && <div><strong>Reopened {a.reopen_count} time(s)</strong>{a.last_reopen_reason ? ` — latest reason: ${a.last_reopen_reason}` : ""}</div>}
        </dl>
      </section>

      <section className="card stack">
        <h2>Finding</h2>
        <p><span className={`badge sev-${f.severity}`}>{SEVERITY_LABELS[f.severity]}</span> {f.title}{" "}
          <span className="badge">{FINDING_STATE_LABELS[f.state]}</span></p>
        <p className="small muted">{f.kind === "generated" ? `Raised by a template trigger at approval of revision ${f.revision}` : `Raised by a reviewer during revision ${f.revision}`}, {formatDateTime(f.created_at, tz)}.</p>
        {f.detail.note && <p className="small">Note: {f.detail.note}</p>}
        {f.kind === "generated" && f.detail.min_score !== undefined && (
          <p className="small">Lowest score {f.detail.min_score} (trigger at or below {f.detail.trigger_at_or_below}); {f.detail.assessors_below} of {f.detail.assessors_scored} assessor score(s) at or below.</p>
        )}
        {f.detail.repeat && <p className="small">Repeat check: {f.detail.repeat.status.replace(/_/g, " ")} ({f.detail.repeat.prior_sessions_checked} of {f.detail.repeat.window} previous sessions of this template version checked{f.detail.repeat.sources_withheld ? `; ${f.detail.repeat.sources_withheld} source inspection(s) are outside your access and not listed` : ""}).</p>}
        {f.detail.rule && <p className="hint">Rule: {f.detail.rule}</p>}
      </section>

      {/* Always rendered (even with no steps) so a save result outlives the form that produced it. */}
      <ActionPanel key={a.id} ws={ws} actionId={a.id} sessionId={a.session_id} version={a.version} status={a.status}
        steps={steps} keys={keys} edit={edit} />

      <section className="card table-wrap">
        <h2>History</h2>
        <table>
          <thead><tr><th>When</th><th>Step</th><th>By</th><th>Details</th></tr></thead>
          <tbody>{d.events.map((e, i) => (
            <tr key={i}>
              <td>{formatDateTime(e.created_at, tz)}</td>
              <td>{EVENT_LABELS[e.kind] ?? e.kind}{e.from_status && e.from_status !== e.to_status ? <div className="hint">{ACTION_STATUS_LABELS[e.from_status]} → {ACTION_STATUS_LABELS[e.to_status]}</div> : null}</td>
              <td>{e.actor_label}{e.override && <div className="badge in_review">Override</div>}</td>
              <td className="wide small">
                {e.reason && <div>Reason: {e.reason}</div>}
                {e.evidence && <div>Evidence: {e.evidence}</div>}
                {e.changes && Object.entries(e.changes).map(([k, v]) => (
                  <div key={k}>{k.replace(/_/g, " ")}: {k === "assignee_id" ? "reassigned" : `${String(v.from ?? "—")} → ${String(v.to ?? "—")}`}</div>
                ))}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </section>
    </>
  );
}
