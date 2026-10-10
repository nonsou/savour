import type { AssessmentInput, AttendanceMode, Criterion, Outcome, ReportInputs, SubjectInput } from "@/lib/scoring";

export const TWO: Criterion[] = [
  { key: "taste", label: "Taste", allow_na: false },
  { key: "hygiene", label: "Hygiene", allow_na: true },
];

export function assessment(answers: AssessmentInput["answers"], label = "Assessor 1", extra: Partial<AssessmentInput> = {}): AssessmentInput {
  return { assessor_label: label, observed_attendance: null, answers, notes: null, na_confirmed: true, version: 1, ...extra };
}

export function subject(outcome: Outcome, assessments: AssessmentInput[], extra: Partial<SubjectInput> = {}): SubjectInput {
  return {
    subject_id: extra.subject_id ?? `s-${outcome}-${assessments.length}`, name: extra.name ?? "Vendor One",
    outcome, outcome_reason: null, required_assessors: assessments.length, assessments, ...extra,
  };
}

export function inputs(mode: AttendanceMode, subjects: SubjectInput[], criteria = TWO, versionId = "tv1"): ReportInputs {
  return {
    formula_version: "savour-m1.1",
    workspace: { name: "Same Name Foods", timezone: "Africa/Lagos" },
    session: {
      id: "sess-1", name: "Saturday panel", local_date: "2026-10-10", location: "Main Site", revision: 1,
      opens_at: "2026-10-10T08:00:00Z", closes_at: "2026-10-12T08:00:00Z",
      expected_ready_time: mode === "scored" ? "09:00:00" : null,
    },
    template: { id: "t1", version_id: versionId, name: "Food panel", version: 1, attendance_mode: mode, criteria },
    subjects,
  };
}
