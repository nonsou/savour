import { describe, expect, it } from "vitest";
import {
  formatPct, rollupByTemplate, scoreAssessment, scoreSubject, summarizeSession,
} from "@/lib/scoring";
import { assessment, inputs, subject, TWO } from "./fixtures";

const q45 = { taste: 4, hygiene: 5 };
const tpl = (mode: "off" | "presence" | "scored", criteria = TWO) => inputs(mode, [], criteria).template;

describe("PRD SC03 acceptance fixtures", () => {
  it("Taste 4 + Hygiene 5 gives quality 90%", () => {
    expect(scoreAssessment(TWO, q45).pct).toBe(90);
  });

  it.each([
    ["early", "93.3%"], ["middle", "80.0%"], ["late", "66.7%"],
  ] as const)("combined with %s is %s", (outcome, expected) => {
    const r = scoreSubject(tpl("scored"), subject(outcome, [assessment(q45)]));
    expect(formatPct(r.quality)).toBe("90.0%");
    expect(formatPct(r.combined)).toBe(expected);
  });

  it("absence: attendance 0/5, quality AND combined null (not zero)", () => {
    const r = scoreSubject(tpl("scored"), subject("absent", []));
    expect(r.attendancePoints).toBe(0);
    expect(r.quality).toBeNull();
    expect(r.combined).toBeNull();
    expect(r.status).toBe("absent");
  });

  it("attendance off: 4 and 5 still give 90% with no attendance component", () => {
    const r = scoreSubject(tpl("off"), subject("assessed", [assessment(q45)]));
    expect(r.quality).toBe(90);
    expect(r.attendancePoints).toBeNull();
    expect(r.combined).toBeNull();
  });

  it("presence only: a gate without points", () => {
    const r = scoreSubject(tpl("presence"), subject("present", [assessment(q45)]));
    expect(r.attendancePoints).toBeNull();
    expect(r.combined).toBeNull();
    expect(r.quality).toBe(90);
  });

  it("one permitted N/A leaves 4/5 = 80% with coverage 1 of 2", () => {
    const a = scoreAssessment(TWO, { taste: 4, hygiene: { na: "Kitchen closed" } });
    expect(a.pct).toBe(80);
    expect([a.applicable, a.total]).toEqual([1, 2]);
  });

  it("all N/A is Not assessed, never a score", () => {
    const allNa = [{ key: "a", label: "A", allow_na: true }, { key: "b", label: "B", allow_na: true }];
    const r = scoreSubject(tpl("off", allNa), subject("assessed", [assessment({ a: { na: "x" }, b: { na: "y" } })]));
    expect(r.quality).toBeNull();
    expect(r.status).toBe("all_na");
  });
});

describe("invalid answers never produce misleading totals", () => {
  it.each([
    ["out of range", { taste: 6, hygiene: 5 }],
    ["zero", { taste: 0, hygiene: 5 }],
    ["fractional", { taste: 3.5, hygiene: 5 }],
    ["missing", { taste: 4 }],
    ["N/A not permitted", { taste: { na: "x" }, hygiene: 5 }],
    ["N/A without reason", { taste: 4, hygiene: { na: " " } }],
  ])("%s is incomplete", (_n, answers) => {
    const a = scoreAssessment(TWO, answers as never);
    expect(a.complete).toBe(false);
    expect(a.pct).toBeNull();
  });
});

