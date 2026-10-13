// Milestone 5: internal operational alerts. Pure functions only (no I/O, no client clock); safe to import anywhere.
// * billingAlertFindings / appAlertFindings restate the two alert rules on top of the existing evaluators
//   (assess, assessApp). The SQL evaluator private.operations_alert_*_findings must give the same findings for the
//   same snapshot; tests/sql/m5-operations-alerts.test.ts feeds both the same fixtures.
// * validateAlerts checks public.platform_operations_alerts output against an exact allowlist and fails closed:
//   anything unexpected (extra key, unknown enum, impossible or future timestamp, inconsistent heartbeat or
//   counts) is an error state, never an empty or quiet page.
import { assessApp, OP_LABELS, OPS, type Op } from "./application-outcomes";
import { assess } from "./operations";

export const ALERT_CODES = ["WEBHOOK_BACKLOG_STALE", "DISCOVERY_BACKLOG_STALE", "APP_FAILURES_REPORTED"] as const;
export type AlertCode = (typeof ALERT_CODES)[number];
export const SOURCES = ["billing_authoritative", "app_unverified"] as const;
export type Source = (typeof SOURCES)[number];
const SEVERITIES = ["high", "warning"] as const;
export type Severity = (typeof SEVERITIES)[number];
const BILLING_CODES: readonly AlertCode[] = ["WEBHOOK_BACKLOG_STALE", "DISCOVERY_BACKLOG_STALE"];

// ---------------------------------------------------------------------------
// Rule mirrors (parity with the SQL findings helpers)
// ---------------------------------------------------------------------------
export interface AlertFinding {
  code: AlertCode; source: Source; connection_id: string | null; op: Op | null; severity: Severity; count: number; oldest_at: string;
}
export type FindingsResult = { ok: true; findings: AlertFinding[] } | { ok: false };

/** Billing backlog strictly older than 15 minutes. Any snapshot the page shows as an error (invalid shape or a
 *  future timestamp) is unavailable here too: no finding is derived from it. */
export function billingAlertFindings(raw: unknown): FindingsResult {
  const ev = assess(raw);
  if (ev.status === "error" || !ev.snapshot) return { ok: false };
  const byId = new Map(ev.snapshot.connections.map((c) => [c.id, c]));
  const findings = ev.findings.flatMap((f): AlertFinding[] => {
    if (f.code !== "WEBHOOK_BACKLOG_STALE" && f.code !== "DISCOVERY_BACKLOG_STALE") return [];
    const c = byId.get(f.connection_id!)!;
    const [count, oldest] = f.code === "WEBHOOK_BACKLOG_STALE"
      ? [c.webhook.pending + c.webhook.processing + c.webhook.failed, c.webhook.oldest_received_at]
      : [c.discovery.pending + c.discovery.processing + c.discovery.retry, c.discovery.oldest_first_seen_at];
    return [{ code: f.code, source: "billing_authoritative", connection_id: c.id, op: null, severity: "high", count, oldest_at: oldest! }];
  });
  return { ok: true, findings };
}

/** Reported failures in the 24-hour window; high when two adjacent UTC hours had failures. */
export function appAlertFindings(raw: unknown): FindingsResult {
  const ev = assessApp(raw);
  if (!ev.snapshot) return { ok: false };
  const findings = ev.ops.filter((o) => o.counts.failed > 0).map((o): AlertFinding => ({
    code: "APP_FAILURES_REPORTED", source: "app_unverified", connection_id: null, op: o.counts.op,
    severity: o.status === "sustained_failures" ? "high" : "warning", count: o.counts.failed, oldest_at: o.counts.failed_hours[0],
  }));
  return { ok: true, findings };
}

