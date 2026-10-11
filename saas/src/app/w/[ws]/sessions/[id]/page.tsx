import Link from "next/link";
import { ATTENDANCE_MODE_LABELS, SESSION_STATUS_LABELS } from "@/lib/labels";
import { formatDateTime, formatLocalDate } from "@/lib/report";
import { loadSession } from "./data";
import { AssessorPanel } from "./assessor-panel";
import { FindingsPanel } from "./findings-panel";
import { ManagePanel } from "./manage-panel";
import { ReviewPanel } from "./review-panel";

export const metadata = { title: "Session — SAVOUR" };

export default async function SessionPage({ params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws, id } = await params;
  const d = await loadSession(ws, id);
  const { session, template, ctx } = d;
  const tz = ctx.workspace.timezone;
  const collecting = d.collecting;
  const myAssignments = d.assignments.filter((a) => a.user_id === d.user.id && d.roster.some((r) => r.subject_id === a.subject_id));
  const showReport = d.canReview || ctx.role === "viewer";
  return (
    <>
      <div className="row between">
        <div>
          <h1>{session.name}</h1>
          <p className="muted small">
            {formatLocalDate(session.local_date)} · {d.locationName ?? "Location hidden"} · {template ? `${template.name} v${template.version} · ${ATTENDANCE_MODE_LABELS[template.attendance_mode]}` : "Template"}
          </p>
        </div>
        <div className="row">
          <span className={`badge ${session.status}`}>{SESSION_STATUS_LABELS[session.status]}</span>
          {session.is_sample && <span className="badge sample">SAMPLE</span>}
          {session.revision > 1 && <span className="badge">Revision {session.revision}</span>}
        </div>
      </div>
      {d.loadFailed && <p className="notice error">Some session data could not be loaded. Reload to try again.</p>}
      {session.is_sample && <p className="notice sample">SAMPLE — practice inspection with practice subjects. It never counts in business totals, dashboards or setup progress.</p>}
      {session.status === "draft" && <p className="notice">Draft — not collecting. Assessors cannot see it yet. Finish the roster, assessors and reviewers, then open it below.</p>}
      {session.status === "open" && session.collection_reopens > 0 && (
        <p className="notice warn">Collection reopened{session.last_collection_reopen_reason ? `: “${session.last_collection_reopen_reason}”` : ""}. Earlier evidence is kept.</p>
      )}
      {session.status === "in_review" && session.revision > 1 && (
        <p className="notice warn">Under revision: reopened with reason “{session.last_reopen_reason}”. The previous approved report is preserved and excluded from analytics until reapproval.</p>
      )}
      {session.status === "cancelled" && <p className="notice error">Cancelled: {session.cancel_reason}</p>}
      <div className="card small">
        {session.status === "draft"
          ? <p>Collection window: {session.planned_window_hours ?? 48} hour(s), starting when the session is opened.</p>
          : <p>Collection window: {formatDateTime(session.opens_at, tz)} → {formatDateTime(session.closes_at, tz)} {collecting ? <span className="badge open">Collecting</span> : <span className="badge">Closed to assessors</span>}</p>}
        {session.expected_ready_time && <p>Expected ready time: {session.expected_ready_time.slice(0, 5)} ({tz})</p>}
        {showReport && session.status !== "draft" && <Link className="btn" href={`/w/${ws}/sessions/${id}/report`}>View report</Link>}
      </div>
      {myAssignments.length > 0 && <AssessorPanel ws={ws} data={d} collecting={collecting} />}
      {d.canReview && <ReviewPanel ws={ws} data={d} />}
      {d.canReview && <FindingsPanel ws={ws} data={d} />}
      {(ctx.role === "owner" || ctx.role === "admin") && <ManagePanel ws={ws} data={d} />}
      {!d.loadFailed && !d.canReview && myAssignments.length === 0 && ctx.role !== "viewer" && (
        <p className="notice">You have no assignments in this session.</p>
      )}
    </>
  );
}
