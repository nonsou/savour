"use server";

import { revalidatePath } from "next/cache";
import { isUuid, requireUser } from "@/lib/auth";
import { friendlyError, type ActionState } from "@/lib/errors";
import { entityInWorkspace, WRONG_BUSINESS, type GuardClient, type GuardTable } from "@/lib/workspace-guard";

// Findings and corrective actions. Every call is authorized, version-checked, idempotent and audited
// in the database; these wrappers only pass the form values through. Each form carries an
// idempotency key minted when the page was rendered, so a double submit or retry replays the first
// receipt instead of writing twice.
const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const n = (f: FormData, k: string) => (s(f, k) === "" ? null : Number(s(f, k)));
const orNull = (v: string) => (v === "" ? null : v);

function refresh(f: FormData) {
  const ws = s(f, "ws");
  if (!isUuid(ws)) return;
  revalidatePath(`/w/${ws}/actions`);
  revalidatePath(`/w/${ws}/inbox`);
  if (isUuid(s(f, "session"))) revalidatePath(`/w/${ws}/sessions/${s(f, "session")}`);
  if (isUuid(s(f, "action"))) revalidatePath(`/w/${ws}/actions/${s(f, "action")}`);
}

// guard: the entity the form acts on must belong to the business in the form (route context).
// refreshOnError: a refused change to an existing action usually means it changed underneath the
// form (stale version, step no longer valid, access lost). Re-reading the page then replaces the
// stale steps with what the live database allows; the refusal itself wrote nothing.
async function call(f: FormData, fn: string, args: Record<string, unknown>, ok: (data: unknown) => string,
  guard: [GuardTable, string] | null, refreshOnError = false): Promise<ActionState> {
  const { supabase } = await requireUser();
  if (guard && !(await entityInWorkspace(supabase as unknown as GuardClient, guard[0], s(f, guard[1]), s(f, "ws")))) {
    return { error: WRONG_BUSINESS };
  }
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    if (refreshOnError) refresh(f);
    return { error: friendlyError(error) };
  }
  refresh(f);
  return { ok: ok(data) };
}

const replayNote = (data: unknown) => ((data as { replayed?: boolean } | null)?.replayed ? " (already saved earlier; nothing was duplicated)" : "");

export async function createFinding(_: ActionState, f: FormData): Promise<ActionState> {
  return call(f, "create_finding", {
    p_session: s(f, "session"), p_subject: s(f, "subject"), p_severity: s(f, "severity"), p_title: s(f, "title"),
    p_note: orNull(s(f, "note")), p_criterion_key: orNull(s(f, "criterion_key")), p_idempotency_key: s(f, "idempotency_key"),
  }, (d) => `Finding recorded${replayNote(d)}.`, ["sessions", "session"]);
}

export async function withdrawFinding(_: ActionState, f: FormData): Promise<ActionState> {
  return call(f, "withdraw_finding", { p_finding: s(f, "finding"), p_reason: s(f, "reason"), p_expected_version: n(f, "version") },
    () => "Finding withdrawn. It stays in the history and in any approval that already froze it.", ["findings", "finding"]);
}

export async function createAction(_: ActionState, f: FormData): Promise<ActionState> {
  return call(f, "create_action", {
    p_finding: s(f, "finding"), p_issue: s(f, "issue"), p_action_required: s(f, "action_required"), p_severity: s(f, "severity"),
    p_assignee: orNull(s(f, "assignee")), p_due_date: orNull(s(f, "due_date")), p_idempotency_key: s(f, "idempotency_key"),
  }, (d) => `Corrective action assigned${replayNote(d)}. The assignee sees it in their actions and inbox.`, ["findings", "finding"]);
}

export async function updateAction(_: ActionState, f: FormData): Promise<ActionState> {
  return call(f, "update_action", {
    p_action: s(f, "action"), p_expected_version: n(f, "version"), p_issue: orNull(s(f, "issue")),
    p_action_required: orNull(s(f, "action_required")), p_severity: orNull(s(f, "severity")), p_assignee: orNull(s(f, "assignee")),
    p_due_date: orNull(s(f, "due_date")), p_reason: orNull(s(f, "reason")), p_idempotency_key: s(f, "idempotency_key"),
  }, (d) => `Action updated${replayNote(d)}.`, ["actions", "action"], true);
}

const DONE: Record<string, string> = {
  start: "Marked in progress", submit: "Marked ready for verification", return: "Returned to the assignee for more work",
  verify: "Verified and closed", cancel: "Cancelled", reopen: "Reopened",
};

export async function transitionAction(_: ActionState, f: FormData): Promise<ActionState> {
  const command = s(f, "command");
  if (!(command in DONE)) return { error: "That step is not recognised." };
  if (f.get("confirm") === null && (command === "cancel" || command === "verify")) {
    return { error: "Tick the confirmation box first." };
  }
  return call(f, "transition_action", {
    p_action: s(f, "action"), p_command: command, p_expected_version: n(f, "version"),
    p_evidence: orNull(s(f, "evidence")), p_reason: orNull(s(f, "reason")), p_idempotency_key: s(f, "idempotency_key"),
  }, (d) => `${DONE[command]}${replayNote(d)}.`, ["actions", "action"], true);
}

// Single entry point for the action page's step and edit forms (one useActionState in the page's
// action panel). The result names the step it came from, so the page can still explain it after a
// refresh has removed that step's form.
export async function saveActionStep(prev: ActionState, f: FormData): Promise<ActionState> {
  const step = s(f, "step");
  const result = step === "edit" ? await updateAction(prev, f) : await transitionAction(prev, f);
  return { ...result, data: { step } };
}

export async function markRead(_: ActionState, f: FormData): Promise<ActionState> {
  // The database restricts the notification to this recipient and this business.
  return call(f, "mark_notification_read", { p_ws: s(f, "ws"), p_notification: s(f, "notification") }, () => "Marked as read.", null);
}

export async function markAllRead(_: ActionState, f: FormData): Promise<ActionState> {
  return call(f, "mark_all_notifications_read", { p_ws: s(f, "ws") }, (d) => `${Number(d) || 0} notification(s) marked as read.`, null);
}
