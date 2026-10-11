import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  buildAnalytics, formatMean, MixedModeError, NOT_RECORDED, parseFilters, RULES,
  type AnalyticsDataset, type AnalyticsFinding, type AnalyticsRecord,
} from "@/lib/analytics";
import { analyticsSections, buildAnalyticsCsv } from "@/lib/analytics-export";
import { buildAnalyticsPdf } from "@/lib/pdf";
import type { AttendanceMode, Criterion, Outcome, ReportInputs, SubjectInput } from "@/lib/scoring";
import { assessment, TWO } from "./fixtures";

// ---------------------------------------------------------------------------------- fixtures
const SIX: Criterion[] = ["a", "b", "c", "d", "e", "f"].map((k) => ({ key: k, label: k.toUpperCase(), allow_na: false }));
const q = (pct: number) => (pct === 90 ? { taste: 5, hygiene: 4 } : pct === 80 ? { taste: 4, hygiene: 4 } : pct === 100 ? { taste: 5, hygiene: 5 }
  : pct === 70 ? { taste: 4, hygiene: 3 } : pct === 60 ? { taste: 3, hygiene: 3 } : (() => { throw new Error(`no fixture for ${pct}`); })());

interface S { id?: string; name?: string; outcome?: Outcome; answers?: (Record<string, number | { na: string }> | null)[]; extra?: Partial<SubjectInput> }
function subj({ id = "alpha", name = "Alpha Stall", outcome = "assessed", answers = [q(90)], extra = {} }: S): SubjectInput {
  return {
    subject_id: id, name, outcome, outcome_reason: null, required_assessors: answers.length,
    assessments: answers.filter((a) => a !== null).map((a, i) => assessment(a, `Ayo Assessor ${i}`)),
    category_id: null, category_name: null, subject_type: "vendor", ...extra,
  };
}
interface R {
  date: string; subjects: SubjectInput[]; mode?: AttendanceMode; tv?: string; version?: number; formula?: string; location?: string;
  locationName?: string; pack?: string; criteria?: Criterion[]; sample?: boolean; recMode?: "approved" | "provisional"; legacy?: boolean;
}
let n = 0;
function rec(r: R): AnalyticsRecord {
  n += 1;
  const id = `sess-${String(n).padStart(3, "0")}`;
  const inputs: ReportInputs = {
    formula_version: r.formula ?? "savour-m3.1",
    workspace: { name: "Same Name Foods", timezone: "Africa/Lagos" },
    session: { id, name: `Panel ${n}`, local_date: r.date, location: r.locationName ?? "Main", revision: 1,
      opens_at: `${r.date}T08:00:00Z`, closes_at: `${r.date}T20:00:00Z`, expected_ready_time: null, is_sample: r.sample ?? false },
    template: { id: "t1", version_id: r.tv ?? "tv1", name: "Food panel", version: r.version ?? 1, attendance_mode: r.mode ?? "off",
      criteria: r.criteria ?? TWO },
    // Legacy (m1.1/m2.1) snapshots have no category or type keys at all.
    subjects: r.legacy ? r.subjects.map((x) => {
      const y = { ...x };
      delete y.category_id; delete y.category_name; delete y.subject_type;
      return y;
    }) : r.subjects,
  };
  return { session_id: id, revision: 1, approved_at: r.recMode === "provisional" ? null : `${r.date}T18:00:00Z`, local_date: r.date,
    location_id: r.location ?? "loc-main", location_now: r.locationName ?? "Main", template_version_id: r.tv ?? "tv1",
    template_name: "Food panel", template_version: r.version ?? 1, pack: r.pack ?? "food_vendors", mode: r.recMode ?? "approved", inputs };
}
function dataset(records: AnalyticsRecord[], extra: Partial<AnalyticsDataset> = {}): AnalyticsDataset {
  return {
    mode: "approved", role: "owner", filters: {}, today: "2026-10-20", timezone: "Africa/Lagos", workspace_name: "Same Name Foods",
    generated_at: "2026-10-20T10:00:00Z", total: records.length, truncated: false, live_flags_visible: true,
    records, findings: [], actions: [],
    options: { locations: [{ id: "loc-main", name: "Main" }], template_versions: [], packs: ["food_vendors"], first_date: null, last_date: null },
    categories_now: [], subjects_now: [], ...extra,
  };
}
const day = (i: number) => `2026-10-${String(i).padStart(2, "0")}`;
const series = (pcts: number[], extra: Partial<R> = {}, offset = 0) =>
  pcts.map((p, i) => rec({ date: day(offset + i + 1), subjects: [subj({ answers: [q(p)] })], ...extra }));
