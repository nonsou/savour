"use server";

import { revalidatePath } from "next/cache";
import { MESSAGES, sendingConfigured, sendVerification, validateReservation } from "@/lib/alert-email";
import { requireUser } from "@/lib/auth";
import type { ActionState } from "@/lib/errors";

const PATH = "/platform/alerts";

// One owner-initiated verification email. Only the confirmation tick is read from the form; recipient, sender, subject,
// text and URL are fixed. Order: signed-in user, confirmation, Preview + key present, live admin + aal2 reservation in
// SQL (one per UTC day), the single Resend call, then the self-reported outcome. Every message is static; nothing
// from the key, the response or an error is logged or returned.
export async function sendVerificationEmail(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireUser(PATH);
  if (f.get("confirm") !== "on") return { error: MESSAGES.confirm };
  if (!sendingConfigured(process.env)) return { error: MESSAGES.notConfigured };
  const key = process.env.SAVOUR_ALERT_RESEND_API_KEY!;

  const { data, error } = await supabase.rpc("platform_reserve_alert_email_verification");
  if (error) {
    if (error.message === "mfa_required") return { error: MESSAGES.mfa, data: { mfa: true } };
    if (error.message === "verification_daily_limit") return { error: MESSAGES.dailyLimit };
    if (error.message === "forbidden") return { error: MESSAGES.forbidden };
    return { error: MESSAGES.reserveFailed };
  }
  const reservation = validateReservation(data);
  // An unexpected reservation is never sent; the day stays claimed and is shown as unknown after 15 minutes.
  if (!reservation) { revalidatePath(PATH); return { error: MESSAGES.reserveFailed }; }

  const result = await sendVerification(key, reservation);
  const done = await supabase.rpc("platform_finish_alert_email_verification",
    { p_id: reservation.id, p_outcome: result.outcome, p_provider_message_id: result.messageId });
  revalidatePath(PATH);
  if (done.error || done.data !== "recorded") return { error: MESSAGES.finishFailed };
  return result.outcome === "accepted" ? { ok: MESSAGES.accepted } : { error: MESSAGES[result.outcome] };
}
