// Milestone 5 OPS01: validation and evaluation of the read-only billing operations snapshot
// (public.platform_operations_snapshot). Pure functions only: no I/O, no client clock. Every age is
// measured against the snapshot's own observed_at (the database statement time). Anything that does not
// match the exact expected shape fails closed to the error state; no source string is ever rendered
// except validated UUIDs, enums and timestamps.

/** Proposed thresholds (strictly greater than is stale; exactly at the boundary is not). */
export const THRESHOLDS_MS = {
  backlog: 15 * 60_000,
  unfinishedRun: 5 * 60_000,
  run: { process: 5 * 60_000, discover: 2 * 3_600_000, reconcile: 26 * 3_600_000 },
} as const;

export const MODES = ["process", "discover", "reconcile"] as const;
export type Mode = (typeof MODES)[number];
const PROVIDERS = ["bachs", "paystack", "stripe"] as const;
const CONNECTION_STATUSES = ["draft", "tested", "enabled", "disabled"] as const;
const OUTCOMES = ["success", "failure", "partial", "none"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface RunFacts {
  latest_finished_at: string | null; latest_outcome: Outcome; latest_success_at: string | null;
  unfinished: number; oldest_unfinished_started_at: string | null; failed_24h: number; partial_24h: number;
}
export interface ConnectionFacts {
  id: string; provider_code: (typeof PROVIDERS)[number]; status: (typeof CONNECTION_STATUSES)[number]; worker_required: boolean;
  webhook: { pending: number; processing: number; failed: number; expired_leases: number; oldest_received_at: string | null };
  webhook_dead: number; webhook_quarantined: number;
  discovery: { pending: number; processing: number; retry: number; expired_leases: number; oldest_first_seen_at: string | null };
  discovery_dead: number;
  reviews: { open: number; oldest_created_at: string | null };
  collisions_24h: number;
  runs: Record<Mode, RunFacts>;
}
export interface Snapshot {
  observed_at: string; worker_connection_ids: string[]; connections: ConnectionFacts[];
  unassigned_reviews: { open: number; oldest_created_at: string | null };
}

// ---------------------------------------------------------------------------
// Validation (exact allowlist; fail closed)
// ---------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The RPC runs with timezone UTC, so PostgreSQL emits +00:00 with 0-6 fractional digits; any other form is
// rejected. Date.parse silently rolls impossible dates over (2026-02-30 becomes 2 March), so every
// whole-second component is re-checked against the parsed UTC date.
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
const uuid = (v: unknown): string => (typeof v === "string" && UUID.test(v) ? v : fail());
const ts = (v: unknown): string => {
  const m = typeof v === "string" ? TS.exec(v) : null;
  if (!m) return fail();
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const parsed = Date.parse(v as string);
  if (!Number.isFinite(parsed)) fail();
  const t = new Date(parsed);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() + 1 !== mo || t.getUTCDate() !== d
    || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== s) fail();
  return v as string;
};
const tsOrNull = (v: unknown): string | null => (v === null ? null : ts(v));
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T => (values.includes(v as T) ? (v as T) : fail());
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : fail());
/** A count of zero has no oldest timestamp, and a positive count must have one. */
const consistent = (n: number, oldest: string | null) => { if ((n === 0) !== (oldest === null)) fail(); };

function run(v: unknown): RunFacts {
  const o = obj(v, ["latest_finished_at", "latest_outcome", "latest_success_at", "unfinished", "oldest_unfinished_started_at", "failed_24h", "partial_24h"]);
  const r: RunFacts = {
    latest_finished_at: tsOrNull(o.latest_finished_at), latest_outcome: oneOf(o.latest_outcome, OUTCOMES),
    latest_success_at: tsOrNull(o.latest_success_at), unfinished: count(o.unfinished),
    oldest_unfinished_started_at: tsOrNull(o.oldest_unfinished_started_at), failed_24h: count(o.failed_24h), partial_24h: count(o.partial_24h),
  };
  if ((r.latest_outcome === "none") !== (r.latest_finished_at === null)) fail();
  if (r.latest_outcome === "none" && r.latest_success_at !== null) fail();
  if (r.latest_outcome === "success" && r.latest_success_at !== r.latest_finished_at) fail();
  if (r.latest_success_at && r.latest_finished_at && Date.parse(r.latest_success_at) > Date.parse(r.latest_finished_at)) fail();
  consistent(r.unfinished, r.oldest_unfinished_started_at);
  return r;
}

