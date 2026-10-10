"use client";

import { useEffect, useReducer } from "react";
import {
  buildSubmission, formReducer, idempotencyKeyFor, initialFormState, type ExistingAssessment,
} from "@/lib/assessment-draft";
import { formatPct, OUTCOME_LABELS, outcomesFor, scoreAssessment, type AttendanceMode, type Criterion } from "@/lib/scoring";
import { validateDraft } from "@/lib/validation";
import { submitAssessment } from "../../actions";

export function AssessmentForm(props: {
  ws: string; session: string; subject: string; assessor: string; criteria: Criterion[]; mode: AttendanceMode;
  existing: ExistingAssessment | null; amend: boolean; backHref: string;
}) {
  const { criteria, mode, existing } = props;
  const [s, dispatch] = useReducer(formReducer, existing, initialFormState);
  const saving = s.save === "saving";
  const absent = s.observed === "absent";

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (s.save === "unsaved" || s.save === "failed" || s.save === "saving") e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [s.save]);

  async function save() {
    if (saving) return;
    const built = buildSubmission(s, criteria, props.amend);
    if (!built.ok) return dispatch({ type: "invalid", errors: built.errors, message: built.message });
    const body = { ws: props.ws, session: props.session, subject: props.subject, assessor: props.assessor,
      ...built.body, expectedVersion: s.version };
    const payload = JSON.stringify(body);
    const key = idempotencyKeyFor(s.key, payload, () => crypto.randomUUID());
    dispatch({ type: "start", payload, key });
    try {
      const r = await submitAssessment({ ...body, idempotencyKey: key });
      if (r.ok) dispatch({ type: "success", version: r.version, replayed: r.replayed });
      else dispatch({ type: "failure", message: r.error + (r.code === "stale_version"
        ? " Your entries are still on this page; copy anything you need, then reload." : " Nothing was saved.") });
    } catch {
      dispatch({ type: "failure", message: "Could not reach the server. Your entries are kept on this page — press Retry." });
    }
  }

  const checked = absent ? null : validateDraft(criteria, s.draft);
  const preview = checked?.ok ? scoreAssessment(criteria, checked.answers) : null;
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {existing?.state === "cleared" && <p className="notice warn">Earlier scores were cleared because the subject was marked absent or not assessed. Enter fresh scores.</p>}
      {/* Disabled while saving so the values on screen are exactly the values being saved. */}
      <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        {mode !== "off" && (
          <fieldset>
            <legend>Attendance observed <span className="hint">(the reviewer records the final outcome)</span></legend>
            <label className="check"><input type="radio" name="observed" checked={s.observed === ""} onChange={() => dispatch({ type: "observe", value: "" })} /> Not recorded</label>
            {outcomesFor(mode).map((o) => (
              <label key={o} className="check"><input type="radio" name="observed" checked={s.observed === o} onChange={() => dispatch({ type: "observe", value: o })} /> {OUTCOME_LABELS[o]}</label>
            ))}
          </fieldset>
        )}
        {absent ? (
          <>
            <p className="notice">Absent: quality scores and observations are not recorded. Saving discards any unsaved scores; returning to present needs fresh scores.</p>
            <div className="field">
              <label htmlFor="absence-notes">Absence notice or reason (optional)</label>
              <textarea id="absence-notes" value={s.absenceNotes} maxLength={2000} onChange={(e) => dispatch({ type: "absenceNotes", value: e.target.value })} />
            </div>
          </>
        ) : (
          <>
            {criteria.map((c) => {
              const d = s.draft[c.key] ?? {};
              const err = s.errors[c.key];
              return (
                <fieldset key={c.key} aria-describedby={err ? `err-${c.key}` : undefined} aria-invalid={!!err}>
                  <legend>{c.label}</legend>
                  {c.guidance && <p className="hint">{c.guidance}</p>}
                  {!d.na && (
                    <div className="scores" role="radiogroup" aria-label={`${c.label} score`}>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <label key={n}><input type="radio" name={`c-${c.key}`} checked={d.score === n} onChange={() => dispatch({ type: "answer", key: c.key, patch: { score: n } })} /><span>{n}</span></label>
                      ))}
                    </div>
                  )}
                  {c.allow_na && (
                    <>
                      <label className="check"><input type="checkbox" checked={!!d.na} onChange={(e) => dispatch({ type: "answer", key: c.key, patch: { na: e.target.checked } })} /> Not applicable</label>
                      {d.na && <div className="field"><label htmlFor={`na-${c.key}`}>Reason for N/A</label>
                        <input id={`na-${c.key}`} value={d.reason ?? ""} maxLength={500} onChange={(e) => dispatch({ type: "answer", key: c.key, patch: { reason: e.target.value } })} /></div>}
                    </>
                  )}
                  {err && <p id={`err-${c.key}`} className="field-error">{err}</p>}
                </fieldset>
              );
            })}
            <div className="field">
              <label htmlFor="quality-notes">Observations (optional)</label>
              <textarea id="quality-notes" value={s.qualityNotes} maxLength={2000} onChange={(e) => dispatch({ type: "qualityNotes", value: e.target.value })} />
              <p className="hint">Avoid personal names in free text; reports may be shared.</p>
            </div>
          </>
        )}
        {props.amend && (
          <div className="field"><label htmlFor="reason">Reason for amendment (required)</label>
            <input id="reason" value={s.reason} maxLength={500} onChange={(e) => dispatch({ type: "reason", value: e.target.value })} /></div>
        )}
      </fieldset>
      {preview?.pct != null && <p className="muted">Quality preview: {formatPct(preview.pct)} ({preview.applicable} of {preview.total} applicable)</p>}
      <div aria-live="polite" role="status">
        {s.save === "saving" && <p className="notice">Saving…</p>}
        {s.save === "saved" && <p className="notice ok">{s.message}</p>}
        {s.save === "failed" && <p className="notice error">{s.message}</p>}
        {s.save === "unsaved" && <p className="notice warn">{s.message ?? "Unsaved changes."}</p>}
      </div>
      <div className="row">
        <button type="submit" className="btn primary" disabled={saving} aria-busy={saving}>{saving ? "Saving…" : s.save === "failed" ? "Retry save" : "Save"}</button>
        <a className="btn" href={props.backHref}>Back to session</a>
      </div>
    </form>
  );
}
