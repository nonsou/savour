// Milestone 5: development-only automatic owner email. Validates public.platform_operations_mailer output against an
// exact allowlist and fails closed (including any time later than the observation); holds the static text for the
// alerts page. No I/O. The worker heartbeat and the scheduler are separate facts: a manual worker call refreshes the
// heartbeat only, and the latest scheduled start comes from the pg_cron catalog.

const ALERT_CODES = ["WEBHOOK_BACKLOG_STALE", "DISCOVERY_BACKLOG_STALE", "APP_FAILURES_REPORTED"] as const;
const LEDGER_STATUSES = ["pending", "leased", "accepted", "rejected", "unknown", "review", "cancelled"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];
const WORKER_STATUSES = ["ready", "not_configured"] as const;
const FRESHNESS = ["never", "fresh", "stale"] as const;
const JOBS = ["active", "inactive", "absent", "not_measured"] as const;
export type SchedulerJob = (typeof JOBS)[number];
const RUN_STATUSES = ["succeeded", "failed", "running", "other"] as const;
export type ScheduledRunStatus = (typeof RUN_STATUSES)[number];
export const AUTOMATIC_LIMIT = 5;
export const MANUAL_LIMIT = 1;
export const RECENT_LIMIT = 14;
/** The worker is stale after 10 minutes without a heartbeat (it is scheduled every 5). */
export const WORKER_STALE_MS = 10 * 60_000;

export interface MailerRecent {
  code: (typeof ALERT_CODES)[number]; status: LedgerStatus; attempts: number; created_at: string; first_dispatched_at: string | null; finished_at: string | null;
}
export interface MailerView {
  observed_at: string; enabled: boolean; enabled_changed_at: string | null;
  worker: { status: (typeof WORKER_STATUSES)[number] | null; key_present: boolean | null; last_checked_at: string | null; last_ready_at: string | null;
    freshness: (typeof FRESHNESS)[number] };
  scheduler: { job: SchedulerJob; last_scheduled_start_at: string | null; last_scheduled_status: ScheduledRunStatus | null };
  ready_to_enable: boolean;
  today: { utc_day: string; automatic_limit: number; manual_limit: number; automatic_attempts: number };
  queue: { pending: number; leased: number; unknown: number; review: number };
  last_accepted_at: string | null;
  recent: MailerRecent[];
}

class Invalid extends Error {}
const fail = (): never => { throw new Invalid(); };
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00:00$/;
const obj = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail();
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== [...keys].sort().join(",")) fail();
  return o;
};
const count = (v: unknown, max = Number.MAX_SAFE_INTEGER) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : fail());
const bool = (v: unknown) => (typeof v === "boolean" ? v : fail());
const oneOf = <T extends string>(v: unknown, values: readonly T[]) => (values.includes(v as T) ? (v as T) : fail());

