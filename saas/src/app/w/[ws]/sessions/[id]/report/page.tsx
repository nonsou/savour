import Link from "next/link";
import { notFound } from "next/navigation";
import { canSeeReports, isUuid, requireWorkspace } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";
import { answerText, reportHeaderRows, summaryRows, type ReportEnvelope } from "@/lib/report";
import { formatPct, OUTCOME_LABELS, subjectStatusLabel, summarizeSession } from "@/lib/scoring";

export const metadata = { title: "Report — SAVOUR" };

export default async function ReportPage({ params, searchParams }: {
  params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ revision?: string; redact?: string }>;
}) {
  const { ws, id } = await params;
  const sp = await searchParams;
  const { supabase, ctx } = await requireWorkspace(ws);
  if (!isUuid(id) || !canSeeReports(ctx.role)) notFound();
  const revision = sp.revision && /^\d+$/.test(sp.revision) ? Number(sp.revision) : null;
  const redact = sp.redact === "1";
  const { data, error } = await supabase.rpc("get_session_report", { p_session: id, p_revision: revision, p_redact: redact, p_purpose: "view" });
  if (error) {
    return (
      <div className="card stack">
        <h1>Report</h1>
        <p className="notice error">{error.message === "not_found" && ctx.role === "viewer" ? "No approved report is available for this session." : friendlyError(error)}</p>
        <Link className="btn" href={`/w/${ws}/sessions/${id}`}>Back to session</Link>
      </div>
    );
  }
  const env = data as ReportEnvelope;
  const sum = summarizeSession(env.inputs);
  const criteria = env.inputs.template.criteria;
  const q = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (revision !== null) p.set("revision", String(revision));
    if (env.meta.redacted) p.set("redact", "1");
    for (const [k, v] of Object.entries(extra)) { if (v === "") p.delete(k); else p.set(k, v); }
    return p.toString();
  };
  const base = `/w/${ws}/sessions/${id}/report`;

  return (
    <>
      <div className="row between no-print">
        <Link className="btn" href={`/w/${ws}/sessions/${id}`}>Back to session</Link>
        <div className="row">
          <a className="btn" href={`${base}/export?${q({ format: "pdf" })}`}>Download PDF</a>
          <a className="btn" href={`${base}/export?${q({ format: "csv" })}`}>Download CSV</a>
        </div>
      </div>
      <section className={`card stack ${env.meta.status === "approved" ? "highlight" : ""}`}>
        <h1>{env.inputs.session.name}</h1>
        {env.meta.status !== "approved" && <p className="notice warn">Provisional — not approved. Figures may change and are excluded from analytics.</p>}
        {env.meta.status === "approved" && !env.meta.is_current && <p className="notice warn">This is an earlier approved revision. The session has since been reopened{env.meta.reopen_reason ? ` (“${env.meta.reopen_reason}”)` : ""}.</p>}
        <dl className="small">
          {reportHeaderRows(env, new Date()).map(([k, v]) => <div key={k}><strong>{k}:</strong> {v}</div>)}
        </dl>
        <div className="row no-print small">
          {env.revisions.length > 0 && <span className="muted">Revisions:</span>}
          {env.revisions.map((r) => <Link key={r.revision} href={`${base}?${q({ revision: String(r.revision) })}`}>r{r.revision} ({r.approver_name})</Link>)}
          {revision !== null && <Link href={`${base}?${q({ revision: "" })}`}>Current</Link>}
          {ctx.role !== "viewer" && (
            <Link href={`${base}?${q({ redact: env.meta.redacted ? "" : "1" })}`}>{env.meta.redacted ? "Show assessor names" : "Anonymous mode"}</Link>
          )}
        </div>
        {env.meta.redacted && <p className="hint">Assessor identities were removed by the server. Free-text notes may still contain names; review before sharing.</p>}
      </section>

      <section className="card">
        <h2>Summary</h2>
        {summaryRows(sum).map(([k, v]) => <p key={k}><strong>{k}:</strong> {v}</p>)}
      </section>

      <section className="card table-wrap">
        <h2>Subjects</h2>
        {sum.subjects.length === 0 ? <p className="muted">No subjects on this roster.</p> : (
          <table>
            <thead><tr><th>Subject</th><th>Outcome</th>{env.inputs.template.attendance_mode === "scored" && <th>Attendance</th>}<th>Quality</th>{env.inputs.template.attendance_mode === "scored" && <th>Combined</th>}<th>Assessors</th><th>Status</th></tr></thead>
            <tbody>
              {sum.subjects.map((s) => (
                <tr key={s.subjectId}>
                  <td>{s.name}</td>
                  <td>{OUTCOME_LABELS[s.outcome]}{s.outcomeReason && <div className="hint">{s.outcomeReason}</div>}</td>
                  {env.inputs.template.attendance_mode === "scored" && <td>{s.attendancePoints === null ? "—" : `${s.attendancePoints}/5`}</td>}
                  <td>{formatPct(s.quality, "—")}{!s.comparable && <div className="hint">Mixed N/A sets</div>}</td>
                  {env.inputs.template.attendance_mode === "scored" && <td>{formatPct(s.combined, "—")}</td>}
                  <td>{s.assessorsScored} of {s.requiredAssessors}</td>
                  <td>{subjectStatusLabel(s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card stack">
        <h2>Assessment detail</h2>
        {sum.subjects.map((s) => (
          <div key={s.subjectId}>
            <h3>{s.name}</h3>
            {s.assessments.length === 0 && <p className="muted small">No current responses.</p>}
            {s.assessments.map((a, i) => (
              <p key={i} className="small">
                <strong>{a.assessor_label}</strong>
                {a.observed_attendance && ` · observed ${OUTCOME_LABELS[a.observed_attendance]}`}
                {a.answers && ` · ${criteria.map((c) => `${c.label} ${answerText(a.answers![c.key])}`).join(", ")}`}
                {a.result.pct !== null && ` · ${formatPct(a.result.pct)} (${a.result.applicable} of ${a.result.total} applicable)`}
                {a.notes && <><br /><span className="muted">Notes: {a.notes}</span></>}
                {a.absence_reason && <><br /><span className="muted">Absence reason: {a.absence_reason}</span></>}
              </p>
            ))}
          </div>
        ))}
      </section>
    </>
  );
}
