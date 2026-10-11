import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/forms";
import { savedStateKey } from "@/lib/form-keys";
import { answerText, formatDateTime, summaryRows } from "@/lib/report";
import {
  formatPct, OUTCOME_LABELS, outcomesFor, reviewSignals, scoreAssessment, SPREAD_ATTENTION_PCT, summarizeSession,
} from "@/lib/scoring";
import {
  approveSession, closeCollection, confirmNa, requestCorrection, resolveOutcome, setWaiver, withdrawCorrection,
} from "./actions";
import type { loadSession } from "./data";

type Data = Awaited<ReturnType<typeof loadSession>>;

export function ReviewPanel({ ws, data }: { ws: string; data: Data }) {
  const { session, template, report } = data;
  if (!template) return null;
  const tz = data.ctx.workspace.timezone;
  const editable = session.status === "open" || session.status === "in_review";
  const manager = data.ctx.role === "owner" || data.ctx.role === "admin";
  const hidden = (
    <><input type="hidden" name="ws" value={ws} /><input type="hidden" name="session" value={session.id} /></>
  );
  const versioned = <>{hidden}<input type="hidden" name="data_version" value={session.data_version} /></>;
  let summary = null;
  let formulaError: string | null = null;
  try { summary = report ? summarizeSession(report.inputs) : null; } catch (e) { formulaError = (e as Error).message; }
  const outcomes = outcomesFor(template.attendance_mode);
  const openCorrections = data.corrections.filter((c) => c.status === "open" && data.roster.some((r) => r.subject_id === c.subject_id));
  const needsQuality = template.criteria.length > 0;

  if (session.status === "draft") {
    return (
      <section className="stack">
        <h2>Review</h2>
        <p className="notice">This session is a draft. Review starts after it is opened and responses arrive.</p>
      </section>
    );
  }

  return (
    <section className="stack">
      <h2>Review</h2>
      {data.reportError && <p className="notice error">The live summary could not be loaded. Reload before approving.</p>}
      {formulaError && <p className="notice error" role="alert">{formulaError}</p>}
      {summary && (
        <div className="card small">
          {summaryRows(summary).map(([k, v]) => <p key={k}><strong>{k}:</strong> {v}</p>)}
          {openCorrections.length > 0 && <p className="notice warn">{openCorrections.length} correction request(s) open — approval waits until each is resolved or withdrawn.</p>}
        </div>
      )}
      {data.roster.map((r) => {
        const assigned = data.assignments.filter((a) => a.subject_id === r.subject_id);
        const responses = data.assessments.filter((a) => a.subject_id === r.subject_id);
        const result = summary?.subjects.find((x) => x.subjectId === r.subject_id);
        const sig = result ? reviewSignals(template, result) : null;
        const resolved = r.outcome !== "unknown";
        const noQuality = r.outcome === "absent" || r.outcome === "not_assessed" || !needsQuality;
        return (
          <article key={r.subject_id} className="card stack">
            <div className="row between">
              <h3>{r.subject_name}</h3>
              <span className="badge">{OUTCOME_LABELS[r.outcome]}</span>
            </div>
            {r.restored_at && (
              <p className="notice warn small">Restored to the roster {formatDateTime(r.restored_at, tz)}{r.restore_reason ? ` (${r.restore_reason})` : ""}. Responses submitted before removal were kept and count again — check them.</p>
            )}
            {sig && !noQuality && (
              <p className="small">
                <span className="signal"><strong>Responses:</strong> {sig.complete} of {sig.required} complete{sig.waived ? `, ${sig.waived} waived` : ""}{sig.missing ? `, ${sig.missing} missing` : ""}</span>
                {sig.spread !== null && <span className="signal"><strong>Score spread:</strong> {formatPct(sig.spread)}</span>}
              </p>
            )}
            {sig && sig.attendanceDisagreement.length > 0 && (
              <p className="notice warn">Assessors disagree on attendance: {sig.attendanceDisagreement.map((o) => OUTCOME_LABELS[o]).join(" vs ")}. Record one final outcome and explain.</p>
            )}
            {sig && sig.spread !== null && sig.spread >= SPREAD_ATTENTION_PCT && (
              <p className="notice warn">Scores differ by {formatPct(sig.spread)} between assessors{sig.criterionSpread.length ? `: ${sig.criterionSpread.map((c) => `${c.label} ${c.min}–${c.max}`).join(", ")}` : ""}.</p>
            )}
            {sig && sig.naPatternsDiffer && (
              <p className="notice warn">Assessors marked different criteria N/A, so their percentages use different denominators and no overall score spread is shown.
                {sig.criterionSpread.length ? ` Criteria both scored still differ: ${sig.criterionSpread.map((c) => `${c.label} ${c.min}–${c.max}`).join(", ")}.` : " Compare the criteria they both scored below."}</p>
            )}
            {editable && (
              <ActionForm action={resolveOutcome} className="row">
                {hidden}
                <input type="hidden" name="subject" value={r.subject_id} />
                {/* Keyed by the saved outcome so React's post-save form reset uses refreshed defaults. */}
                <div key={savedStateKey(r.outcome, r.outcome_reason, r.version)} style={{ display: "contents" }}>
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
                </div>
                <SubmitButton className="btn">Save outcome</SubmitButton>
              </ActionForm>
            )}
            <p className="hint">Absent or Not assessed clears current scores and feedback for this subject (history is kept). Changing back requires fresh scores.</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Assessor</th><th>Response</th><th>Quality</th><th>Actions</th></tr></thead>
                <tbody>
                  {assigned.length === 0 && <tr><td colSpan={4} className="muted">No assessors assigned.</td></tr>}
                  {assigned.map((a) => {
                    const x = responses.find((y) => y.assessor_id === a.user_id);
                    const res = x ? scoreAssessment(template.criteria, x.answers) : null;
                    const complete = !!(x?.state === "submitted" && x.answers);
                    const cr = data.corrections.find((c) => c.subject_id === r.subject_id && c.assessor_id === a.user_id && c.status === "open");
                    const self = a.user_id === data.user.id;
                    const canWaive = editable && !noQuality && !complete && !a.waived_at && resolved && (!self || manager);
                    return (
                      <tr key={a.user_id}>
                        <td>{x?.assessor_name ?? "Assigned assessor"}{self && " (you)"}</td>
                        <td className="small wide">
                          {!x && !a.waived_at && <span className="muted">No response yet</span>}
                          {a.waived_at && <div className="notice warn">Waived: {a.waiver_reason} — still counted as missing.</div>}
                          {x?.state === "cleared" && <span>Cleared — needs fresh scores if present</span>}
                          {x?.state === "submitted" && (
                            <>
                              {x.observed_attendance && <div>Observed: {OUTCOME_LABELS[x.observed_attendance]}</div>}
                              {x.answers && template.criteria.map((c) => <div key={c.key}>{c.label}: {answerText(x.answers![c.key])}</div>)}
                              {x.notes && <div className="muted">Notes: {x.notes}</div>}
                              {x.absence_reason && <div className="muted">Absence reason: {x.absence_reason}</div>}
                            </>
                          )}
                          {cr && <div className="notice warn">Correction requested by {cr.requester_name}: {cr.reason}</div>}
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
                          {editable && !noQuality && (
                            <Link className="btn" href={`/w/${ws}/sessions/${session.id}/assess/${r.subject_id}?assessor=${a.user_id}`}>Amend</Link>
                          )}
                          {data.collecting && x?.state === "submitted" && !self && !cr && (
                            <details>
                              <summary className="btn">Request correction</summary>
                              <ActionForm action={requestCorrection}>
                                {versioned}
                                <input type="hidden" name="subject" value={r.subject_id} /><input type="hidden" name="assessor" value={a.user_id} />
                                <div className="field"><label htmlFor={`cr-${r.subject_id}-${a.user_id}`}>What should be corrected?</label>
                                  <input id={`cr-${r.subject_id}-${a.user_id}`} name="reason" required maxLength={500} /></div>
                                <SubmitButton className="btn">Send request</SubmitButton>
                              </ActionForm>
                            </details>
                          )}
                          {editable && cr && (
                            <details>
                              <summary className="btn">Withdraw request</summary>
                              <ActionForm action={withdrawCorrection}>
                                {versioned}<input type="hidden" name="request" value={cr.id} />
                                <div className="field"><label htmlFor={`wd-${cr.id}`}>Reason (required)</label><input id={`wd-${cr.id}`} name="reason" required maxLength={500} /></div>
                                <SubmitButton className="btn">Withdraw</SubmitButton>
                              </ActionForm>
                            </details>
                          )}
                          {canWaive && (
                            <details>
                              <summary className="btn">Waive missing response</summary>
                              <ActionForm action={setWaiver}>
                                {versioned}
                                <input type="hidden" name="subject" value={r.subject_id} /><input type="hidden" name="assessor" value={a.user_id} />
                                <input type="hidden" name="waive" value="true" />
                                <p className="hint">The response stays missing in every report and coverage stays incomplete; the waiver only lets approval proceed.</p>
                                <div className="field"><label htmlFor={`wv-${r.subject_id}-${a.user_id}`}>Reason (required)</label>
                                  <input id={`wv-${r.subject_id}-${a.user_id}`} name="reason" required maxLength={500} /></div>
                                <SubmitButton className="btn">Waive</SubmitButton>
                              </ActionForm>
                            </details>
                          )}
                          {editable && a.waived_at && (
                            <ActionForm action={setWaiver}>
                              {versioned}
                              <input type="hidden" name="subject" value={r.subject_id} /><input type="hidden" name="assessor" value={a.user_id} />
                              <input type="hidden" name="waive" value="false" />
                              <SubmitButton className="btn">Remove waiver</SubmitButton>
                            </ActionForm>
                          )}
                          {editable && !noQuality && !complete && !a.waived_at && !resolved && <span className="hint">Record the outcome before waiving.</span>}
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
            <p className="small">Approval checks every outcome, required response (or explicit waiver), N/A confirmation and open correction request on the server,
              then freezes this revision. Waived responses stay missing in the approved report. If anything changed since this page loaded, approval is refused and you must reload.</p>
            {session.is_sample && <p className="notice sample">SAMPLE — approving a practice session never counts in business totals.</p>}
            <label className="check"><input type="checkbox" name="confirm" required /> I have reviewed these results and approve them.</label>
            <SubmitButton pendingText="Approving…">Approve</SubmitButton>
          </ActionForm>
        </div>
      )}
    </section>
  );
}
