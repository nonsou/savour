import { describe, expect, it } from "vitest";
import { buildPdf } from "@/lib/pdf";
import {
  buildCsv, buildDashboardCsv, overviewMetrics, partitionReports, setupSteps, summaryRows,
  type ReportEnvelope, type SetupProgress,
} from "@/lib/report";
import {
  formatPct, reviewSignals, rollupByTemplate, scoreSubject, subjectStatusLabel, summarizeSession,
  UnknownFormulaError, type ReportInputs,
} from "@/lib/scoring";
import { assessment, inputs, subject, TWO } from "./fixtures";

const q45 = { taste: 4, hygiene: 5 };
const m2 = (doc: ReportInputs, extra: Partial<ReportInputs> = {}): ReportInputs => ({ ...doc, formula_version: "savour-m2.1", ...extra });
const waiver = (label = "Assessor 2", reason = "Ill on the day") => ({ assessor_label: label, reason, waived_at: "2026-10-10T10:00:00Z" });
const envelope = (doc: ReportInputs): ReportEnvelope => ({
  meta: { status: "approved", revision: 1, approved_at: "2026-10-10T15:00:00Z", approver_name: "Rita Reviewer",
    formula_version: doc.formula_version, is_current: true, redacted: true, session_status: "approved", session_revision: 1, reopen_reason: null },
  inputs: doc, revisions: [],
});

describe("formula dispatch", () => {
  it("m2.1 computes an m1.1-shaped input identically (missing fields read as zero)", () => {
    const doc = inputs("scored", [
      subject("early", [assessment(q45), assessment({ taste: 3, hygiene: 4 }, "Assessor 2")], { subject_id: "a" }),
      subject("absent", [], { subject_id: "b", required_assessors: 2 }),
      subject("late", [assessment({ taste: 4, hygiene: { na: "closed" } })], { subject_id: "c" }),
    ]);
    const a = summarizeSession(doc);
    const b = summarizeSession(m2(doc));
    expect(b.subjects.map((s) => [s.status, s.quality, s.combined])).toEqual(a.subjects.map((s) => [s.status, s.quality, s.combined]));
    expect([b.quality, b.combined, b.attendance, b.coverage]).toEqual([a.quality, a.combined, a.attendance, a.coverage]);
  });

  it("refuses an unknown formula visibly instead of recomputing", () => {
    const doc = { ...inputs("off", [subject("assessed", [assessment(q45)])]), formula_version: "savour-m9.9" };
    expect(() => summarizeSession(doc)).toThrow(UnknownFormulaError);
    expect(() => summarizeSession(doc)).toThrow(/savour-m9\.9/);
    expect(() => rollupByTemplate([doc])).toThrow(UnknownFormulaError);
  });
});

describe("waivers keep missing work missing", () => {
  const doc = m2(inputs("scored", [
    subject("early", [assessment(q45)], { subject_id: "w", name: "Waived Stall", required_assessors: 2, waived_assessors: 1, waivers: [waiver()] }),
    subject("late", [assessment(q45)], { subject_id: "ok", name: "Complete Stall" }),
    subject("middle", [], { subject_id: "all", name: "All Waived", required_assessors: 2, waived_assessors: 2,
      waivers: [waiver("Assessor 1", "Rained off"), waiver("Assessor 2", "Rained off")] }),
  ]));
  const sum = summarizeSession(doc);

  it("a partly waived subject has no headline, stays incomplete and keeps its required count", () => {
    const w = sum.subjects[0];
    expect([w.status, w.quality, w.combined, w.requiredAssessors, w.missingResponses, w.waivedAssessors]).toEqual(["incomplete", null, null, 2, 1, 1]);
    expect(w.assessments[0].result.pct).toBe(90); // available detail still shown
    expect(w.attendancePoints).toBe(5);          // attendance still counted once
    expect(subjectStatusLabel(w)).toBe("Incomplete — 1 of 2 response(s) missing (1 waived)");
  });

  it("a fully waived subject approves with nothing invented: no quality, all responses missing", () => {
    const a = sum.subjects[2];
    expect([a.status, a.quality, a.missingResponses, a.waivedAssessors]).toEqual(["incomplete", null, 2, 2]);
  });

  it("coverage and averages exclude waived subjects and disclose them", () => {
    expect(sum.coverage).toMatchObject({ complete: 1, due: 3, waivedSubjects: 2, waivedResponses: 3 });
    expect(sum.quality).toMatchObject({ mean: 90, included: 1 });
    expect(formatPct(sum.combined.mean)).toBe("66.7%");
    expect(summaryRows(sum)[0][1]).toContain("2 subject(s) incomplete with 3 waived response(s)");
  });

  it("CSV and PDF show waived responses as missing, with reasons", async () => {
    const csv = buildCsv(envelope(doc));
    expect(csv).toContain(`"Waived Stall","Early and ready","","5","","","1","2","1","Incomplete — 1 of 2 response(s) missing (1 waived)","1","1"`);
    expect(csv).toContain("Waived responses (still counted as missing)");
    expect(csv).toContain(`"All Waived","Assessor 1","Rained off"`);
    const pdf = await buildPdf(envelope(doc), new Date("2026-10-10T16:00:00Z"));
    expect(pdf.length).toBeGreaterThan(1000);
  });
});

