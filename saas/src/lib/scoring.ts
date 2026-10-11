// Shared SAVOUR calculation module. The dashboard, session report, PDF and CSV all call these
// functions on the same inputs (an approved snapshot or the provisional live inputs), so they
// cannot disagree. Pure: no I/O, no rounding until display.
//
// Formulas: every snapshot carries the label of the calculation applied at approval.
// * savour-m1.1 (Milestone 1 snapshots, never rewritten).
// * savour-m2.1 (Milestone 2): identical arithmetic. It adds disclosures only: per-subject
//   waived_assessors/waivers/restored, removed_subjects and session.is_sample. A waiver excuses a
//   missing response for approval but never counts as a response: the subject stays incomplete
//   (no quality/combined headline, excluded from averages) and coverage stays incomplete.
//   Missing m2.1 fields read as zero/empty, so an m1.1-shaped input computes identically.
// * savour-m3.1 (Milestone 3): identical arithmetic again. Adds disclosures only: session.location_id,
//   template.pack/settings, per-subject category_id/category_name/subject_type as recorded at
//   approval, findings[] and actions[] (state at approval). Criteria may carry versioned trigger
//   settings (critical, trigger_at_or_below) which never affect any score.
// Unknown labels are refused (UnknownFormulaError), never silently recomputed.

export type AttendanceMode = "off" | "presence" | "scored";
export type Outcome =
  | "unknown" | "early" | "middle" | "late" | "present" | "absent" | "assessed" | "not_assessed";

export interface Criterion {
  key: string; label: string; guidance?: string | null; allow_na: boolean;
  critical?: boolean;                     // m3: versioned finding trigger settings; never used in arithmetic
  trigger_at_or_below?: number;
}
export type Answer = number | { na: string };
export type Answers = Record<string, Answer>;

export interface AssessmentInput {
  assessor_label: string;
  assessor_id?: string;
  observed_attendance: Outcome | null;
  answers: Answers | null;
  notes: string | null;
  absence_reason?: string | null;
  na_confirmed: boolean;
  version: number;
}

export interface WaiverInput {
  assessor_id?: string;
  assessor_label: string;
  reason: string;
  waived_at: string;
  waived_by_label?: string;
}

export interface SubjectInput {
  subject_id: string;
  name: string;
  outcome: Outcome;
  outcome_reason: string | null;
  required_assessors: number;
  assessments: AssessmentInput[];
  waived_assessors?: number;              // m2.1: waived assignments still without a response
  waivers?: WaiverInput[];                // m2.1
  restored?: { restored_at: string; reason: string | null } | null;  // m2.1
  // m3.1: directory values at approval. A missing key means "not recorded" (legacy snapshot); a
  // present null category_id means the subject had no category at approval.
  category_id?: string | null;
  category_name?: string | null;
  subject_type?: string;
}

export interface RemovedSubjectInput {
  subject_id: string; name: string; removed_at: string; reason: string | null; retained_responses: number;
}

export type Severity = "critical" | "high" | "medium" | "low";
export type ActionStatus = "open" | "in_progress" | "ready_for_verification" | "closed" | "cancelled";

// m3.1: findings and action state frozen at approval (assignee identities removed when redacted).
export interface FindingSnapshot {
  finding_id: string; subject_id: string; kind: "generated" | "manual"; criterion_key: string | null;
  severity: Severity; title: string; detail: Record<string, unknown>; revision: number; withdrawn?: boolean; created_at: string;
}
export interface ActionSnapshot {
  action_id: string; finding_id: string; subject_id: string; severity: Severity; status: ActionStatus; issue: string;
  action_required: string; due_date: string; assignee_id?: string; assignee_label: string;
  resolution_evidence: string | null; resolved_at: string | null; verified_at: string | null; cancel_reason: string | null;
  reopen_count: number; created_at: string; updated_at: string; version: number;
}

