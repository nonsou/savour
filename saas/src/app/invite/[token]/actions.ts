"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { friendlyError, type ActionState } from "@/lib/errors";

export async function acceptInvitation(_: ActionState, form: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("accept_invitation", {
    p_token: String(form.get("token") ?? ""),
    p_display_name: String(form.get("display_name") ?? ""),
  });
  if (error) return { error: friendlyError(error) };
  redirect(`/w/${data}`);
}
