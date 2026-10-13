# Fable internal alert implemented code review

Actual Claude Code claude-fable-5-1 review.

Reviewed all six files. Findings below are limited to blockers and the one open question.

**Blocker 1: SQL app validation is weaker than the TypeScript mirror and can clear alerts from an incomplete snapshot.** In `saas/supabase/migrations/20261013114038_m5_operations_alerts.sql:229-246` the per-op check reads only `op`, `failed`, `latest_reported_at` and `failed_hours`. It never touches `success`, `replayed`, `rejected`, `capped_buckets`, `bucket_cap`, `stored_buckets` or `reporting_actors_24h`, and it accepts `latest_reported_at` as JSON null while `failed` is positive. The TypeScript path rejects all of these in `saas/src/lib/application-outcomes.ts:88-97` and `120-127`. Result: a snapshot the page shows as "unusable" is treated by the cron evaluator as a validated read and clears every app slot whose `failed` happens to be zero. That contradicts the migration's own contract at lines 24 to 26 and the parity claim at line 145.

Minimum safe validation to add to `operations_alert_app_findings`:
- Validate the four outcome counts and `capped_buckets` with `operations_alert_count`.
- Require `latest_reported_at` null exactly when the four-outcome total is zero.
- Validate `bucket_cap` equals 1000, and `stored_buckets` and `reporting_actors_24h` as counts.
- Raise when any op total is positive and `reporting_actors_24h` is zero.
- Require `failed_hours` strictly ascending, not merely unique, so the sustained rule sees the same input as the TypeScript one.

Regression fixtures for the SQL parity test, each expecting `invalid_snapshot` except the last:
1. `failed: 2`, one failed hour, `latest_reported_at: null`.
2. `success` missing; `success: null`; `success: -1`; `success: "3"`; `success: 1.5`. Repeat for `replayed` and `rejected`.
3. `failed: 1` with `reporting_actors_24h: 0`.
4. `bucket_cap: 500`.
5. Two failed hours in descending order.
6. Positive control: every op all-zero, `latest_reported_at` null, actors 0, expecting empty findings and a clear.

**Blocker 2: run clock taken before the lock can break a run.** `v_now` is set at line 308 before `pg_try_advisory_xact_lock` at line 316. If two runs start close together and the later-starting one wins the lock, the other then writes an older `last_attempt_at`. The heartbeat check at line 98 then fails on a run whose billing source was unavailable, and the whole transaction errors. No false clear results, but the run is lost. Fix: acquire the lock first, then set `v_now` from `clock_timestamp()`.

**Billing validation** is acceptable as scoped. Every field the two billing rules use is validated, including the count-versus-oldest consistency at line 187, and unrelated fields are not interpreted.

**Confirmed, no action needed:**
- Grants: evaluator and helpers have no grants; only the guarded read wrapper is granted to authenticated, and `platform_actor(false)` runs before any read. I could not read `private.platform_actor` itself, so live-admin semantics are assumed from the stated pattern.
- No false clear on helper failure: each source runs in its own savepoint and its rows roll back.
- Recurrence: `episode_count` increments only on inactive-to-active, and repeated observations update one row.
- Busy runs write nothing. Manual runs never touch cron columns, and freshness reads cron columns only.
- Cron job name, command and five-minute schedule match the read helper's probe and the ten-minute staleness rule.
- Mailbox and channel are stated as pending, nothing sends, and empty results are labelled as not a health statement.
- Timestamps are strict UTC ISO with `+00:00` on both sides; impossible dates raise in SQL and are re-checked in TypeScript.