import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { answerText, summaryRows } from "@/lib/report";
import { formatPct, OUTCOME_LABELS, outcomesFor, scoreAssessment, summarizeSession } from "@/lib/scoring";
import { approveSession, closeCollection, confirmNa, resolveOutcome } from "./actions";
import type { loadSession } from "./data";

type Data = Awaited<ReturnType<typeof loadSession>>;

export function ReviewPanel({ ws, data }: { ws: string; data: Data }) {
  const { session, template, report } = data;
  if (!template) return null;
  const editable = session.status === "open" || session.status === "in_review";
  const hidden = (
    <><input type="hidden" name="ws" value={ws} /><input type="hidden" name="session" value={session.id} /></>
  );
  const summary = report ? summarizeSession(report.inputs) : null;
  const outcomes = outcomesFor(template.attendance_mode);
  return (
    <section className="stack">
      <h2>Review</h2>
      {data.reportError && <p className="notice error">The live summary could not be loaded. Reload before approving.</p>}
      {summary && (
        <div className="card small">
          {summaryRows(summary).map(([k, v]) => <p key={k}><strong>{k}:</strong> {v}</p>)}
        </div>
      )}
      {data.roster.map((r) => {
        const assigned = data.assignments.filter((a) => a.subject_id === r.subject_id);
        const responses = data.assessments.filter((a) => a.subject_id === r.subject_id);
        const pcts = responses.map((a) => scoreAssessment(template.criteria, a.answers).pct).filter((p): p is number => p !== null);
        const observed = [...new Set(responses.map((a) => a.observed_attendance).filter(Boolean))];
        return (
          <article key={r.subject_id} className="card stack">
            <div className="row between">
              <h3>{r.subject_name}</h3>
              <span className="badge">{OUTCOME_LABELS[r.outcome]}</span>
            </div>
            {observed.length > 1 && <p className="notice warn">Assessors disagree on attendance: {observed.map((o) => OUTCOME_LABELS[o!]).join(" vs ")}. Record one final outcome and explain.</p>}
            {pcts.length > 1 && Math.max(...pcts) - Math.min(...pcts) >= 20 && <p className="notice warn">Score spread {formatPct(Math.max(...pcts) - Math.min(...pcts))} between assessors.</p>}
            {editable && (
              <ActionForm action={resolveOutcome} className="row">
                {hidden}
                <input type="hidden" name="subject" value={r.subject_id} />
                <input type="hidden" name="version" value={r.version} />
                <div style={{ flex: "1 1 180px" }}>
                  <label htmlFor={`o-${r.subject_id}`}>Final outcome</label>
                  <select id={`o-${r.subject_id}`} name="outcome" defaultValue={r.outcome === "unknown" ? "" : r.outcome} required>
                    <option value="" disabled>Choose…</option>
                    {outcomes.map((o) => <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>)}
                  </select>
                </div>
                <div style={{ flex: "2 1 220px" }}>
                  <label htmlFor={`or-${r.subject_id}`}>Reason / note <span className="hint">(required for Not assessed)</span></label>
                  <input id={`or-${r.subject_id}`} name="reason" defaultValue={r.outcome_reason ?? ""} maxLength={500} />
                </div>
                <SubmitButton className="btn">Save outcome</SubmitButton>
              </ActionForm>
            )}
            <p className="hint">Absent or Not assessed clears current scores and feedback for this subject (history is kept). Changing back requires fresh scores.</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Assessor</th><th>Response</th><th>Quality</th><th></th></tr></thead>
                <tbody>
                  {assigned.length === 0 && <tr><td colSpan={4} className="muted">No assessors assigned.</td></tr>}
                  {assigned.map((a) => {
                    const x = responses.find((y) => y.assessor_id === a.user_id);
                    const res = x ? scoreAssessment(template.criteria, x.answers) : null;
                    return (
                      <tr key={a.user_id}>
                        <td>{x?.assessor_name ?? "Assigned assessor"}{a.user_id === data.user.id && " (you)"}</td>
                        <td className="small">
                          {!x && <span className="muted">No response yet</span>}
                          {x?.state === "cleared" && <span>Cleared — needs fresh scores if present</span>}
                          {x?.state === "submitted" && (
                            <>
                              {x.observed_attendance && <div>Observed: {OUTCOME_LABELS[x.observed_attendance]}</div>}
                              {x.answers && template.criteria.map((c) => <div key={c.key}>{c.label}: {answerText(x.answers![c.key])}</div>)}
                              {x.notes && <div className="muted">Notes: {x.notes}</div>}
                              {x.absence_reason && <div className="muted">Absence reason: {x.absence_reason}</div>}
                            </>
                          )}
                        </td>
                        <td>{res?.pct != null ? `${formatPct(res.pct)} (${res.applicable}/${res.total})` : "—"}</td>
                        <td className="stack">
                          {editable && x && res?.hasNa && !x.na_confirmed && (
                            <ActionForm action={confirmNa}>
                              {hidden}
                              <input type="hidden" name="subject" value={r.subject_id} />
                              <input type="hidden" name="assessor" value={a.user_id} />
                              <input type="hidden" name="version" value={x.version} />
                              <SubmitButton className="btn">Confirm N/A</SubmitButton>
                            </ActionForm>
                          )}
                          {editable && r.outcome !== "absent" && r.outcome !== "not_assessed" && (
                            <Link className="btn" href={`/w/${ws}/sessions/${session.id}/assess/${r.subject_id}?assessor=${a.user_id}`}>Amend</Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </article>
        );
      })}
      {editable && (
        <div className="card stack">
          {session.status === "open" && (
            <ActionForm action={closeCollection}>
              {hidden}
              <p className="small">Closing collection stops assessor submissions; review can continue.</p>
              <SubmitButton className="btn">Close collection</SubmitButton>
            </ActionForm>
          )}
          <ActionForm action={approveSession}>
            {hidden}
            <input type="hidden" name="data_version" value={session.data_version} />
            <h3>Approve revision {session.revision}</h3>
            <p className="small">Approval checks every outcome, required response and N/A confirmation on the server, then freezes this revision. If anything changed since this page loaded, approval is refused and you must reload.</p>
            <label className="check"><input type="checkbox" name="confirm" required /> I have reviewed these results and approve them.</label>
            <SubmitButton pendingText="Approving…">Approve</SubmitButton>
          </ActionForm>
        </div>
      )}
    </section>
  );
}