// ---------------------------------------------------------------------------
// Read response validation (exact allowlist; fail closed)
// ---------------------------------------------------------------------------
const RUN_STATUSES = ["ok", "billing_unavailable", "app_unavailable", "both_unavailable"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
const SOURCE_STATUSES = ["ok", "unavailable"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];
const TRIGGERS = ["cron", "manual"] as const;
const FRESHNESS = ["never", "fresh", "stale", "unavailable"] as const;
export type Freshness = (typeof FRESHNESS)[number];
const JOBS = ["active", "inactive", "absent", "not_measured"] as const;
export type SchedulerJob = (typeof JOBS)[number];
export const ALERT_LIMIT = 100;
/** Proposed: the job runs every 5 minutes, so more than 10 minutes without a scheduled attempt is stale. */
export const CRON_STALE_MS = 10 * 60_000;

export interface Heartbeat {
  last_attempt_at: string | null; last_attempt_trigger: (typeof TRIGGERS)[number] | null;
  billing_status: SourceStatus | null; app_status: SourceStatus | null; billing_ok_at: string | null; app_ok_at: string | null;
  last_cron_attempted_at: string | null; last_cron_status: RunStatus | null; last_cron_completed_at: string | null;
  last_manual_attempted_at: string | null; last_manual_status: RunStatus | null; cron_freshness: Freshness;
}
export interface AlertRow {
  code: AlertCode; source: Source; connection_id: string | null; op: Op | null; severity: Severity; active: boolean; episode_count: number;
  first_seen_at: string; last_seen_at: string; last_changed_at: string; cleared_at: string | null; unobserved_since: string | null;
  observed_count: number; observed_oldest_at: string;
}
export interface AlertsView {
  observed_at: string; scheduler_job: SchedulerJob; heartbeat: Heartbeat;
  alert_limit: number; alerts_total: number; alerts_active: number; alerts_truncated: boolean; alerts: AlertRow[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?\+00:00$/;
class Invalid extends Error {}
const fail = (): never => { throw new Invalid("invalid_alerts"); };
const obj = (v: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail();
  const o = v as Record<string, unknown>;
  const actual = Object.keys(o).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) fail();
  return o;
};
const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fail());
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail());
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T => (values.includes(v as T) ? (v as T) : fail());
const oneOfOrNull = <T extends string>(v: unknown, values: readonly T[]): T | null => (v === null ? null : oneOf(v, values));
const epoch = (v: string) => Date.parse(v);

/** PostgreSQL UTC output only, impossible dates rejected, and never later than the observation. */
function tsAt(observed: number) {
  const ts = (v: unknown): string => {
    const m = typeof v === "string" ? TS.exec(v) : null;
    if (!m) return fail();
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    const t = new Date(Date.parse(v as string));
    if (!Number.isFinite(t.getTime()) || t.getUTCFullYear() !== y || t.getUTCMonth() + 1 !== mo || t.getUTCDate() !== d
      || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== s) fail();
    if (t.getTime() > observed) fail();
    return v as string;
  };
  return { ts, tsOrNull: (v: unknown): string | null => (v === null ? null : ts(v)) };
}

