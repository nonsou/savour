// Regression for the browser QA defect: a Verify that lost to a concurrent Return (stale version)
// made no change, but its error vanished because the page refresh removed the Verify form that owned
// the result. The action page now has one always-rendered panel that owns the result; steps come
// only from the fresh server read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { availableSteps, describeActionResult, type ActionDetail, type StepInfo } from "@/lib/corrective";

const A = "eeeeeeee-0000-4000-8000-000000005101";
const B = "eeeeeeee-0000-4000-8000-000000005102";
const ACT = "eeeeeeee-0000-4000-8000-000000005103";
const SES = "eeeeeeee-0000-4000-8000-000000005104";
const state = vi.hoisted(() => ({ workspace: "", rpc: vi.fn(), refresh: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: state.refresh }));
vi.mock("@/lib/auth", () => ({
  isUuid: (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  requireUser: async () => ({ supabase: {
    rpc: state.rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { workspace_id: state.workspace }, error: null }) }) }) }),
  } }),
}));
import { saveActionStep } from "@/app/w/[ws]/actions/commands";
import { ActionPanel } from "@/app/w/[ws]/actions/[id]/action-panel";

const reviewer = { review: true, assignee: false, manager: false, self_verification: false };
const stepsFor = (status: ActionDetail["action"]["status"]) =>
  availableSteps({ action: { status } as ActionDetail["action"], permissions: reviewer });
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries({ ws: A, action: ACT, session: SES, version: "11", idempotency_key: B, ...fields })) f.set(k, v);
  return f;
};
beforeEach(() => { state.workspace = A; state.rpc.mockReset(); state.refresh.mockReset(); });

describe("save result explained against the live action", () => {
  it("a verify that lost to a concurrent return says nothing was saved, the new state, and that the step is gone", () => {
    const view = describeActionResult(
      { error: "This was changed by someone else since you loaded it. Reload to see the latest version.", data: { step: "verify" } },
      { status: "in_progress", version: 12, steps: stepsFor("in_progress") });
    expect(view).toEqual({ tone: "error", title: "Verify and close: not saved", lines: [
      "This was changed by someone else since you loaded it. Reload to see the latest version.",
      "Nothing was saved by this attempt.", "The action is now In progress (version 12).",
      "Verify and close is no longer available to you. The steps below show what you can do now."] });
  });

  it("does not claim a step vanished when it is still offered", () => {
    const view = describeActionResult({ error: "A reason is required.", data: { step: "return" } },
      { status: "ready_for_verification", version: 11, steps: stepsFor("ready_for_verification") })!;
    expect(view.lines.some((l) => l.includes("no longer available"))).toBe(false);
  });

  it("explains success too, after the success removed the step", () => {
    expect(describeActionResult({ ok: "Returned to the assignee for more work.", data: { step: "return" } },
      { status: "in_progress", version: 12, steps: stepsFor("in_progress") }))
      .toEqual({ tone: "ok", title: "Return for more work: saved", lines: ["Returned to the assignee for more work.", "The action is now In progress (version 12)."] });
    expect(describeActionResult(null, { status: "open", version: 1, steps: [] })).toBeNull();
  });

  it("treats a blocked self-verification as not offered", () => {
    const blocked: StepInfo[] = [{ step: "verify", blocked: "another reviewer must verify" }];
    expect(describeActionResult({ error: "x", data: { step: "verify" } }, { status: "ready_for_verification", version: 3, steps: blocked })!
      .lines.at(-1)).toMatch(/no longer available/);
  });
});

