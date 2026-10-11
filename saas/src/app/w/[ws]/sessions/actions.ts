"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { friendlyError, type ActionState } from "@/lib/errors";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const list = (f: FormData, k: string) => f.getAll(k).map(String).filter(Boolean);

// New sessions start as drafts. Opening is a separate, explicit action on the session page.
export async function createSession(_: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const ws = s(form, "ws");
  const { data, error } = await supabase.rpc("create_session_draft", {
    p_ws: ws, p_location: s(form, "location"), p_template_version: s(form, "template_version"),
    p_name: s(form, "name"), p_local_date: s(form, "local_date") || null,
    p_subject_ids: list(form, "subjects"), p_assessor_ids: list(form, "assessors"), p_reviewer_ids: list(form, "reviewers"),
    p_window_hours: Number(s(form, "window_hours") || 48), p_ready_time: s(form, "ready_time") || null,
  });
  if (error) return { error: friendlyError(error) };
  redirect(`/w/${ws}/sessions/${data}`);
}

// Labelled practice inspection: SAMPLE subjects suited to the template's pack, never counted.
export async function createSample(_: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const ws = s(form, "ws");
  const { data, error } = await supabase.rpc("create_sample_session", {
    p_ws: ws, p_location: s(form, "location"), p_template_version: s(form, "template_version"),
  });
  if (error) return { error: friendlyError(error) };
  redirect(`/w/${ws}/sessions/${data}`);
}