const declines = (ds: AnalyticsDataset) => buildAnalytics(ds, {}).attention.flags.filter((f) => f.kind === "decline");

// ---------------------------------------------------------------------------------- tests
describe("quality decline rule (latest 3 vs preceding 3 comparable subject-sessions)", () => {
  it("flags a drop of exactly 10 points", () => {
    const flags = declines(dataset(series([90, 90, 90, 80, 80, 80])));
    expect(flags).toHaveLength(1);
    expect(flags[0].value).toBeCloseTo(-10, 9);
    expect(flags[0].sources).toHaveLength(6);
    expect(flags[0].detail).toContain("90.0% to 80.0%");
  });

  it("flags exactly -10 when the means are repeating decimals (floating-point safe)", () => {
    // 26/30 = 86.67% and 23/30 = 76.67%: mathematically exactly 10 points apart.
    const p26 = { a: 5, b: 5, c: 5, d: 5, e: 3, f: 3 };
    const p23 = { a: 4, b: 4, c: 4, d: 4, e: 4, f: 3 };
    const recs = [p26, p26, p26, p23, p23, p23].map((a, i) => rec({ date: day(i + 1), criteria: SIX, subjects: [subj({ answers: [a] })] }));
    expect(declines(dataset(recs))).toHaveLength(1);
  });

  it("does not flag a smaller drop, and uses only the latest six", () => {
    expect(declines(dataset(series([90, 90, 90, 80, 90, 80])))).toHaveLength(0);
    // An old high score before the window does not count.
    expect(declines(dataset(series([100, 80, 80, 80, 80, 80, 80])))).toHaveLength(0);
    expect(declines(dataset(series([60, 100, 100, 100, 90, 90, 80])))).toHaveLength(1);
  });

  it("five comparable subject-sessions is Insufficient data, never a flag", () => {
    const r = buildAnalytics(dataset(series([100, 100, 60, 60, 60])), {});
    expect(r.attention.flags).toHaveLength(0);
    expect(r.attention.insufficient).toEqual([expect.objectContaining({ kind: "decline", have: 5, need: 6 })]);
    expect(r.attention.insufficient[0].detail).toContain("5 of 6");
  });

  it("orders by session date, then approval time", () => {
    const recs = series([90, 90, 90, 80, 80, 80]).reverse();   // arrival order must not matter
    expect(declines(dataset(recs))).toHaveLength(1);
    expect(declines(dataset(series([80, 80, 80, 90, 90, 90]).reverse()))).toHaveLength(0);  // a rise by date
  });

  it("never compares across template versions, formulas or N/A patterns", () => {
    const v = [...series([90, 90, 90], { tv: "tv1" }), ...series([80, 80, 80], { tv: "tv2", version: 2 }, 10)];
    const rv = buildAnalytics(dataset(v), {});
    expect(rv.attention.flags).toHaveLength(0);
    expect(rv.versionGroups).toHaveLength(2);
    expect(rv.versionBreaks).toHaveLength(1);
    expect(rv.attention.insufficient.map((i) => i.have)).toEqual([3, 3]);

    const f = [...series([90, 90, 90], { formula: "savour-m2.1" }), ...series([80, 80, 80], { formula: "savour-m3.1" }, 10)];
    const rf = buildAnalytics(dataset(f), {});
    expect(rf.attention.flags).toHaveLength(0);
    expect(rf.versionGroups.map((g) => g.formula)).toEqual(["savour-m2.1", "savour-m3.1"]);

    const na = [...series([90, 90, 90]),
      ...[1, 2, 3].map((i) => rec({ date: day(10 + i), subjects: [subj({ answers: [{ taste: 3, hygiene: { na: "Closed" } }] })] }))];
    const rn = buildAnalytics(dataset(na), {});
    expect(rn.attention.flags).toHaveLength(0);
    expect(rn.versionGroups).toHaveLength(1);
    expect(rn.versionGroups[0].quality.map((g) => [g.criteria, g.n, g.quality])).toEqual([[["Taste"], 3, 60], [["Taste", "Hygiene"], 3, 90]]);
  });
});

