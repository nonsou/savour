// Tables shared by the analytics CSV and PDF. Both exports render exactly these sections, built from
// one buildAnalytics() result, so the two files reconcile with each other and with the page.
import {
  applicabilityLabel, filterSummary, formatMean, modeLabel, RULES, type AnalyticsDataset, type AnalyticsFilters,
  type AnalyticsResult, type ComparisonRow, type Flag,
} from "./analytics";
import { toCsv } from "./csv";
import { formatDateTime } from "./report";
import { OUTCOME_LABELS, type SubjectStatus } from "./scoring";

export type Cell = string | number | null;
export interface Section { title: string; note?: string; header: string[]; rows: Cell[][] }

export const STATUS_LABELS: Record<SubjectStatus, string> = {
  scored: "Scored", incomplete: "Incomplete (missing responses)", mixed_na: "Not comparable (mixed N/A)", all_na: "All N/A",
  absent: "Absent", not_assessed: "Not assessed", unknown: "Outcome unknown", attendance_only: "Attendance only",
};
export const FLAG_LABELS: Record<Flag["kind"], string> = {
  critical: "Open critical finding", overdue: "Overdue action", decline: "Quality decline", attendance: "Late or absent",
};
// Decline and attendance flags come from approved snapshots; finding and action flags are live state
// read when the analysis was generated.
export const FLAG_SOURCES: Record<Flag["kind"], string> = {
  critical: "Live state", overdue: "Live state", decline: "Approved snapshots", attendance: "Approved snapshots",
};

const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const pct = (n: number | null) => (n === null ? "No data" : formatMean(n));

export function headerRows(ds: AnalyticsDataset, filters: AnalyticsFilters, result: AnalyticsResult): [string, string][] {
  return [
    ["Business", ds.workspace_name],
    ["Timezone", ds.timezone],
    ["Data", modeLabel(ds.mode)],
    ["Filters", filterSummary(ds, filters, result)],
    ["Sessions in scope", `${result.sessions} of ${ds.total} matching session(s)${ds.truncated ? " — only the latest 1000 are included" : ""}`],
    ...(result.unsupported.length ? [["Not shown", `${result.unsupported.length} session(s) with an unsupported formula`] as [string, string]] : []),
    ["Assessor identities", "Never included in analytics"],
    ["Generated at", formatDateTime(ds.generated_at, ds.timezone)],
    ["Note", RULES.disclaimer],
  ];
}

function comparisonRows(list: ComparisonRow[]): Cell[][] {
  return list.flatMap((c) => {
    const base: Cell[] = [c.label + (c.annotation ? ` (${c.annotation})` : ""), c.versionLabel, c.formula, c.counts.subjectSessions,
      c.coverage.complete, c.coverage.due, r1(c.coverage.pct), c.counts.absent, c.counts.unknown, c.counts.waivedResponses,
      c.attendance ? r1(c.attendance.rate) : "Attendance off"];
    if (!c.quality.length) return [[...base, "No scored subject-sessions", 0, "No data", "No data"]];
    // Combined exists only for scored-attendance versions; otherwise it is not applicable ("—").
    return c.quality.map((q) => [...base, applicabilityLabel(q), q.n, r1(q.quality) ?? "No data", q.combined === null ? "—" : r1(q.combined)]);
  });
}

const COMPARISON_HEADER = ["Group (name at approval)", "Template version", "Formula", "Subject-sessions", "Coverage complete", "Coverage due",
  "Coverage %", "Absent", "Outcome unknown", "Waived responses (still missing)", "Attendance rate %", "Applicable criteria",
  "Comparable n", "Mean quality %", "Mean combined %"];