function connection(v: unknown, required: Set<string>): ConnectionFacts {
  const o = obj(v, ["id", "provider_code", "status", "worker_required", "webhook", "webhook_dead", "webhook_quarantined", "discovery",
    "discovery_dead", "reviews", "collisions_24h", "runs"]);
  const w = obj(o.webhook, ["pending", "processing", "failed", "expired_leases", "oldest_received_at"]);
  const d = obj(o.discovery, ["pending", "processing", "retry", "expired_leases", "oldest_first_seen_at"]);
  const rv = obj(o.reviews, ["open", "oldest_created_at"]);
  const runs = obj(o.runs, MODES);
  const c: ConnectionFacts = {
    id: uuid(o.id), provider_code: oneOf(o.provider_code, PROVIDERS), status: oneOf(o.status, CONNECTION_STATUSES),
    worker_required: bool(o.worker_required),
    webhook: { pending: count(w.pending), processing: count(w.processing), failed: count(w.failed), expired_leases: count(w.expired_leases),
      oldest_received_at: tsOrNull(w.oldest_received_at) },
    webhook_dead: count(o.webhook_dead), webhook_quarantined: count(o.webhook_quarantined),
    discovery: { pending: count(d.pending), processing: count(d.processing), retry: count(d.retry), expired_leases: count(d.expired_leases),
      oldest_first_seen_at: tsOrNull(d.oldest_first_seen_at) },
    discovery_dead: count(o.discovery_dead),
    reviews: { open: count(rv.open), oldest_created_at: tsOrNull(rv.oldest_created_at) },
    collisions_24h: count(o.collisions_24h),
    runs: { process: run(runs.process), discover: run(runs.discover), reconcile: run(runs.reconcile) },
  };
  consistent(c.webhook.pending + c.webhook.processing + c.webhook.failed, c.webhook.oldest_received_at);
  consistent(c.discovery.pending + c.discovery.processing + c.discovery.retry, c.discovery.oldest_first_seen_at);
  consistent(c.reviews.open, c.reviews.oldest_created_at);
  if (c.webhook.expired_leases > c.webhook.processing || c.discovery.expired_leases > c.discovery.processing) fail();
  if (c.worker_required !== required.has(c.id)) fail();
  return c;
}

export type Validation = { ok: true; snapshot: Snapshot } | { ok: false };