function heartbeat(v: unknown, observed: number): Heartbeat {
  const o = obj(v, ["last_attempt_at", "last_attempt_trigger", "billing_status", "app_status", "billing_ok_at", "app_ok_at",
    "last_cron_attempted_at", "last_cron_status", "last_cron_completed_at", "last_manual_attempted_at", "last_manual_status", "cron_freshness"]);
  const { tsOrNull } = tsAt(observed);
  const h: Heartbeat = {
    last_attempt_at: tsOrNull(o.last_attempt_at), last_attempt_trigger: oneOfOrNull(o.last_attempt_trigger, TRIGGERS),
    billing_status: oneOfOrNull(o.billing_status, SOURCE_STATUSES), app_status: oneOfOrNull(o.app_status, SOURCE_STATUSES),
    billing_ok_at: tsOrNull(o.billing_ok_at), app_ok_at: tsOrNull(o.app_ok_at),
    last_cron_attempted_at: tsOrNull(o.last_cron_attempted_at), last_cron_status: oneOfOrNull(o.last_cron_status, RUN_STATUSES),
    last_cron_completed_at: tsOrNull(o.last_cron_completed_at),
    last_manual_attempted_at: tsOrNull(o.last_manual_attempted_at), last_manual_status: oneOfOrNull(o.last_manual_status, RUN_STATUSES),
    cron_freshness: oneOf(o.cron_freshness, FRESHNESS),
  };
  const never = h.last_attempt_at === null;
  if ([h.last_attempt_trigger, h.billing_status, h.app_status].some((x) => (x === null) !== never)) fail();
  if ((h.last_cron_attempted_at === null) !== (h.last_cron_status === null)) fail();
  if ((h.last_manual_attempted_at === null) !== (h.last_manual_status === null)) fail();
  if (never && [h.billing_ok_at, h.app_ok_at, h.last_cron_attempted_at, h.last_manual_attempted_at].some((x) => x !== null)) fail();
  // The latest attempt is the newer of the cron and manual attempts, and its trigger says which.
  if (!never) {
    const own = h.last_attempt_trigger === "cron" ? h.last_cron_attempted_at : h.last_manual_attempted_at;
    if (own !== h.last_attempt_at) fail();
    for (const t of [h.last_cron_attempted_at, h.last_manual_attempted_at]) if (t && epoch(t) > epoch(h.last_attempt_at!)) fail();
  }
  // A source that was ok in the latest attempt was last read at that attempt; an earlier read is never later.
  for (const [status, at] of [[h.billing_status, h.billing_ok_at], [h.app_status, h.app_ok_at]] as const) {
    if (status === "ok" && at !== h.last_attempt_at) fail();
    if (at && epoch(at) > epoch(h.last_attempt_at!)) fail();
  }
  if (h.last_cron_completed_at !== null) {
    if (h.last_cron_attempted_at === null || epoch(h.last_cron_completed_at) > epoch(h.last_cron_attempted_at)) fail();
  }
  if (h.last_cron_status === "ok" && h.last_cron_completed_at !== h.last_cron_attempted_at) fail();
  // Freshness is computed in SQL at microsecond precision; allow 1 ms of truncation difference at the boundary.
  const age = h.last_cron_attempted_at === null ? null : observed - epoch(h.last_cron_attempted_at);
  const expectFresh = age !== null && age <= CRON_STALE_MS + 1;
  const expectStale = age !== null && age > CRON_STALE_MS - 1;
  switch (h.cron_freshness) {
    case "never": if (age !== null) fail(); break;
    case "stale": if (!expectStale) fail(); break;
    case "unavailable": if (!expectFresh || h.last_cron_status === "ok") fail(); break;
    case "fresh": if (!expectFresh || h.last_cron_status !== "ok") fail(); break;
  }
  return h;
}

function alertRow(v: unknown, observed: number): AlertRow {
  const o = obj(v, ["code", "source", "connection_id", "op", "severity", "active", "episode_count", "first_seen_at", "last_seen_at",
    "last_changed_at", "cleared_at", "unobserved_since", "observed_count", "observed_oldest_at"]);
  const { ts, tsOrNull } = tsAt(observed);
  const code = oneOf(o.code, ALERT_CODES);
  const source = oneOf(o.source, SOURCES);
  const billing = BILLING_CODES.includes(code);
  if (billing !== (source === "billing_authoritative")) fail();
  const r: AlertRow = {
    code, source,
    connection_id: billing ? (typeof o.connection_id === "string" && UUID.test(o.connection_id) ? o.connection_id : fail()) : (o.connection_id === null ? null : fail()),
    op: billing ? (o.op === null ? null : fail()) : oneOf(o.op, OPS),
    severity: oneOf(o.severity, SEVERITIES), active: bool(o.active), episode_count: count(o.episode_count),
    first_seen_at: ts(o.first_seen_at), last_seen_at: ts(o.last_seen_at), last_changed_at: ts(o.last_changed_at),
    cleared_at: tsOrNull(o.cleared_at), unobserved_since: tsOrNull(o.unobserved_since),
    observed_count: count(o.observed_count), observed_oldest_at: ts(o.observed_oldest_at),
  };
  if (r.episode_count < 1 || r.observed_count < 1) fail();
  if (r.active !== (r.cleared_at === null)) fail();
  if (!billing && r.unobserved_since !== null) fail();
  if (epoch(r.first_seen_at) > epoch(r.last_seen_at) || epoch(r.first_seen_at) > epoch(r.last_changed_at)) fail();
  if (r.cleared_at && epoch(r.cleared_at) < epoch(r.last_seen_at)) fail();
  return r;
}

