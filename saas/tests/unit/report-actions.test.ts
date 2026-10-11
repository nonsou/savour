import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { availableSteps, type ActionDetail } from "@/lib/corrective";
import { buildPdf } from "@/lib/pdf";
import { appendixComparison, buildCsv, snapshotState, type AppendixAction, type ReportEnvelope } from "@/lib/report";
import { summarizeSession, type ActionSnapshot, type ReportInputs } from "@/lib/scoring";
import { validateCriteria } from "@/lib/validation";
import { assessment, inputs, subject } from "./fixtures";

const frozen = (redacted: boolean): ActionSnapshot => ({
  action_id: "a1", finding_id: "f1", subject_id: "s1", severity: "critical", status: "in_progress", issue: "=Undercooked meat",
  action_required: "Retrain on temperatures", due_date: "2026-10-15", assignee_label: redacted ? "Assignee 1" : "Ayo Assessor",
  ...(redacted ? {} : { assignee_id: "u-ayo" }), resolution_evidence: null, resolved_at: null, verified_at: null, cancel_reason: null,
  reopen_count: 0, created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T11:00:00Z", version: 2,
});
const live = (extra: Partial<AppendixAction>, redacted: boolean): AppendixAction => ({
  action_id: "a1", finding_id: "f1", subject_id: "s1", subject_name: "Vendor One", severity: "critical", status: "closed",
  issue: "=Undercooked meat", action_required: "Retrain", due_date: "2026-10-15", due_state: "done",
  assignee_label: redacted ? "Assigned staff member" : "Ayo Assessor", resolution_evidence: "+Trained 3 staff", resolved_at: null,
  verified_at: "2026-10-12T10:00:00Z", cancel_reason: null, reopen_count: 0, created_at: "2026-10-10T10:00:00Z",
  updated_at: "2026-10-12T10:00:00Z", version: 4, in_snapshot: true, snapshot_status: "in_progress", changed_since_snapshot: true,
  created_after_snapshot: false, ...extra,
});

function env(kind: "m3" | "m2" | "provisional", redacted = false): ReportEnvelope {
  const doc: ReportInputs = {
    ...inputs("scored", [subject("early", [assessment({ taste: 4, hygiene: 5 }, redacted ? "Assessor 1" : "Ayo Assessor")], { subject_id: "s1" })]),
    formula_version: kind === "m2" ? "savour-m2.1" : "savour-m3.1",
  };
  if (kind !== "m2") {
    doc.findings = [{ finding_id: "f1", subject_id: "s1", kind: "generated", criterion_key: "taste", severity: "critical",
      title: "Taste scored 1 (at or below 2)", detail: { rule: "A finding is raised when ..." }, revision: 1, created_at: "2026-10-10T09:00:00Z" }];
    doc.actions = [frozen(redacted)];
  }
  const approved = kind !== "provisional";
  return {
    meta: { status: approved ? "approved" : "provisional", revision: 1, approved_at: approved ? "2026-10-10T12:00:00Z" : undefined,
      approver_name: approved ? "Rita Reviewer" : undefined, formula_version: doc.formula_version, is_current: true, redacted,
      session_status: approved ? "approved" : "in_review", session_revision: 1, reopen_reason: null,
      actions_snapshot: kind === "m3" ? "frozen" : kind === "m2" ? "not_recorded" : "provisional" },
    inputs: doc,
    actions_appendix: {
      as_of: "2026-10-12T15:30:00Z", today: "2026-10-12", snapshot: kind === "m3" ? "frozen" : kind === "m2" ? "not_recorded" : "provisional",
      snapshot_approved_at: approved ? "2026-10-10T12:00:00Z" : null, snapshot_revision: approved ? 1 : null, redacted,
      actions: kind === "m2"
        ? [live({ in_snapshot: null, changed_since_snapshot: null, created_after_snapshot: true, snapshot_status: null }, redacted)]
        : kind === "provisional" ? [live({ in_snapshot: null, changed_since_snapshot: null, created_after_snapshot: null }, redacted)]
        : [live({}, redacted), live({ action_id: "a2", in_snapshot: false, created_after_snapshot: true, changed_since_snapshot: null,
          snapshot_status: null, issue: "Later action" }, redacted)],
      findings: [],
    },
    revisions: [],
  };
}

