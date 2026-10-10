import { notFound } from "next/navigation";
import { isUuid, requireWorkspace } from "@/lib/auth";
import type { ReportEnvelope } from "@/lib/report";
import type { Answers, AttendanceMode, Criterion, Outcome } from "@/lib/scoring";

export interface SessionRow {
  id: string; name: string; local_date: string; status: string; revision: number; data_version: number;
  opens_at: string; closes_at: string; expected_ready_time: string | null; last_reopen_reason: string | null;
  cancel_reason: string | null; location_id: string; template_version_id: string;
}
export interface RosterRow { subject_id: string; subject_name: string; outcome: Outcome; outcome_reason: string | null; version: number }
export interface AssignmentRow { subject_id: string; user_id: string }
export interface AssessmentRow {
  subject_id: string; assessor_id: string; assessor_name: string; observed_attendance: Outcome | null;
  answers: Answers | null; notes: string | null; absence_reason: string | null; state: string;
  na_confirmed: boolean; version: number; updated_at: string;
}
export interface TemplateVersionRow { id: string; name: string; version: number; attendance_mode: AttendanceMode; criteria: Criterion[] }

// Everything is read with the caller's own client: RLS decides what each role receives.
export async function loadSession(ws: string, id: string) {
  if (!isUuid(id)) notFound();
  const { supabase, user, ctx } = await requireWorkspace(ws);
  const { data: session } = await supabase.from("sessions")
    .select("id, name, local_date, status, revision, data_version, opens_at, closes_at, expected_ready_time, last_reopen_reason, cancel_reason, location_id, template_version_id")
    .eq("id", id).eq("workspace_id", ws).maybeSingle();
  if (!session) notFound();
  const [tv, roster, assignments, assessments, reviewers, location] = await Promise.all([
    supabase.from("template_versions").select("id, name, version, attendance_mode, criteria").eq("id", session.template_version_id).maybeSingle(),
    supabase.from("session_subjects").select("subject_id, subject_name, outcome, outcome_reason, version").eq("session_id", id).order("subject_name"),
    supabase.from("session_assignments").select("subject_id, user_id").eq("session_id", id),
    supabase.from("assessments").select("subject_id, assessor_id, assessor_name, observed_attendance, answers, notes, absence_reason, state, na_confirmed, version, updated_at").eq("session_id", id),
    supabase.from("session_reviewers").select("user_id").eq("session_id", id),
    supabase.from("locations").select("name").eq("id", session.location_id).maybeSingle(),
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
  // Server time decides the window; computed once per request, outside rendering.
  const collecting = session.status === "open" && Date.now() < new Date(session.closes_at).getTime();
  return {
    supabase, user, ctx, canReview, report, reportError, reviewerIds, collecting,
    session: session as SessionRow,
    template: tv.data as TemplateVersionRow | null,
    locationName: (location.data as { name: string } | null)?.name ?? null,
    roster: (roster.data ?? []) as RosterRow[],
    assignments: (assignments.data ?? []) as AssignmentRow[],
    assessments: (assessments.data ?? []) as AssessmentRow[],
    loadFailed: !!(tv.error || roster.error || assignments.error || assessments.error),
  };
}
