"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { friendlyError, type ActionState } from "@/lib/errors";
import { siteOrigin } from "@/lib/urls";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const locs = (f: FormData) => f.getAll("locations").map(String).filter(Boolean);

export async function createInvitation(_: ActionState, f: FormData): Promise<ActionState> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("create_invitation", {
    p_ws: s(f, "ws"), p_email: s(f, "email"), p_role: s(f, "role"), p_all_locations: f.get("all_locations") === "on",
    p_location_ids: locs(f), p_session: null, p_subject_ids: null,
  });
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/w/${s(f, "ws")}/team`);
  const inv = data as { token: string; expires_at: string };
  return { ok: "Invitation created. Copy the link now; it is shown only once.",
    data: { link: `${await siteOrigin()}/invite/${inv.token}`, expires_at: inv.expires_at } };
}

async function run(f: FormData, fn: string, args: Record<string, unknown>, ok: string): Promise<ActionState> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc(fn, args);
  if (error) return { error: friendlyError(error) };
  revalidatePath(`/w/${s(f, "ws")}`, "layout");
  return { ok };
}

export async function revokeInvitation(_: ActionState, f: FormData) {
  return run(f, "revoke_invitation", { p_invitation: s(f, "id") }, "Invitation revoked.");
}

export async function updateMember(_: ActionState, f: FormData) {
  return run(f, "update_member", {
    p_ws: s(f, "ws"), p_user: s(f, "user"), p_role: s(f, "role"),
    p_all_locations: f.get("all_locations") === "on", p_location_ids: locs(f),
  }, "Access updated. It applies on the member's next request.");
}

export async function revokeMember(_: ActionState, f: FormData) {
  if (f.get("confirm") !== "on") return { error: "Tick the confirmation box to remove this member." };
  return run(f, "revoke_member", { p_ws: s(f, "ws"), p_user: s(f, "user") },
    "Member removed. Their access ends on their next request; their name stays on past work.");
}
