import Link from "next/link";
import { notFound } from "next/navigation";
import { canSeeReports, isUuid, requireWorkspace } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";
import { answerText, formatDateTime, reportHeaderRows, SAMPLE_NOTICE, summaryRows, type ReportEnvelope } from "@/lib/report";
import { formatPct, isKnownFormula, OUTCOME_LABELS, subjectStatusLabel, summarizeSession } from "@/lib/scoring";

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
  if (!isKnownFormula(env.inputs.formula_version)) {
    return (
      <div className="card stack">
        <h1>Report</h1>
        <p className="notice error" role="alert">This report was calculated with formula “{env.inputs.formula_version}”, which this version of SAVOUR cannot show.
          No figures are displayed rather than recalculating them differently.</p>
        <Link className="btn" href={`/w/${ws}/sessions/${id}`}>Back to session</Link>
      </div>
    );
  }
  const sum = summarizeSession(env.inputs);
  const criteria = env.inputs.template.criteria;
  const scoredMode = env.inputs.template.attendance_mode === "scored";
  const tz = env.inputs.workspace.timezone;
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
        {sum.isSample && <p className="notice sample">{SAMPLE_NOTICE}</p>}
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
            <thead><tr><th>Subject</th><th>Outcome</th>{scoredMode && <th>Attendance</th>}{!sum.attendanceOnly && <th>Quality</th>}{scoredMode && !sum.attendanceOnly && <th>Combined</th>}{!sum.attendanceOnly && <th>Responses</th>}<th>Status</th></tr></thead>
            <tbody>
              {sum.subjects.map((s) => (
                <tr key={s.subjectId}>
                  <td>{s.name}</td>
                  <td>{OUTCOME_LABELS[s.outcome]}{s.outcomeReason && <div className="hint">{s.outcomeReason}</div>}</td>
                  {scoredMode && <td>{s.attendancePoints === null ? "—" : `${s.attendancePoints}/5`}</td>}
                  {!sum.attendanceOnly && <td>{formatPct(s.quality, "—")}{!s.comparable && <div className="hint">Mixed N/A sets</div>}</td>}
                  {scoredMode && !sum.attendanceOnly && <td>{formatPct(s.combined, "—")}</td>}
                  {!sum.attendanceOnly && <td>{s.completeResponses} of {s.requiredAssessors}{s.waivedAssessors ? <div className="hint">{s.waivedAssessors} waived (missing)</div> : null}</td>}
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
            {s.restored && <p className="hint">Restored to the roster {formatDateTime(s.restored.restored_at, tz)}{s.restored.reason ? ` (${s.restored.reason})` : ""}; earlier responses were retained.</p>}
            {s.waivers.map((w, i) => <p key={`w${i}`} className="small notice warn">{w.assessor_label}: response waived — {w.reason} ({formatDateTime(w.waived_at, tz)}). Still counted as missing.</p>)}
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

      {sum.removed.length > 0 && (
        <section className="card stack">
          <h2>Removed from roster</h2>
          <p className="small muted">Not included in any figure above. Their responses are kept in history.</p>
          <ul className="small">{sum.removed.map((r) => (
            <li key={r.subject_id}>{r.name}{r.reason ? ` — ${r.reason}` : ""} ({formatDateTime(r.removed_at, tz)}; {r.retained_responses} response(s) retained)</li>
          ))}</ul>
        </section>
      )}
    </>
  );
}