describe("frozen action snapshot versus the dated current appendix", () => {
  it("m3.1 approval: frozen section shows approval-time state; appendix is dated and compared", () => {
    const e = env("m3");
    expect(snapshotState(e)).toBe("frozen");
    const csv = buildCsv(e);
    expect(csv).toContain("Findings and actions at approval (revision 1");
    expect(csv).toContain(`"Vendor One","'=Undercooked meat","Critical","In progress","2026-10-15","Ayo Assessor"`);
    expect(csv).toContain("Current actions as of 12 Oct 2026, 16:30 (Africa/Lagos) — not part of the approved evidence");
    expect(csv).toContain(`"Changed since approval (was In progress)"`);
    expect(csv).toContain(`"Created after this approval"`);
    expect(csv).toContain(`"'+Trained 3 staff"`);
    expect(csv).not.toMatch(/(^|,)"[=+\-@]/m);
  });

  it("legacy approval never claims to have frozen actions", () => {
    const e = env("m2");
    expect(snapshotState(e)).toBe("not_recorded");
    const csv = buildCsv(e);
    expect(csv).toContain("No action state was frozen at this approval (formula savour-m2.1");
    expect(csv).not.toContain(`"Actions"`);
    expect(appendixComparison(e, e.actions_appendix!.actions[0])).toBe("Not frozen at this approval");
  });

  it("provisional report labels actions as live", () => {
    const e = env("provisional");
    expect(buildCsv(e)).toContain("Findings and actions (live, provisional — not frozen)");
    expect(appendixComparison(e, e.actions_appendix!.actions[0])).toBe("Live (nothing approved yet)");
  });

  it("the actions sections never change the calculated figures", () => {
    const withActions = env("m3").inputs;
    const without = { ...withActions, findings: undefined, actions: undefined };
    const a = summarizeSession(withActions);
    const b = summarizeSession(without);
    expect([a.quality, a.combined, a.coverage, a.attendance]).toEqual([b.quality, b.combined, b.coverage, b.attendance]);
  });

  it("redacted exports carry no assignee or assessor identity (CSV, PDF content and metadata)", async () => {
    const e = env("m3", true);
    const csv = buildCsv(e);
    expect(csv).not.toContain("Ayo");
    expect(csv).toContain("Assignee 1");
    expect(csv).toContain("Assigned staff member");
    const bytes = await buildPdf(e);
    const doc = await PDFDocument.load(bytes);
    expect([doc.getTitle(), doc.getAuthor(), doc.getSubject(), doc.getKeywords()].join("|")).not.toContain("Ayo");
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("Ayo");
  });

  it("PDF renders both sections with long Unicode text", async () => {
    const e = env("m3");
    e.inputs.actions![0].action_required = "Ọlá Àdìgún: " + "retrain ".repeat(250);
    const doc = await PDFDocument.load(await buildPdf(e));
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });
});

describe("step availability mirrors the database rules", () => {
  const detail = (status: ActionDetail["action"]["status"], p: Partial<ActionDetail["permissions"]>) =>
    ({ action: { status }, permissions: { review: false, assignee: false, manager: false, self_verification: false, ...p } }) as ActionDetail;
  const steps = (d: ActionDetail) => availableSteps(d).map((s) => `${s.step}${s.override ? "*" : ""}${s.blocked ? "!" : ""}`);

  it("assignee progresses only their own work, linearly", () => {
    expect(steps(detail("open", { assignee: true }))).toEqual(["start"]);
    expect(steps(detail("in_progress", { assignee: true }))).toEqual(["submit"]);
    expect(steps(detail("ready_for_verification", { assignee: true }))).toEqual([]);
    expect(steps(detail("closed", { assignee: true }))).toEqual([]);
  });

  it("reviewers progress with an override, verify others' work, and can never self-verify", () => {
    expect(steps(detail("open", { review: true }))).toEqual(["start*", "cancel", "edit"]);
    expect(steps(detail("ready_for_verification", { review: true }))).toEqual(["return", "verify", "cancel", "edit"]);
    expect(steps(detail("ready_for_verification", { review: true, self_verification: true }))).toEqual(["return", "verify!", "cancel", "edit"]);
    expect(steps(detail("ready_for_verification", { review: true, manager: true, self_verification: true }))).toEqual(["return", "verify*", "cancel", "edit"]);
    expect(steps(detail("cancelled", { review: true }))).toEqual(["reopen"]);
  });

  it("nobody else gets any step", () => {
    expect(steps(detail("open", {}))).toEqual([]);
  });
});

describe("template trigger validation (client mirror)", () => {
  it("accepts 1..4 and refuses other triggers", () => {
    expect(validateCriteria([{ key: "a", label: "A", allow_na: false, trigger_at_or_below: 2, critical: true }], false)).toBeNull();
    expect(validateCriteria([{ key: "a", label: "A", allow_na: false, trigger_at_or_below: 5 }], false)).toMatch(/1 to 4/);
  });
});
