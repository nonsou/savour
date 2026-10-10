// Pure state machine for the assessment form, so save-state behaviour is unit-testable.
// Rules: "Saved" is only shown when the server confirmed exactly the values on screen; quality
// observations and absence notes are separate fields; a confirmed absent save discards the old
// quality draft so returning to present requires fresh scores.
import type { Answers, Criterion, Outcome } from "./scoring";
import { draftFromAnswers, validateDraft, type Draft, type DraftAnswer } from "./validation";

export type SaveState = "idle" | "unsaved" | "saving" | "saved" | "failed";

export interface ExistingAssessment {
  observed: Outcome | null; answers: Answers | null; notes: string | null; absence_reason: string | null;
  version: number; state: string;
}

export interface FormState {
  observed: Outcome | "";
  draft: Draft;
  qualityNotes: string;
  absenceNotes: string;
  reason: string;
  version: number;
  save: SaveState;
  message: string | null;
  errors: Record<string, string>;
  edits: number;                       // increments on every edit
  inFlight: { edits: number; observed: Outcome | "" } | null;
  key: { payload: string; key: string } | null;
}

export type FormAction =
  | { type: "observe"; value: Outcome | "" }
  | { type: "answer"; key: string; patch: DraftAnswer }
  | { type: "qualityNotes" | "absenceNotes" | "reason"; value: string }
  | { type: "invalid"; errors: Record<string, string>; message: string }
  | { type: "start"; payload: string; key: string }
  | { type: "success"; version: number; replayed: boolean }
  | { type: "failure"; message: string };

export function initialFormState(existing: ExistingAssessment | null): FormState {
  const cleared = !existing || existing.state === "cleared";
  const absent = !cleared && existing.observed === "absent";
  return {
    observed: cleared ? "" : existing.observed ?? "",
    draft: cleared || absent ? {} : draftFromAnswers(existing.answers),
    qualityNotes: cleared || absent ? "" : existing.notes ?? "",
    absenceNotes: absent ? existing.absence_reason ?? "" : "",
    reason: "", version: existing?.version ?? 0, save: "idle", message: null, errors: {}, edits: 0,
    inFlight: null, key: null,
  };
}

const edited = (s: FormState, patch: Partial<FormState>): FormState => ({
  ...s, ...patch, edits: s.edits + 1, message: s.save === "saving" ? s.message : null,
  save: s.save === "saving" ? "saving" : "unsaved",
});

export function formReducer(s: FormState, a: FormAction): FormState {
  switch (a.type) {
    case "observe": return edited(s, { observed: a.value });
    case "answer": return edited(s, { draft: { ...s.draft, [a.key]: { ...s.draft[a.key], ...a.patch } } });
    case "qualityNotes": return edited(s, { qualityNotes: a.value });
    case "absenceNotes": return edited(s, { absenceNotes: a.value });
    case "reason": return edited(s, { reason: a.value });
    case "invalid": return { ...s, save: "failed", errors: a.errors, message: a.message };
    case "start":
      return { ...s, save: "saving", message: null, errors: {}, key: { payload: a.payload, key: a.key },
        inFlight: { edits: s.edits, observed: s.observed } };
    case "success": {
      const sent = s.inFlight;
      const stale = !sent || sent.edits !== s.edits;
      const base: FormState = { ...s, version: a.version, inFlight: null };
      if (stale) {
        return { ...base, save: "unsaved", message: `Version ${a.version} saved, but you changed entries since. Save again to keep them.` };
      }
      // The server stored only what was sent: an absent save drops the old quality draft (so
      // returning to present needs fresh scores); a present save drops any absence note.
      const cleaned = sent.observed === "absent" ? { draft: {}, qualityNotes: "" } : { absenceNotes: "" };
      return { ...base, ...cleaned, save: "saved",
        message: a.replayed ? "Saved (confirmed earlier attempt)." : `Saved as version ${a.version}.` };
    }
    case "failure": return { ...s, save: "failed", message: a.message, inFlight: null };
  }
}

export interface Submission { observed: Outcome | null; answers: Answers | null; notes: string | null; reason: string | null }

// Builds what is sent to the server. Absent sends only the absence note; present sends only the
// quality observations. Nothing from the other mode leaks into the payload.
export function buildSubmission(s: FormState, criteria: Criterion[], amend: boolean):
  { ok: true; body: Submission } | { ok: false; errors: Record<string, string>; message: string } {
  const absent = s.observed === "absent";
  let answers: Answers | null = null;
  if (!absent) {
    const v = validateDraft(criteria, s.draft);
    if (!v.ok) return { ok: false, errors: v.errors, message: "Complete the highlighted criteria. Nothing was saved." };
    answers = v.answers;
  }
  if (amend && !s.reason.trim()) return { ok: false, errors: {}, message: "A reason is required for an amendment. Nothing was saved." };
  return { ok: true, body: {
    observed: s.observed || null, answers,
    notes: (absent ? s.absenceNotes : s.qualityNotes).trim() || null,
    reason: amend ? s.reason.trim() : null,
  } };
}

// Same payload => same idempotency key, so a retry after a lost response cannot double-save.
export function idempotencyKeyFor(prev: FormState["key"], payload: string, fresh: () => string): string {
  return prev?.payload === payload ? prev.key : fresh();
}