export type AlertsValidation = { ok: true; view: AlertsView } | { ok: false };

export function validateAlerts(raw: unknown): AlertsValidation {
  try {
    const o = obj(raw, ["observed_at", "scheduler_job", "heartbeat", "alert_limit", "alerts_total", "alerts_active", "alerts_truncated", "alerts"]);
    const observed_at = tsAt(Infinity).ts(o.observed_at);
    const observed = epoch(observed_at);
    const limit = count(o.alert_limit);
    if (limit !== ALERT_LIMIT) fail();
    const total = count(o.alerts_total);
    const active = count(o.alerts_active);
    const truncated = bool(o.alerts_truncated);
    if (!Array.isArray(o.alerts)) fail();
    const alerts = (o.alerts as unknown[]).map((a) => alertRow(a, observed));
    // The list is the first min(total, limit) rows; nothing is dropped silently.
    if (active > total || alerts.length !== Math.min(total, limit) || truncated !== total > limit) fail();
    const listedActive = alerts.filter((a) => a.active).length;
    if (listedActive > active || (!truncated && listedActive !== active)) fail();
    // Active rows first, so a truncated list never hides an active alert behind an inactive one.
    if (alerts.some((a, i) => i > 0 && a.active && !alerts[i - 1].active)) fail();
    const keys = new Set(alerts.map((a) => `${a.code}:${a.connection_id ?? a.op}`));
    if (keys.size !== alerts.length) fail();
    return { ok: true, view: {
      observed_at, scheduler_job: oneOf(o.scheduler_job, JOBS), heartbeat: heartbeat(o.heartbeat, observed),
      alert_limit: limit, alerts_total: total, alerts_active: active, alerts_truncated: truncated, alerts,
    } };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false };
    throw e;
  }
}

/** Automatic checks are described as running only when the named job is active AND the latest scheduled run is
 *  recent and read both sources. Anything else (including a job catalog that cannot be read) is "not confirmed". */
export const automaticChecksConfirmed = (v: AlertsView) => v.scheduler_job === "active" && v.heartbeat.cron_freshness === "fresh";

// ---------------------------------------------------------------------------
// Static text (no interpolation of anything but validated times, counts, UUIDs and operation labels)
// ---------------------------------------------------------------------------
export const FRESHNESS_LABELS: Record<Freshness, string> = {
  fresh: "Scheduled check: ran in the last 10 minutes",
  stale: "Scheduled check: stale (no scheduled run in the last 10 minutes)",
  never: "Scheduled check: has never run",
  unavailable: "Scheduled check: latest run could not read a source",
};
export const JOB_LABELS: Record<SchedulerJob, string> = {
  active: "Schedule entry: found and active.",
  inactive: "Schedule entry: found but paused.",
  absent: "Schedule entry: not set up.",
  not_measured: "Schedule entry: not measured (the schedule list cannot be read here). This does not mean it is off or on.",
};
export const SOURCE_LABELS: Record<Source, string> = {
  billing_authoritative: "Billing queues (database records)",
  app_unverified: "Saves and exports (unverified user reports)",
};
export const CHECK_FAILING =
  "This source could not be read in the latest check. Its warnings below were left exactly as they were: not cleared and not refreshed.";
