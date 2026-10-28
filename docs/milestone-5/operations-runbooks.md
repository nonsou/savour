# Milestone 5 OPS01: billing operations runbooks

Status: draft for owner review. Applies to the read-only page `/platform/operations` (founder platform admin
only) and the RPC `public.platform_operations_snapshot()` added by migration
`20261012220419_m5_operator_monitoring.sql`. That RPC is a SECURITY INVOKER wrapper over the guarded
`private.platform_operations_snapshot()` (SECURITY DEFINER, platform admin checked first), which reads through the
owner-only `private.operations_snapshot()`.

## Ground rules (read first)

- **Detection is manual.** Nothing here runs on a schedule, delivers an alert or messages anyone. A problem is
  detected only when an operator opens or refreshes the page, so time-to-detect equals the check cadence. The
  page shortens time-to-diagnose, not time-to-detect.
- **Billing only.** The page covers bounded billing worker and queue diagnostics. "Billing checks within
  thresholds" never means the platform is healthy or that there are no incidents. Not instrumented: failed
  saves, auth abuse, authorization denials (including denials of this page), exports, non-billing application
  queues, housekeeping runs, Edge function/provider HTTP errors, pg_cron history, database capacity and backups.
- **Thresholds are proposed**, not PRD requirements: webhook/discovery backlog older than 15 minutes; latest
  finished scheduled run older than 5 minutes (process), 2 hours (discover), 26 hours (reconcile); unfinished
  scheduled run older than 5 minutes; ID collisions in a 24-hour attention window. Exactly at a boundary is not
  stale. Only `trigger = 'cron'` runs count; a manual run proves nothing about scheduling.
- **The page hides free text on purpose** (labels, error codes, bodies, event IDs, review kinds/details). Reading
  it is a **trusted database operator** step: a database-owner SQL session (for example the Supabase SQL editor
  run by the person holding database access). That session does not use a user JWT, so it is not an "aal2 path"
  and the app's MFA does not protect it; access to it is governed by who holds database credentials. Only the
  named billing operator (currently UNASSIGNED) should do it. Queries below are `select` only.
- **Never** grant access, write a paid period, edit a subscription binding, reuse or change an idempotency key, or
  call a provider API by hand from this runbook. Entitlement only comes from the worker's verified absorb path.
  No provider command is given here on purpose.
- **Timeouts are not proven.** The guarded private entry sets `statement_timeout = '5s'` and `lock_timeout = '2s'` as function
  settings. A function-level `statement_timeout` is not proof that the outer RPC query timer is 5 s: PostgreSQL
  arms that timer when the top-level statement starts, so the effective bound is the role-level timeout PostgREST
  applies. The local test database (PGlite) does not exercise timeouts at all: a direct probe saw a function with
  `statement_timeout = '200ms'` run a 1 s sleep to completion (a session-level setting was not enforced either).
  Make no claim of strict 5-second cancellation. A slow or cancelled read shows as "monitor could not be read"
  (RB-OPS-01).
- **In-app guide.** The page shows a plain-language "What to do" section, and every finding links to its action
  there (anchors `#guide-rb-…`, plus `#guide-incident`). Those steps cover only what to review, record and
  escalate, and they say which assignments are still pending. This document is the developer and
  trusted-operator version: SQL and function names live only here, never in the product UI.
- Each step that changes anything (resolving a review, releasing an intent, re-running a worker) is a named,
  audited operator function or an owner-approved deployment step, and is recorded in `billing.operator_log` or
  `platform.admin_audit` by that function.

## Ownership (placeholders)

| Role | Assignee |
| --- | --- |
| Support owner | UNASSIGNED |
| Billing operator (trusted database access) | UNASSIGNED |
| Support hours | UNASSIGNED |
| Escalation contact | UNASSIGNED |

These stay UNASSIGNED until the owner names them. Until then every action below is "owner decides".

## Alert codes to actions