export function validateSnapshot(raw: unknown): Validation {
  try {
    const o = obj(raw, ["observed_at", "worker_connection_ids", "connections", "unassigned_reviews"]);
    if (!Array.isArray(o.worker_connection_ids) || !Array.isArray(o.connections)) fail();
    const ids = (o.worker_connection_ids as unknown[]).map(uuid);
    const required = new Set(ids);
    if (required.size !== ids.length) fail();
    const connections = (o.connections as unknown[]).map((c) => connection(c, required));
    const seen = new Set(connections.map((c) => c.id));
    if (seen.size !== connections.length || ids.some((id) => !seen.has(id))) fail();
    const u = obj(o.unassigned_reviews, ["open", "oldest_created_at"]);
    const unassigned = { open: count(u.open), oldest_created_at: tsOrNull(u.oldest_created_at) };
    consistent(unassigned.open, unassigned.oldest_created_at);
    return { ok: true, snapshot: { observed_at: ts(o.observed_at), worker_connection_ids: ids, connections, unassigned_reviews: unassigned } };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
export type Status = "error" | "attention" | "not_measured" | "within_thresholds";
export const STATUS_ORDER: Status[] = ["error", "attention", "not_measured", "within_thresholds"];
export const STATUS_LABELS: Record<Status, string> = {
  error: "Error: snapshot unusable",
  attention: "Attention needed",
  not_measured: "Not measured",
  within_thresholds: "Billing checks within thresholds",
};

export type Code =
  | "SNAPSHOT_UNAVAILABLE" | "SNAPSHOT_INVALID" | "FUTURE_TIMESTAMP"
  | "NO_WORKER_CONNECTIONS" | "WORKER_NOT_REQUIRED" | "RUN_NEVER_FINISHED"
  | "RUN_STALE" | "RUN_LATEST_FAILED" | "RUN_LATEST_PARTIAL" | "RUN_STUCK"
  | "WEBHOOK_BACKLOG_STALE" | "WEBHOOK_LEASE_EXPIRED" | "WEBHOOK_DEAD" | "WEBHOOK_QUARANTINED" | "WEBHOOK_COLLISIONS_24H"
  | "DISCOVERY_BACKLOG_STALE" | "DISCOVERY_LEASE_EXPIRED" | "DISCOVERY_DEAD"
  | "REVIEWS_OPEN" | "REVIEWS_UNASSIGNED_OPEN";

/** Every code maps to one static message and one action in ACTIONS (the in-page guide), whose ID is also a
 *  heading in docs/milestone-5/operations-runbooks.md. */
export const CODES: Record<Code, { status: Status; action: ActionId; message: string }> = {
  SNAPSHOT_UNAVAILABLE: { status: "error", action: "RB-OPS-01", message: "The snapshot could not be read. Nothing below is current; retry, then follow the unavailable-snapshot steps." },
  SNAPSHOT_INVALID: { status: "error", action: "RB-OPS-01", message: "The snapshot did not match the expected shape or values, so it is not shown." },
  FUTURE_TIMESTAMP: { status: "error", action: "RB-OPS-02", message: "A recorded time is later than the database observation time. Ages cannot be trusted." },
  NO_WORKER_CONNECTIONS: { status: "not_measured", action: "RB-WORK-04", message: "No connection has a stored credential, so the billing worker serves none and nothing is measured." },
  WORKER_NOT_REQUIRED: { status: "not_measured", action: "RB-WORK-04", message: "The worker does not serve this connection (no stored credential); its run freshness is not measured." },
  RUN_NEVER_FINISHED: { status: "not_measured", action: "RB-WORK-01", message: "No scheduled (cron) run of this mode has ever finished for this connection." },
  RUN_STALE: { status: "attention", action: "RB-WORK-01", message: "The latest finished scheduled run is older than the threshold: the schedule may not be firing." },
  RUN_LATEST_FAILED: { status: "attention", action: "RB-WORK-02", message: "The latest finished scheduled run failed." },
  RUN_LATEST_PARTIAL: { status: "attention", action: "RB-WORK-02", message: "The latest finished scheduled run finished with failed items." },
  RUN_STUCK: { status: "attention", action: "RB-WORK-03", message: "A scheduled run started more than 5 minutes ago and has not finished (crashed or orphaned worker)." },
  WEBHOOK_BACKLOG_STALE: { status: "attention", action: "RB-BILL-01", message: "The oldest unprocessed webhook event was received more than 15 minutes ago." },
  WEBHOOK_LEASE_EXPIRED: { status: "attention", action: "RB-WORK-03", message: "A webhook event is held by a worker whose lease has expired." },
  WEBHOOK_DEAD: { status: "attention", action: "RB-BILL-02", message: "Webhook events stopped retrying (dead)." },
  WEBHOOK_QUARANTINED: { status: "attention", action: "RB-BILL-02", message: "Webhook events were quarantined." },
  WEBHOOK_COLLISIONS_24H: { status: "attention", action: "RB-BILL-03", message: "An event ID arrived again with different bytes in the last 24 hours (proposed 24-hour attention window)." },
  DISCOVERY_BACKLOG_STALE: { status: "attention", action: "RB-BILL-01", message: "The oldest queued discovered payment was first seen more than 15 minutes ago." },
  DISCOVERY_LEASE_EXPIRED: { status: "attention", action: "RB-WORK-03", message: "A discovered payment is held by a worker whose lease has expired." },
  DISCOVERY_DEAD: { status: "attention", action: "RB-BILL-02", message: "Discovered payments stopped retrying (dead)." },
  REVIEWS_OPEN: { status: "attention", action: "RB-REC-01", message: "Unresolved billing review items exist for this connection." },
  REVIEWS_UNASSIGNED_OPEN: { status: "attention", action: "RB-REC-01", message: "Unresolved billing review items exist without a connection." },
};

/** In-page operator guide, one entry per action ID used in CODES. Plain next steps for a non-developer:
 *  what to review, what to record, who to escalate to. No SQL, credentials or provider commands here (the
 *  developer runbook keeps those details for the trusted database operator). */
export type ActionId = "RB-OPS-01" | "RB-OPS-02" | "RB-WORK-01" | "RB-WORK-02" | "RB-WORK-03" | "RB-WORK-04"
  | "RB-BILL-01" | "RB-BILL-02" | "RB-BILL-03" | "RB-REC-01";
const PENDING_ESCALATION = "Escalate to the escalation contact. Not yet assigned: until the owner names one, tell the owner directly.";
const RECORD = "Record the finding, the connection shown and the capture time from this page in your support notes.";
export const ACTIONS: Record<ActionId, { title: string; steps: string[] }> = {
  "RB-OPS-01": { title: "The monitor could not be read", steps: [
    "Press Retry once. It reloads this page; nothing runs in the background.",
    "If it still fails, billing is not being monitored right now. Do not assume it is fine.",
    RECORD,
    `${PENDING_ESCALATION} A developer or the trusted database operator (not yet assigned) needs to check the database and the latest release.`,
  ] },
  "RB-OPS-02": { title: "A recorded time is in the future", steps: [
    "Press Refresh once. A record saved at the exact moment of reading can cause this rarely.",
    "If it stays, the ages on this page cannot be trusted. Do not act on them.",
    RECORD,
    `${PENDING_ESCALATION} Report it as a defect; nobody should edit recorded times.`,
  ] },
  "RB-WORK-01": { title: "Scheduled billing runs are not happening", steps: [
    "Check the connection on Platform admin: it should be enabled or intentionally disabled, with a stored key.",
    "Refresh after a few minutes. If the latest scheduled run is still old, the schedule has probably stopped.",
    RECORD,
    `${PENDING_ESCALATION} Restarting the schedule is a deployment step for the database operator (not yet assigned), not something to do from here.`,
  ] },
  "RB-WORK-02": { title: "The latest scheduled billing run failed", steps: [
    "Note whether it failed outright or finished with some failed items. An older successful run does not clear this.",
    "On Platform admin, check the connection's last test. If the key may be wrong, re-test it there (needs two-step verification).",
    "Failed items retry on their own. Refresh later and see whether a newer run succeeds.",
    RECORD,
    `${PENDING_ESCALATION} The detailed error is visible only to the trusted database operator (not yet assigned).`,
  ] },
  "RB-WORK-03": { title: "A billing worker stopped part-way", steps: [
    "Refresh after a few minutes. Held items are picked up again by the next scheduled run.",
    "If the count stays the same over several refreshes, the worker may be crashing.",
    RECORD,
    `${PENDING_ESCALATION} Do not try to clear or delete anything yourself.`,
  ] },
  "RB-WORK-04": { title: "A connection is not served by the billing worker", steps: [
    "The worker serves only connections with a stored API key (enabled or disabled). Without one, its run times are not measured.",
    "If this connection should be serving customers, store and test its key on Platform admin (needs two-step verification).",
    "Any queue or review items shown for this connection still need the other actions on this page.",
  ] },
  "RB-BILL-01": { title: "Billing events are waiting too long", steps: [
    "First check the scheduled-run findings for the same connection: a backlog is usually caused by the worker.",
    "Refresh after a few minutes and compare the counts and the oldest time.",
    RECORD,
    `${PENDING_ESCALATION} Never change an item's status by hand; no customer gets access from this page.`,
  ] },
  "RB-BILL-02": { title: "Billing items stopped retrying or were held back", steps: [
    "These items never give anyone access on their own. Nothing is lost: they stay for review.",
    RECORD,
    "Check the review items for the same connection and follow \"Billing items need a human decision\" below.",
    `${PENDING_ESCALATION} Retrying them needs an approved, audited operator step that does not exist yet.`,
  ] },
  "RB-BILL-03": { title: "An event arrived twice with different contents", steps: [
    "The original is kept unchanged and a review item is created. Treat it as possible tampering or a provider fault.",
    "On Platform admin, confirm the connection's webhook secret is the one you expect.",
    RECORD,
    `${PENDING_ESCALATION} If more than one appears, follow the incident steps below.`,
  ] },
  "RB-REC-01": { title: "Billing items need a human decision", steps: [
    "Do not give any business access, change its plan or mark anything paid from this page or by hand.",
    "The trusted database operator (not yet assigned) reads each item and checks it against the provider's own dashboard.",
    "Resolving an item is a recorded, audited operator step with a written reason. Paid access only ever comes from the verified billing worker.",
    RECORD,
    `${PENDING_ESCALATION}`,
  ] },
};
export const actionAnchor = (id: ActionId) => `guide-${id.toLowerCase()}`;
/** Shown with the guide on every load: incident communication stays a human, owner-approved step. */
export const INCIDENT_STEPS: string[] = [
  "Write down what this page showed (findings, connections, capture time) and what you do not know yet.",
  "Any message to customers, the provider or anyone outside the team is drafted by a person and sent only after the owner approves it. This page sends nothing.",
  "Do not say \"no impact\" or \"everything is healthy\" based on this page; it covers billing checks only.",
];

export interface Finding { code: Code; status: Status; connection_id: string | null; mode: Mode | null }
export interface Evaluation { status: Status; findings: Finding[]; snapshot: Snapshot | null }

const worst = (statuses: Status[]): Status =>
  STATUS_ORDER.find((s) => statuses.includes(s)) ?? "within_thresholds";

export function errorEvaluation(code: "SNAPSHOT_UNAVAILABLE" | "SNAPSHOT_INVALID"): Evaluation {
  return { status: "error", findings: [{ code, status: "error", connection_id: null, mode: null }], snapshot: null };
}

export function evaluate(s: Snapshot): Evaluation {
  const now = Date.parse(s.observed_at);
  const findings: Finding[] = [];
  const add = (code: Code, connection_id: string | null = null, mode: Mode | null = null) =>
    findings.push({ code, status: CODES[code].status, connection_id, mode });
  /** Age against observed_at; null when absent. A future time is an error (never clamped to healthy). */
  let future = false;
  const age = (t: string | null): number | null => {
    if (t === null) return null;
    const a = now - Date.parse(t);
    if (a < 0) future = true;
    return a;
  };
  const over = (t: string | null, limit: number) => { const a = age(t); return a !== null && a > limit; };

  if (s.worker_connection_ids.length === 0) add("NO_WORKER_CONNECTIONS");
  for (const c of s.connections) {
    if (over(c.webhook.oldest_received_at, THRESHOLDS_MS.backlog)) add("WEBHOOK_BACKLOG_STALE", c.id);
    if (c.webhook.expired_leases > 0) add("WEBHOOK_LEASE_EXPIRED", c.id);
    if (c.webhook_dead > 0) add("WEBHOOK_DEAD", c.id);
    if (c.webhook_quarantined > 0) add("WEBHOOK_QUARANTINED", c.id);
    if (c.collisions_24h > 0) add("WEBHOOK_COLLISIONS_24H", c.id);
    if (over(c.discovery.oldest_first_seen_at, THRESHOLDS_MS.backlog)) add("DISCOVERY_BACKLOG_STALE", c.id);
    if (c.discovery.expired_leases > 0) add("DISCOVERY_LEASE_EXPIRED", c.id);
    if (c.discovery_dead > 0) add("DISCOVERY_DEAD", c.id);
    age(c.reviews.oldest_created_at);
    if (c.reviews.open > 0) add("REVIEWS_OPEN", c.id);
    for (const m of MODES) {
      const r = c.runs[m];
      // Timestamps are checked for the future even when the connection is not required.
      age(r.latest_finished_at);
      age(r.latest_success_at);
      const stuck = over(r.oldest_unfinished_started_at, THRESHOLDS_MS.unfinishedRun);
      if (!c.worker_required) continue;
      if (stuck) add("RUN_STUCK", c.id, m);
      if (r.latest_outcome === "none") { add("RUN_NEVER_FINISHED", c.id, m); continue; }
      if (over(r.latest_finished_at, THRESHOLDS_MS.run[m])) add("RUN_STALE", c.id, m);
      if (r.latest_outcome === "failure") add("RUN_LATEST_FAILED", c.id, m);
      if (r.latest_outcome === "partial") add("RUN_LATEST_PARTIAL", c.id, m);
    }
    if (!c.worker_required) add("WORKER_NOT_REQUIRED", c.id);
  }
  age(s.unassigned_reviews.oldest_created_at);
  if (s.unassigned_reviews.open > 0) add("REVIEWS_UNASSIGNED_OPEN");
  if (future) findings.unshift({ code: "FUTURE_TIMESTAMP", status: "error", connection_id: null, mode: null });
  findings.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status));
  return { status: worst(findings.map((f) => f.status)), findings, snapshot: s };
}

