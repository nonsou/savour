export const SUBJECT_TYPES: [string, string][] = [
  ["vendor", "Vendor"], ["outlet", "Outlet"], ["operation", "Operation"], ["supplier", "Supplier"],
  ["service_provider", "Service provider"],
];

export const SESSION_STATUS_LABELS: Record<string, string> = {
  draft: "Draft (not collecting)", open: "Open", in_review: "In review", approved: "Approved", cancelled: "Cancelled",
};

export const ATTENDANCE_MODE_LABELS: Record<string, string> = {
  off: "Attendance off", presence: "Presence only", scored: "Scored readiness",
};

// Milestone 3
export const SEVERITY_LABELS: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export const ACTION_STATUS_LABELS: Record<string, string> = {
  open: "Open", in_progress: "In progress", ready_for_verification: "Ready for verification", closed: "Closed", cancelled: "Cancelled",
};

export const DUE_STATE_LABELS: Record<string, string> = {
  overdue: "Overdue", due_today: "Due today", upcoming: "Upcoming", done: "Finished",
};

export const FINDING_STATE_LABELS: Record<string, string> = { open: "Open", resolved: "Resolved", withdrawn: "Withdrawn" };
