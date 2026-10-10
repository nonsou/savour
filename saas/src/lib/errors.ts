// Maps database error codes (raised by private.fail) to plain-language messages.
const MESSAGES: Record<string, string> = {
  not_authenticated: "Your session has ended. Please sign in again.",
  email_not_verified: "Verify your email address before creating a business.",
  forbidden: "You do not have permission to do that.",
  not_found: "Not found, or you no longer have access.",
  stale_version: "This was changed by someone else since you loaded it. Reload to see the latest version.",
  idempotency_conflict: "This save conflicts with an earlier attempt. Reload the page and try again.",
  idempotency_key_required: "Save could not be identified. Reload and try again.",
  window_closed: "The collection window for this session has closed.",
  session_locked: "This session is approved or cancelled and cannot be changed.",
  invalid_state: "That action is not available in the session's current state.",
  not_assigned: "You are not assigned to this subject (or your access has changed).",
  invalid_score: "Every score must be a whole number from 1 to 5.",
  missing_criterion: "Every criterion needs a score or an allowed N/A.",
  unknown_criterion: "The form does not match the session template. Reload and try again.",
  na_not_allowed: "N/A is not allowed for that criterion.",
  na_reason_required: "Give a reason for each N/A.",
  invalid_answers: "The answers could not be read. Reload and try again.",
  invalid_attendance: "That attendance value is not valid for this session.",
  absent_clears_scores: "An absent observation cannot include scores.",
  subject_not_assessable: "The reviewer marked this subject absent or not assessed; scores cannot be added.",
  notes_too_long: "Notes are limited to 2,000 characters.",
  reason_required: "A reason is required.",
  invalid_outcome: "That outcome is not valid for this template's attendance mode.",
  approval_blocked: "Approval is blocked",
  invalid_timezone: "Choose a valid timezone.",
  invalid_name: "Enter a name.",
  invalid_email: "Enter a valid email address.",
  role_not_invitable: "You cannot invite someone with that role.",
  role_not_grantable: "That role cannot be granted here.",
  cannot_change_own_role: "You cannot change your own role.",
  last_owner: "A business must keep at least one owner.",
  locations_required: "Choose at least one location, or all locations.",
  subjects_required: "Choose at least one subject for the guest.",
  invalid_scope: "That access scope is not valid for this role.",
  invitation_invalid: "This invitation link is not valid.",
  invitation_expired: "This invitation has expired. Ask for a new link.",
  invitation_revoked: "This invitation was revoked.",
  invitation_used: "This invitation has already been used.",
  invitation_wrong_account: "This invitation is for a different verified email address. Sign in with the invited email.",
  already_member: "You are already a member of this business.",
  session_closed: "That session is no longer open.",
  invalid_assessor: "Each assessor must be active staff who hold the session location.",
  invalid_reviewer: "Each reviewer must be active and hold the session location.",
  roster_required: "Choose at least one subject.",
  ready_time_required: "Scored readiness needs an expected ready time.",
  invalid_window: "The collection window must be 1 to 168 hours.",
  invalid_date: "Choose a session date.",
  template_needs_criteria: "Add at least one criterion, or use scored attendance.",
  invalid_criteria: "Check the criteria",
  immutable_record: "Approved and published records cannot be changed.",
};

export interface DbError { message?: string; details?: string | null; code?: string }

export function friendlyError(error: DbError | null | undefined): string {
  if (!error) return "Something went wrong.";
  const code = error.message ?? "";
  const base = MESSAGES[code];
  if (!base) return "The request failed. Nothing was saved. Please try again.";
  return error.details && ["approval_blocked", "invalid_criteria", "not_found"].includes(code)
    ? `${base}: ${error.details}`
    : base;
}

export type ActionState = { ok?: string; error?: string; data?: Record<string, unknown> } | null;
