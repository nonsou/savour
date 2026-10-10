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

export async function setAssignment(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const subjects = f.getAll("subject").map(String).filter(Boolean);
  if (!subjects.length) return { error: "Choose at least one subject." };
  let version = n(f, "data_version");
  for (const subject of subjects) {
    const { data, error } = await supabase.rpc("set_assignment", {
      p_session: s(f, "session"), p_subject: subject, p_user: s(f, "user"),
      p_assigned: s(f, "assigned") === "true", p_expected_data_version: version,
    });
    if (error) return { error: friendlyError(error) };
    version = data as number;
  }
  revalidatePath(`/w/${s(f, "ws")}/sessions/${s(f, "session")}`);
  return { ok: "Assignments updated." };
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
