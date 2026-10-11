import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { isUnfinished, type ActionList } from "@/lib/corrective";
import { friendlyError } from "@/lib/errors";
import { ACTION_STATUS_LABELS, DUE_STATE_LABELS, SEVERITY_LABELS } from "@/lib/labels";
import { formatLocalDate } from "@/lib/report";

export const metadata = { title: "Actions — SAVOUR" };

const VIEWS = { mine: "Assigned to me", open: "Unfinished", overdue: "Overdue", all: "All" } as const;
type View = keyof typeof VIEWS;

export default async function ActionsPage({ params, searchParams }: {
  params: Promise<{ ws: string }>; searchParams: Promise<{ view?: string }>;
}) {
  const { ws } = await params;
  const sp = await searchParams;
  const { supabase, ctx } = await requireWorkspace(ws);
  // Viewer and Guest have no action access (the RPC refuses them too).
  if (!["owner", "admin", "reviewer", "assessor"].includes(ctx.role)) notFound();
  const { data, error } = await supabase.rpc("get_actions", { p_ws: ws, p_session: null });
  const list = error ? null : (data as ActionList);
  const view: View = sp.view && sp.view in VIEWS ? (sp.view as View) : ctx.role === "assessor" ? "mine" : "open";
  const rows = (list?.actions ?? []).filter((a) =>
    view === "mine" ? a.is_mine : view === "open" ? isUnfinished(a.status) : view === "overdue" ? a.due_state === "overdue" : true);
  const overdue = (list?.actions ?? []).filter((a) => a.due_state === "overdue").length;

  return (
    <>
      <h1>Corrective actions</h1>
      <p className="muted small">
        {ctx.role === "assessor" ? "Actions assigned to you. An action does not give access to the rest of the session or its report."
          : "Actions on sessions you review, plus any assigned to you."} Due dates use the business timezone ({list?.timezone ?? ctx.workspace.timezone}).
        {list && ` Today is ${formatLocalDate(list.today)}.`}
      </p>
      <nav className="row small" aria-label="Filter actions">
        {(Object.keys(VIEWS) as View[]).map((v) => (
          <Link key={v} href={`/w/${ws}/actions?view=${v}`} className={`btn${v === view ? " primary" : ""}`} aria-current={v === view ? "page" : undefined}>
            {VIEWS[v]}{v === "overdue" && overdue ? ` (${overdue})` : ""}
          </Link>
        ))}
      </nav>
      {error && <p className="notice error">{friendlyError(error)}</p>}
      {list && rows.length === 0 && <p className="notice">No actions in this view.</p>}
      {rows.length > 0 && (
        <div className="stack">
          {rows.map((a) => (
            <article key={a.id} className={`card action-card ${a.due_state}`}>
              <div className="row between">
                <h2 className="action-title"><Link href={`/w/${ws}/actions/${a.id}`}>{a.issue}</Link></h2>
                <span className={`badge sev-${a.severity}`}>{SEVERITY_LABELS[a.severity]}</span>
              </div>
              <p className="small muted">{a.subject_name} · {a.session_name} ({formatLocalDate(a.session_date)}) · {a.location_name}</p>
              <p className="small">
                <span className={`badge status-${a.status}`}>{ACTION_STATUS_LABELS[a.status]}</span>{" "}
                <span className={`badge due-${a.due_state}`}>{a.due_state === "done" ? "Finished" : `${DUE_STATE_LABELS[a.due_state]} · ${formatLocalDate(a.due_date)}`}</span>{" "}
                {a.is_mine ? <strong>Assigned to you</strong> : <>Assignee: {a.assignee_label}</>}
                {!a.assignee_in_scope && isUnfinished(a.status) && <span className="badge in_review"> Assignee no longer in scope — reassign</span>}
              </p>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
