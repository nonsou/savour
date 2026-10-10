"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { friendlyError, type ActionState } from "@/lib/errors";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const idOrNull = (f: FormData) => s(f, "id") || null;

export async function saveLocation(_: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const ws = s(form, "ws");
  const { error } = await supabase.rpc("upsert_location", {
    p_ws: ws, p_id: idOrNull(form), p_name: s(form, "name"), p_archived: form.get("archived") === "on",
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/w/${ws}`, "layout");
  return { ok: "Location saved." };
}

export async function saveSubject(_: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const ws = s(form, "ws");
  const { error } = await supabase.rpc("upsert_subject", {
    p_ws: ws, p_id: idOrNull(form), p_name: s(form, "name"), p_type: s(form, "subject_type"),
    p_archived: form.get("archived") === "on",
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/w/${ws}`, "layout");
  return { ok: "Subject saved." };
}
