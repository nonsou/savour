"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isUuid, requireUser } from "@/lib/auth";
import { isProviderUrl, TERMS_VERSION } from "@/lib/billing";
import { friendlyError, type ActionState } from "@/lib/errors";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

// Provider calls happen only in Supabase Edge Functions, invoked with the signed-in user's own JWT.
// No payment secret exists in this Next.js app; returned URLs are checked to be Bachs-hosted pages.
async function invoke(fn: "bachs-checkout" | "bachs-portal" | "bachs-cancel", body: Record<string, unknown>) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error || !data || typeof data !== "object") return { kind: "error", code: "billing_service_unavailable" } as const;
  return data as { kind: "redirect" | "processing" | "done" | "error"; url?: string; code?: string; data?: Record<string, unknown> };
}

const message = (code: string | undefined) =>
  code === "billing_service_unavailable" ? "Billing is not reachable right now. Nothing was charged. Try again later." : friendlyError({ message: code });

export async function setBillingContact(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_billing_contact", { p_ws: s(f, "ws"), p_email: s(f, "email"),
    p_consent: f.get("consent") === "on", p_expected_version: Number(s(f, "version")) });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/w/${s(f, "ws")}/billing`);
  return { ok: "Billing contact saved." };
}

export async function startCheckout(_: ActionState, f: FormData): Promise<ActionState> {
  const ws = s(f, "ws");
  if (!isUuid(ws)) return { error: friendlyError({ message: "not_found" }) };
  if (f.get("consent") !== "on") return { error: "Tick the box to confirm you have read the price, renewal, cancellation and refund terms." };
  const r = await invoke("bachs-checkout", { workspace_id: ws, currency: s(f, "currency"), price_id: s(f, "price_id"), terms_version: TERMS_VERSION });
  if (r.kind === "redirect" && isProviderUrl(r.url)) redirect(r.url);
  if (r.kind === "processing") redirect(`/w/${ws}/billing/return`);
  revalidatePath(`/w/${ws}/billing`);
  return { error: message(r.code) };
}

export async function openPortal(_: ActionState, f: FormData): Promise<ActionState> {
  const ws = s(f, "ws");
  if (!isUuid(ws)) return { error: friendlyError({ message: "not_found" }) };
  const r = await invoke("bachs-portal", { workspace_id: ws });
  // A fresh, short-lived portal URL: sent to the browser once, never stored or logged.
  if (r.kind === "redirect" && isProviderUrl(r.url)) redirect(r.url);
  return { error: message(r.code) };
}

export async function cancelSubscription(_: ActionState, f: FormData): Promise<ActionState> {
  const ws = s(f, "ws");
  if (f.get("confirm") !== "on") return { error: "Tick the confirmation box to cancel at the end of the paid period." };
  const r = await invoke("bachs-cancel", { workspace_id: ws, expected_version: Number(s(f, "version")) });
  revalidatePath(`/w/${ws}`, "layout");
  if (r.kind === "done" && r.data?.cancellation === "confirmed") return { ok: "Cancellation confirmed by Bachs. Access continues until the end of the paid period; there will be no further renewal." };
  if (r.kind === "processing" || r.kind === "done") return { ok: "Cancellation requested. It shows as pending until Bachs confirms it." };
  return { error: message(r.code) };
}
