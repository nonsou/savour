// Report envelope returned by public.get_session_report, plus shared presentation helpers and
// the CSV export. UI, PDF and CSV all derive numbers from summarizeSession() on envelope.inputs.
import { toCsv } from "./csv";
import { ACTION_STATUS_LABELS, DUE_STATE_LABELS, SEVERITY_LABELS } from "./labels";
import {
  formatPct, isKnownFormula, isSampleInputs, OUTCOME_LABELS, rollupByTemplate, summarizeSession, subjectStatusLabel,
  type ActionSnapshot, type ActionStatus, type ReportInputs, type SessionSummary, type Severity,
} from "./scoring";

export interface ReportMeta {
  status: "approved" | "provisional";
  revision: number;
  report_id?: string;
  approved_at?: string;
  approver_name?: string;
  formula_version: string;
  inputs_hash?: string;
  is_current: boolean;
  redacted: boolean;
  session_status: string;
  session_revision: number;
  reopen_reason: string | null;
  actions_snapshot?: ActionsSnapshotState;   // Milestone 3
  workspace_id?: string;                      // Milestone 3: lets routes check the business in the URL
}

// frozen: the viewed approval froze action state (m3.1). not_recorded: an earlier approval that
// froze none. provisional: nothing is approved; actions shown are live.
export type ActionsSnapshotState = "frozen" | "not_recorded" | "provisional";

export interface AppendixAction {
  action_id: string; finding_id: string; subject_id: string; subject_name: string; severity: Severity; status: ActionStatus;
  issue: string; action_required: string; due_date: string; due_state: string; assignee_label: string;
  resolution_evidence: string | null; resolved_at: string | null; verified_at: string | null; cancel_reason: string | null;
  reopen_count: number; created_at: string; updated_at: string; version: number;
  in_snapshot: boolean | null; snapshot_status: ActionStatus | null; changed_since_snapshot: boolean | null; created_after_snapshot: boolean | null;
}

// Live state of this session's actions and findings, dated by the server clock. Never part of the
// approved evidence; compared with the frozen action IDs/versions of the revision being viewed.
export interface ActionsAppendix {
  as_of: string; today: string; snapshot: ActionsSnapshotState; snapshot_approved_at: string | null; snapshot_revision: number | null;
  redacted: boolean; actions: AppendixAction[];
  findings: { finding_id: string; subject_id: string; subject_name: string; kind: string; severity: Severity; title: string;
    revision: number; state: string; withdrawn_at: string | null; created_at: string; in_snapshot: boolean | null }[];
}

export interface ReportEnvelope {
  meta: ReportMeta;
  inputs: ReportInputs;
  actions_appendix?: ActionsAppendix;          // Milestone 3
  revisions: { revision: number; approved_at: string; approver_name: string }[];
}

export type ApprovedReport = { session_id: string; revision: number; approved_at: string; inputs: ReportInputs };

export interface Dashboard {
  approved: ApprovedReport[];
  under_revision: { session_id: string; name: string; local_date: string; revision: number; reason: string | null; status?: string }[];
}

// Business figures use known-formula, non-sample reports only. get_dashboard already excludes
// samples in SQL; this second guard keeps a sample (or an unsupported formula) out of any total.
export function partitionReports(approved: ApprovedReport[]) {
  return {
    business: approved.filter((r) => !isSampleInputs(r.inputs) && isKnownFormula(r.inputs.formula_version)),
    samples: approved.filter((r) => isSampleInputs(r.inputs)),
    unsupported: approved.filter((r) => !isSampleInputs(r.inputs) && !isKnownFormula(r.inputs.formula_version)),
  };
}

export interface OverviewMetrics { approved: number; subjectsScored: number; underRevision: number }

// Null when the dashboard could not be loaded: callers must show "unavailable", never zeros.
export function overviewMetrics(dash: Dashboard | null | undefined): OverviewMetrics | null {
  if (!dash || !Array.isArray(dash.approved) || !Array.isArray(dash.under_revision)) return null;
  const { business } = partitionReports(dash.approved);
  const scored = new Set(business.flatMap((r) =>
    summarizeSession(r.inputs).subjects.filter((x) => x.status === "scored").map((x) => x.subjectId)));
  return { approved: business.length, subjectsScored: scored.size, underRevision: dash.under_revision.length };
}