export interface ReportInputs {
  formula_version: string;
  workspace: { name: string; timezone: string };
  session: {
    id: string; name: string; local_date: string; location: string; revision: number;
    opens_at: string; closes_at: string; expected_ready_time: string | null;
    is_sample?: boolean;                  // m2.1
    location_id?: string;                 // m3.1
  };
  template: {
    id: string; version_id: string; name: string; version: number;
    attendance_mode: AttendanceMode; criteria: Criterion[];
    pack?: string;                        // m3.1
    settings?: { repeat_window?: number };  // m3.1
  };
  subjects: SubjectInput[];
  removed_subjects?: RemovedSubjectInput[];  // m2.1
  findings?: FindingSnapshot[];             // m3.1
  actions?: ActionSnapshot[];               // m3.1
  redacted?: boolean;
}

export const FORMULA_VERSION = "savour-m3.1";
export const KNOWN_FORMULAS = ["savour-m1.1", "savour-m2.1", "savour-m3.1"] as const;

export class UnknownFormulaError extends Error {
  constructor(public formula: string) {
    super(`Unknown calculation formula "${formula}". These results cannot be shown until SAVOUR supports it.`);
    this.name = "UnknownFormulaError";
  }
}

export function isKnownFormula(f: string | null | undefined): boolean {
  return (KNOWN_FORMULAS as readonly string[]).includes(f ?? "");
}

export function assertKnownFormula(inputs: Pick<ReportInputs, "formula_version">): void {
  if (!isKnownFormula(inputs.formula_version)) throw new UnknownFormulaError(String(inputs.formula_version));
}

export const isSampleInputs = (r: ReportInputs) => r.session?.is_sample === true;
export const ATTENDANCE_POINTS: Partial<Record<Outcome, number>> = { early: 5, middle: 3, late: 1, absent: 0 };
export const PRESENT_OUTCOMES: Outcome[] = ["early", "middle", "late", "present"];
export const OUTCOME_LABELS: Record<Outcome, string> = {
  unknown: "Unknown", early: "Early and ready", middle: "Around expected time", late: "Late",
  present: "Present", absent: "Absent", assessed: "Assessed", not_assessed: "Not assessed",
};

export function outcomesFor(mode: AttendanceMode): Outcome[] {
  if (mode === "scored") return ["early", "middle", "late", "absent"];
  if (mode === "presence") return ["present", "absent"];
  return ["assessed", "not_assessed"];
}

const isNa = (a: Answer | undefined): a is { na: string } => typeof a === "object" && a !== null;

export interface AssessmentResult {
  complete: boolean;          // every criterion answered validly
  applicable: number;         // scored criteria (excludes N/A)
  total: number;              // criteria in the template
  points: number;
  pct: number | null;         // null when incomplete or all N/A
  applicableKeys: string[];
  hasNa: boolean;
}

export function scoreAssessment(criteria: Criterion[], answers: Answers | null): AssessmentResult {
  const empty = { complete: false, applicable: 0, total: criteria.length, points: 0, pct: null, applicableKeys: [], hasNa: false };
  if (!answers) return empty;
  let points = 0;
  const keys: string[] = [];
  let hasNa = false;
  for (const c of criteria) {
    const a = answers[c.key];
    if (isNa(a)) {
      if (!c.allow_na || !a.na.trim()) return empty;
      hasNa = true;
    } else if (typeof a === "number" && Number.isInteger(a) && a >= 1 && a <= 5) {
      points += a;
      keys.push(c.key);
    } else {
      return empty;
    }
  }
  const pct = keys.length ? (points / (5 * keys.length)) * 100 : null;
  return { complete: true, applicable: keys.length, total: criteria.length, points, pct, applicableKeys: keys, hasNa };
}

export type SubjectStatus =
  | "scored" | "absent" | "not_assessed" | "all_na" | "mixed_na" | "incomplete" | "unknown" | "attendance_only";

// Statuses where every required response is present (used for coverage).
export const COMPLETE_STATUSES: SubjectStatus[] = ["scored", "all_na", "mixed_na", "attendance_only"];