describe("counts, coverage and attendance never invent zeros", () => {
  const ds = dataset([
    rec({ date: day(1), mode: "scored", subjects: [
      subj({ id: "a", outcome: "early" }),
      subj({ id: "b", outcome: "absent", answers: [] }),
      subj({ id: "c", outcome: "late", answers: [q(80), null], extra: { required_assessors: 2, waived_assessors: 1,
        waivers: [{ assessor_label: "Assessor 2", reason: "Ill", waived_at: "2026-10-01T09:00:00Z" }] } }),
      subj({ id: "d", outcome: "middle", answers: [q(90), { taste: 4, hygiene: { na: "x" } }] }),
    ] }),
    rec({ date: day(2), mode: "off", subjects: [subj({ id: "a", outcome: "not_assessed", answers: [] }), subj({ id: "e" })] }),
    rec({ date: day(3), mode: "presence", recMode: "approved", subjects: [subj({ id: "a", outcome: "unknown" })] }),
  ]);
  const r = buildAnalytics(ds, {});

  it("counts every status separately", () => {
    expect(r.counts).toMatchObject({ subjectSessions: 7, scored: 2, incomplete: 1, waivedSubjects: 1, missingResponses: 1, waivedResponses: 1,
      mixedNa: 1, absent: 1, notAssessed: 1, unknown: 1 });
  });

  it("coverage excludes confirmed absence only where attendance is on", () => {
    expect(r.coverage).toEqual({ complete: 3, due: 6, excludedAbsent: 1, pct: 50 });
  });

  it("attendance uses only attendance-on sessions and reports unknowns", () => {
    expect(r.attendance).toMatchObject({ confirmed: 4, present: 3, early: 1, middle: 1, late: 1, absent: 1, unknown: 1, rate: 75 });
    // Every confirmed outcome is scored readiness (the presence-mode row is unknown): mean of 5, 0, 1, 3.
    expect(r.attendance!.avgPoints).toBe(2.25);
    const offOnly = buildAnalytics(dataset([rec({ date: day(1), mode: "off", subjects: [subj({})] })]), {});
    expect(offOnly.attendance).toBeNull();
  });

  it("an empty selection is No data, not zero", () => {
    const e = buildAnalytics(dataset([]), {});
    expect(e.coverage.pct).toBeNull();
    expect(e.versionGroups).toEqual([]);
    expect(formatMean(null)).toBe("No data");
    const csv = buildAnalyticsCsv(dataset([]), {}, e);
    expect(csv).toContain(`"Coverage","No data"`);
  });
});

describe("attendance rule (late or absent in 2 of the last 3 attendance-on sessions)", () => {
  const att = (outcomes: (Outcome | "off")[]) => dataset(outcomes.map((o, i) => rec({ date: day(i + 1), mode: o === "off" ? "off" : "scored",
    subjects: [subj({ outcome: o === "off" ? "assessed" : o, answers: o === "absent" || o === "unknown" ? [] : [q(90)] })] })));

  it("flags two of three and lists the sources", () => {
    const flags = buildAnalytics(att(["early", "late", "absent"]), {}).attention.flags.filter((f) => f.kind === "attendance");
    expect(flags).toHaveLength(1);
    expect(flags[0].sources.map((s) => s.label.split(": ")[1])).toEqual(["early", "late", "absent"]);
  });

  it("skips unknown outcomes and attendance-off sessions, disclosing unknowns", () => {
    const r = buildAnalytics(att(["late", "off", "unknown", "early", "off", "late"]), {});
    const flag = r.attention.flags.find((f) => f.kind === "attendance")!;
    expect(flag.detail).toContain("1 session(s) with unknown attendance not counted");
    expect(buildAnalytics(att(["late", "early", "early"]), {}).attention.flags).toHaveLength(0);
  });

  it("fewer than three recorded sessions is Insufficient data", () => {
    const r = buildAnalytics(att(["late", "absent", "unknown", "off"]), {});
    expect(r.attention.flags.filter((f) => f.kind === "attendance")).toHaveLength(0);
    expect(r.attention.insufficient.find((i) => i.kind === "attendance")).toMatchObject({ have: 2, need: 3 });
  });
});

