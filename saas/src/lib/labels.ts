export const SUBJECT_TYPES: [string, string][] = [
  ["vendor", "Vendor"], ["outlet", "Outlet"], ["operation", "Operation"], ["supplier", "Supplier"],
  ["service_provider", "Service provider"],
];

export const SESSION_STATUS_LABELS: Record<string, string> = {
  open: "Open", in_review: "In review", approved: "Approved", cancelled: "Cancelled",
};

export const ATTENDANCE_MODE_LABELS: Record<string, string> = {
  off: "Attendance off", presence: "Presence only", scored: "Scored readiness",
};