export function validateMailer(raw: unknown): MailerView | null {
  try {
    const o = obj(raw, ["observed_at", "enabled", "enabled_changed_at", "worker", "scheduler", "ready_to_enable", "today", "queue",
      "last_accepted_at", "recent"]);
    const ts = (v: unknown): string => (typeof v === "string" && TS.test(v) && Number.isFinite(Date.parse(v)) ? v : fail());
    const observed_at = ts(o.observed_at);
    const observed = Date.parse(observed_at);
    const past = (v: unknown): string | null => {
      if (v === null) return null;
      const t = ts(v);
      return Date.parse(t) <= observed ? t : fail(); // a future time fails closed
    };
    const w = obj(o.worker, ["status", "key_present", "last_checked_at", "last_ready_at", "freshness"]);
    const worker: MailerView["worker"] = {
      status: w.status === null ? null : oneOf(w.status, WORKER_STATUSES),
      key_present: w.key_present === null ? null : bool(w.key_present),
      last_checked_at: past(w.last_checked_at), last_ready_at: past(w.last_ready_at), freshness: oneOf(w.freshness, FRESHNESS),
    };
    if ((worker.status === null) !== (worker.last_checked_at === null) || (worker.status === null) !== (worker.key_present === null)) fail();
    if (worker.status !== null && worker.key_present !== (worker.status === "ready")) fail();
    if (worker.status === "ready" && worker.last_ready_at !== worker.last_checked_at) fail();
    const age = worker.last_checked_at === null ? null : observed - Date.parse(worker.last_checked_at);
    // SQL compares at microsecond precision; allow 1 ms of truncation at the boundary.
    if ((worker.freshness === "never") !== (age === null)) fail();
    if (worker.freshness === "fresh" && age! > WORKER_STALE_MS + 1) fail();
    if (worker.freshness === "stale" && age! <= WORKER_STALE_MS - 1) fail();
    const s = obj(o.scheduler, ["job", "last_scheduled_start_at", "last_scheduled_status"]);
    const scheduler: MailerView["scheduler"] = { job: oneOf(s.job, JOBS), last_scheduled_start_at: past(s.last_scheduled_start_at),
      last_scheduled_status: s.last_scheduled_status === null ? null : oneOf(s.last_scheduled_status, RUN_STATUSES) };
    if ((scheduler.last_scheduled_start_at === null) !== (scheduler.last_scheduled_status === null)) fail();
    if ((scheduler.job === "absent" || scheduler.job === "not_measured") && scheduler.last_scheduled_start_at !== null) fail();
    const ready_to_enable = bool(o.ready_to_enable);
    if (ready_to_enable !== (worker.freshness === "fresh" && worker.status === "ready" && scheduler.job === "active")) fail();
    const t = obj(o.today, ["utc_day", "automatic_limit", "manual_limit", "automatic_attempts"]);
    if (t.utc_day !== observed_at.slice(0, 10) || t.automatic_limit !== AUTOMATIC_LIMIT || t.manual_limit !== MANUAL_LIMIT) fail();
    // Queue counts: non-negative only. Leases from two UTC days can coexist inside one 15-minute window (5 before and
    // 5 after midnight), so no fixed upper bound is imposed here; SQL enforces the real limits.
    const q = obj(o.queue, ["pending", "leased", "unknown", "review"]);
    if (!Array.isArray(o.recent) || o.recent.length > RECENT_LIMIT) fail();
    const recent = (o.recent as unknown[]).map((r): MailerRecent => {
      const x = obj(r, ["code", "status", "attempts", "created_at", "first_dispatched_at", "finished_at"]);
      const row: MailerRecent = { code: oneOf(x.code, ALERT_CODES), status: oneOf(x.status, LEDGER_STATUSES), attempts: count(x.attempts, 5),
        created_at: past(x.created_at)!, first_dispatched_at: past(x.first_dispatched_at), finished_at: past(x.finished_at) };
      if (row.created_at === null || (row.attempts === 0) !== (row.first_dispatched_at === null)) fail();
      if ((row.status === "pending" || row.status === "cancelled") && row.attempts !== 0) fail();
      return row;
    });
    return {
      observed_at, enabled: bool(o.enabled), enabled_changed_at: past(o.enabled_changed_at), worker, scheduler, ready_to_enable,
      today: { utc_day: t.utc_day as string, automatic_limit: AUTOMATIC_LIMIT, manual_limit: MANUAL_LIMIT, automatic_attempts: count(t.automatic_attempts, AUTOMATIC_LIMIT) },
      queue: { pending: count(q.pending), leased: count(q.leased), unknown: count(q.unknown), review: count(q.review) },
      last_accepted_at: past(o.last_accepted_at), recent,
    };
  } catch (e) {
    if (e instanceof Invalid) return null;
    throw e;
  }
}