describe("dataset integrity", () => {
  it("drops samples even if one reaches the aggregator", () => {
    const r = buildAnalytics(dataset([...series([90]), rec({ date: day(9), sample: true, subjects: [subj({ answers: [q(60)] })] })]), {});
    expect(r.excludedSamples).toBe(1);
    expect(r.counts.subjectSessions).toBe(1);
  });

  it("refuses to blend approved and provisional records", () => {
    const mixed = dataset([...series([90]), rec({ date: day(9), recMode: "provisional", subjects: [subj({})] })]);
    expect(() => buildAnalytics(mixed, {})).toThrow(MixedModeError);
    const prov = buildAnalytics(dataset([rec({ date: day(9), recMode: "provisional", subjects: [subj({})] })], { mode: "provisional" }), {});
    expect(prov.mode).toBe("provisional");
    expect(prov.attention.available).toBe(false);
  });

  it("leaves unsupported formulas out visibly", () => {
    const r = buildAnalytics(dataset([...series([90]), rec({ date: day(9), formula: "savour-m9.9", subjects: [subj({})] })]), {});
    expect(r.unsupported).toHaveLength(1);
    expect(r.counts.subjectSessions).toBe(1);
  });
});

describe("historical grouping never relabels snapshots", () => {
  const ds = dataset([
    rec({ date: day(1), legacy: true, formula: "savour-m2.1", subjects: [subj({ id: "a", name: "Alpha Stall" })] }),
    rec({ date: day(2), subjects: [subj({ id: "a", name: "Alpha Stall", extra: { category_id: "c1", category_name: "Grills" } })] }),
    rec({ date: day(3), subjects: [subj({ id: "a", name: "Alpha Grill House", extra: { category_id: "c1", category_name: "Grills" } }),
      subj({ id: "b", name: "Beta" })] }),
  ], {
    categories_now: [{ id: "c1", name: "Barbecue", archived: true }],
    subjects_now: [{ id: "a", name: "Alpha Grill House", archived: false }],
  });
  const r = buildAnalytics(ds, {});

  it("groups by the category recorded at approval, annotating the current name", () => {
    expect(r.categories.map((c) => [c.label, c.annotation, c.counts.subjectSessions])).toEqual([
      ["Grills", "now called Barbecue, archived", 2], ["Not recorded at approval", null, 1], ["Uncategorised", null, 1],
    ]);
    expect(r.categoryOptions.find((c) => c.id === "c1")!.name).toBe("Grills (now Barbecue)");
  });

  it("keeps one stable history per subject across renames", () => {
    const h = r.histories.find((x) => x.subjectId === "a")!;
    expect(h.names).toEqual(["Alpha Stall", "Alpha Grill House"]);
    expect(h.currentName).toBe("Alpha Grill House");
    expect(h.points.map((p) => p.nameAtApproval)).toEqual(["Alpha Stall", "Alpha Stall", "Alpha Grill House"]);
    expect(h.points.map((p) => p.versionBreak)).toEqual([false, true, false]); // m2.1 -> m3.1 formula break
  });

  it("subject-level filters select rows from the same dataset", () => {
    expect(buildAnalytics(ds, { category_id: NOT_RECORDED }).counts.subjectSessions).toBe(1);
    expect(buildAnalytics(ds, { category_id: "c1" }).counts.subjectSessions).toBe(2);
    expect(buildAnalytics(ds, { subject_id: "b" }).histories.map((x) => x.subjectId)).toEqual(["b"]);
    expect(buildAnalytics(ds, { subject_type: NOT_RECORDED }).counts.subjectSessions).toBe(1);
  });
});

describe("all three starter packs and location comparison", () => {
  const ds = dataset([
    rec({ date: day(1), pack: "food_vendors", mode: "scored", tv: "food", subjects: [subj({ outcome: "early" })] }),
    rec({ date: day(2), pack: "restaurant_ops", tv: "rest", location: "loc-annex", locationName: "Annex",
      criteria: [{ key: "hygiene", label: "Hygiene", allow_na: false, critical: true }], subjects: [subj({ id: "k", answers: [{ hygiene: 2 }] })] }),
    rec({ date: day(3), pack: "supplier_service", tv: "sup", criteria: [{ key: "quality", label: "Quality", allow_na: false, trigger_at_or_below: 2 }],
      subjects: [subj({ id: "s", answers: [{ quality: 4 }] })] }),
  ], { options: { locations: [{ id: "loc-main", name: "Main" }, { id: "loc-annex", name: "Annex Kitchen" }], template_versions: [], packs: [], first_date: null, last_date: null } });
  const r = buildAnalytics(ds, {});

  it("keeps one comparable group per pack/version and combined only for scored attendance", () => {
    expect(r.versionGroups.map((g) => [g.templateVersionId, g.quality[0].quality, g.quality[0].combined])).toEqual([
      ["food", 90, (14 / 15) * 100], ["rest", 40, null], ["sup", 80, null]]);
    expect(r.versionGroups[0].attendance).not.toBeNull();
    expect(r.versionGroups[1].attendance).toBeNull();
  });

  it("compares locations by ID with approval-time names and current-name annotation", () => {
    expect(r.locations.map((l) => [l.label, l.annotation])).toEqual([["Annex", "now called Annex Kitchen"], ["Main", null], ["Main", null]]);
  });
});

