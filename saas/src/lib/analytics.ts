// Reproducible analytics (Milestone 3). Pure: takes the dataset returned by public.get_analytics and
// the filters, and returns every figure the analytics page, CSV and PDF show. All three call
// buildAnalytics() on the same RPC output, so they cannot disagree.
//
// Rules
// * The unit is the subject-session, equal weight. Per-subject results come from summarizeSession()
//   (the report calculation), so analytics never re-implements scoring.
// * Quality means are only taken within one comparability group: the same template version, the
//   same formula label and the same applicable-criterion set (N/A pattern). Different groups are
//   never averaged together; a version break is shown instead.
// * Absence, not assessed, unknown, waived and missing work are counted and shown, never turned into
//   zero. No data is null and is displayed as "No data".
// * Attendance figures exist only where the frozen template had attendance on; attendance never
//   enters quality.
// * Grouping uses only what each snapshot recorded: category/type stamped at approval
//   (legacy snapshots: "Not recorded at approval"), the approval-time subject and location names, and
//   the immutable session location ID. Current directory names are annotations only.
// * Approved and provisional data are never mixed: a dataset containing both throws.
// * Samples never count: get_analytics excludes them in SQL; any sample record reaching this module
//   is dropped and counted as a defect signal.
import {
  COMPLETE_STATUSES, isKnownFormula, isSampleInputs, summarizeSession,
  type AttendanceMode, type Outcome, type ReportInputs, type Severity, type SubjectResult, type SubjectStatus,
} from "./scoring";

export type AnalyticsMode = "approved" | "provisional";

export interface AnalyticsRecord {
  session_id: string; revision: number; approved_at: string | null; local_date: string;
  location_id: string; location_now: string; template_version_id: string; template_name: string;
  template_version: number; pack: string; mode: AnalyticsMode; inputs: ReportInputs;
}
export interface AnalyticsFinding {
  finding_id: string; session_id: string; session_name: string; local_date: string; session_status: string;
  session_revision: number; subject_id: string; subject_name: string; kind: "generated" | "manual";
  criterion_key: string | null; severity: Severity; title: string; revision: number; state: string; current: boolean;
  rule: string | null; repeat: { status: string; window: number; prior_sessions_checked: number } | null; created_at: string;
}
export interface AnalyticsAction {
  action_id: string; finding_id: string; session_id: string; session_name: string; local_date: string; subject_id: string;
  subject_name: string; issue: string; severity: Severity; status: string; due_date: string; due_state: string;
}
export interface AnalyticsDataset {
  mode: AnalyticsMode; role: string; filters: Record<string, string>; today: string; timezone: string; workspace_name: string;
  generated_at: string; total: number; truncated: boolean; live_flags_visible: boolean;
  records: AnalyticsRecord[]; findings: AnalyticsFinding[]; actions: AnalyticsAction[];
  options: {
    locations: { id: string; name: string }[];
    template_versions: { id: string; name: string; version: number; pack: string }[];
    packs: string[]; first_date: string | null; last_date: string | null;
  };
  categories_now: { id: string; name: string; archived: boolean }[];
  subjects_now: { id: string; name: string; archived: boolean }[];
}

export const FILTER_KEYS = ["from", "to", "location_id", "pack", "template_version_id", "category_id", "subject_id", "subject_type"] as const;
export type FilterKey = typeof FILTER_KEYS[number];
export type AnalyticsFilters = Partial<Record<FilterKey, string>>;

export const PACK_LABELS: Record<string, string> = {
  food_vendors: "Food vendors", restaurant_ops: "Restaurant operations", supplier_service: "Supplier and service quality", custom: "Custom",
};
export const NOT_RECORDED = "not_recorded";
export const NOT_RECORDED_LABEL = "Not recorded at approval";
export const UNCATEGORISED = "none";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SUBJECT_TYPES = ["vendor", "outlet", "operation", "supplier", "service_provider"];

