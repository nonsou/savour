// Client-side mirror of private.validate_answers / validate_criteria. The database remains the
// authority; this only gives immediate, field-level feedback before a save is attempted.
import type { Answers, Criterion } from "./scoring";

export interface DraftAnswer { score?: number | null; na?: boolean; reason?: string }
export type Draft = Record<string, DraftAnswer>;

export function validateDraft(criteria: Criterion[], draft: Draft):
  { ok: true; answers: Answers } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const answers: Answers = {};
  for (const c of criteria) {
    const d = draft[c.key] ?? {};
    if (d.na) {
      if (!c.allow_na) errors[c.key] = "N/A is not allowed for this criterion.";
      else if (!d.reason?.trim()) errors[c.key] = "Give a reason for N/A.";
      else answers[c.key] = { na: d.reason.trim() };
    } else if (typeof d.score === "number" && Number.isInteger(d.score) && d.score >= 1 && d.score <= 5) {
      answers[c.key] = d.score;
    } else {
      errors[c.key] = "Choose a score from 1 to 5.";
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, answers };
}

export function draftFromAnswers(answers: Answers | null): Draft {
  const draft: Draft = {};
  for (const [k, v] of Object.entries(answers ?? {})) {
    draft[k] = typeof v === "number" ? { score: v } : { na: true, reason: v.na };
  }
  return draft;
}

const KEY = /^[a-z][a-z0-9_]{0,39}$/;

export function slugKey(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return /^[a-z]/.test(s) ? s : `c_${s}`.slice(0, 40);
}

export function validateCriteria(criteria: Criterion[], scoredAttendance: boolean): string | null {
  if (criteria.length === 0 && !scoredAttendance) return "Add at least one criterion or use scored attendance.";
  if (criteria.length > 25) return "Use at most 25 criteria.";
  const seen = new Set<string>();
  for (const c of criteria) {
    if (!KEY.test(c.key)) return `Invalid key "${c.key}".`;
    if (seen.has(c.key)) return `Duplicate criterion "${c.label}".`;
    if (!c.label.trim() || c.label.length > 80) return "Each criterion needs a label (max 80 characters).";
    seen.add(c.key);
  }
  return null;
}
