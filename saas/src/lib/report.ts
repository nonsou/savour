// Report envelope returned by public.get_session_report, plus shared presentation helpers and
// the CSV export. UI, PDF and CSV all derive numbers from summarizeSession() on envelope.inputs.
import { toCsv } from "./csv";
import {
  formatPct, OUTCOME_LABELS, rollupByTemplate, summarizeSession, subjectStatusLabel,
  type ReportInputs, type SessionSummary,
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
}

export interface ReportEnvelope {
  meta: ReportMeta;
  inputs: ReportInputs;
  revisions: { revision: number; approved_at: string; approver_name: string }[];
}

export interface Dashboard {
  approved: { session_id: string; revision: number; approved_at: string; inputs: ReportInputs }[];
  under_revision: { session_id: string; name: string; local_date: string; revision: number; reason: string | null }[];
}

export interface OverviewMetrics { approved: number; subjectsScored: number; underRevision: number }

// Null when the dashboard could not be loaded: callers must show "unavailable", never zeros.
export function overviewMetrics(dash: Dashboard | null | undefined): OverviewMetrics | null {
  if (!dash || !Array.isArray(dash.approved) || !Array.isArray(dash.under_revision)) return null;
  const scored = new Set(dash.approved.flatMap((r) =>
    summarizeSession(r.inputs).subjects.filter((x) => x.status === "scored").map((x) => x.subjectId)));
  return { approved: dash.approved.length, subjectsScored: scored.size, underRevision: dash.under_revision.length };
}

// Setup checklist from count queries; a failed count is null (unknown), not "nothing created yet".
export function setupChecklist(counts: (number | null)[]): { known: boolean; incomplete: boolean } {
  const known = counts.every((c) => c !== null);
  return { known, incomplete: known && counts.some((c) => c === 0) };
}

// Dashboard CSV: one row per approved current session plus the like-for-like template rollup.
export function buildDashboardCsv(dash: Dashboard, workspace: { name: string; timezone: string }, generatedAt = new Date()): string {
  const rows: (string | number | null)[][] = [
    ["SAVOUR dashboard export"], ["Business", workspace.name], ["Timezone", workspace.timezone],
    ["Filters", "Approved current revisions only; sessions under revision excluded"],
    ["Generated at", formatDateTime(generatedAt.toISOString(), workspace.timezone)], [],
    ["Template version", "Sessions", "Subject-sessions", "Mean quality %", "Mean combined %", "Attendance rate %"],
  ];
  for (const r of rollupByTemplate(dash.approved.map((a) => a.inputs))) {
    rows.push([r.label, r.sessions, r.subjectSessions, round1(r.quality), round1(r.combined), round1(r.attendanceRate)]);
  }
  rows.push([], ["Session", "Date", "Location", "Template", "Revision", "Approved at", "Mean quality %", "Coverage complete", "Coverage due"]);
  for (const a of dash.approved) {
    const s = summarizeSession(a.inputs);
    rows.push([a.inputs.session.name, a.inputs.session.local_date, a.inputs.session.location,
      `${a.inputs.template.name} v${a.inputs.template.version}`, a.revision, formatDateTime(a.approved_at, workspace.timezone),
      round1(s.quality.mean), s.coverage.complete, s.coverage.due]);
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

export function reportHeaderRows(env: ReportEnvelope, generatedAt: Date): [string, string][] {
  const { inputs, meta } = env;
  const tz = inputs.workspace.timezone;
  return [
    ["Business", inputs.workspace.name],
    ["Session", inputs.session.name],
    ["Session date", formatLocalDate(inputs.session.local_date)],
    ["Location", inputs.session.location],
    ["Timezone", tz],
    ["Template", `${inputs.template.name} v${inputs.template.version}`],
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
  const rows: [string, string][] = [
    ["Coverage", sum.coverage.pct === null ? "Not applicable" : `${sum.coverage.complete} of ${sum.coverage.due} (${formatPct(sum.coverage.pct)})${sum.coverage.excludedAbsent ? `, ${sum.coverage.excludedAbsent} absent excluded` : ""}`],
    ["Mean quality", `${formatPct(sum.quality.mean, "No data")} over ${sum.quality.included} subject(s)${sum.quality.excludedMixed ? `; ${sum.quality.excludedMixed} with mixed N/A sets shown separately` : ""}`],
  ];
  if (sum.inputs.template.attendance_mode === "scored") {
    rows.push(["Mean combined", `${formatPct(sum.combined.mean, "No data")} over ${sum.combined.included} subject(s)`]);
  }
  if (sum.attendance) {
    rows.push(["Attendance rate", `${formatPct(sum.attendance.rate, "Not applicable")} (${sum.attendance.present} present of ${sum.attendance.confirmed} confirmed; ${sum.attendance.unknown} unknown)`]);
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
    "Assessors scored", "Required assessors", "Applicable criteria sets", "Status"]);
  for (const s of sum.subjects) {
    rows.push([s.name, OUTCOME_LABELS[s.outcome], s.outcomeReason, s.attendancePoints, round1(s.quality),
      round1(s.combined), s.assessorsScored, s.requiredAssessors, s.applicabilitySets.length, subjectStatusLabel(s)]);
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
  return toCsv(rows);
}

export function exportFilename(env: ReportEnvelope, ext: "csv" | "pdf"): string {
  const safe = env.inputs.session.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";
  const tag = env.meta.status === "approved" ? `r${env.meta.revision}` : `r${env.meta.revision}-provisional`;
  return `savour-${safe}-${env.inputs.session.local_date}-${tag}${env.meta.redacted ? "-redacted" : ""}.${ext}`;
}
