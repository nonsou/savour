"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { friendlyError, type ActionState } from "@/lib/errors";
import type { Answers, Outcome } from "@/lib/scoring";
import { siteOrigin } from "@/lib/urls";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const n = (f: FormData, k: string) => (s(f, k) === "" ? null : Number(s(f, k)));

async function run(form: FormData, fn: string, args: Record<string, unknown>, ok: string): Promise<ActionState> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc(fn, args);
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/w/${s(form, "ws")}/sessions/${s(form, "session")}`);
  return { ok };
}

export async function resolveOutcome(_: ActionState, f: FormData) {
  return run(f, "resolve_outcome", {
    p_session: s(f, "session"), p_subject: s(f, "subject"), p_outcome: s(f, "outcome"),
    p_reason: s(f, "reason") || null, p_expected_version: n(f, "version"),
  }, "Outcome saved.");
}

export async function confirmNa(_: ActionState, f: FormData) {
  return run(f, "confirm_na", {
    p_session: s(f, "session"), p_subject: s(f, "subject"), p_assessor: s(f, "assessor"), p_expected_version: n(f, "version"),
  }, "N/A confirmed.");
}

export async function closeCollection(_: ActionState, f: FormData) {
  return run(f, "close_collection", { p_session: s(f, "session") }, "Collection closed. The session is in review.");
}

export async function approveSession(_: ActionState, f: FormData) {
  if (f.get("confirm") !== "on") return { error: "Tick the confirmation box to approve." };
  return run(f, "approve_session", { p_session: s(f, "session"), p_expected_data_version: n(f, "data_version") },
    "Approved. This revision is now locked.");
}

export async function reopenSession(_: ActionState, f: FormData) {
  return run(f, "reopen_session", { p_session: s(f, "session"), p_reason: s(f, "reason") },
    "Reopened as a new review revision. The previous approval is preserved.");
}

export async function cancelSession(_: ActionState, f: FormData) {
  if (f.get("confirm") !== "on") return { error: "Tick the confirmation box to cancel." };
  return run(f, "cancel_session", { p_session: s(f, "session"), p_reason: s(f, "reason") }, "Session cancelled.");
}

// One database call per subject, each carrying the version returned by the previous call, so a
// concurrent change elsewhere stops the batch with stale_version instead of overwriting it. Any
// calls already made before a failure are reported honestly.
async function batch(f: FormData, items: string[], call: (item: string, version: number | null) => PromiseLike<{ data: unknown; error: { message: string; details?: string | null } | null }>,
  ok: string): Promise<ActionState> {
  if (!items.length) return { error: "Choose at least one subject." };
  let version = n(f, "data_version");
  let done = 0;
  for (const item of items) {
    const { data, error } = await call(item, version);
    if (error) {
      revalidatePath(`/w/${s(f, "ws")}/sessions/${s(f, "session")}`);
      return { error: friendlyError(error) + (done ? ` ${done} of ${items.length} change(s) were saved before this; reload to see them.` : " Nothing was changed.") };
    }
    version = data as number;
    done += 1;
  }
  revalidatePath(`/w/${s(f, "ws")}/sessions/${s(f, "session")}`);
  return { ok };
}

export async function setAssignment(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  return batch(f, f.getAll("subject").map(String).filter(Boolean), (subject, version) => supabase.rpc("set_assignment", {
    p_session: s(f, "session"), p_subject: subject, p_user: s(f, "user"),
    p_assigned: s(f, "assigned") === "true", p_expected_data_version: version, p_reason: s(f, "reason") || null,
  }), "Assignments updated.");
}

export async function setRosterSubjects(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const on = s(f, "on") === "true";
  return batch(f, f.getAll("subject").map(String).filter(Boolean), (subject, version) => supabase.rpc("set_roster_subject", {
    p_session: s(f, "session"), p_subject: subject, p_on: on, p_reason: s(f, "reason") || null, p_expected_data_version: version,
  }), on ? "Roster updated." : "Removed from the roster. Earlier responses are kept in history.");
}

export async function setReviewer(_: ActionState, f: FormData) {
  return run(f, "set_session_reviewer", {
    p_session: s(f, "session"), p_user: s(f, "user"), p_on: s(f, "on") === "true", p_reason: s(f, "reason") || null,
    p_expected_data_version: n(f, "data_version"),
  }, "Reviewers updated.");
}

export async function updateDraft(_: ActionState, f: FormData) {
  return run(f, "update_session_draft", {
    p_session: s(f, "session"), p_name: s(f, "name"), p_local_date: s(f, "local_date") || null, p_location: s(f, "location"),
    p_template_version: s(f, "template_version"), p_window_hours: n(f, "window_hours"), p_ready_time: s(f, "ready_time") || null,
    p_expected_data_version: n(f, "data_version"),
  }, "Draft saved.");
}

export async function openSession(_: ActionState, f: FormData) {
  if (f.get("confirm") !== "on") return { error: "Tick the confirmation box to open collection." };
  return run(f, "open_session", { p_session: s(f, "session"), p_expected_data_version: n(f, "data_version") },
    "Opened. Assigned assessors can now see and submit their subjects.");
}

export async function updateWindow(_: ActionState, f: FormData) {
  return run(f, "update_session_window", {
    p_session: s(f, "session"), p_hours: n(f, "hours"), p_reason: s(f, "reason") || null, p_expected_data_version: n(f, "data_version"),
  }, "Collection window updated.");
}

export async function reopenCollection(_: ActionState, f: FormData) {
  if (f.get("confirm") !== "on") return { error: "Tick the confirmation box to reopen collection." };
  return run(f, "reopen_collection", {
    p_session: s(f, "session"), p_hours: n(f, "hours"), p_reason: s(f, "reason"), p_expected_data_version: n(f, "data_version"),
  }, "Collection reopened. Expired or revoked guests need a new invitation.");
}

export async function setWaiver(_: ActionState, f: FormData) {
  const waive = s(f, "waive") === "true";
  return run(f, "set_waiver", {
    p_session: s(f, "session"), p_subject: s(f, "subject"), p_assessor: s(f, "assessor"), p_waive: waive,
    p_reason: s(f, "reason") || null, p_expected_data_version: n(f, "data_version"),
  }, waive ? "Waived. The response still counts as missing in every report." : "Waiver removed.");
}

export async function requestCorrection(_: ActionState, f: FormData) {
  return run(f, "request_correction", {
    p_session: s(f, "session"), p_subject: s(f, "subject"), p_assessor: s(f, "assessor"), p_reason: s(f, "reason"),
    p_expected_data_version: n(f, "data_version"),
  }, "Correction requested. The assessor sees it on their assessment page. Approval waits until it is resolved.");
}

export async function withdrawCorrection(_: ActionState, f: FormData) {
  return run(f, "withdraw_correction", {
    p_request: s(f, "request"), p_reason: s(f, "reason"), p_expected_data_version: n(f, "data_version"),
  }, "Correction request withdrawn.");
}

export async function inviteGuest(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("create_invitation", {
    p_ws: s(f, "ws"), p_email: s(f, "email"), p_role: "guest", p_all_locations: false, p_location_ids: [],
    p_session: s(f, "session"), p_subject_ids: f.getAll("subjects").map(String),
  });
  if (error) return { error: friendlyError(error) };
  const inv = data as { token: string; expires_at: string };
  return { ok: "Guest invitation created. Copy the link now; it is shown only once.",
    data: { link: `${await siteOrigin()}/invite/${inv.token}`, expires_at: inv.expires_at } };
}

export interface SubmitPayload {
  ws: string; session: string; subject: string; assessor: string;
  observed: Outcome | null; answers: Answers | null; notes: string | null;
  expectedVersion: number; idempotencyKey: string; reason: string | null;
}

export type SubmitResult = { ok: true; version: number; replayed: boolean } | { ok: false; error: string; code: string };

export async function submitAssessment(p: SubmitPayload): Promise<SubmitResult> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("submit_assessment", {
    p_session: p.session, p_subject: p.subject, p_assessor: p.assessor, p_observed: p.observed,
    p_answers: p.answers, p_notes: p.notes, p_expected_version: p.expectedVersion,
    p_idempotency_key: p.idempotencyKey, p_reason: p.reason,
  });
  if (error) return { ok: false, error: friendlyError(error), code: error.message };
  revalidatePath(`/w/${p.ws}/sessions/${p.session}`);
  const r = data as { version: number; replayed: boolean };
  return { ok: true, version: r.version, replayed: r.replayed };
}