// Untrusted query parameters -> validated filters. Invalid values are dropped (and reported) rather
// than sent; the database validates again.
export function parseFilters(sp: Record<string, string | string[] | undefined>): { filters: AnalyticsFilters; ignored: string[] } {
  const filters: AnalyticsFilters = {};
  const ignored: string[] = [];
  for (const key of FILTER_KEYS) {
    const raw = sp[key];
    const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!v) continue;
    const ok = key === "from" || key === "to" ? DATE.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`))
      : key === "pack" ? v in PACK_LABELS
      : key === "subject_type" ? SUBJECT_TYPES.includes(v) || v === NOT_RECORDED
      : key === "category_id" ? UUID.test(v) || v === UNCATEGORISED || v === NOT_RECORDED
      : UUID.test(v);
    if (ok) filters[key] = v; else ignored.push(key);
  }
  if (filters.from && filters.to && filters.from > filters.to) { ignored.push("from", "to"); delete filters.from; delete filters.to; }
  return { filters, ignored };
}

export function filtersToQuery(filters: AnalyticsFilters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) if (filters[k]) p.set(k, filters[k]!);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p.toString();
}

export class MixedModeError extends Error {
  constructor() {
    super("Approved and provisional records cannot be combined. Nothing is shown rather than blending them.");
    this.name = "MixedModeError";
  }
}

// ---------------------------------------------------------------------------
// Subject-session rows
// ---------------------------------------------------------------------------
export interface SubjectSessionRow {
  sessionId: string; sessionName: string; revision: number; localDate: string; approvedAt: string | null;
  locationId: string; locationName: string; pack: string;
  templateVersionId: string; templateLabel: string; formula: string; attendanceMode: AttendanceMode;
  needsQuality: boolean;           // the frozen template has quality criteria
  versionKey: string; compKey: string | null; applicability: string | null;
  subjectId: string; subjectName: string; categoryKey: string; categoryName: string; subjectType: string;
  result: SubjectResult;
}

function categoryOf(s: ReportInputs["subjects"][number]): { key: string; name: string } {
  if (!("category_id" in s)) return { key: NOT_RECORDED, name: NOT_RECORDED_LABEL };
  if (!s.category_id) return { key: UNCATEGORISED, name: "Uncategorised" };
  return { key: s.category_id, name: s.category_name ?? "Unnamed category" };
}

function rowsOf(rec: AnalyticsRecord): SubjectSessionRow[] {
  const sum = summarizeSession(rec.inputs);
  const t = rec.inputs.template;
  const formula = rec.inputs.formula_version;
  const versionKey = `${t.version_id}|${formula}`;
  return sum.subjects.map((r) => {
    const input = rec.inputs.subjects.find((x) => x.subject_id === r.subjectId)!;
    const cat = categoryOf(input);
    const applicability = r.status === "scored" ? r.applicabilitySets[0] : null;
    return {
      sessionId: rec.session_id, sessionName: rec.inputs.session.name, revision: rec.revision, localDate: rec.local_date,
      approvedAt: rec.approved_at, locationId: rec.location_id, locationName: rec.inputs.session.location, pack: rec.pack,
      templateVersionId: t.version_id, templateLabel: `${t.name} v${t.version}`, formula, attendanceMode: t.attendance_mode,
      needsQuality: t.criteria.length > 0, versionKey, compKey: applicability === null ? null : `${versionKey}|${applicability}`, applicability,
      subjectId: r.subjectId, subjectName: r.name, categoryKey: cat.key, categoryName: cat.name,
      subjectType: input.subject_type ?? NOT_RECORDED, result: r,
    };
  });
}

const byTime = (a: SubjectSessionRow, b: SubjectSessionRow) =>
  a.localDate.localeCompare(b.localDate) || (a.approvedAt ?? "").localeCompare(b.approvedAt ?? "") || a.sessionId.localeCompare(b.sessionId);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------
export interface StatusCounts {
  subjectSessions: number; scored: number; incomplete: number; waivedSubjects: number; missingResponses: number;
  waivedResponses: number; mixedNa: number; allNa: number; absent: number; notAssessed: number; unknown: number;
  attendanceOnly: number;
}
export interface Coverage { complete: number; due: number; excludedAbsent: number; pct: number | null }
export interface AttendanceStats {
  confirmed: number; present: number; early: number; middle: number; late: number; absent: number; unknown: number;
  rate: number | null; avgPoints: number | null;
}
export interface QualityGroup {
  compKey: string; applicability: string; criteria: string[]; n: number; quality: number | null; combined: number | null;
}
export interface VersionGroup {
  versionKey: string; templateVersionId: string; label: string; formula: string; attendanceMode: AttendanceMode;
  sessions: number; firstDate: string; lastDate: string; counts: StatusCounts; coverage: Coverage;
  attendance: AttendanceStats | null; quality: QualityGroup[];
}

// Outstanding quality work is disclosed wherever quality responses are still due: incomplete
// subjects and subjects whose outcome is still unknown (provisional data). Absent, not assessed and
// attendance-only subjects owe no quality responses, so they never count as missing.
const owesQuality = (r: SubjectSessionRow) => r.needsQuality && (r.result.status === "incomplete" || r.result.status === "unknown");

function counts(rows: SubjectSessionRow[]): StatusCounts {
  const st = (s: SubjectStatus) => rows.filter((r) => r.result.status === s).length;
  const owing = rows.filter(owesQuality);
  return {
    subjectSessions: rows.length, scored: st("scored"), incomplete: st("incomplete"),
    waivedSubjects: owing.filter((r) => r.result.waivedAssessors > 0).length,
    missingResponses: owing.reduce((n, r) => n + r.result.missingResponses, 0),
    waivedResponses: owing.reduce((n, r) => n + r.result.waivedAssessors, 0),
    mixedNa: st("mixed_na"), allNa: st("all_na"), absent: st("absent"), notAssessed: st("not_assessed"),
    unknown: st("unknown"), attendanceOnly: st("attendance_only"),
  };
}

// Same rule as summarizeSession: confirmed absence leaves the due denominator only where attendance
// gating applies (attendance on).
function coverage(rows: SubjectSessionRow[]): Coverage {
  const excludedAbsent = rows.filter((r) => r.attendanceMode !== "off" && r.result.status === "absent").length;
  const due = rows.length - excludedAbsent;
  const complete = rows.filter((r) => COMPLETE_STATUSES.includes(r.result.status)).length;
  return { complete, due, excludedAbsent, pct: due ? (complete / due) * 100 : null };
}

const PRESENT: Outcome[] = ["early", "middle", "late", "present"];

// Attendance only from rows whose frozen template had attendance on.
function attendance(rows: SubjectSessionRow[]): AttendanceStats | null {
  const on = rows.filter((r) => r.attendanceMode !== "off");
  if (!on.length) return null;
  const o = (x: Outcome) => on.filter((r) => r.result.outcome === x).length;
  const confirmed = on.filter((r) => r.result.outcome !== "unknown");
  const present = confirmed.filter((r) => PRESENT.includes(r.result.outcome)).length;
  const scored = confirmed.filter((r) => r.attendanceMode === "scored");
  return {
    confirmed: confirmed.length, present, early: o("early"), middle: o("middle"), late: o("late"), absent: o("absent"),
    unknown: on.length - confirmed.length, rate: confirmed.length ? (present / confirmed.length) * 100 : null,
    avgPoints: scored.length && scored.length === confirmed.length ? mean(scored.map((r) => r.result.attendancePoints ?? 0)) : null,
  };
}

function criteriaLabels(rows: SubjectSessionRow[], records: AnalyticsRecord[], applicability: string): string[] {
  const rec = records.find((r) => r.session_id === rows[0].sessionId)!;
  const keys = applicability ? applicability.split(",") : [];
  return keys.map((k) => rec.inputs.template.criteria.find((c) => c.key === k)?.label ?? k);
}

function qualityGroups(rows: SubjectSessionRow[], records: AnalyticsRecord[]): QualityGroup[] {
  const groups = new Map<string, SubjectSessionRow[]>();
  for (const r of rows) if (r.compKey) groups.set(r.compKey, [...(groups.get(r.compKey) ?? []), r]);
  return [...groups.entries()].map(([compKey, list]) => ({
    compKey, applicability: list[0].applicability!, criteria: criteriaLabels(list, records, list[0].applicability!), n: list.length,
    quality: mean(list.map((r) => r.result.quality as number)),
    combined: list[0].attendanceMode === "scored" ? mean(list.filter((r) => r.result.combined !== null).map((r) => r.result.combined as number)) : null,
  })).sort((a, b) => b.n - a.n || a.compKey.localeCompare(b.compKey));
}

function versionGroups(rows: SubjectSessionRow[], records: AnalyticsRecord[]): VersionGroup[] {
  const groups = new Map<string, SubjectSessionRow[]>();
  for (const r of rows) groups.set(r.versionKey, [...(groups.get(r.versionKey) ?? []), r]);
  return [...groups.values()].map((list) => {
    const sorted = [...list].sort(byTime);
    const f = sorted[0];
    return {
      versionKey: f.versionKey, templateVersionId: f.templateVersionId, label: f.templateLabel, formula: f.formula,
      attendanceMode: f.attendanceMode, sessions: new Set(list.map((r) => r.sessionId)).size,
      firstDate: f.localDate, lastDate: sorted[sorted.length - 1].localDate,
      counts: counts(list), coverage: coverage(list), attendance: attendance(list), quality: qualityGroups(list, records),
    };
  }).sort((a, b) => a.firstDate.localeCompare(b.firstDate) || a.versionKey.localeCompare(b.versionKey));
}

export interface VersionBreak { date: string; sessionId: string; from: string; to: string }

// Points in date order where consecutive sessions switch template version or formula.
function versionBreaks(rows: SubjectSessionRow[]): VersionBreak[] {
  const sessions = [...new Map([...rows].sort(byTime).map((r) => [r.sessionId, r])).values()];
  const out: VersionBreak[] = [];
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i].versionKey !== sessions[i - 1].versionKey) {
      out.push({ date: sessions[i].localDate, sessionId: sessions[i].sessionId,
        from: `${sessions[i - 1].templateLabel} (${sessions[i - 1].formula})`, to: `${sessions[i].templateLabel} (${sessions[i].formula})` });
    }
  }
  return out;
}

export interface ComparisonRow {
  key: string; label: string; annotation: string | null; versionLabel: string; formula: string;
  counts: StatusCounts; coverage: Coverage; attendance: AttendanceStats | null; quality: QualityGroup[];
}

function compare(rows: SubjectSessionRow[], records: AnalyticsRecord[], keyOf: (r: SubjectSessionRow) => string,
  labelOf: (key: string, rows: SubjectSessionRow[]) => { label: string; annotation: string | null }): ComparisonRow[] {
  const out: ComparisonRow[] = [];
  const byKey = new Map<string, SubjectSessionRow[]>();
  for (const r of rows) byKey.set(keyOf(r), [...(byKey.get(keyOf(r)) ?? []), r]);
  for (const [key, list] of byKey) {
    const { label, annotation } = labelOf(key, list);
    for (const vg of versionGroups(list, records)) {
      const vrows = list.filter((r) => r.versionKey === vg.versionKey);
      out.push({ key, label, annotation, versionLabel: vg.label, formula: vg.formula, counts: counts(vrows),
        coverage: coverage(vrows), attendance: attendance(vrows), quality: vg.quality });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label) || a.versionLabel.localeCompare(b.versionLabel) || a.formula.localeCompare(b.formula));
}

const distinctNames = (names: string[]) => [...new Set(names)].join(" / ");

// ---------------------------------------------------------------------------
// Subject history
// ---------------------------------------------------------------------------
export interface HistoryPoint {
  sessionId: string; sessionName: string; revision: number; localDate: string; templateLabel: string; formula: string;
  nameAtApproval: string; status: SubjectStatus; quality: number | null; combined: number | null;
  outcome: Outcome; attendanceMode: AttendanceMode; applicability: string | null; compKey: string | null; versionBreak: boolean;
}
export interface SubjectHistory { subjectId: string; currentName: string | null; archived: boolean; names: string[]; points: HistoryPoint[] }

function histories(rows: SubjectSessionRow[], ds: AnalyticsDataset): SubjectHistory[] {
  const bySubject = new Map<string, SubjectSessionRow[]>();
  for (const r of rows) bySubject.set(r.subjectId, [...(bySubject.get(r.subjectId) ?? []), r]);
  return [...bySubject.entries()].map(([subjectId, list]) => {
    const sorted = [...list].sort(byTime);
    const now = ds.subjects_now.find((s) => s.id === subjectId);
    return {
      subjectId, currentName: now?.name ?? null, archived: now?.archived ?? false,
      names: [...new Set(sorted.map((r) => r.subjectName))],
      points: sorted.map((r, i) => ({
        sessionId: r.sessionId, sessionName: r.sessionName, revision: r.revision, localDate: r.localDate,
        templateLabel: r.templateLabel, formula: r.formula, nameAtApproval: r.subjectName, status: r.result.status,
        quality: r.result.quality, combined: r.result.combined, outcome: r.result.outcome, attendanceMode: r.attendanceMode,
        applicability: r.applicability, compKey: r.compKey, versionBreak: i > 0 && sorted[i - 1].versionKey !== r.versionKey,
      })),
    };
  }).sort((a, b) => (a.currentName ?? a.names[0]).localeCompare(b.currentName ?? b.names[0]) || a.subjectId.localeCompare(b.subjectId));
}

// ---------------------------------------------------------------------------
// Needs attention (explainable flags)
// ---------------------------------------------------------------------------
export const RULES = {
  decline: "Quality decline: among the latest six scored subject-sessions with the same template version, formula and applicable criteria "
    + "(ordered by session date, then approval time), the mean quality of the latest three is at least 10 percentage points below the "
    + "mean of the three before. Fewer than six comparable subject-sessions is Insufficient data.",
  attendance: "Attendance: late or absent in at least two of the last three sessions that had attendance on and a recorded outcome. "
    + "Unknown outcomes and sessions with attendance off are not counted; fewer than three such sessions is Insufficient data.",
  critical: "Open critical finding: a critical finding that is current evidence (raised manually, or generated in the session's current "
    + "approved revision), not withdrawn, and without a closed action (or with an action still active).",
  overdue: "Overdue action: an unfinished action (open, in progress or ready for verification) whose due date has ended in the "
    + "workspace timezone, using the server clock.",
  disclaimer: "Flags are prompts for review. They are not certifications, ratings or penalties and do not change any score.",
} as const;
export const DECLINE_PP = 10;
const EPS = 1e-9;  // floating-point tolerance so exactly -10 points is flagged

export type FlagKind = "decline" | "attendance" | "critical" | "overdue";
export interface FlagSource { label: string; sessionId?: string; revision?: number; actionId?: string; findingId?: string }
export interface Flag { kind: FlagKind; subjectId: string; subjectName: string; detail: string; sources: FlagSource[]; value?: number }
export interface Insufficient { kind: "decline" | "attendance"; subjectId: string; subjectName: string; detail: string; have: number; need: number }

function declineFlags(rows: SubjectSessionRow[], flags: Flag[], insufficient: Insufficient[]) {
  const groups = new Map<string, SubjectSessionRow[]>();
  for (const r of rows) if (r.compKey) groups.set(`${r.subjectId}#${r.compKey}`, [...(groups.get(`${r.subjectId}#${r.compKey}`) ?? []), r]);
  for (const list of groups.values()) {
    const sorted = [...list].sort(byTime);
    const last = sorted[sorted.length - 1];
    const scope = `${last.templateLabel}, ${last.formula}`;
    if (sorted.length < 6) {
      insufficient.push({ kind: "decline", subjectId: last.subjectId, subjectName: last.subjectName, have: sorted.length, need: 6,
        detail: `Insufficient data: ${sorted.length} of 6 comparable scored subject-sessions (${scope}).` });
      continue;
    }
    const six = sorted.slice(-6);
    const prev = six.slice(0, 3).map((r) => r.result.quality as number);
    const latest = six.slice(3).map((r) => r.result.quality as number);
    const diff = (latest.reduce((a, b) => a + b, 0) - prev.reduce((a, b) => a + b, 0)) / 3;
    if (diff <= -DECLINE_PP + EPS) {
      flags.push({ kind: "decline", subjectId: last.subjectId, subjectName: last.subjectName, value: diff,
        detail: `Mean quality fell ${Math.abs(Math.round(diff * 10) / 10).toFixed(1)} points: ${fmt(mean(prev))} to ${fmt(mean(latest))} (${scope}).`,  // plain words: every glyph is in the report font
        sources: six.map((r) => ({ label: `${r.localDate} ${r.sessionName} r${r.revision}: ${fmt(r.result.quality)}`, sessionId: r.sessionId, revision: r.revision })) });
    }
  }
}

