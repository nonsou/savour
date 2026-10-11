// Shapes returned by the findings/actions RPCs and the step-availability rules the UI uses to decide
// which forms to show. The database enforces every rule again; this only avoids offering steps that
// would be refused.
import type { ActionStatus, Severity } from "./scoring";

export interface ActionRow {
  id: string; workspace_id: string; finding_id: string; session_id: string; subject_id: string; session_name: string; session_date: string;
  session_status: string; subject_name: string; location_name: string; issue: string; action_required: string;
  severity: Severity; status: ActionStatus; due_date: string; due_state: "overdue" | "due_today" | "upcoming" | "done";
  assignee_id: string; assignee_label: string; assignee_in_scope: boolean; is_mine: boolean; can_review: boolean;
  resolution_evidence: string | null; resolved_by: string | null; resolved_by_label: string | null; resolved_at: string | null;
  verified_at: string | null; verified_by_label: string | null; cancel_reason: string | null; cancelled_at: string | null;
  reopen_count: number; last_reopen_reason: string | null; version: number; created_by: string; created_by_label: string;
  created_at: string; updated_at: string;
}
export interface ActionList { today: string; timezone: string; actions: ActionRow[] }

export interface FindingDetail {
  id: string; kind: "generated" | "manual"; severity: Severity; title: string; revision: number; criterion_key: string | null;
  created_at: string; state: "open" | "resolved" | "withdrawn"; withdrawn_at: string | null;
  detail: {
    rule?: string; note?: string; criterion_label?: string; min_score?: number; trigger_at_or_below?: number; critical?: boolean;
    assessors_below?: number; assessors_scored?: number; template_version?: number; previous_revision_finding_id?: string | null;
    repeat?: { status: string; window: number; prior_sessions_checked: number; rule?: string; sources_withheld?: number };
  };
}
export interface ActionEvent {
  kind: string; from_status: string | null; to_status: string; actor_label: string; reason: string | null; override: boolean;
  created_at: string; changes: Record<string, { from: unknown; to: unknown }> | null; evidence: string | null;
}
export interface ActionDetail {
  today: string; timezone: string; action: ActionRow; finding: FindingDetail;
  permissions: { review: boolean; assignee: boolean; manager: boolean; self_verification: boolean };
  events: ActionEvent[];
}

export interface FindingRow extends Omit<FindingDetail, "state"> {
  subject_id: string; subject_name: string; created_by_label: string; withdraw_reason: string | null; version: number;
  state: "open" | "resolved" | "withdrawn"; current: boolean; actions: number; active_actions: number;
}
export interface Assignee { user_id: string; display_name: string; role: string }

export type Step = "start" | "submit" | "return" | "verify" | "cancel" | "reopen" | "edit";
export interface StepInfo { step: Step; override?: boolean; needsReason?: boolean; blocked?: string }

const UNFINISHED: ActionStatus[] = ["open", "in_progress", "ready_for_verification"];
export const isUnfinished = (s: ActionStatus) => UNFINISHED.includes(s);

export function availableSteps(d: Pick<ActionDetail, "action" | "permissions">): StepInfo[] {
  const { status } = d.action;
  const p = d.permissions;
  const out: StepInfo[] = [];
  const doer = p.assignee || p.review;
  if (status === "open" && doer) out.push({ step: "start", override: !p.assignee, needsReason: !p.assignee });
  if (status === "in_progress" && doer) out.push({ step: "submit", override: !p.assignee, needsReason: !p.assignee });
  if (status === "ready_for_verification" && p.review) {
    out.push({ step: "return", needsReason: true });
    if (!p.self_verification) out.push({ step: "verify" });
    else if (p.manager) out.push({ step: "verify", override: true, needsReason: true });
    else out.push({ step: "verify", blocked: "You resolved or own this action, so another reviewer, an admin or the owner must verify it." });
  }
  if (isUnfinished(status) && p.review) out.push({ step: "cancel", needsReason: true }, { step: "edit" });
  if ((status === "closed" || status === "cancelled") && p.review) out.push({ step: "reopen", needsReason: true });
  return out;
}

export const STEP_LABELS: Record<Step, string> = {
  start: "Start work", submit: "Submit resolution evidence", return: "Return for more work", verify: "Verify and close",
  cancel: "Cancel action", reopen: "Reopen action", edit: "Edit or reassign",
};

export const EVENT_LABELS: Record<string, string> = {
  create: "Created and assigned", update: "Edited", start: "Started", submit: "Resolution submitted", return: "Returned",
  verify: "Verified and closed", cancel: "Cancelled", reopen: "Reopened",
};

// Save result of the action page's step and edit forms, explained against the action as it is now
// (the page re-reads it after every save, successful or not). The form that produced the result may
// no longer be offered (for example, a verify that lost to a concurrent return), so the explanation
// says so instead of disappearing with the form.
export interface ActionSaveResult { ok?: string; error?: string; data?: Record<string, unknown> }
export interface ResultView { tone: "ok" | "error"; title: string; lines: string[] }

const STATUS_WORDS: Record<ActionStatus, string> = {
  open: "Open", in_progress: "In progress", ready_for_verification: "Ready for verification", closed: "Closed", cancelled: "Cancelled",
};

export function describeActionResult(result: ActionSaveResult | null,
  current: { status: ActionStatus; version: number; steps: StepInfo[] }): ResultView | null {
  if (!result || (!result.ok && !result.error)) return null;
  const step = result.data?.step as Step | undefined;
  const label = step && step in STEP_LABELS ? STEP_LABELS[step] : "Save";
  const now = `The action is now ${STATUS_WORDS[current.status]} (version ${current.version}).`;
  if (result.ok) return { tone: "ok", title: `${label}: saved`, lines: [result.ok, now] };
  const lines = [result.error!, "Nothing was saved by this attempt.", now];
  const stillOffered = step ? current.steps.some((s) => s.step === step && !s.blocked) : true;
  if (!stillOffered) lines.push(`${label} is no longer available to you. The steps below show what you can do now.`);
  return { tone: "error", title: `${label}: not saved`, lines };
}
