import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import type { AccessSummary } from "@/lib/billing";
import { createClient } from "@/lib/supabase/server";

export type Role = "owner" | "admin" | "reviewer" | "assessor" | "viewer" | "guest";

export interface WorkspaceContext {
  workspace: { id: string; name: string; country: string; timezone: string };
  role: Role;
  display_name: string;
  all_locations: boolean;
  guest_session_id: string | null;
  location_ids: string[];
  aal: string;
  /** Milestone 4: role-aware billing summary (null for guests). */
  access: AccessSummary | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | null | undefined): s is string => !!s && UUID.test(s);

// getUser() asks the Auth server, so a signed-out or deleted user is rejected even with a cookie.
export const requireUser = cache(async (next?: string) => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  return { supabase, user: data.user };
});

// Membership, role and location scope are read live from the database on every request.
export const requireWorkspace = cache(async (wsId: string) => {
  if (!isUuid(wsId)) notFound();
  const { supabase, user } = await requireUser(`/w/${wsId}`);
  const { data, error } = await supabase.rpc("workspace_context", { p_ws: wsId });
  if (error) throw new Error("Could not load workspace context.");
  if (!data) notFound();
  return { supabase, user, ctx: data as WorkspaceContext };
});

export const isManager = (r: Role) => r === "owner" || r === "admin";
export const canReviewRole = (r: Role) => r === "owner" || r === "admin" || r === "reviewer";
export const canSeeReports = (r: Role) => canReviewRole(r) || r === "viewer";

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner", admin: "Admin", reviewer: "Reviewer", assessor: "Assessor", viewer: "Viewer", guest: "Guest assessor",
};
