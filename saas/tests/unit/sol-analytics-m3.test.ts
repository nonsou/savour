// Independent Sol examples with fixed expected arithmetic (not derived from the implementation).
import { describe, expect, it } from "vitest";
import { buildAnalytics, type AnalyticsDataset, type AnalyticsRecord } from "@/lib/analytics";
import { assessment, inputs, subject } from "./fixtures";
import type { ReportInputs } from "@/lib/scoring";

const SID = "eeeeeeee-0000-4000-8000-000000004001";
const CAT_A = "eeeeeeee-0000-4000-8000-000000004002";
const CAT_B = "eeeeeeee-0000-4000-8000-000000004003";
function record(i: number, p: ReportInputs): AnalyticsRecord {
  p.session.id = `session-${i}`; p.session.local_date = `2026-10-${String(i).padStart(2, "0")}`;
  return { session_id: p.session.id, revision: 1, approved_at: `${p.session.local_date}T12:00:00Z`, local_date: p.session.local_date,
    location_id: "location-1", location_now: "Site now", template_version_id: p.template.version_id, template_name: p.template.name,
    template_version: p.template.version, pack: "food_vendors", mode: "approved", inputs: p };
}
function dataset(records: AnalyticsRecord[], extra: Partial<AnalyticsDataset> = {}): AnalyticsDataset {
  return { mode: "approved", role: "owner", filters: {}, today: "2026-10-11", timezone: "Africa/Lagos", workspace_name: "QA",
    generated_at: "2026-10-11T12:00:00Z", total: records.length, truncated: false, live_flags_visible: true,
    records, findings: [], actions: [], options: { locations: [{ id: "location-1", name: "Site now" }], template_versions: [], packs: [], first_date: null, last_date: null },
    categories_now: [], subjects_now: [], ...extra };
}
const panel = (a: number, b: number) => inputs("scored", [subject("early", [assessment({ taste: a, hygiene: b })], { subject_id: SID })]);

describe("Sol: fixed analytics arithmetic", () => {
  it("flags exactly minus10pp across six comparable subject-sessions, not five", () => {
    const records = Array.from({ length: 6 }, (_, i) => record(i + 1, i < 3 ? panel(4, 4) : panel(3, 4)));
    const six = buildAnalytics(dataset(records), {});
    expect(six.attention.flags.find((f) => f.kind === "decline")).toMatchObject({ value: -10, subjectId: SID });
    const five = buildAnalytics(dataset(records.slice(1)), {});
    expect(five.attention.flags.some((f) => f.kind === "decline")).toBe(false);
    expect(five.attention.insufficient.some((f) => f.kind === "decline" && f.have === 5 && f.need === 6)).toBe(true);
  });
  it("gives each subject-session equal weight and separates N/A applicability", () => {
    const first = inputs("scored", [subject("early", [assessment({ taste: 1, hygiene: 1 }), assessment({ taste: 5, hygiene: 5 }, "Second")], { subject_id: SID })]);
    const second = panel(5, 5);
    const out = buildAnalytics(dataset([record(1, first), record(2, second)]), {});
    expect(out.versionGroups[0].quality[0]).toMatchObject({ n: 2, quality: 80 });
    const na = inputs("scored", [subject("early", [assessment({ taste: 5, hygiene: { na: "No kitchen" } })], { subject_id: SID })]);
    const split = buildAnalytics(dataset([record(1, panel(4, 4)), record(2, na)]), {});
    expect(split.versionGroups[0].quality.map((g) => g.quality).sort((a, b) => (a ?? -1) - (b ?? -1))).toEqual([80, 100]);
  });
  it("does not mix the same template's different formula labels", () => {
    const first = panel(4, 4); const second = panel(5, 5); second.formula_version = "savour-m2.1";
    const out = buildAnalytics(dataset([record(1, first), record(2, second)]), {});
    expect(out.versionGroups).toHaveLength(2);
    expect(out.versionBreaks).toHaveLength(1);
  });
});

describe("Sol: unknown work and source-specific filters", () => {
  it("discloses missing and waived responses even while the outcome remains unknown", () => {
    const p = inputs("scored", [subject("unknown", [], { subject_id: SID, required_assessors: 2, waived_assessors: 1 })]);
    const rec = record(1, p); rec.mode = "provisional";
    const out = buildAnalytics(dataset([rec], { mode: "provisional" }), {});
    expect(out.counts).toMatchObject({ unknown: 1, missingResponses: 2, waivedResponses: 1, waivedSubjects: 1 });
    expect(out.coverage).toMatchObject({ complete: 0, due: 1, pct: 0 });
    expect(out.versionGroups[0].quality).toHaveLength(0);
  });
  it("does not attach another category's action to a historical category filter just because the subject ID matches", () => {
    const first = panel(4, 4); first.subjects[0] = { ...first.subjects[0], category_id: CAT_A, category_name: "Category A" };
    const second = panel(3, 4); second.subjects[0] = { ...second.subjects[0], category_id: CAT_B, category_name: "Category B" };
    const ds = dataset([record(1, first), record(2, second)], { actions: [{ action_id: "action-b", finding_id: "finding-b", session_id: "session-2",
      session_name: "B inspection", local_date: "2026-10-02", subject_id: SID, subject_name: "Same subject", issue: "B work", severity: "high",
      status: "in_progress", due_date: "2026-10-01", due_state: "overdue" }] });
    const out = buildAnalytics(ds, { category_id: CAT_A });
    expect(out.sessions).toBe(1);
    expect(out.attention.flags.some((f) => f.kind === "overdue")).toBe(false);
  });
  it("can show the selected subject's overdue work even before its first approved inspection", () => {
    const ds = dataset([], { actions: [{ action_id: "new-action", finding_id: "new-finding", session_id: "new-session",
      session_name: "Open inspection", local_date: "2026-10-11", subject_id: SID, subject_name: "New subject", issue: "Required work", severity: "high",
      status: "open", due_date: "2026-10-10", due_state: "overdue" }] });
    const out = buildAnalytics(ds, { subject_id: SID });
    expect(out.sessions).toBe(0);
    expect(out.attention.flags.find((f) => f.kind === "overdue")).toMatchObject({ subjectId: SID });
  });
});
