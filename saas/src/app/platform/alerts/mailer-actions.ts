"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import type { ActionState } from "@/lib/errors";
import { MAILER_MESSAGES } from "@/lib/operations-mailer";

const PATH = "/platform/alerts";

// Switch automatic owner email on or off. Only the confirmation tick is read; SQL checks the live admin row and aal2
// and records that admin (never a caller-supplied actor). Enabling also requires a ready worker heartbeat in the last
// 10 minutes and the named scheduled job active. Messages are static.
async function toggle(fn: "platform_enable_operations_mailer" | "platform_disable_operations_mailer", f: FormData,
  confirm: string, ok: string): Promise<ActionState> {
  const { supabase } = await requireUser(PATH);
  if (f.get("confirm") !== "on") return { error: confirm };
  const { error } = await supabase.rpc(fn);
  if (error) {
    if (error.message === "mfa_required") return { error: MAILER_MESSAGES.mfa, data: { mfa: true } };
    if (error.message === "mailer_not_ready") return { error: MAILER_MESSAGES.notReady };
    if (error.message === "mailer_not_scheduled") return { error: MAILER_MESSAGES.notScheduled };
    if (error.message === "forbidden") return { error: MAILER_MESSAGES.forbidden };
    return { error: MAILER_MESSAGES.failed };
  }
  revalidatePath(PATH);
  return { ok };
}

export async function enableAutomaticEmail(_: ActionState, f: FormData) {
  return toggle("platform_enable_operations_mailer", f, MAILER_MESSAGES.confirmEnable, MAILER_MESSAGES.enabled);
}
export async function disableAutomaticEmail(_: ActionState, f: FormData) {
  return toggle("platform_disable_operations_mailer", f, MAILER_MESSAGES.confirmDisable, MAILER_MESSAGES.disabled);
}