describe("removed and restored subjects", () => {
  it("are disclosed but never counted", () => {
    const doc = m2(inputs("off", [subject("assessed", [assessment(q45)], { restored: { restored_at: "2026-10-10T12:00:00Z", reason: "Back" } })],
      TWO), { removed_subjects: [{ subject_id: "gone", name: "Gone Stall", removed_at: "2026-10-10T11:00:00Z", reason: "Withdrew", retained_responses: 1 }] });
    const sum = summarizeSession(doc);
    expect(sum.subjects).toHaveLength(1);
    expect(sum.coverage).toMatchObject({ complete: 1, due: 1 });
    expect(sum.subjects[0].restored?.reason).toBe("Back");
    expect(summaryRows(sum).find(([k]) => k === "Removed from roster")?.[1]).toBe("Gone Stall (Withdrew)");
    expect(buildCsv(envelope(doc))).toContain(`"Gone Stall","Withdrew"`);
  });
});

describe("attendance-only templates", () => {
  it("score attendance only, with quality reported as not applicable", () => {
    const doc = m2(inputs("scored", [
      subject("early", [], { subject_id: "a", required_assessors: 0 }), subject("absent", [], { subject_id: "b", required_assessors: 0 }),
    ], []));
    const sum = summarizeSession(doc);
    expect(sum.attendanceOnly).toBe(true);
    expect(sum.subjects.map((s) => [s.status, s.quality, s.attendancePoints])).toEqual([["attendance_only", null, 5], ["absent", null, 0]]);
    expect(sum.attendance).toMatchObject({ rate: 50, avgPoints: 2.5 });
    expect(summaryRows(sum).find(([k]) => k === "Mean quality")?.[1]).toBe("Not applicable (attendance-only template)");
    expect(summaryRows(sum).some(([k]) => k === "Mean combined")).toBe(false);
  });
});

describe("samples never reach business totals", () => {
  const real = inputs("off", [subject("assessed", [assessment({ taste: 3, hygiene: 3 })], { subject_id: "r" })], TWO, "tv");
  const sample = m2(inputs("off", [subject("assessed", [assessment({ taste: 5, hygiene: 5 })], { subject_id: "s" })], TWO, "tv"));
  sample.session = { ...sample.session, is_sample: true, name: "SAMPLE - Practice inspection" };
  const dash = {
    approved: [
      { session_id: "r", revision: 1, approved_at: "2026-10-10T15:00:00Z", inputs: real },
      { session_id: "s", revision: 1, approved_at: "2026-10-10T15:00:00Z", inputs: sample },
    ],
    under_revision: [],
  };

  it("rollups, overview metrics and the dashboard CSV drop a sample even if one is delivered", () => {
    expect(rollupByTemplate([real, sample])[0]).toMatchObject({ sessions: 1, quality: 60 });
    expect(overviewMetrics(dash)).toEqual({ approved: 1, subjectsScored: 1, underRevision: 0 });
    const csv = buildDashboardCsv(dash, { name: "Biz", timezone: "Africa/Lagos" });
    expect(csv).not.toContain("SAMPLE - Practice inspection");
    expect(csv).toContain("SAMPLE practice sessions excluded");
  });

  it("unsupported formulas are listed, not computed", () => {
    const odd = { ...real, formula_version: "savour-m9.9" };
    const d = { approved: [{ session_id: "o", revision: 1, approved_at: "", inputs: odd }], under_revision: [] };
    expect(partitionReports(d.approved).unsupported).toHaveLength(1);
    expect(overviewMetrics(d)).toEqual({ approved: 0, subjectsScored: 0, underRevision: 0 });
    expect(buildDashboardCsv(d, { name: "Biz", timezone: "Africa/Lagos" })).toContain("Not shown: unsupported formula savour-m9.9");
  });

  it("sample reports and exports are labelled", () => {
    const csv = buildCsv(envelope(sample));
    expect(csv).toContain("SAMPLE — practice data");
  });
});