function attendanceFlags(rows: SubjectSessionRow[], flags: Flag[], insufficient: Insufficient[]) {
  const bySubject = new Map<string, SubjectSessionRow[]>();
  for (const r of rows) if (r.attendanceMode !== "off") bySubject.set(r.subjectId, [...(bySubject.get(r.subjectId) ?? []), r]);
  for (const list of bySubject.values()) {
    const sorted = [...list].sort(byTime);
    const unknown = sorted.filter((r) => r.result.outcome === "unknown").length;
    const eligible = sorted.filter((r) => r.result.outcome !== "unknown");
    const name = sorted[sorted.length - 1].subjectName;
    const note = unknown ? ` ${unknown} session(s) with unknown attendance not counted.` : "";
    if (eligible.length < 3) {
      insufficient.push({ kind: "attendance", subjectId: sorted[0].subjectId, subjectName: name, have: eligible.length, need: 3,
        detail: `Insufficient data: ${eligible.length} of 3 sessions with attendance recorded.${note}` });
      continue;
    }
    const last3 = eligible.slice(-3);
    const bad = last3.filter((r) => r.result.outcome === "late" || r.result.outcome === "absent");
    if (bad.length >= 2) {
      flags.push({ kind: "attendance", subjectId: sorted[0].subjectId, subjectName: name, value: bad.length,
        detail: `Late or absent in ${bad.length} of the last 3 sessions with attendance recorded.${note}`,
        sources: last3.map((r) => ({ label: `${r.localDate} ${r.sessionName} r${r.revision}: ${r.result.outcome}`, sessionId: r.sessionId, revision: r.revision })) });
    }
  }
}

