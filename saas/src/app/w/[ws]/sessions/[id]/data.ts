import { notFound } from "next/navigation";
import { isUuid, requireWorkspace } from "@/lib/auth";
import type { ReportEnvelope } from "@/lib/report";
import type { Answers, AttendanceMode, Criterion, Outcome } from "@/lib/scoring";

export interface SessionRow {
  id: string; name: string; local_date: string; status: string; revision: number; data_version: number;
  opens_at: string; closes_at: string; expected_ready_time: string | null; last_reopen_reason: string | null;
  cancel_reason: string | null; location_id: string; template_version_id: string;
  is_sample: boolean; opened_at: string | null; planned_window_hours: number | null; collection_reopens: number;
  last_collection_reopen_reason: string | null;
}
export interface RosterRow {
  subject_id: string; subject_name: string; outcome: Outcome; outcome_reason: string | null; version: number;
  removed_at: string | null; removal_reason: string | null; restored_at: string | null; restore_reason: string | null;
}
export interface AssignmentRow { subject_id: string; user_id: string; waived_at: string | null; waiver_reason: string | null }
export interface AssessmentRow {
  subject_id: string; assessor_id: string; assessor_name: string; observed_attendance: Outcome | null;
  answers: Answers | null; notes: string | null; absence_reason: string | null; state: string;
  na_confirmed: boolean; version: number; updated_at: string;
}
export interface CorrectionRow {
  id: string; subject_id: string; assessor_id: string; reason: string; requester_name: string; status: string;
  resolution: string | null; created_at: string; resolved_at: string | null;
}
export interface TemplateVersionRow { id: string; name: string; version: number; attendance_mode: AttendanceMode; criteria: Criterion[] }

// Everything is read with the caller's own client: RLS decides what each role receives
// (assessors and guests never receive removed roster rows, peers' work or other requests).
export async function loadSession(ws: string, id: string) {
  if (!isUuid(id)) notFound();
  const { supabase, user, ctx } = await requireWorkspace(ws);
  const { data: session } = await supabase.from("sessions")
    .select("id, name, local_date, status, revision, data_version, opens_at, closes_at, expected_ready_time, last_reopen_reason, cancel_reason, location_id, template_version_id, is_sample, opened_at, planned_window_hours, collection_reopens, last_collection_reopen_reason")
    .eq("id", id).eq("workspace_id", ws).maybeSingle();
  if (!session) notFound();
  const [tv, roster, assignments, assessments, reviewers, location, corrections] = await Promise.all([
    supabase.from("template_versions").select("id, name, version, attendance_mode, criteria").eq("id", session.template_version_id).maybeSingle(),
    supabase.from("session_subjects").select("subject_id, subject_name, outcome, outcome_reason, version, removed_at, removal_reason, restored_at, restore_reason").eq("session_id", id).order("subject_name"),
    supabase.from("session_assignments").select("subject_id, user_id, waived_at, waiver_reason").eq("session_id", id),
    supabase.from("assessments").select("subject_id, assessor_id, assessor_name, observed_attendance, answers, notes, absence_reason, state, na_confirmed, version, updated_at").eq("session_id", id),
    supabase.from("session_reviewers").select("user_id").eq("session_id", id),
    supabase.from("locations").select("name").eq("id", session.location_id).maybeSingle(),
    supabase.from("correction_requests").select("id, subject_id, assessor_id, reason, requester_name, status, resolution, created_at, resolved_at").eq("session_id", id).order("created_at", { ascending: false }),
  ]);
  const reviewerIds = ((reviewers.data ?? []) as { user_id: string }[]).map((r) => r.user_id);
  const canReview = ctx.role === "owner" || ctx.role === "admin" || (ctx.role === "reviewer" && reviewerIds.includes(user.id));
  let report: ReportEnvelope | null = null;
  let reportError = false;
  if (canReview || ctx.role === "viewer") {
    const r = await supabase.rpc("get_session_report", { p_session: id, p_revision: null, p_redact: false, p_purpose: "view" });
    report = (r.data as ReportEnvelope | null) ?? null;
    reportError = !!r.error && ctx.role !== "viewer";
  }
  // Server time decides the window (same predicate as the database): computed once per request.
  const now = Date.now();
  const collecting = session.status === "open" && now >= new Date(session.opens_at).getTime() && now < new Date(session.closes_at).getTime();
  const windowExpired = session.status === "open" && now >= new Date(session.closes_at).getTime();
  const allRoster = (roster.data ?? []) as RosterRow[];
  return {
    supabase, user, ctx, canReview, report, reportError, reviewerIds, collecting, windowExpired,
    session: session as SessionRow,
    template: tv.data as TemplateVersionRow | null,
    locationName: (location.data as { name: string } | null)?.name ?? null,
    roster: allRoster.filter((r) => !r.removed_at),
    removedRoster: allRoster.filter((r) => r.removed_at),
    assignments: (assignments.data ?? []) as AssignmentRow[],
    assessments: (assessments.data ?? []) as AssessmentRow[],
    corrections: (corrections.data ?? []) as CorrectionRow[],
    loadFailed: !!(tv.error || roster.error || assignments.error || assessments.error || corrections.error),
  };
}
