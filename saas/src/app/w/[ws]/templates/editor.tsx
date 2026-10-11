"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import type { ActionState } from "@/lib/errors";
import type { AttendanceMode, Criterion } from "@/lib/scoring";
import { slugKey, validateCriteria } from "@/lib/validation";

type Row = Criterion & { isNew?: boolean };

export function TemplateEditor({ ws, templateId, name, pack, mode, criteria, action }: {
  ws: string; templateId: string | null; name: string; pack: string; mode: AttendanceMode; criteria: Criterion[];
  action: (s: ActionState, f: FormData) => Promise<ActionState>;
}) {
  const [rows, setRows] = useState<Row[]>(criteria);
  const [attendance, setAttendance] = useState<AttendanceMode>(mode);
  // Controlled (like the other fields) so React's post-publish form reset cannot restore an old name.
  const [templateName, setTemplateName] = useState(name);
  const finalRows = rows.map((r) => ({
    key: r.isNew ? slugKey(r.label) : r.key, label: r.label.trim(), guidance: r.guidance?.trim() || null, allow_na: r.allow_na,
  }));
  const problem = validateCriteria(finalRows, attendance === "scored");
  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <ActionForm action={action}>
      <input type="hidden" name="ws" value={ws} />
      <input type="hidden" name="template_id" value={templateId ?? ""} />
      <input type="hidden" name="pack" value={pack} />
      <input type="hidden" name="criteria" value={JSON.stringify(finalRows)} />
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
            <div className="row between">
              <label className="check"><input type="checkbox" checked={r.allow_na} onChange={(e) => update(i, { allow_na: e.target.checked })} /> Allow N/A (reason required)</label>
              <button type="button" className="btn danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
            </div>
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setRows([...rows, { key: "", label: "", allow_na: false, isNew: true }])}>Add criterion</button>
      </fieldset>
      {attendance === "scored" && finalRows.length === 0 && <p className="notice">Attendance only: reports show readiness and attendance with no quality score.</p>}
      {problem && <p className="notice warn">{problem}</p>}
      <p className="muted small">Publishing creates a new immutable version. Sessions already created keep the version they started with.</p>
      <SubmitButton pendingText="Publishing…">Publish version</SubmitButton>
    </ActionForm>
  );
}
