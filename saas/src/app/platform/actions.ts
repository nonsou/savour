"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { friendlyError, type ActionState } from "@/lib/errors";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

// Non-secret platform writes. SQL verifies the platform admin row and aal2 on every call; secrets are
// never posted to these actions (they go from the browser straight to the platform-credentials function).
async function run(fn: string, args: Record<string, unknown>, ok: string): Promise<ActionState> {
  const { supabase } = await requireUser("/platform");
  const { error } = await supabase.rpc(fn, args);
  if (error) return { error: friendlyError(error) };
  revalidatePath("/platform");
  return { ok };
}

export async function createConnection(_: ActionState, f: FormData) {
  return run("platform_create_connection", { p_provider: s(f, "provider"), p_label: s(f, "label") }, "Connection created (draft). Store its credentials next.");
}
export async function setExpectedOrg(_: ActionState, f: FormData) {
  return run("platform_set_expected_org", { p_conn: s(f, "connection"), p_org: s(f, "org"), p_expected_version: Number(s(f, "version")) },
    "Expected account saved. Run a connection test.");
}
export async function proposePrice(_: ActionState, f: FormData) {
  return run("platform_propose_price", { p_conn: s(f, "connection"), p_currency: s(f, "currency"), p_amount: s(f, "amount"), p_product_id: s(f, "product") },
    "Price proposed. It becomes payable only after a connection test reads the product back with the same currency, amount and monthly cadence.");
}
export async function enableConnection(_: ActionState, f: FormData) {
  return run("platform_enable", { p_conn: s(f, "connection"), p_expected_version: Number(s(f, "version")) }, "Connection enabled for new checkouts.");
}
export async function disableConnection(_: ActionState, f: FormData) {
  if (f.get("confirm") !== "on") return { error: "Tick the confirmation box. Existing subscriptions keep renewing and are still verified on this connection." };
  return run("platform_disable", { p_conn: s(f, "connection"), p_expected_version: Number(s(f, "version")) },
    "Connection disabled for new checkouts. Existing subscriptions stay on it and are still verified.");
}
export async function setDefault(_: ActionState, f: FormData) {
  return run("platform_set_default", { p_conn: s(f, "connection") || null, p_expected_version: Number(s(f, "version")) },
    "Default changed. It applies to new checkouts only; existing subscriptions stay on their connection.");
}