const fmt = (n: number | null) => (n === null ? "No data" : `${(Math.round(n * 10) / 10).toFixed(1)}%`);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export interface AnalyticsResult {
  mode: AnalyticsMode; filters: AnalyticsFilters; excludedSamples: number; unsupported: { sessionId: string; formula: string }[];
  sessions: number; counts: StatusCounts; coverage: Coverage; attendance: AttendanceStats | null;
  versionGroups: VersionGroup[]; versionBreaks: VersionBreak[];
  locations: ComparisonRow[]; categories: ComparisonRow[];
  histories: SubjectHistory[];
  attention: { available: boolean; flags: Flag[]; insufficient: Insufficient[]; liveFlags: boolean };
  subjectOptions: { id: string; name: string }[];
  categoryOptions: { id: string; name: string }[];
  typeOptions: string[];
}

export function buildAnalytics(ds: AnalyticsDataset, filters: AnalyticsFilters): AnalyticsResult {
  if (ds.records.some((r) => r.mode !== ds.mode)) throw new MixedModeError();
  const samples = ds.records.filter((r) => isSampleInputs(r.inputs));
  const unsupported = ds.records.filter((r) => !isSampleInputs(r.inputs) && !isKnownFormula(r.inputs.formula_version));
  const records = ds.records.filter((r) => !isSampleInputs(r.inputs) && isKnownFormula(r.inputs.formula_version));

  const all = records.flatMap(rowsOf);
  const rows = all.filter((r) =>
    (!filters.subject_id || r.subjectId === filters.subject_id)
    && (!filters.category_id || r.categoryKey === filters.category_id)
    && (!filters.subject_type || r.subjectType === filters.subject_type));
  // Live findings/actions under subject-level filters: a subject filter selects that subject's live
  // work even before its first approval; category/type are approval-time stamps of a specific
  // inspection, so they select only sources from the filtered inspections (session and subject).
  const historicalFilter = !!(filters.category_id || filters.subject_type);
  const sourcePairs = new Set(rows.map((r) => `${r.sessionId}|${r.subjectId}`));
  const inScope = (sessionId: string, subjectId: string) =>
    (!filters.subject_id || subjectId === filters.subject_id) && (!historicalFilter || sourcePairs.has(`${sessionId}|${subjectId}`));

  const catNow = (id: string) => ds.categories_now.find((c) => c.id === id);
  const flags: Flag[] = [];
  const insufficient: Insufficient[] = [];
  const attentionAvailable = ds.mode === "approved";
  if (attentionAvailable) {
    declineFlags(rows, flags, insufficient);
    attendanceFlags(rows, flags, insufficient);
    for (const f of ds.findings) {
      if (f.severity !== "critical" || f.state !== "open" || !f.current || !inScope(f.session_id, f.subject_id)) continue;
      flags.push({ kind: "critical", subjectId: f.subject_id, subjectName: f.subject_name,
        detail: `${f.title} (${f.kind === "generated" ? `generated at revision ${f.revision}` : "raised manually"}; session ${f.session_name}, ${f.local_date}).`
          + (f.repeat ? ` Repeat check: ${f.repeat.status.replace(/_/g, " ")} (${f.repeat.prior_sessions_checked} of ${f.repeat.window} prior sessions).` : ""),
        sources: [{ label: `${f.local_date} ${f.session_name}`, sessionId: f.session_id, findingId: f.finding_id }] });
    }
    for (const a of ds.actions) {
      if (a.due_state !== "overdue" || !inScope(a.session_id, a.subject_id)) continue;
      flags.push({ kind: "overdue", subjectId: a.subject_id, subjectName: a.subject_name,
        detail: `${a.issue} — due ${a.due_date}, ${a.status.replace(/_/g, " ")} (${a.severity}).`,
        sources: [{ label: `Action: ${a.issue}`, actionId: a.action_id, sessionId: a.session_id }] });
    }
  }
  const kindOrder: FlagKind[] = ["critical", "overdue", "decline", "attendance"];
  flags.sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || a.subjectName.localeCompare(b.subjectName));

  const catOptions = new Map<string, string>();
  for (const r of all) catOptions.set(r.categoryKey, r.categoryKey === NOT_RECORDED || r.categoryKey === UNCATEGORISED ? r.categoryName
    : `${r.categoryName}${catNow(r.categoryKey) && catNow(r.categoryKey)!.name !== r.categoryName ? ` (now ${catNow(r.categoryKey)!.name})` : ""}`);
  const subjOptions = new Map<string, string>();
  for (const r of [...all].sort(byTime)) subjOptions.set(r.subjectId, ds.subjects_now.find((s) => s.id === r.subjectId)?.name ?? r.subjectName);

  return {
    mode: ds.mode, filters, excludedSamples: samples.length,
    unsupported: unsupported.map((r) => ({ sessionId: r.session_id, formula: r.inputs.formula_version })),
    sessions: new Set(rows.map((r) => r.sessionId)).size,
    counts: counts(rows), coverage: coverage(rows), attendance: attendance(rows),
    versionGroups: versionGroups(rows, records), versionBreaks: versionBreaks(rows),
    locations: compare(rows, records, (r) => r.locationId, (key, list) => {
      const now = ds.options.locations.find((l) => l.id === key)?.name ?? null;
      const names = distinctNames(list.map((r) => r.locationName));
      return { label: names, annotation: now && now !== names ? `now called ${now}` : null };
    }),
    categories: compare(rows, records, (r) => r.categoryKey, (key, list) => {
      const names = distinctNames(list.map((r) => r.categoryName));
      const now = catNow(key);
      const notes = [now && now.name !== names ? `now called ${now.name}` : null, now?.archived ? "archived" : null].filter(Boolean);
      return { label: names, annotation: notes.length ? notes.join(", ") : null };
    }),
    histories: histories(rows, ds),
    attention: { available: attentionAvailable, flags, insufficient: insufficient.sort((a, b) => a.subjectName.localeCompare(b.subjectName)),
      liveFlags: ds.live_flags_visible },
    subjectOptions: [...subjOptions.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    categoryOptions: [...catOptions.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    typeOptions: [...new Set(all.map((r) => r.subjectType))].sort(),
  };
}

// ---------------------------------------------------------------------------
// Shared presentation helpers (page, CSV, PDF)
// ---------------------------------------------------------------------------
export const formatMean = fmt;
export const applicabilityLabel = (q: QualityGroup) => (q.criteria.length ? q.criteria.join(", ") : "No criteria");

export function filterSummary(ds: AnalyticsDataset, filters: AnalyticsFilters, result?: AnalyticsResult): string {
  const parts: string[] = [];
  if (filters.from || filters.to) parts.push(`Dates ${filters.from ?? "start"} to ${filters.to ?? "latest"}`);
  if (filters.location_id) parts.push(`Location ${ds.options.locations.find((l) => l.id === filters.location_id)?.name ?? filters.location_id}`);
  if (filters.pack) parts.push(`Pack ${PACK_LABELS[filters.pack] ?? filters.pack}`);
  if (filters.template_version_id) {
    const v = ds.options.template_versions.find((x) => x.id === filters.template_version_id);
    parts.push(`Template ${v ? `${v.name} v${v.version}` : filters.template_version_id}`);
  }
  if (filters.category_id) parts.push(`Category ${result?.categoryOptions.find((c) => c.id === filters.category_id)?.name ?? filters.category_id}`);
  if (filters.subject_type) parts.push(`Subject type ${filters.subject_type === NOT_RECORDED ? NOT_RECORDED_LABEL : filters.subject_type.replace(/_/g, " ")}`);
  if (filters.subject_id) parts.push(`Subject ${result?.subjectOptions.find((s) => s.id === filters.subject_id)?.name ?? filters.subject_id}`);
  return parts.length ? parts.join("; ") : "None";
}

export function modeLabel(mode: AnalyticsMode): string {
  return mode === "approved"
    ? "Approved current revisions only (sessions under revision, drafts and SAMPLE practice sessions excluded)"
    : "PROVISIONAL — live data from open and in-review sessions you review. Not approved; never combined with approved figures.";
}