describe("review signals", () => {
  it("report completeness, attendance disagreement and score spread", () => {
    const tpl = inputs("scored", [], TWO).template;
    const s = scoreSubject(tpl, subject("early", [
      assessment({ taste: 5, hygiene: 5 }, "A", { observed_attendance: "early" }),
      assessment({ taste: 2, hygiene: 4 }, "B", { observed_attendance: "late" }),
    ], { required_assessors: 3, waived_assessors: 1 }));
    const r = reviewSignals(tpl, s);
    expect(r).toMatchObject({ required: 3, complete: 2, waived: 1, missing: 1, attendanceDisagreement: ["early", "late"] });
    expect(r.spread).toBeCloseTo(40);
    expect(r.criterionSpread).toEqual([{ key: "taste", label: "Taste", min: 2, max: 5 }]);
  });

  it("hide the aggregate spread when N/A patterns differ, keeping per-criterion comparison of shared scores", () => {
    const tpl = inputs("scored", [], TWO).template;
    // A scores Taste 5 + Hygiene 1 = 60%; B marks Hygiene N/A and scores Taste 2 = 40%. The 20-point
    // "spread" would compare 2-criterion and 1-criterion denominators, so it must not be shown.
    const s = scoreSubject(tpl, subject("early", [
      assessment({ taste: 5, hygiene: 1 }, "A"),
      assessment({ taste: 2, hygiene: { na: "Kitchen closed" } }, "B"),
    ]));
    expect(s.assessments.map((a) => a.result.pct)).toEqual([60, 40]);
    const r = reviewSignals(tpl, s);
    expect(r.naPatternsDiffer).toBe(true);
    expect(r.spread).toBeNull();
    expect(r.criterionSpread).toEqual([{ key: "taste", label: "Taste", min: 2, max: 5 }]); // shared numeric answers only
    expect(s.status).toBe("mixed_na"); // the existing headline rule is unchanged
  });

  it("treat an all-N/A response next to a scored one as a different pattern", () => {
    const allNa = [{ key: "a", label: "A", allow_na: true }, { key: "b", label: "B", allow_na: true }];
    const tpl = inputs("off", [], allNa).template;
    const r = reviewSignals(tpl, scoreSubject(tpl, subject("assessed", [
      assessment({ a: 5, b: 1 }), assessment({ a: { na: "x" }, b: { na: "y" } }, "B"),
    ])));
    expect([r.naPatternsDiffer, r.spread, r.criterionSpread]).toEqual([true, null, []]);
  });

  it("keep the spread when both assessors used the same N/A pattern", () => {
    const tpl = inputs("scored", [], TWO).template;
    const r = reviewSignals(tpl, scoreSubject(tpl, subject("early", [
      assessment({ taste: 5, hygiene: { na: "closed" } }, "A"), assessment({ taste: 3, hygiene: { na: "closed" } }, "B"),
    ])));
    expect(r.naPatternsDiffer).toBe(false);
    expect(r.spread).toBeCloseTo(40);
  });

  it("show no spread for a single response", () => {
    const tpl = inputs("off", [], TWO).template;
    const r = reviewSignals(tpl, scoreSubject(tpl, subject("assessed", [assessment(q45)])));
    expect([r.spread, r.naPatternsDiffer, r.attendanceDisagreement, r.criterionSpread]).toEqual([null, false, [], []]);
  });
});

describe("setup checklist", () => {
  it("derives steps from SQL counts; samples are optional and never activate", () => {
    const p: SetupProgress = { locations: 1, categories: 0, subjects: 2, templates: 1, reviewers: 0, sessions: 0, opened: 0, approved: 0,
      samples: { sessions: 1, approved: 1, latest_session_id: "x" } };
    const steps = setupSteps(p, "ws");
    expect(steps.find((s) => s.key === "sample")).toMatchObject({ done: true, optional: true });
    expect(steps.find((s) => s.key === "approved")?.done).toBe(false);
  });
});