describe("multiple assessors and canonical attendance", () => {
  it("aggregates quality first, then adds attendance once", () => {
    // 90% and 70% -> quality 80%; early: (8 + 5) / 15 = 86.7%
    const r = scoreSubject(tpl("scored"), subject("early", [assessment(q45), assessment({ taste: 3, hygiene: 4 }, "Assessor 2")]));
    expect(r.quality).toBe(80);
    expect(formatPct(r.combined)).toBe("86.7%");
    expect(r.assessorsScored).toBe(2);
  });

  it("two assessors produce one attendance outcome in the session summary", () => {
    const sum = summarizeSession(inputs("scored", [
      subject("absent", [], { subject_id: "a", required_assessors: 2 }),
      subject("late", [assessment(q45), assessment(q45, "Assessor 2")], { subject_id: "b" }),
    ]));
    expect(sum.attendance).toMatchObject({ confirmed: 2, present: 1, rate: 50, avgPoints: 0.5 });
    expect(sum.coverage).toMatchObject({ complete: 1, due: 1, excludedAbsent: 1, pct: 100 });
  });

  it("never pools unlike N/A sets into quality, combined, session or dashboard totals", () => {
    // Assessor 1 scores both criteria; Assessor 2 marks Hygiene N/A.
    const mixed = [assessment(q45), assessment({ taste: 4, hygiene: { na: "closed" } }, "Assessor 2")];
    const r = scoreSubject(tpl("scored"), subject("early", mixed));
    expect(r.status).toBe("mixed_na");
    expect([r.quality, r.combined]).toEqual([null, null]);
    expect(r.comparable).toBe(false);
    expect(r.applicabilitySets).toHaveLength(2);
    expect(r.assessments.map((a) => a.result.pct)).toEqual([90, 80]); // detail still visible
    expect(r.attendancePoints).toBe(5);
    const doc = inputs("scored", [
      subject("early", mixed, { subject_id: "m" }),
      subject("late", [assessment(q45)], { subject_id: "ok" }),
    ]);
    const sum = summarizeSession(doc);
    expect(sum.quality).toMatchObject({ mean: 90, included: 1, excludedMixed: 1 });
    expect(sum.combined.included).toBe(1);
    expect(formatPct(sum.combined.mean)).toBe("66.7%");
    const [roll] = rollupByTemplate([doc]);
    expect(roll.quality).toBe(90);
    expect(formatPct(roll.combined)).toBe("66.7%");
  });

  it("an all-N/A assessor next to a scoring assessor is also not comparable", () => {
    const allNaTwo = [{ key: "a", label: "A", allow_na: true }, { key: "b", label: "B", allow_na: true }];
    const r = scoreSubject(tpl("off", allNaTwo), subject("assessed", [
      assessment({ a: 5, b: 5 }), assessment({ a: { na: "x" }, b: { na: "y" } }, "Assessor 2"),
    ]));
    expect(r.status).toBe("mixed_na");
    expect(r.quality).toBeNull();
  });

  it("coverage and means exclude a subject missing a required response", () => {
    const sum = summarizeSession(inputs("off", [
      subject("assessed", [assessment(q45)], { subject_id: "a", required_assessors: 2 }),
      subject("assessed", [assessment(q45), assessment(q45, "B")], { subject_id: "b" }),
    ]));
    expect(sum.subjects[0].status).toBe("incomplete");
    expect(sum.subjects[0].quality).toBeNull();
    expect(sum.subjects[0].assessments[0].result.pct).toBe(90);
    expect(sum.coverage).toMatchObject({ complete: 1, due: 2, pct: 50 });
    expect(sum.quality).toMatchObject({ mean: 90, included: 1 });
  });

  it("an unrecorded outcome is never counted complete", () => {
    const sum = summarizeSession(inputs("scored", [subject("unknown", [assessment(q45)])]));
    expect(sum.subjects[0].status).toBe("unknown");
    expect(sum.coverage.complete).toBe(0);
    expect(sum.quality.mean).toBeNull();
  });

  it("attendance off: not assessed stays in the coverage denominator", () => {
    const sum = summarizeSession(inputs("off", [
      subject("assessed", [assessment(q45)], { subject_id: "a" }),
      subject("not_assessed", [], { subject_id: "b", outcome_reason: "Closed" }),
    ]));
    expect(sum.attendance).toBeNull();
    expect(sum.coverage).toMatchObject({ complete: 1, due: 2, pct: 50 });
  });

  it("an absent observation without scores is incomplete for a present subject", () => {
    const r = scoreSubject(tpl("scored"), subject("early", [assessment(null, "A", { observed_attendance: "absent" })]));
    expect(r.status).toBe("incomplete");
    expect(r.quality).toBeNull();
  });

  it("zero denominators are not applicable, not zero", () => {
    const sum = summarizeSession(inputs("scored", [subject("absent", [], { subject_id: "a" })]));
    expect(sum.coverage.pct).toBeNull();
    expect(sum.quality.mean).toBeNull();
  });
});

describe("dashboard rollup", () => {
  it("groups like-for-like by template version with equal weight per subject-session", () => {
    const a = inputs("scored", [subject("early", [assessment(q45)], { subject_id: "x" })], TWO, "v1");
    const b = inputs("scored", [subject("late", [assessment({ taste: 3, hygiene: 3 })], { subject_id: "y" })], TWO, "v1");
    const c = inputs("off", [subject("assessed", [assessment({ storage: 5 })])], [{ key: "storage", label: "Storage", allow_na: false }], "v2");
    const rows = rollupByTemplate([a, b, c]);
    expect(rows).toHaveLength(2);
    const v1 = rows.find((r) => r.templateVersionId === "v1")!;
    expect(v1).toMatchObject({ sessions: 2, subjectSessions: 2, quality: 75, attendanceRate: 100 });
    expect(rows.find((r) => r.templateVersionId === "v2")!.attendanceRate).toBeNull();
  });
});

describe("overview metrics", () => {
  it("are unavailable (null), never zero, when the dashboard failed to load", async () => {
    const { overviewMetrics, setupChecklist } = await import("@/lib/report");
    expect(overviewMetrics(null)).toBeNull();
    expect(overviewMetrics({} as never)).toBeNull();
    expect(overviewMetrics({ approved: [], under_revision: [] })).toEqual({ approved: 0, subjectsScored: 0, underRevision: 0 });
    const doc = inputs("off", [subject("assessed", [assessment(q45)], { subject_id: "a" })]);
    expect(overviewMetrics({ approved: [{ session_id: "s", revision: 1, approved_at: "", inputs: doc }], under_revision: [] }))
      .toEqual({ approved: 1, subjectsScored: 1, underRevision: 0 });
    expect(setupChecklist([1, null, 1, 1])).toEqual({ known: false, incomplete: false });
    expect(setupChecklist([1, 0, 1, 1])).toEqual({ known: true, incomplete: true });
  });
});