export type MailerState = "unavailable" | "pending" | "worker_stale" | "not_scheduled" | "ready" | "enabled" | "enabled_unconfirmed";
/** One headline state. Enabled is confirmed only with a fresh ready worker AND the named job active. */
export function mailerState(v: MailerView | null): MailerState {
  if (!v) return "unavailable";
  const workerOk = v.worker.freshness === "fresh" && v.worker.status === "ready";
  if (v.enabled) return workerOk && v.scheduler.job === "active" ? "enabled" : "enabled_unconfirmed";
  if (v.worker.freshness === "stale") return "worker_stale";
  if (!workerOk) return "pending";
  return v.scheduler.job === "active" ? "ready" : "not_scheduled";
}

export const MAILER_STATE_LABELS: Record<MailerState, string> = {
  unavailable: "Automatic email status could not be read. Do not assume it is on or off.",
  pending: "Pending: the worker has not reported a ready provider key in the last 10 minutes. Nothing can be switched on yet.",
  worker_stale: "Worker stale: no worker check in the last 10 minutes (it may be unscheduled, or the development project paused).",
  not_scheduled: "Not scheduled: the worker reports its key, but the scheduled job is not confirmed active, so this cannot be switched on.",
  ready: "Ready but off: the worker reports its key and the scheduled job is active. No warning is emailed until an owner switches this on.",
  enabled: "On: active warnings (including any already active when switched on) are emailed to the owner test address, within the daily cap.",
  enabled_unconfirmed: "Switched on, but the worker or its scheduled job is not confirmed right now, so emails may not be sent.",
};
export const JOB_LABELS: Record<SchedulerJob, string> = {
  active: "Scheduled job: found and active.",
  inactive: "Scheduled job: found but paused.",
  absent: "Scheduled job: not set up.",
  not_measured: "Scheduled job: not measured (the schedule list cannot be read here). This does not mean it is on or off.",
};
export const RUN_LABELS: Record<ScheduledRunStatus, string> = {
  succeeded: "the scheduler queued the request",
  failed: "the scheduler could not queue the request",
  running: "still running",
  other: "status not recognised",
};
/** Shown beside the scheduled-run line: what a scheduler status does and does not mean. */
export const SCHEDULE_NOTE = "A scheduled run that succeeded only means the request to the worker was queued. It is not an email sent or delivered, and not a health statement.";
export const MAILER_TERMS: string[] = [
  "Development only: every email goes to the owner test address nonsou@gmail.com from onboarding@resend.dev (a Resend test domain).",
  `Two fixed, separate budgets: at most ${AUTOMATIC_LIMIT} automatic attempts per UTC day plus the ${MANUAL_LIMIT} manual verification per day, so at most ${AUTOMATIC_LIMIT + MANUAL_LIMIT} a day. At most one email per warning episode; no email when a warning clears.`,
  "When switched on, warnings that are already active are emailed too (at most 20 queued per run, high severity first).",
  "Accepted means Resend accepted the request, as reported by the worker. It is not confirmation of delivery.",
  "No response time is promised and nobody is on call. Always check this page.",
];
export const LEDGER_LABELS: Record<LedgerStatus, string> = {
  pending: "Waiting to send",
  leased: "Sending",
  accepted: "Accepted by Resend (as reported by the worker; not confirmation of delivery)",
  rejected: "Rejected by Resend",
  unknown: "Unknown outcome; may be retried with the same message within 23 hours",
  review: "Stopped: needs a person to review (out of attempts or past 23 hours)",
  cancelled: "Cancelled: the warning cleared before it was sent",
};
export const MAILER_MESSAGES = {
  confirmEnable: "Tick the confirmation box to switch automatic email on.",
  confirmDisable: "Tick the confirmation box to switch automatic email off.",
  enabled: "Automatic email is on. It sends only while the scheduled job and the worker keep running.",
  disabled: "Automatic email is off. Nothing new will be sent.",
  notReady: "The worker has not reported a ready key in the last 10 minutes, so automatic email was not switched on.",
  notScheduled: "The scheduled job is not confirmed active, so automatic email was not switched on.",
  mfa: "Two-step verification is required for this change. Verify on the platform admin page, then try again. Nothing was changed.",
  forbidden: "You do not have permission to do that. Nothing was changed.",
  failed: "The change could not be saved. Nothing was changed.",
} as const;