describe("live flags", () => {
  const finding = (extra: Partial<AnalyticsFinding>): AnalyticsFinding => ({
    finding_id: "f1", session_id: "s1", session_name: "Panel", local_date: day(5), session_status: "approved", session_revision: 2,
    subject_id: "alpha", subject_name: "Alpha Stall", kind: "generated", criterion_key: "taste", severity: "critical",
    title: "Taste scored 1 (at or below 2)", revision: 2, state: "open", current: true, rule: "rule",
    repeat: { status: "insufficient_data", window: 3, prior_sessions_checked: 1 }, created_at: "", ...extra,
  });
  it("flags current open critical findings and overdue actions only", () => {
    const ds = dataset(series([90]), {
      findings: [finding({}), finding({ finding_id: "f2", current: false }), finding({ finding_id: "f3", state: "resolved" }),
        finding({ finding_id: "f4", severity: "high" })],
      actions: [
        { action_id: "a1", finding_id: "f1", session_id: "s1", session_name: "Panel", local_date: day(5), subject_id: "alpha",
          subject_name: "Alpha Stall", issue: "Fix", severity: "critical", status: "ready_for_verification", due_date: day(4), due_state: "overdue" },
        { action_id: "a2", finding_id: "f1", session_id: "s1", session_name: "Panel", local_date: day(5), subject_id: "alpha",
          subject_name: "Alpha Stall", issue: "Fix", severity: "critical", status: "open", due_date: day(20), due_state: "due_today" },
      ],
    });
    const flags = buildAnalytics(ds, {}).attention.flags;
    expect(flags.map((f) => [f.kind, f.sources[0].findingId ?? f.sources[0].actionId])).toEqual([["critical", "f1"], ["overdue", "a1"]]);
    expect(flags[0].detail).toContain("Repeat check: insufficient data (1 of 3 prior sessions)");
  });
});

describe("filters from the query string", () => {
  it("accepts valid values and drops the rest", () => {
    const { filters, ignored } = parseFilters({ from: "2026-10-01", to: "2026-13-40", location_id: "x", pack: "food_vendors",
      category_id: "none", subject_type: "robot", subject_id: "11111111-1111-4111-8111-111111111111" });
    expect(filters).toEqual({ from: "2026-10-01", pack: "food_vendors", category_id: "none", subject_id: "11111111-1111-4111-8111-111111111111" });
    expect(ignored.sort()).toEqual(["location_id", "subject_type", "to"]);
    expect(parseFilters({ from: "2026-10-09", to: "2026-10-01" }).filters).toEqual({});
  });
});

describe("analytics exports", () => {
  const ds = dataset([
    ...series([90, 90, 90, 80, 80, 80]).map((r) => { r.inputs.subjects[0].name = "=HYPERLINK(\"http://x\")"; return r; }),
    rec({ date: day(9), subjects: [subj({ id: "b", name: "@Beta", answers: [q(70)] })] }),
  ]);
  const r = buildAnalytics(ds, {});

  it("CSV carries exactly the shared sections and numbers, with formula-injection defence", () => {
    const csv = buildAnalyticsCsv(ds, {}, r);
    for (const s of analyticsSections(ds, r)) {
      expect(csv).toContain(`"${s.title}"`);
      for (const row of s.rows) for (const cell of row) if (typeof cell === "number") expect(csv).toContain(`"${cell}"`);
    }
    expect(csv).toContain(`"Subject-sessions","7"`);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain(`"'@Beta"`);
    expect(csv).not.toMatch(/(^|,)"[=+\-@]/m);
    expect(csv).toContain(RULES.decline.slice(0, 40));
  });

  it("never includes assessor identities", () => {
    const csv = buildAnalyticsCsv(ds, {}, r);
    expect(csv).not.toContain("Ayo Assessor");
  });

  it("PDF is built from the same sections with clean metadata", async () => {
    const bytes = await buildAnalyticsPdf(ds, {}, r, new Date("2026-10-20T10:00:00Z"));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe("SAVOUR analytics - approved - 2026-10-20");
    expect([doc.getAuthor(), doc.getSubject()].join("|")).not.toContain("Ayo");
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("Ayo Assessor");
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });
});