export function analyticsSections(ds: AnalyticsDataset, result: AnalyticsResult): Section[] {
  const c = result.counts;
  const sections: Section[] = [
    {
      title: "Overview", note: "Each subject-session counts once. Quality means are only shown within one comparable group below.",
      header: ["Measure", "Value"],
      rows: [
        ["Sessions", result.sessions], ["Subject-sessions", c.subjectSessions], ["Scored", c.scored],
        ["Incomplete (missing responses)", c.incomplete], ["Missing responses", c.missingResponses],
        ["Waived responses (still counted missing)", c.waivedResponses], ["Mixed N/A (not comparable)", c.mixedNa],
        ["All N/A", c.allNa], ["Absent", c.absent], ["Not assessed", c.notAssessed], ["Outcome unknown", c.unknown],
        ["Attendance only", c.attendanceOnly],
        ["Coverage", result.coverage.pct === null ? "No data" : `${result.coverage.complete} of ${result.coverage.due} (${pct(result.coverage.pct)})`],
        ["Attendance rate (attendance-on sessions only)", result.attendance ? `${pct(result.attendance.rate)} (${result.attendance.present} present of ${result.attendance.confirmed} confirmed; ${result.attendance.unknown} unknown)` : "Attendance off"],
      ],
    },
    {
      title: "By template version, formula and applicable criteria",
      note: "Different template versions, formulas or N/A patterns are never averaged together.",
      header: ["Template version", "Formula", "Attendance", "Sessions", "Subject-sessions", "First date", "Last date", "Coverage %",
        "Attendance rate %", "Applicable criteria", "Comparable n", "Mean quality %", "Mean combined %"],
      rows: result.versionGroups.flatMap((v) => {
        const base: Cell[] = [v.label, v.formula, v.attendanceMode, v.sessions, v.counts.subjectSessions, v.firstDate, v.lastDate,
          r1(v.coverage.pct), v.attendance ? r1(v.attendance.rate) : "Attendance off"];
        if (!v.quality.length) return [[...base, "No scored subject-sessions", 0, "No data", "No data"]];
        return v.quality.map((q) => [...base, applicabilityLabel(q), q.n, r1(q.quality) ?? "No data",
          v.attendanceMode === "scored" ? r1(q.combined) ?? "No data" : "—"]);
      }),
    },
    {
      title: "Version breaks", note: "Trends restart at each break.",
      header: ["Date", "From", "To"], rows: result.versionBreaks.map((b) => [b.date, b.from, b.to]),
    },
    { title: "Locations", note: "Grouped by the session location; names as recorded at approval.", header: COMPARISON_HEADER, rows: comparisonRows(result.locations) },
    { title: "Categories", note: "Grouped by the category recorded at approval. Earlier snapshots show Not recorded at approval.",
      header: COMPARISON_HEADER, rows: comparisonRows(result.categories) },
  ];
  if (result.attention.available) {
    sections.push({
      title: "Needs attention", note: RULES.disclaimer + (result.attention.liveFlags ? "" : " Finding and action flags are visible to reviewers only."),
      header: ["Flag", "Data", "Subject", "Detail", "Rule", "Sources"],
      rows: result.attention.flags.map((f) => [FLAG_LABELS[f.kind], f.kind === "critical" || f.kind === "overdue"
        ? `${FLAG_SOURCES[f.kind]} at ${formatDateTime(ds.generated_at, ds.timezone)}` : FLAG_SOURCES[f.kind],
      f.subjectName, f.detail, RULES[f.kind], f.sources.map((s) => s.label).join("; ")]),
    }, {
      title: "Insufficient data for a rule", header: ["Rule", "Subject", "Detail"],
      rows: result.attention.insufficient.map((i) => [FLAG_LABELS[i.kind], i.subjectName, i.detail]),
    });
  }
  sections.push({
    title: "Subject history", note: "Stable subject IDs; names as recorded at each approval.",
    header: ["Subject (current name)", "Date", "Session", "Revision", "Template version", "Formula", "Name at approval", "Status",
      "Quality %", "Combined %", "Attendance", "Version break"],
    rows: result.histories.flatMap((h) => h.points.map((p) => [
      `${h.currentName ?? h.names[h.names.length - 1]}${h.archived ? " (archived)" : ""}`, p.localDate, p.sessionName, p.revision,
      p.templateLabel, p.formula, p.nameAtApproval, STATUS_LABELS[p.status], r1(p.quality), r1(p.combined),
      p.attendanceMode === "off" ? "Attendance off" : OUTCOME_LABELS[p.outcome], p.versionBreak ? "Yes" : ""])),
  });
  return sections;
}

export function buildAnalyticsCsv(ds: AnalyticsDataset, filters: AnalyticsFilters, result: AnalyticsResult): string {
  const rows: Cell[][] = [["SAVOUR analytics export"]];
  for (const [k, v] of headerRows(ds, filters, result)) rows.push([k, v]);
  for (const s of analyticsSections(ds, result)) {
    rows.push([], [s.title]);
    if (s.note) rows.push(["Note", s.note]);
    rows.push(s.header);
    if (!s.rows.length) rows.push(["None"]);
    rows.push(...s.rows);
  }
  return toCsv(rows);
}

export function analyticsFilename(ds: AnalyticsDataset, ext: "csv" | "pdf"): string {
  return `savour-analytics-${ds.mode}-${ds.today}.${ext}`;
}
