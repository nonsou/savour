"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { friendlyError, type ActionState } from "@/lib/errors";
import { packById } from "@/lib/packs";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function publishTemplate(_: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const ws = s(form, "ws");
  let criteria: unknown;
  try { criteria = JSON.parse(s(form, "criteria") || "[]"); } catch { return { error: "The criteria could not be read." }; }
  const { error } = await supabase.rpc("publish_template", {
    p_ws: ws, p_template_id: s(form, "template_id") || null, p_name: s(form, "name"),
    p_pack: s(form, "pack") || "custom", p_attendance_mode: s(form, "attendance_mode"), p_criteria: criteria,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/w/${ws}`, "layout");
  return { ok: "Published a new version. Existing sessions keep their original version." };
}

export async function installPack(_: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const ws = s(form, "ws");
  const pack = packById(s(form, "pack"));
  if (!pack) return { error: "Unknown starter pack." };
  const { error } = await supabase.rpc("publish_template", {
    p_ws: ws, p_template_id: null, p_name: pack.name, p_pack: pack.id,
    p_attendance_mode: pack.attendanceMode, p_criteria: pack.criteria,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/w/${ws}`, "layout");
  return { ok: `${pack.name} template published. You can edit it and publish new versions.` };
}
