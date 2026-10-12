// Milestone 5 OPS02: static vocabulary, the business-rejection classifier, and fail-closed validation and
// evaluation of public.platform_application_outcomes. Pure functions only (no I/O, no client clock); safe to
// import anywhere. The server-side recording lives in outcome-telemetry.ts.

export const OPS = ["assessment_save", "report_pdf", "report_csv", "analytics_pdf", "analytics_csv", "dashboard_csv"] as const;
export type Op = (typeof OPS)[number];
export const OUTCOMES = ["success", "replayed", "rejected", "failed"] as const;
export type AppOutcome = (typeof OUTCOMES)[number];

export const OP_LABELS: Record<Op, string> = {
  assessment_save: "Inspection assessment save",
  report_pdf: "Session report PDF export",
  report_csv: "Session report CSV export",
  analytics_pdf: "Analytics PDF export",
  analytics_csv: "Analytics CSV export",
  dashboard_csv: "Dashboard CSV export",
};

// Database error codes (raised by private.fail) that mean "the request was refused for a known business or
// permission reason". Anything else (SQL, network, timeout, PostgREST text, unknown codes) is a failure.
const REJECTION_CODES: ReadonlySet<string> = new Set([
  "not_authenticated", "forbidden", "not_found", "not_assigned",
  "stale_version", "idempotency_conflict", "idempotency_key_required",
  "session_locked", "session_closed", "window_closed", "subject_removed", "subject_not_assessable",
  "reason_required", "reason_too_long", "notes_too_long", "invalid_attendance", "absent_clears_scores",
  "invalid_score", "missing_criterion", "unknown_criterion", "na_not_allowed", "na_reason_required", "invalid_answers",
  "assessment_not_reserved", "read_only", "workspace_suspended",
  "invalid_mode", "invalid_filter", "invalid_purpose",
]);

/** Exact-match allowlist; the code itself is never logged or stored. */
export function classifyRejection(code: unknown): "rejected" | "failed" {
  return typeof code === "string" && REJECTION_CODES.has(code) ? "rejected" : "failed";
}

// ---------------------------------------------------------------------------
// Snapshot validation (exact allowlist; fail closed)
// ---------------------------------------------------------------------------
export interface OpCounts {
  op: Op; success: number; replayed: number; rejected: number; failed: number;
  capped_buckets: number; latest_reported_at: string | null; failed_hours: string[];
}
export interface AppSnapshot {
  observed_at: string; window_start: string; bucket_cap: number; stored_buckets: number; reporting_actors_24h: number;
  operations: OpCounts[];
}

const HOUR_MS = 3_600_000;
const TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?\+00:00$/;
class Invalid extends Error {}
const fail = (): never => { throw new Invalid("invalid_snapshot"); };
const obj = (v: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail();
  const o = v as Record<string, unknown>;
  const actual = Object.keys(o).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) fail();
  return o;
};
const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail());
/** PostgreSQL UTC output only; impossible dates (which Date.parse rolls over) are rejected. Returns epoch ms. */
const ts = (v: unknown): number => {
  const m = typeof v === "string" ? TS.exec(v) : null;
  if (!m) return fail();
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const t = new Date(Date.parse(v as string));
  if (!Number.isFinite(t.getTime()) || t.getUTCFullYear() !== y || t.getUTCMonth() + 1 !== mo || t.getUTCDate() !== d
    || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== s) fail();
  return t.getTime();
};
const wholeHour = (ms: number) => { if (ms % HOUR_MS !== 0) fail(); return ms; };

function opCounts(v: unknown, expected: Op, from: number, to: number, observed: number, cap: number): OpCounts {
  const o = obj(v, ["op", "success", "replayed", "rejected", "failed", "capped_buckets", "latest_reported_at", "failed_hours"]);
  if (o.op !== expected) fail();
  if (!Array.isArray(o.failed_hours) || o.failed_hours.length > 24) fail();
  const hours = o.failed_hours as unknown[];
  let prev = -Infinity;
  for (const h of hours) {
    const t = wholeHour(ts(h));
    if (t <= prev || t < from || t > to) fail();
    prev = t;
  }
  const c: OpCounts = {
    op: expected, success: count(o.success), replayed: count(o.replayed), rejected: count(o.rejected), failed: count(o.failed),
    capped_buckets: count(o.capped_buckets), latest_reported_at: null, failed_hours: hours as string[],
  };
  if (o.latest_reported_at !== null) {
    const latest = ts(o.latest_reported_at);
    if (latest < from || latest > observed) fail();
    c.latest_reported_at = o.latest_reported_at as string;
  }
  const total = c.success + c.replayed + c.rejected + c.failed;
  if ((total === 0) !== (c.latest_reported_at === null)) fail();
  if ((c.failed === 0) !== (hours.length === 0)) fail();
  // A capped bucket holds exactly cap, so capped buckets can never exceed the total.
  if (c.capped_buckets * cap > total) fail();
  return c;
}

export type AppValidation = { ok: true; snapshot: AppSnapshot } | { ok: false };