// Setup checklist source: public.get_setup_progress (Owner/Admin). Counts exclude samples in SQL.
export interface SetupProgress {
  locations: number; categories: number; subjects: number; templates: number; reviewers: number;
  sessions: number; opened: number; approved: number;
  samples: { sessions: number; approved: number; latest_session_id: string | null };
}

export interface SetupStep { key: string; label: string; done: boolean; href: string; optional?: boolean }

export function setupSteps(p: SetupProgress, ws: string): SetupStep[] {
  return [
    { key: "location", label: "Add a location", done: p.locations > 0, href: `/w/${ws}/setup` },
    { key: "template", label: "Install a starter pack or publish a template", done: p.templates > 0, href: `/w/${ws}/templates` },
    { key: "subjects", label: "Add subjects (one at a time or by CSV import)", done: p.subjects > 0, href: `/w/${ws}/setup` },
    { key: "sample", label: "Try a practice inspection (SAMPLE, never counted)", done: p.samples.sessions > 0, href: `/w/${ws}`, optional: true },
    { key: "reviewer", label: "Invite a reviewer", done: p.reviewers > 0, href: `/w/${ws}/team`, optional: true },
    { key: "session", label: "Create and open a real session", done: p.opened > 0, href: `/w/${ws}/sessions/new` },
    { key: "approved", label: "Approve your first real report", done: p.approved > 0, href: `/w/${ws}/sessions` },
  ];
}

// Setup checklist from count queries; a failed count is null (unknown), not "nothing created yet".
export function setupChecklist(counts: (number | null)[]): { known: boolean; incomplete: boolean } {
  const known = counts.every((c) => c !== null);
  return { known, incomplete: known && counts.some((c) => c === 0) };
}

// Dashboard CSV: one row per approved current session plus the like-for-like template rollup.
export function buildDashboardCsv(dash: Dashboard, workspace: { name: string; timezone: string }, generatedAt = new Date()): string {
  const { business, unsupported } = partitionReports(dash.approved);
  const rows: (string | number | null)[][] = [
    ["SAVOUR dashboard export"], ["Business", workspace.name], ["Timezone", workspace.timezone],
    ["Filters", "Approved current revisions only; sessions under revision and SAMPLE practice sessions excluded"],
    ["Generated at", formatDateTime(generatedAt.toISOString(), workspace.timezone)], [],
    ["Template version", "Sessions", "Subject-sessions", "Mean quality %", "Mean combined %", "Attendance rate %"],
  ];
  for (const r of rollupByTemplate(business.map((a) => a.inputs))) {
    rows.push([r.label, r.sessions, r.subjectSessions, round1(r.quality), round1(r.combined), round1(r.attendanceRate)]);
  }
  rows.push([], ["Session", "Date", "Location", "Template", "Revision", "Approved at", "Mean quality %", "Coverage complete", "Coverage due",
    "Subjects with waived responses"]);
  for (const a of business) {
    const s = summarizeSession(a.inputs);
    rows.push([a.inputs.session.name, a.inputs.session.local_date, a.inputs.session.location,
      `${a.inputs.template.name} v${a.inputs.template.version}`, a.revision, formatDateTime(a.approved_at, workspace.timezone),
      s.attendanceOnly ? null : round1(s.quality.mean), s.coverage.complete, s.coverage.due, s.coverage.waivedSubjects]);
  }
  for (const a of unsupported) {
    rows.push([a.inputs.session.name, a.inputs.session.local_date, "", "", a.revision, "",
      `Not shown: unsupported formula ${a.inputs.formula_version}`]);
  }
  return toCsv(rows);
}

export function formatDateTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const text = new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(d);
  return `${text} (${timeZone})`;
}

export function formatLocalDate(date: string): string {
  // local_date is a calendar date; anchor at noon UTC so no timezone shifts the day.
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", dateStyle: "medium" }).format(new Date(`${date}T12:00:00Z`));
}

export function reportStatusLabel(meta: ReportMeta): string {
  if (meta.status === "approved") return meta.is_current ? `Approved — revision ${meta.revision}` : `Superseded approved revision ${meta.revision}`;
  return meta.session_revision > 1
    ? `Provisional — revision ${meta.revision} under review (not approved)`
    : "Provisional — not approved";
}

export const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

export function answerText(a: number | { na: string } | undefined): string {
  if (a === undefined) return "Missing";
  return typeof a === "number" ? String(a) : `N/A (${a.na})`;
}

export const SAMPLE_NOTICE = "SAMPLE — practice data. Never counted in business totals, dashboards or activation.";

