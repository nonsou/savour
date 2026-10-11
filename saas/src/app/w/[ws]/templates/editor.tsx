"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import type { ActionState } from "@/lib/errors";
import type { AttendanceMode, Criterion } from "@/lib/scoring";
import { slugKey, validateCriteria } from "@/lib/validation";

type Row = Criterion & { isNew?: boolean };

export function TemplateEditor({ ws, templateId, name, pack, mode, criteria, repeatWindow = 3, action }: {
  ws: string; templateId: string | null; name: string; pack: string; mode: AttendanceMode; criteria: Criterion[];
  repeatWindow?: number; action: (s: ActionState, f: FormData) => Promise<ActionState>;
}) {
  const [rows, setRows] = useState<Row[]>(criteria);
  const [attendance, setAttendance] = useState<AttendanceMode>(mode);
  const [windowSize, setWindowSize] = useState(repeatWindow);
  // Controlled (like the other fields) so React's post-publish form reset cannot restore an old name.
  const [templateName, setTemplateName] = useState(name);
  // Trigger settings are sent only when set, so a criterion without them keeps the M1 shape.
  const finalRows: Criterion[] = rows.map((r) => ({
    key: r.isNew ? slugKey(r.label) : r.key, label: r.label.trim(), guidance: r.guidance?.trim() || null, allow_na: r.allow_na,
    ...(r.critical ? { critical: true } : {}),
    ...(r.trigger_at_or_below ? { trigger_at_or_below: r.trigger_at_or_below } : {}),
  }));
  const anyTrigger = finalRows.some((r) => r.critical || r.trigger_at_or_below);
  const problem = validateCriteria(finalRows, attendance === "scored");
  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <ActionForm action={action}>
      <input type="hidden" name="ws" value={ws} />
      <input type="hidden" name="template_id" value={templateId ?? ""} />
      <input type="hidden" name="pack" value={pack} />
      <input type="hidden" name="criteria" value={JSON.stringify(finalRows)} />
      <input type="hidden" name="settings" value={JSON.stringify({ repeat_window: windowSize })} />
      <div className="field"><label htmlFor={`n-${templateId}`}>Template name</label>
        <input id={`n-${templateId}`} name="name" value={templateName} onChange={(e) => setTemplateName(e.target.value)} required maxLength={120} /></div>
      <div className="field"><label htmlFor={`m-${templateId}`}>Attendance</label>
        <select id={`m-${templateId}`} name="attendance_mode" value={attendance} onChange={(e) => setAttendance(e.target.value as AttendanceMode)}>
          <option value="off">Off — no arrival question</option>
          <option value="presence">Presence only — present/absent gate, no points</option>
          <option value="scored">Scored readiness — Early 5, Around expected time 3, Late 1, Absent 0</option>
        </select></div>
      <fieldset>
        <legend>Criteria (each scored 1–5, equal weight)</legend>
        {rows.map((r, i) => (
          <div key={i} className="card" style={{ marginBottom: ".5rem" }}>
            <div className="field"><label htmlFor={`c-${templateId}-${i}`}>Label</label>
              <input id={`c-${templateId}-${i}`} value={r.label} maxLength={80} onChange={(e) => update(i, { label: e.target.value })} /></div>
            <div className="field"><label htmlFor={`g-${templateId}-${i}`}>Guidance <span className="hint">(optional)</span></label>
              <input id={`g-${templateId}-${i}`} value={r.guidance ?? ""} maxLength={300} onChange={(e) => update(i, { guidance: e.target.value })} /></div>
            <label className="check"><input type="checkbox" checked={r.allow_na} onChange={(e) => update(i, { allow_na: e.target.checked })} /> Allow N/A (reason required)</label>
            <label className="check"><input type="checkbox" checked={!!r.critical} onChange={(e) => update(i, { critical: e.target.checked || undefined })} /> Critical criterion (findings are severity Critical)</label>
            <div className="field"><label htmlFor={`t-${templateId}-${i}`}>Raise a finding when any score is at or below</label>
              <select id={`t-${templateId}-${i}`} value={r.trigger_at_or_below ?? ""}
                onChange={(e) => update(i, { trigger_at_or_below: e.target.value ? Number(e.target.value) : undefined })}>
                <option value="">{r.critical ? "2 (default for critical criteria)" : "Never"}</option>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select></div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
            </div>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setRows([...rows, { key: "", label: "", allow_na: false, isNew: true }])}>Add criterion</button>
      </fieldset>
      {attendance === "scored" && finalRows.length === 0 && <p className="notice">Attendance only: reports show readiness and attendance with no quality score.</p>}
      <div className="field"><label htmlFor={`rw-${templateId}`}>Repeat check: look back over the previous</label>
        <select id={`rw-${templateId}`} value={windowSize} onChange={(e) => setWindowSize(Number(e.target.value))}>
          {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} approved session{n > 1 ? "s" : ""} of this version</option>)}
        </select></div>
      <p className="hint">{anyTrigger
        ? "Findings are raised at approval from the frozen scores. They never change any average, and they are prompts for review, not certifications or penalties."
        : "No finding triggers: approval raises no findings from this version (reviewers can still raise findings manually)."}</p>
      {problem && <p className="notice warn">{problem}</p>}
      <p className="muted small">Publishing creates a new immutable version. Sessions already created keep the version they started with.</p>
      <SubmitButton pendingText="Publishing…">Publish version</SubmitButton>
    </ActionForm>
  );
}