| Code | Status | Action |
| --- | --- | --- |
| SNAPSHOT_UNAVAILABLE | error | RB-OPS-01 |
| SNAPSHOT_INVALID | error | RB-OPS-01 |
| FUTURE_TIMESTAMP | error | RB-OPS-02 |
| NO_WORKER_CONNECTIONS | not measured | RB-WORK-04 |
| WORKER_NOT_REQUIRED | not measured | RB-WORK-04 |
| RUN_NEVER_FINISHED | not measured | RB-WORK-01 |
| RUN_STALE | attention | RB-WORK-01 |
| RUN_LATEST_FAILED | attention | RB-WORK-02 |
| RUN_LATEST_PARTIAL | attention | RB-WORK-02 |
| RUN_STUCK | attention | RB-WORK-03 |
| WEBHOOK_LEASE_EXPIRED | attention | RB-WORK-03 |
| DISCOVERY_LEASE_EXPIRED | attention | RB-WORK-03 |
| WEBHOOK_BACKLOG_STALE | attention | RB-BILL-01 |
| DISCOVERY_BACKLOG_STALE | attention | RB-BILL-01 |
| WEBHOOK_DEAD | attention | RB-BILL-02 |
| WEBHOOK_QUARANTINED | attention | RB-BILL-02 |
| DISCOVERY_DEAD | attention | RB-BILL-02 |
| WEBHOOK_COLLISIONS_24H | attention | RB-BILL-03 |
| REVIEWS_OPEN | attention | RB-REC-01 |
| REVIEWS_UNASSIGNED_OPEN | attention | RB-REC-01 |

Overall status precedence: error, then attention, then not measured, then within thresholds.

## Snapshot problems

### RB-OPS-01

Snapshot unavailable or invalid. The page shows no data rather than an empty or healthy state.

1. Press Retry once (a full page reload; there is no background polling).
2. If it persists, the trusted operator checks database availability and whether the migration is applied
   (`select to_regprocedure('public.platform_operations_snapshot()')`). A timeout means a slow read path: check
   for long-running DDL holding locks.
3. `SNAPSHOT_INVALID` after a deploy means the app and database disagree on the shape. Treat as a defect: roll
   back per RB-ROLL-01. Do not loosen validation to make the page render.
4. While unavailable, billing is **not monitored**; say so if anyone asks.

### RB-OPS-02

A recorded time is later than the database observation time. Ages cannot be trusted. Refresh once (a row
committed between the statement start and its snapshot can cause this rarely). If it persists, the trusted
operator checks the database clock and which table holds future-dated rows; report as a defect. Do not edit
timestamps.

## Worker runs (read-only triage)

### RB-WORK-01

`RUN_STALE` / `RUN_NEVER_FINISHED`: the schedule may not be firing for that mode.

1. Confirm the connection is meant to be served (credential stored, see RB-WORK-04).
2. Trusted operator, read only: latest scheduled runs for the connection and mode:
   `select mode, trigger, started_at, finished_at, failed, error_code from billing.worker_runs where connection_id = '<id>' order by started_at desc limit 20;`
3. Check that the pg_cron jobs exist and recently ran (`cron.job`, `cron.job_run_details`). Re-applying the
   schedule file is an owner-approved deployment step, not part of this slice.
4. A manual worker run does not prove the schedule and is not a fix.

### RB-WORK-02

`RUN_LATEST_FAILED` / `RUN_LATEST_PARTIAL`: the newest finished scheduled run failed or finished with failed
items. An older success never clears this; only a newer successful scheduled run does.

1. Trusted operator reads `error_code` of recent runs (query in RB-WORK-01) and the failed queue rows
   (`last_error_code` in `billing.webhook_inbox` / `billing.discovered_payments`).
2. Credential or organization errors: re-test the connection on `/platform` (aal2) before anything else.
3. Item failures retry with backoff on their own; watch for RB-BILL-02 if they go dead.

### RB-WORK-03

`RUN_STUCK`, `WEBHOOK_LEASE_EXPIRED`, `DISCOVERY_LEASE_EXPIRED`: a worker crashed or was orphaned.

1. Expired leases are reclaimed by the next scheduled claim; refresh after one process interval.
2. If counts stay, check Edge function logs for crashes or time-outs (not instrumented here).
3. An unfinished run older than 30 minutes no longer blocks key retirement; it is never edited or deleted.