export function reportHeaderRows(env: ReportEnvelope, generatedAt: Date): [string, string][] {
  const { inputs, meta } = env;
  const tz = inputs.workspace.timezone;
  return [
    ...(isSampleInputs(inputs) ? [["Sample", SAMPLE_NOTICE] as [string, string]] : []),
    ["Business", inputs.workspace.name],
    ["Session", inputs.session.name],
    ["Session date", formatLocalDate(inputs.session.local_date)],
    ["Location", inputs.session.location],
    ["Timezone", tz],
    ["Template", `${inputs.template.name} v${inputs.template.version}${inputs.template.criteria.length === 0 ? " (attendance only)" : ""}`],
    ["Attendance", inputs.template.attendance_mode === "off" ? "Off" : inputs.template.attendance_mode === "presence" ? "Presence only" : "Scored readiness (Early 5, Around expected time 3, Late 1, Absent 0)"],
    ...(inputs.session.expected_ready_time ? [["Expected ready time", `${inputs.session.expected_ready_time.slice(0, 5)} (${tz})`] as [string, string]] : []),
    ["Report", reportStatusLabel(meta)],
    ["Approved by", meta.approver_name ?? "—"],
    ["Approved at", formatDateTime(meta.approved_at, tz)],
    ["Formula", meta.formula_version],
    ["Assessor identities", meta.redacted ? "Redacted" : "Included"],
    ["Filters", `Session ${inputs.session.id}, revision ${meta.revision}`],
    ["Generated at", formatDateTime(generatedAt.toISOString(), tz)],
  ];
}