export function validateAppSnapshot(raw: unknown): AppValidation {
  try {
    const o = obj(raw, ["observed_at", "window_start", "bucket_cap", "stored_buckets", "reporting_actors_24h", "operations"]);
    const observed = ts(o.observed_at);
    const from = wholeHour(ts(o.window_start));
    const to = from + 23 * HOUR_MS;
    // The window is the observation's own UTC hour plus the 23 hours before it.
    if (observed < to || observed >= to + HOUR_MS) fail();
    const cap = count(o.bucket_cap);
    if (cap !== 1000) fail();
    if (!Array.isArray(o.operations) || o.operations.length !== OPS.length) fail();
    const operations = OPS.map((op, i) => opCounts((o.operations as unknown[])[i], op, from, to, observed, cap));
    const actors = count(o.reporting_actors_24h);
    const stored = count(o.stored_buckets);
    // Bounded storage: one bucket per actor, hour slot, op and outcome; each holds at most cap. So each
    // outcome is at most actors x 24 x cap, failures at most actors x failed hours x cap, and one op's four
    // outcomes together at most actors x 24 x 4 x cap (implied by the per-outcome bound).
    for (const c of operations) {
      const total = c.success + c.replayed + c.rejected + c.failed;
      if (total > 0 && actors === 0) fail();
      if ([c.success, c.replayed, c.rejected, c.failed].some((n) => n > actors * 24 * cap)) fail();
      if (c.failed > actors * c.failed_hours.length * cap) fail();
      if (c.capped_buckets > actors * 24 * OUTCOMES.length || c.capped_buckets > stored) fail();
    }
    if (actors > stored) fail();
    return { ok: true, snapshot: {
      observed_at: o.observed_at as string, window_start: o.window_start as string, bucket_cap: cap,
      stored_buckets: stored, reporting_actors_24h: actors, operations,
    } };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
/** Per operation: nothing reported is "not measured", never a zero-failure success. */
export type OpStatus = "sustained_failures" | "failures_reported" | "not_measured" | "no_failures_reported";
export type AppStatus = "unavailable" | "invalid" | OpStatus;
export const APP_STATUS_ORDER: AppStatus[] = ["unavailable", "invalid", "sustained_failures", "failures_reported", "not_measured", "no_failures_reported"];
export const APP_STATUS_LABELS: Record<AppStatus, string> = {
  unavailable: "Error: application outcome counts could not be read",
  invalid: "Error: application outcome counts unusable",
  sustained_failures: "Reported failures in two consecutive hours",
  failures_reported: "Failures reported",
  not_measured: "Not measured",
  no_failures_reported: "No failures reported",
};
export const SUSTAINED_RULE =
  "Proposed signal: at least one failure reported in each of two consecutive UTC clock hours inside the last-24-hours window. Hours are coarse buckets, so two failures a minute apart across an hour boundary also match. It does not prove a continuous outage, and rejected (validation, permission) or replayed saves never count toward it.";

export interface OpEvaluation { counts: OpCounts; status: OpStatus }
export interface AppEvaluation { status: AppStatus; snapshot: AppSnapshot | null; ops: OpEvaluation[] }

export function sustained(failedHours: string[]): boolean {
  const t = failedHours.map((h) => Date.parse(h));
  return t.some((x, i) => i > 0 && x - t[i - 1] === HOUR_MS);
}

export function evaluateApp(s: AppSnapshot): AppEvaluation {
  const ops = s.operations.map((c): OpEvaluation => {
    const total = c.success + c.replayed + c.rejected + c.failed;
    const status: OpStatus = total === 0 ? "not_measured"
      : sustained(c.failed_hours) ? "sustained_failures"
        : c.failed > 0 ? "failures_reported" : "no_failures_reported";
    return { counts: c, status };
  });
  const status = APP_STATUS_ORDER.find((x) => ops.some((o) => o.status === x)) ?? "not_measured";
  return { status, snapshot: s, ops };
}

export function assessApp(raw: unknown): AppEvaluation {
  const v = validateAppSnapshot(raw);
  return v.ok ? evaluateApp(v.snapshot) : { status: "invalid", snapshot: null, ops: [] };
}
export const unavailableApp = (): AppEvaluation => ({ status: "unavailable", snapshot: null, ops: [] });

// ---------------------------------------------------------------------------
// Static disclosures and operator guide (rendered on every load)
// ---------------------------------------------------------------------------
export const APP_PROVENANCE =
  "These counts are reported after each request by the signed-in user's own session, through the app server. They are unverified: any signed-in user can add to or suppress their own counts. They are not tamper-proof and are not full monitoring.";
export const APP_LIMITS: string[] = [
  "Counted: inspection assessment saves and session report, analytics and dashboard exports (one outcome per request: success, replayed, rejected or failed).",
  "An export counted as success means the file was generated on the server, not that it was delivered or downloaded.",
  "Not counted: requests by signed-out visitors, requests that fail before sign-in is confirmed, other saves and actions, and any report lost because the database was unreachable, the server process stopped, or recording took longer than 750 ms.",
  "Windows are UTC clock hours: the current partial hour plus the 23 hours before it. There is no shorter window.",
  "Each user's count per operation, outcome and hour stops at the bucket limit; a capped bucket under-counts.",
  "The authoritative per-request record is the structured server log line (event application_outcome) in the hosting logs, not these counts.",
];
export const APP_ZERO_NOTICE =
  "No failures reported does not mean saves and exports are healthy, and nothing here sends alerts: detection happens only when someone opens or refreshes this page.";
export const APP_GUIDE: string[] = [
  "Record the operation name, the counts shown and the capture time from this page in your support notes. Nothing else is needed from here.",
  "Ask whoever has access to the hosting logs to look for event application_outcome with that operation and outcome around that time. Those lines carry only an event ID, the operation, the outcome and the time.",
  "Remember that a single user can inflate these counts. Compare with the hosting logs before treating it as an incident.",
  "Escalate to the escalation contact. Not yet assigned: until the owner names one, tell the owner directly. Any message to customers is drafted by a person and sent only after the owner approves it.",
];