export const ALERT_TEXT: Record<AlertCode, { title: string; message: string; guide: string }> = {
  WEBHOOK_BACKLOG_STALE: { title: "Billing events waiting too long",
    message: "The oldest unprocessed webhook event for this connection was received more than 15 minutes before the check.",
    guide: "/platform/operations#guide-rb-bill-01" },
  DISCOVERY_BACKLOG_STALE: { title: "Discovered payments waiting too long",
    message: "The oldest queued discovered payment for this connection was first seen more than 15 minutes before the check.",
    guide: "/platform/operations#guide-rb-bill-01" },
  APP_FAILURES_REPORTED: { title: "Failed saves or exports reported",
    message: "Signed-in users' sessions reported at least one failure for this operation in the last 24 UTC hours. Unverified: confirm in the hosting logs.",
    guide: "/platform/operations#app-guide-h" },
};
export const SUSTAINED_FLAG = "High: failures were reported in two adjacent UTC hours (proposed signal; it does not prove a continuous outage).";
export const opLabel = (op: Op) => OP_LABELS[op];

/** Brief provenance, always visible above everything else. */
export const PROVENANCE: string[] = [
  "Recipient: the platform owner. Only live platform admins can open this page; no other staff access was added.",
  "Delivery: the owner chose email plus this admin page. Automatic alert email is not connected (it needs a separately reviewed sender), so no warning has been emailed and none is promised. For now a warning is seen only when someone opens this page.",
  "Email verification: a manual test email to the owner address is available below, at most once per UTC day. It is a test only, carries no alert content and does not mean warnings are emailed.",
  "Support hours: awaiting the owner's choice. Nobody is on call and no response time is promised.",
  "These checks run inside the database they watch. If the database, its scheduler or the check itself stops, the only sign is an old scheduled-check time.",
];
/** Full detail, inside a native collapsible section. */
export const DETAILS: string[] = [
  "Only two conditions are checked: billing webhook or payment-discovery items waiting more than 15 minutes, and failed saves or exports reported by users in the last 24 UTC hours. Worker run freshness, dead or held items and review items are shown on the Operations monitor, not here.",
  "Billing warnings come from the database's own queue records. A billing warning is marked no longer observed only when a check that read the billing records successfully found the condition absent.",
  "Save and export warnings come from counts that users' own sessions report. Any signed-in user can add to or suppress their own counts, so compare with the hosting logs before treating one as an incident.",
  "Save and export counts are kept in whole UTC hours. A warning remains active while failures appear in the current window, which can last up to 24 hours after the last reported failure. No longer reported does not mean confirmed recovery.",
  "If a source cannot be read, or returns something unexpected or dated in the future, that source is marked failing for that check and its warnings are left unchanged. The other source is still checked.",
  "A connection that is no longer listed keeps its last warning, marked as not observed. It is never treated as fixed because it disappeared.",
  "The scheduled check is meant to run every 5 minutes once the owner approves setting it up. A check run by hand is shown separately and never counts as a scheduled run.",
  "Each warning keeps one entry. Episodes counts how many times it became active again; repeated checks of the same condition do not add entries.",
];
export const NO_ALERTS_ACTIVE = "No warning is active in the stored results. This is not a health statement: it only covers the two conditions above, as of the latest check that could read each source.";
export const GUIDE_BILLING: string[] = [
  "Open the Operations monitor and follow \"Billing events are waiting too long\". It is read-only.",
  "Record the warning, the connection and the times shown here in your support notes.",
  "Escalate to the escalation contact. Not yet assigned: until the owner names one, tell the owner directly. Never change billing items by hand.",
];
export const GUIDE_APP: string[] = [
  "Record the operation, the count and the times shown here in your support notes.",
  "Ask whoever has access to the hosting logs to look for event application_outcome with that operation and outcome failed around those hours.",
  "A single user can inflate these counts. Treat it as an incident only after the hosting logs agree.",
  "Escalate to the escalation contact. Not yet assigned: until the owner names one, tell the owner directly. Any message to customers is drafted by a person and sent only after the owner approves it.",
];