export interface SubjectResult {
  subjectId: string;
  name: string;
  outcome: Outcome;
  outcomeReason: string | null;
  status: SubjectStatus;
  attendancePoints: number | null;
  quality: number | null;        // only when status is "scored" (complete, comparable, outcome recorded)
  combined: number | null;       // same, scored readiness only
  assessorsScored: number;
  requiredAssessors: number;
  completeResponses: number;     // complete responses from assigned assessors
  missingResponses: number;      // required minus complete (waived work stays missing)
  waivedAssessors: number;       // of the missing responses, how many were explicitly waived
  waivers: WaiverInput[];
  restored: SubjectInput["restored"];
  applicabilitySets: string[];   // distinct applicable criterion sets among scored assessments
  comparable: boolean;           // false when assessors used different N/A patterns
  meanApplicable: number;
  assessments: (AssessmentInput & { result: AssessmentResult })[];
}

export function scoreSubject(template: ReportInputs["template"], subject: SubjectInput): SubjectResult {
  const mode = template.attendance_mode;
  const criteria = template.criteria;
  const attendancePoints = mode === "scored" ? (ATTENDANCE_POINTS[subject.outcome] ?? null) : null;
  const assessments = subject.assessments.map((a) => ({ ...a, result: scoreAssessment(criteria, a.answers) }));
  const completeResponses = assessments.filter((a) => a.result.complete).length;
  const base = {
    subjectId: subject.subject_id, name: subject.name, outcome: subject.outcome,
    outcomeReason: subject.outcome_reason, attendancePoints, requiredAssessors: subject.required_assessors,
    assessments, quality: null, combined: null, assessorsScored: 0, applicabilitySets: [],
    comparable: true, meanApplicable: 0, completeResponses,
    missingResponses: Math.max(0, subject.required_assessors - completeResponses),
    waivedAssessors: subject.waived_assessors ?? 0, waivers: subject.waivers ?? [], restored: subject.restored ?? null,
  };
  // Absence / not assessed: attendance (if scored) counts once; quality and combined do not exist.
  if (subject.outcome === "absent") return { ...base, status: "absent" };
  if (subject.outcome === "not_assessed") return { ...base, status: "not_assessed" };
  if (criteria.length === 0) {
    return { ...base, status: subject.outcome === "unknown" ? "unknown" : "attendance_only" };
  }
  const complete = assessments.filter((a) => a.result.complete);
  const scored = complete.filter((a) => a.result.pct !== null);
  const sets = [...new Set(complete.map((a) => a.result.applicableKeys.join(",")))];
  const detail = { assessorsScored: scored.length, applicabilitySets: sets, comparable: sets.length <= 1 };
  // Headline numbers exist only for a fully resolved, like-for-like subject. Partial or mixed
  // results stay visible per assessor but never feed quality, combined or any total.
  if (subject.outcome === "unknown") return { ...base, ...detail, status: "unknown" };
  if (complete.length < subject.required_assessors || complete.length === 0) return { ...base, ...detail, status: "incomplete" };
  if (sets.length > 1) return { ...base, ...detail, status: "mixed_na" };
  if (scored.length === 0) return { ...base, ...detail, status: "all_na" };
  // Quality is aggregated across assessors first (equal weight per assessor) ...
  const quality = scored.reduce((sum, a) => sum + (a.result.pct as number), 0) / scored.length;
  const meanApplicable = scored[0].result.applicable;
  // ... then the single canonical attendance component is added once.
  let combined: number | null = null;
  if (mode === "scored" && attendancePoints !== null) {
    const qMax = 5 * meanApplicable;
    combined = (((quality / 100) * qMax + attendancePoints) / (qMax + 5)) * 100;
  }
  return { ...base, ...detail, status: "scored", quality, combined, meanApplicable };
}