### RB-WORK-04

`NO_WORKER_CONNECTIONS` / `WORKER_NOT_REQUIRED`: the worker serves exactly `billing.worker_connections()`
(connections with a stored credential, enabled or disabled). A connection without a credential is not served,
so its runs are not measured. If it should be served, store and test a credential on `/platform` (aal2).
Queue or review items on an unserved connection still need RB-BILL / RB-REC actions.

## Billing queues

### RB-BILL-01

`WEBHOOK_BACKLOG_STALE` / `DISCOVERY_BACKLOG_STALE`: the oldest pending, processing, failed (webhook) or
pending, processing, retry (discovery) item is older than 15 minutes, including items waiting for a future
retry time or held by a live lease.

1. Check RB-WORK-01/02/03 first: a backlog is usually a symptom of the worker.
2. Trusted operator, read only: `select status, attempts, next_attempt_at, last_error_code from billing.webhook_inbox where connection_id = '<id>' and status in ('pending','processing','failed') order by received_at limit 20;`
3. Do not change statuses or attempts by hand.

### RB-BILL-02

`WEBHOOK_DEAD`, `WEBHOOK_QUARANTINED`, `DISCOVERY_DEAD`: items that stopped retrying or failed signature/org
checks. They never grant anything. The trusted operator reads `outcome`, `last_error_code`,
`quarantine_reason` and the matching review items, then follows RB-REC-01. Re-driving an item needs an
owner-approved, audited operator function; none is added in this slice.

### RB-BILL-03

`WEBHOOK_COLLISIONS_24H`: an event ID arrived again with different bytes. The original stays untouched and a
`webhook_id_collision` review item is created. Treat as possible tampering or a provider defect: check the
webhook secret fingerprint on `/platform`, follow RB-REC-01 and RB-INC-01 if more than one appears.

## Reconciliation

### RB-REC-01

`REVIEWS_OPEN` / `REVIEWS_UNASSIGNED_OPEN`: unresolved `billing.review_queue` items (per connection, and
globally for items without a connection).

1. Trusted operator reads the item (`kind`, `provider_refs`, `detail`) in the SQL session.
2. Verify against the provider dashboard by a human. Do not grant access from the UI, a webhook body, a
   redirect, metadata or an email.
3. Keep the binding and idempotency rules: never move a subscription, payment or intent to another connection
   or workspace, never reuse or edit an idempotency/dedupe key.
4. When resolved, record it with the audited operator function `billing.operator_resolve_review(id, note)`
   (database owner only). Releasing an intent uses `billing.operator_release_intent` after manual verification.
   Both write `billing.operator_log`.
5. A paid period is only written by the worker's verified absorb path. There is no manual paid grant.

## Incident communication

### RB-INC-01

1. The billing operator records what was seen (codes, connection ID, capture time) and what is unknown.
2. Any message to customers, the provider or anyone outside the team is drafted by a human and sent only after
   owner approval. This slice sends nothing.
3. Do not state "no impact" or "all systems healthy" from this page; it covers billing diagnostics only.

## Rollback

### RB-ROLL-01

The change is additive and read-only.

1. Revert the app deploy (the page and the `/platform` link). The worker, cron schedule, credentials and all
   billing data are unaffected.
2. The database function and indexes can stay in place harmlessly. If removal is required, it is a new
   forward migration (`drop function public.platform_operations_snapshot(); drop function private.platform_operations_snapshot(); drop function private.operations_snapshot();`, in that order,
   and the six indexes), never an edit to an applied migration.
3. Never drop or alter worker tables, functions or schedules as part of this rollback.

## Backup and restore

### RB-BACKUP-01

Local synthetic logical recovery verified 28 October 2026; managed Supabase recovery remains pending.

