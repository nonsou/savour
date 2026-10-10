"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { friendlyError, type ActionState } from "@/lib/errors";

export async function createWorkspace(_: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("create_workspace", {
    p_name: String(form.get("name") ?? ""),
    p_country: String(form.get("country") ?? ""),
    p_timezone: String(form.get("timezone") ?? ""),
    p_display_name: String(form.get("display_name") ?? ""),
  });
  if (error) return { error: friendlyError(error) };
  redirect(`/w/${data}/setup`);
}