export function summaryRows(sum: SessionSummary): [string, string][] {
  const c = sum.coverage;
  const rows: [string, string][] = [
    ["Coverage", c.pct === null ? "Not applicable" : `${c.complete} of ${c.due} (${formatPct(c.pct)})${c.excludedAbsent ? `, ${c.excludedAbsent} absent excluded` : ""}`
      + (c.waivedSubjects ? `; ${c.waivedSubjects} subject(s) incomplete with ${c.waivedResponses} waived response(s) — waived work still counts as missing` : "")],
    ["Mean quality", sum.attendanceOnly ? "Not applicable (attendance-only template)"
      : `${formatPct(sum.quality.mean, "No data")} over ${sum.quality.included} subject(s)${sum.quality.excludedMixed ? `; ${sum.quality.excludedMixed} with mixed N/A sets shown separately` : ""}`],
  ];
  if (sum.removed.length) {
    rows.push(["Removed from roster", sum.removed.map((r) => `${r.name}${r.reason ? ` (${r.reason})` : ""}`).join("; ")]);
  }
  if (sum.inputs.template.attendance_mode === "scored" && !sum.attendanceOnly) {
    rows.push(["Mean combined", `${formatPct(sum.combined.mean, "No data")} over ${sum.combined.included} subject(s)`]);
  }
  if (sum.attendance) {
    rows.push(["Attendance rate", `${formatPct(sum.attendance.rate, "Not applicable")} (${sum.attendance.present} present of ${sum.attendance.confirmed} confirmed; ${sum.attendance.unknown} unknown)`]);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Findings and actions (Milestone 3): "at approval" comes only from the frozen snapshot; the
// "current" appendix comes only from the live, server-dated appendix.
// ---------------------------------------------------------------------------
export function snapshotState(env: ReportEnvelope): ActionsSnapshotState {
  if (env.meta.status !== "approved") return "provisional";
  return env.meta.actions_snapshot ?? (Array.isArray(env.inputs.actions) ? "frozen" : "not_recorded");
}

export function frozenActionsTitle(env: ReportEnvelope): string {
  const state = snapshotState(env);
  if (state === "provisional") return "Findings and actions (live, provisional — not frozen)";
  return `Findings and actions at approval (revision ${env.meta.revision}, ${formatDateTime(env.meta.approved_at, env.inputs.workspace.timezone)})`;
}

export function notRecordedNote(env: ReportEnvelope): string {
  return `No action state was frozen at this approval (formula ${env.inputs.formula_version}, approved before action snapshots existed). `
    + "Actions created later appear only in the dated current-actions appendix, never as evidence of this approval.";
}

export function appendixTitle(env: ReportEnvelope): string {
  const a = env.actions_appendix;
  return a ? `Current actions as of ${formatDateTime(a.as_of, env.inputs.workspace.timezone)} — not part of the approved evidence` : "";
}

export function appendixComparison(env: ReportEnvelope, a: AppendixAction): string {
  if (a.in_snapshot === null) return snapshotState(env) === "provisional" ? "Live (nothing approved yet)" : "Not frozen at this approval";
  if (!a.in_snapshot) return a.created_after_snapshot ? "Created after this approval" : "Not in this approval";
  return a.changed_since_snapshot ? `Changed since approval (was ${ACTION_STATUS_LABELS[a.snapshot_status ?? "open"]})` : "Unchanged since approval";
}

// One presentation of an action for every format (page, CSV, PDF) and both sections (frozen at
// approval; current appendix), so no format shows less than another.
export interface ActionLine {
  subject: string; issue: string; severity: string; status: string; due: string; assignee: string; required: string;
  evidence: string | null; verified: string | null; cancelled: string | null; reopened: string | null;
  comparison?: string; updated?: string;
}
export const ACTION_FIELDS: { key: keyof ActionLine; label: string }[] = [
  { key: "subject", label: "Subject" }, { key: "issue", label: "Issue" }, { key: "severity", label: "Severity" },
  { key: "status", label: "Status" }, { key: "due", label: "Due date" }, { key: "assignee", label: "Assignee" },
  { key: "required", label: "Action required" }, { key: "evidence", label: "Resolution evidence" }, { key: "verified", label: "Verified at" },
  { key: "cancelled", label: "Cancellation reason" }, { key: "reopened", label: "Reopened" },
];
export const APPENDIX_FIELDS: { key: keyof ActionLine; label: string }[] = [
  ...ACTION_FIELDS, { key: "comparison", label: "Compared with this approval" }, { key: "updated", label: "Last updated" },
];
// Detail fields shown under the headline in the page and PDF.
export const ACTION_DETAIL_FIELDS = ACTION_FIELDS.filter((f) => ["required", "evidence", "verified", "cancelled", "reopened"].includes(f.key));

const subjectNameIn = (inputs: ReportInputs, id: string) => inputs.subjects.find((s) => s.subject_id === id)?.name
  ?? inputs.removed_subjects?.find((s) => s.subject_id === id)?.name ?? "Subject";

export function frozenActionLine(inputs: ReportInputs, a: ActionSnapshot): ActionLine {
  const tz = inputs.workspace.timezone;
  return {
    subject: subjectNameIn(inputs, a.subject_id), issue: a.issue, severity: SEVERITY_LABELS[a.severity], status: ACTION_STATUS_LABELS[a.status],
    due: a.due_date, assignee: a.assignee_label, required: a.action_required, evidence: a.resolution_evidence,
    verified: a.verified_at ? formatDateTime(a.verified_at, tz) : null, cancelled: a.cancel_reason,
    reopened: a.reopen_count ? `${a.reopen_count} time(s)` : null,
  };
}

export function appendixActionLine(env: ReportEnvelope, a: AppendixAction): ActionLine {
  const tz = env.inputs.workspace.timezone;
  return {
    subject: a.subject_name, issue: a.issue, severity: SEVERITY_LABELS[a.severity], status: ACTION_STATUS_LABELS[a.status],
    due: a.due_state === "done" ? a.due_date : `${a.due_date} (${DUE_STATE_LABELS[a.due_state] ?? a.due_state})`, assignee: a.assignee_label,
    required: a.action_required, evidence: a.resolution_evidence, verified: a.verified_at ? formatDateTime(a.verified_at, tz) : null,
    cancelled: a.cancel_reason, reopened: a.reopen_count ? `${a.reopen_count} time(s)` : null,
    comparison: appendixComparison(env, a), updated: formatDateTime(a.updated_at, tz),
  };
}

function findingsAndActionsRows(env: ReportEnvelope): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  const nameOf = (id: string) => env.inputs.subjects.find((s) => s.subject_id === id)?.name
    ?? env.inputs.removed_subjects?.find((s) => s.subject_id === id)?.name ?? "Subject";
  rows.push([], [frozenActionsTitle(env)]);
  if (snapshotState(env) === "not_recorded") {
    rows.push(["Note", notRecordedNote(env)]);
  } else {
    const findings = env.inputs.findings ?? [];
    rows.push(["Findings"], ["Subject", "Finding", "Severity", "Source", "Revision", "Rule"]);
    if (!findings.length) rows.push(["None"]);
    for (const f of findings) {
      rows.push([nameOf(f.subject_id), f.title, SEVERITY_LABELS[f.severity], f.kind === "generated" ? "Template trigger" : "Raised by reviewer",
        f.revision, typeof f.detail?.rule === "string" ? f.detail.rule : null]);
    }
    const actions = env.inputs.actions ?? [];
    rows.push(["Actions"], ACTION_FIELDS.map((f) => f.label));
    if (!actions.length) rows.push(["None"]);
    for (const a of actions) {
      const line = frozenActionLine(env.inputs, a);
      rows.push(ACTION_FIELDS.map((f) => line[f.key] ?? null));
    }
  }
  const ap = env.actions_appendix;
  if (ap) {
    rows.push([], [appendixTitle(env)]);
    rows.push(["Note", "Live state read when this file was generated. Free-text issue and evidence may contain names; review before sharing."]);
    rows.push(APPENDIX_FIELDS.map((f) => f.label));
    if (!ap.actions.length) rows.push(["None"]);
    for (const a of ap.actions) {
      const line = appendixActionLine(env, a);
      rows.push(APPENDIX_FIELDS.map((f) => line[f.key] ?? null));
    }
  }
  return rows;
}

export function buildCsv(env: ReportEnvelope, generatedAt = new Date()): string {
  const sum = summarizeSession(env.inputs);
  const criteria = env.inputs.template.criteria;
  const rows: (string | number | null)[][] = [["SAVOUR session report"]];
  for (const [k, v] of reportHeaderRows(env, generatedAt)) rows.push([k, v]);
  rows.push(["Note", "Free-text notes may contain names; review before sharing."]);
  rows.push([]);
  for (const [k, v] of summaryRows(sum)) rows.push([k, v]);
  rows.push([]);
  rows.push(["Subject", "Outcome", "Outcome reason", "Attendance points", "Quality %", "Combined %",
    "Assessors scored", "Required assessors", "Applicable criteria sets", "Status", "Missing responses", "Waived responses"]);
  for (const s of sum.subjects) {
    rows.push([s.name, OUTCOME_LABELS[s.outcome], s.outcomeReason, s.attendancePoints, round1(s.quality),
      round1(s.combined), s.assessorsScored, s.requiredAssessors, s.applicabilitySets.length, subjectStatusLabel(s),
      s.status === "incomplete" ? s.missingResponses : 0, s.waivedAssessors]);
  }
  const waivers = sum.subjects.flatMap((s) => s.waivers.map((w) => [s.name, w.assessor_label, w.reason, w.waived_at] as const));
  if (waivers.length) {
    rows.push([], ["Waived responses (still counted as missing)"], ["Subject", "Assessor", "Reason", "Waived at"]);
    for (const [name, who, reason, at] of waivers) rows.push([name, who, reason, formatDateTime(at, env.inputs.workspace.timezone)]);
  }
  if (sum.removed.length) {
    rows.push([], ["Removed from roster (not in totals)"], ["Subject", "Reason", "Removed at", "Retained responses"]);
    for (const r of sum.removed) rows.push([r.name, r.reason, formatDateTime(r.removed_at, env.inputs.workspace.timezone), r.retained_responses]);
  }
  rows.push([]);
  rows.push(["Subject", "Assessor", "Observed attendance", "Criterion", "Answer", "Assessment quality %", "Notes", "Absence reason"]);
  for (const s of sum.subjects) {
    for (const a of s.assessments) {
      const obs = a.observed_attendance ? OUTCOME_LABELS[a.observed_attendance] : "";
      if (!a.answers || criteria.length === 0) {
        rows.push([s.name, a.assessor_label, obs, "", "", null, a.notes, a.absence_reason ?? null]);
        continue;
      }
      for (const c of criteria) {
        rows.push([s.name, a.assessor_label, obs, c.label, answerText(a.answers[c.key]), round1(a.result.pct), a.notes, a.absence_reason ?? null]);
      }
    }
  }
  rows.push(...findingsAndActionsRows(env));
  return toCsv(rows);
}

export function exportFilename(env: ReportEnvelope, ext: "csv" | "pdf"): string {
  const safe = env.inputs.session.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";
  const tag = env.meta.status === "approved" ? `r${env.meta.revision}` : `r${env.meta.revision}-provisional`;
  return `savour-${isSampleInputs(env.inputs) ? "SAMPLE-" : ""}${safe}-${env.inputs.session.local_date}-${tag}${env.meta.redacted ? "-redacted" : ""}.${ext}`;
}