/** Validate then evaluate; any shape problem is the error state, never an empty or healthy page. */
export function assess(raw: unknown): Evaluation {
  const v = validateSnapshot(raw);
  return v.ok ? evaluate(v.snapshot) : errorEvaluation("SNAPSHOT_INVALID");
}

// ---------------------------------------------------------------------------
// Static disclosures (rendered on every load, including the error state)
// ---------------------------------------------------------------------------
export const DETECTION_NOTICE =
  "Detection happens only when an operator opens or refreshes this page. Nothing here runs on a schedule, sends alerts or messages anyone, so time-to-detect equals your manual check cadence.";
export const SCOPE_NOTICE =
  "This covers bounded billing worker and queue diagnostics only. A within-thresholds result does not mean the platform is healthy or that there are no incidents.";

export const NOT_INSTRUMENTED: string[] = [
  "Saves other than inspection assessment submissions (every other write action and its errors)",
  "Authentication abuse (sign-in attempts, brute force)",
  "Authorization denials (forbidden/RPC denials, including denials of this page), except as rejected saves and exports in the user-reported counts",
  "Export delivery or download, and saves or exports attempted while signed out (the user-reported counts cover only generation outcomes for signed-in sessions)",
  "Application queues other than billing (inbox, due reminders)",
  "Housekeeping worker runs (not tied to a connection)",
  "Edge function errors, provider API latency and HTTP failures",
  "pg_cron job execution history (cron.job_run_details)",
  "Database capacity, backups and restore",
];

export const OWNERSHIP: { role: string; value: string }[] = [
  { role: "Support owner", value: "UNASSIGNED" },
  { role: "Billing operator", value: "UNASSIGNED" },
  { role: "Support hours", value: "UNASSIGNED" },
  { role: "Escalation contact", value: "UNASSIGNED" },
];