1. [Local rehearsal](local-recovery-rehearsal.md) and [machine-readable result](local-recovery-result.json): native PostgreSQL 17.11, 20 real migrations, two synthetic businesses, approved reports and trial billing. Row hashes, sequence state, catalog/RLS/ACLs, tenant denial, immutable reports, corruption rejection and late-error rollback passed. The local server stopped and its artifacts were deleted.
2. This does not verify managed backups/PITR, real Auth/MFA, Vault encryption, Storage or paid/refund/dispute billing recovery. No hosted database was restored or exported.
3. Follow the [managed restore checklist](managed-restore-checklist.md) before a separately approved isolated target/export. Do not physically clone the current project: encryption keys are copied and restored cron/net jobs can start immediately. Target cost needs separate approval.
4. Existing backup configuration and retention must be inspected before making recovery promises. Measured local drill time is not an RTO/RPO or SLA.

## Support assignment checklist

### RB-SUP-01

- [ ] Support owner named (pending)
- [ ] Billing operator with trusted database access named (pending)
- [ ] Support hours set (pending)
- [ ] Escalation contact set (pending)
- [ ] Manual check cadence agreed (pending; detection latency equals this cadence)
- [ ] External alert delivery decided (pending; not in this slice)
- [ ] Restore drill authorized (pending, RB-BACKUP-01)


## Application save and export outcomes

The admin Operations page separately shows best-effort user-session-reported outcome counters. These are unverified and may be inflated or omitted by a signed-in user; database outages and recording timeouts omit events. Compare them with hosting log event `application_outcome` before declaring an incident. The log allowlist contains only server-generated event UUID, static operation/outcome and server time; no request, error, business or inspection fields. `telemetry_recording_failed` indicates failure of the convenience-counter path, not necessarily a failed inspection save.

Operation scope: assessment submissions; session report and analytics PDF/CSV generation; dashboard CSV generation. Success means a response/file was produced, not downloaded; a request failure after a committed assessment is not proof that nothing was saved. Known stale/validation/permission rejections and idempotent replays remain separate from technical failures.

Record operation, counters and database capture time; compare hosting logs around that time, inspect the user's visible result, then escalate to the named operator (still unassigned). Do not alter approved evidence or blindly repeat a write. The proposed signal is failures in two adjacent UTC hour buckets within the current partial plus preceding23 hours; it does not prove continuous downtime. Missing reports mean not measured. External alert routing/delivery remains pending; this does not complete OPS01.

## Internal operational alerts (`/platform/alerts`)

Migration `20261013114038_m5_operations_alerts.sql` stores bounded current alert state for two signals only:
`WEBHOOK_BACKLOG_STALE` / `DISCOVERY_BACKLOG_STALE` (source `billing_authoritative`, same 15-minute rule as above) and
`APP_FAILURES_REPORTED` (source `app_unverified`, failures reported in the 24-hour window; high when two adjacent UTC
hours failed). The page links to it from `/platform` and `/platform/operations`. It sends nothing and escalates
nothing automatically. Recipient: the platform owner, who chose email plus the admin page. Email is requested but
not connected (pending an email service, handled outside this work), so no email is sent or promised; today the
page is the only place warnings appear. Support hours remain UNASSIGNED, awaiting the owner's choice.

### RB-ALERT-01

Billing alert active. Follow RB-BILL-01 for the connection shown. "No longer observed" means a successful billing
check found the condition absent; it is not an incident closure. A connection no longer listed keeps its warning
with "not observed since"; it is never treated as fixed.

### RB-ALERT-02

App alert active. Follow the application outcomes section above (compare hosting-log `application_outcome` lines
first). "No longer reported" means the failed hours left the 24-hour window, not confirmed recovery.

### RB-ALERT-03

Scheduled check stale, never run, or a source failing. The checks run inside the database: a stale scheduled check
may mean the job is not scheduled, paused, or the database/scheduler is down. A failing source leaves its warnings
unchanged. Trusted operator, read only: `select * from operations.alert_heartbeat;` and, where pg_cron exists,
`select jobname, active from cron.job where jobname = 'savour-operations-alerts';`. A manual evaluation
(`select private.evaluate_operations_alerts('manual');`, database owner only) refreshes the state but never counts
as a scheduled run. Scheduling is `supabase/cron/operations_alerts_schedule.sql`, applied only by the operator after
the owner's channel decision; removal is `operations_alerts_unschedule.sql` (that job only). Rollback of the
migration is a new forward migration, never an edit.