export interface SessionSummary {
  inputs: ReportInputs;
  isSample: boolean;
  attendanceOnly: boolean;       // template has no quality criteria
  removed: RemovedSubjectInput[];
  subjects: SubjectResult[];
  outcomeCounts: Partial<Record<Outcome, number>>;
  attendance: null | { confirmed: number; present: number; unknown: number; rate: number | null; avgPoints: number | null };
  coverage: { complete: number; due: number; excludedAbsent: number; pct: number | null; waivedSubjects: number; waivedResponses: number };
  quality: { mean: number | null; included: number; excludedMixed: number };
  combined: { mean: number | null; included: number };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarizeSession(inputs: ReportInputs): SessionSummary {
  assertKnownFormula(inputs);
  const mode = inputs.template.attendance_mode;
  const subjects = inputs.subjects.map((s) => scoreSubject(inputs.template, s));
  const outcomeCounts: Partial<Record<Outcome, number>> = {};
  for (const s of subjects) outcomeCounts[s.outcome] = (outcomeCounts[s.outcome] ?? 0) + 1;

  let attendance: SessionSummary["attendance"] = null;
  if (mode !== "off") {
    const confirmed = subjects.filter((s) => s.outcome !== "unknown");
    const present = confirmed.filter((s) => PRESENT_OUTCOMES.includes(s.outcome)).length;
    attendance = {
      confirmed: confirmed.length, present, unknown: subjects.length - confirmed.length,
      rate: confirmed.length ? (present / confirmed.length) * 100 : null,
      avgPoints: mode === "scored" ? mean(confirmed.map((s) => s.attendancePoints ?? 0)) : null,
    };
  }
  // Coverage: confirmed absence leaves the due denominator only where attendance gating applies.
  const excludedAbsent = mode === "off" ? 0 : subjects.filter((s) => s.outcome === "absent").length;
  const due = subjects.length - excludedAbsent;
  const complete = subjects.filter((s) => COMPLETE_STATUSES.includes(s.status)).length;

  // Waived work is disclosed, never counted complete.
  const waived = subjects.filter((s) => s.status === "incomplete" && s.waivedAssessors > 0);
  const scored = subjects.filter((s) => s.status === "scored");
  return {
    inputs, subjects, outcomeCounts, attendance,
    isSample: isSampleInputs(inputs), attendanceOnly: inputs.template.criteria.length === 0,
    removed: inputs.removed_subjects ?? [],
    coverage: {
      complete, due, excludedAbsent, pct: due ? (complete / due) * 100 : null,
      waivedSubjects: waived.length, waivedResponses: waived.reduce((n, s) => n + s.waivedAssessors, 0),
    },
    quality: {
      mean: mean(scored.map((s) => s.quality as number)), included: scored.length,
      excludedMixed: subjects.filter((s) => s.status === "mixed_na").length,
    },
    combined: {
      mean: mean(scored.filter((s) => s.combined !== null).map((s) => s.combined as number)),
      included: scored.filter((s) => s.combined !== null).length,
    },
  };
}

export interface TemplateRollup {
  templateVersionId: string;
  label: string;
  attendanceMode: AttendanceMode;
  sessions: number;
  subjectSessions: number;
  quality: number | null;
  combined: number | null;
  attendanceRate: number | null;
}

// Business totals never include samples. get_dashboard already excludes them in SQL; this is a
// second, client-side guard so a sample can never contaminate a rollup.
export function businessReports(reports: ReportInputs[]): ReportInputs[] {
  return reports.filter((r) => !isSampleInputs(r));
}

// Dashboard rollup: like-for-like only (one template version per row), equal weight per subject-session.
// Samples are dropped. Unknown formulas throw (the caller shows the problem instead of numbers).
export function rollupByTemplate(reports: ReportInputs[]): TemplateRollup[] {
  const groups = new Map<string, SessionSummary[]>();
  for (const r of businessReports(reports)) {
    const list = groups.get(r.template.version_id) ?? [];
    list.push(summarizeSession(r));
    groups.set(r.template.version_id, list);
  }
  return [...groups.entries()].map(([id, list]) => {
    const t = list[0].inputs.template;
    const subjects = list.flatMap((l) => l.subjects);
    const scored = subjects.filter((s) => s.status === "scored");
    const confirmed = list.reduce((n, l) => n + (l.attendance?.confirmed ?? 0), 0);
    const present = list.reduce((n, l) => n + (l.attendance?.present ?? 0), 0);
    return {
      templateVersionId: id, label: `${t.name} v${t.version}`, attendanceMode: t.attendance_mode,
      sessions: list.length, subjectSessions: subjects.length,
      quality: mean(scored.map((s) => s.quality as number)),
      combined: mean(scored.filter((s) => s.combined !== null).map((s) => s.combined as number)),
      attendanceRate: t.attendance_mode === "off" || !confirmed ? null : (present / confirmed) * 100,
    };
  });
}

export function formatPct(n: number | null | undefined, empty = "Not assessed"): string {
  if (n === null || n === undefined || Number.isNaN(n)) return empty;
  return `${(Math.round(n * 10) / 10).toFixed(1)}%`;
}

export function subjectStatusLabel(s: SubjectResult): string {
  switch (s.status) {
    case "absent": return "Absent — quality not assessed";
    case "not_assessed": return "Not assessed";
    case "all_na": return "Not assessed (all criteria N/A)";
    case "mixed_na": return "Not comparable — assessors used different N/A criteria";
    case "incomplete":
      return s.waivedAssessors > 0
        ? `Incomplete — ${s.missingResponses} of ${s.requiredAssessors} response(s) missing (${s.waivedAssessors} waived)`
        : `Incomplete — ${s.missingResponses} of ${s.requiredAssessors} response(s) missing`;
    case "unknown": return "Outcome not recorded";
    case "attendance_only": return "Attendance only";
    default: return "Scored";
  }
}

// Review aids (pure, no schema): completeness, attendance disagreement and score spread per subject.
export interface ReviewSignals {
  required: number;
  complete: number;
  waived: number;
  missing: number;
  attendanceDisagreement: Outcome[];       // distinct observed outcomes when assessors disagree
  spread: number | null;                   // max - min assessment quality %, only when like-for-like
  naPatternsDiffer: boolean;               // complete responses used different N/A (applicability) sets
  criterionSpread: { key: string; label: string; min: number; max: number }[];  // gaps of 2+ points
}

export const SPREAD_ATTENTION_PCT = 20;

export function reviewSignals(template: Pick<ReportInputs["template"], "criteria">, s: SubjectResult): ReviewSignals {
  const observed = [...new Set(s.assessments.map((a) => a.observed_attendance).filter((o): o is Outcome => !!o))];
  // An aggregate percentage spread is only like-for-like when every complete response scored the
  // same set of criteria. With different N/A patterns the denominators differ, so no aggregate
  // spread is reported; the per-criterion comparison below still uses the numeric answers that
  // assessors actually share.
  const complete = s.assessments.filter((a) => a.result.complete);
  const naPatternsDiffer = new Set(complete.map((a) => a.result.applicableKeys.join(","))).size > 1;
  const pcts = complete.map((a) => a.result.pct).filter((p): p is number => p !== null);
  const criterionSpread = template.criteria.flatMap((c) => {
    const vals = s.assessments.map((a) => a.answers?.[c.key]).filter((v): v is number => typeof v === "number");
    if (vals.length < 2) return [];
    const min = Math.min(...vals), max = Math.max(...vals);
    return max - min >= 2 ? [{ key: c.key, label: c.label, min, max }] : [];
  });
  return {
    required: s.requiredAssessors, complete: s.completeResponses, waived: s.waivedAssessors, missing: s.missingResponses,
    attendanceDisagreement: observed.length > 1 ? observed : [],
    spread: !naPatternsDiffer && pcts.length > 1 ? Math.max(...pcts) - Math.min(...pcts) : null,
    naPatternsDiffer,
    criterionSpread,
  };
}