describe("saveActionStep (the panel's single server action)", () => {
  it("returns the refusal tagged with its step and re-reads the page so stale steps are replaced", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "stale_version" } });
    const r = await saveActionStep(null, form({ step: "verify", command: "verify", confirm: "on" }));
    expect(r).toEqual({ error: expect.stringContaining("changed by someone else"), data: { step: "verify" } });
    expect(state.rpc).toHaveBeenCalledOnce();
    expect(state.rpc.mock.calls[0]).toEqual(["transition_action", { p_action: ACT, p_command: "verify", p_expected_version: 11,
      p_evidence: null, p_reason: null, p_idempotency_key: B }]);
    expect(state.refresh).toHaveBeenCalledWith(`/w/${A}/actions/${ACT}`);
  });

  it("routes edits to update_action with the form's version and key, and tags success", async () => {
    state.rpc.mockResolvedValue({ data: { action_id: ACT, version: 12, status: "open", replayed: false }, error: null });
    const r = await saveActionStep(null, form({ step: "edit", due_date: "2026-10-20" }));
    expect(r).toEqual({ ok: "Action updated.", data: { step: "edit" } });
    expect(state.rpc.mock.calls[0][0]).toBe("update_action");
    expect(state.rpc.mock.calls[0][1]).toMatchObject({ p_action: ACT, p_expected_version: 11, p_due_date: "2026-10-20", p_idempotency_key: B });
  });

  it("keeps the business guard: another business's action never reaches the database or refreshes", async () => {
    state.workspace = B;
    const r = await saveActionStep(null, form({ step: "verify", command: "verify", confirm: "on" }));
    expect(r?.error).toBeTruthy();
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("reports a replayed retry without duplicating", async () => {
    state.rpc.mockResolvedValue({ data: { action_id: ACT, version: 12, status: "in_progress", replayed: true }, error: null });
    expect((await saveActionStep(null, form({ step: "return", command: "return", reason: "Photo missing" })))?.ok)
      .toBe("Returned to the assignee for more work (already saved earlier; nothing was duplicated).");
  });
});

describe("action panel markup across availability changes", () => {
  const render = (status: ActionDetail["action"]["status"], version: number, steps: StepInfo[]) => renderToStaticMarkup(createElement(ActionPanel, {
    ws: A, actionId: ACT, sessionId: SES, version, status, steps,
    keys: Object.fromEntries(steps.map((s, i) => [s.step, `key-${s.step}-${i}`])), edit: null,
  }));

  it("always renders the same live result region first, with or without steps", () => {
    for (const html of [render("ready_for_verification", 11, stepsFor("ready_for_verification")), render("closed", 13, []),
      render("in_progress", 12, stepsFor("in_progress"))]) {
      expect(html).toMatch(/<h2 id="action-steps">Next steps<\/h2><div id="action-result" class="action-result" tabindex="-1" role="status" aria-live="polite" aria-atomic="true">/);
      expect(html.indexOf('id="action-result"')).toBeLessThan(html.includes("<form") ? html.indexOf("<form") : Infinity);
    }
  });

  it("offers only the fresh steps: no stale Verify after a return, no forms when nothing is allowed", () => {
    const ready = render("ready_for_verification", 11, stepsFor("ready_for_verification"));
    expect(ready).toContain('name="command" value="verify"');
    const after = render("in_progress", 12, stepsFor("in_progress"));
    expect(after).not.toContain('value="verify"');
    expect(after).toContain('name="command" value="submit"');
    expect(after).toContain('name="version" value="12"');
    expect(after).not.toContain('name="version" value="11"');
    const none = render("closed", 13, []);
    expect(none).not.toContain("<form");
    expect(none).toContain("No further steps are available to you for this action.");
  });

  it("gives each form its own server-minted idempotency key", () => {
    const html = render("ready_for_verification", 11, stepsFor("ready_for_verification").filter((s) => s.step !== "edit"));
    const keys = [...html.matchAll(/name="idempotency_key" value="([^"]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(["key-return-0", "key-verify-1", "key-cancel-2"]);
  });
});

describe("structure that keeps the result alive", () => {
  const root = join(import.meta.dirname, "..", "..", "src", "app", "w", "[ws]", "actions", "[id]");
  const page = readFileSync(join(root, "page.tsx"), "utf8");
  const panel = readFileSync(join(root, "action-panel.tsx"), "utf8");

  it("the page renders the panel unconditionally, keyed by action, and has no per-step action state", () => {
    expect(page).toMatch(/\n {6}<ActionPanel key=\{a\.id\}/);
    expect(page).not.toMatch(/steps\.length[^\n]*&&[^\n]*ActionPanel/);
    expect(page).not.toContain("ActionForm");
    expect(page).not.toContain("useActionState");
  });

  it("the panel owns exactly one action state at its top level", () => {
    expect(panel.startsWith('"use client";')).toBe(true);
    expect(panel.match(/useActionState\(/g)).toHaveLength(1);
    expect(panel).toMatch(/export function ActionPanel\([^]*?\n {2}const \[result, save, pending\] = useActionState\(saveActionStep, null\);/);
  });
});
