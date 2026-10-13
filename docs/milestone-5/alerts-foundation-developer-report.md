# M5 internal operational alert foundation: developer report

Status: implemented and tested locally in the sanitized workspace only (13 October 2026). Nothing was deployed, applied to a hosted project, scheduled, pushed or sent. No network, cloud, install, git, credentials or real data were used. No existing migration or security test was edited.

## Scope

Exactly two signals, stored as internal alert state for the platform owner:

| Code | Source | Rule |
|---|---|---|
| `WEBHOOK_BACKLOG_STALE`, `DISCOVERY_BACKLOG_STALE` | `billing_authoritative` | Oldest backlog item strictly older than 15 minutes against the snapshot's `observed_at`, compared at millisecond precision. Same rule as `src/lib/operations.ts`. Severity `high`. |
| `APP_FAILURES_REPORTED` (per operation) | `app_unverified` | `failed > 0` in the current partial UTC hour plus the 23 before it. Severity `high` when two adjacent UTC hours had failures (the proposed sustained signal), else `warning`. Success, replayed and rejected never count. |

Not in scope: worker run freshness, dead/quarantined items, reviews, external delivery, acknowledgement, settings.

## Database (`saas/supabase/migrations/20261013114038_m5_operations_alerts.sql`, the scaffold; no other migration touched)

- `operations.alert_state`: one row per stable slot key (`code:connection_id` or `code:op`), at most 2 × connections + 6 rows. It holds the source enum, active flag, episode count, first seen, last seen, last changed, cleared, unobserved-since, observed count and oldest time. There is no payload, error text, label, note or email. CHECK constraints tie code to source and key. Rows are never deleted.
- `operations.alert_heartbeat`: a singleton. It holds the latest attempt (trigger plus each source's status and last successful read), separate cron columns (attempted, status, completed with both sources ok) and separate manual columns.
- Both tables are in the existing unexposed `operations` schema, with RLS on, no policy and no grants.
- `private.evaluate_operations_alerts(p_trigger)` is SECURITY INVOKER and accepts only `'cron'` or `'manual'`. It has no grants, so only the database owner can run it.
  - It takes `pg_try_advisory_xact_lock` on one fixed key through `private.operations_alerts_try_lock()`. When the lock is busy it returns `busy` and writes nothing, including the heartbeat. Only after the lock is held does it read the run time from `clock_timestamp()` (review follow-up, below). The snapshot helpers keep their own statement-time `observed_at`.
  - Each source runs in its own exception block (savepoint) over the existing owner-only snapshot helpers. If a helper raises, or a snapshot fails validation, that source is marked `unavailable` and its alert rows stay as they were. The other source is still evaluated. No SQLERRM is stored.
  - Billing validation is minimal, which the review accepted. Interpreted fields must be present, typed, non-null where required, non-negative whole numbers, and PostgreSQL-UTC timestamps that are possible dates and not in the future (every timestamp the TS evaluator ages). Unused extra keys are tolerated.
  - App validation is a full exact-shape mirror of `validateAppSnapshot` (review follow-up, below).
  - Transitions: inactive → active (including the first sighting) increments the episode count on the same row. Re-observing an active condition updates only last seen and the observed count and time. A row is cleared only when a successful read of its own source lacks the condition. A billing slot whose connection is no longer listed is marked `unobserved_since` and never cleared.
- Pure findings helpers `private.operations_alert_billing_findings(jsonb)` and `private.operations_alert_app_findings(jsonb)` are owner-only and read no tables. The evaluator and the parity tests use them.
- Read path: `public.platform_operations_alerts()` (invoker) → `private.platform_operations_alerts()` (definer: `platform_actor(false)` first, then the read helper) → `private.operations_alerts_read()` (owner-only).
  - The output is an allowlist: observed_at, scheduler job state, heartbeat, `cron_freshness` (never/fresh/stale/unavailable; stale after more than 10 minutes), full totals, active total, a truncation flag, and at most 100 rows ordered active first, then high severity, then most recently changed.
  - The scheduler probe reads only `cron.job` rows named `savour-operations-alerts`, through dynamic SQL, and only when `to_regclass('cron.job')` exists. Results: `active`, `inactive` or `absent`; otherwise `not_measured`, never "inactive".
- Grants: `authenticated` may execute only the wrapper and the guarded entry. Everything is revoked from public, anon, authenticated, service_role and the billing roles. No schema, table or role grant was added.
- The migration creates no cron job and no extension.

## Operator cron files (not applied)

- `saas/supabase/cron/operations_alerts_schedule.sql`: requires pg_cron and the evaluator, then runs `cron.schedule('savour-operations-alerts', '*/5 * * * *', $$select private.evaluate_operations_alerts('cron')$$)`. It does not touch pg_net, HTTP, Vault, configuration or any other job.
- `saas/supabase/cron/operations_alerts_unschedule.sql`: removes that job only.
- Sol reviews and applies these in savour-dev only, after the recipient channel decision. Proof of the job path is a recent cron attempt in the heartbeat plus a `cron.job_run_details` row. A manual run proves nothing about scheduling.

## App

- `saas/src/lib/operations-alerts.ts` (new, pure):
  - `billingAlertFindings` and `appAlertFindings` restate the two rules on top of the existing `assess` and `assessApp`, for parity with SQL.
  - `validateAlerts` validates the read response with an exact allowlist and fails closed. It rejects future or impossible timestamps, inconsistent heartbeat, freshness or trigger fields, count or truncation mismatches, inactive rows listed before active ones, and duplicate slots.
  - Static page text.
- `saas/src/app/platform/alerts/page.tsx` (new, server component, `force-dynamic` and `fetchCache = "force-no-store"`):
  - Access: `forbidden` → 404, `not_authenticated` → login, any other error → "could not be read". Invalid data → "unusable". Neither error state ever shows "no warnings".
  - Always visible: a brief provenance block (recipient is the platform owner, live admins only, no new staff access; the owner chose email plus this page, but email is not connected yet and nothing is sent or promised; support hours awaiting a choice; the database cannot report its own outage).
  - Scheduled-check status: fresh, stale, never or unavailable, plus the schedule-entry state. The page says "automatic checks" only when the job is active and the latest scheduled run is fresh.
  - Each source's latest status. A failing source shows "warnings left unchanged".
  - Active warnings and "No longer observed" are listed separately. App rows say "not confirmed recovery". Unobserved connections are flagged. A truncation notice shows when rows are cut.
  - Source-specific guides link to `/platform/operations#guide-rb-bill-01` and `#app-guide-h`. Full details, including the app hour-bucket latency, sit in a native `<details>`.
  - Interaction is a GET Refresh link only. There are no forms, acknowledgements or settings. Cards use existing `.card` and `.row` classes with `overflow-wrap: anywhere` for UUIDs, and 44 px `.btn` and summary targets.
- Links: `/platform` now shows "Operations monitor (read-only)" (previously "Billing operations monitor") and "Operational alerts". `/platform/operations` links to the alerts page.
- Runbook section `RB-ALERT-01..03` was added to `docs/milestone-5/operations-runbooks.md`. It makes no escalation promise.

## Review follow-up (SOL-FOLLOWUP.md, fable-alert-code-review.md)

1. **Blocker 1, app validation weaker than TypeScript (could clear alerts from an incomplete snapshot): fixed.** `private.operations_alert_app_findings` now mirrors `validateAppSnapshot`:
   - Exact key sets at the top level and per operation, through the new owner-only `private.operations_alert_keys`.
   - `bucket_cap` must be 1000. `stored_buckets` and `reporting_actors_24h` are counts, and users never exceed stored buckets.
   - All four outcome counts and `capped_buckets` must be whole non-negative counts. Missing, null, string, negative or fractional values raise.
   - `latest_reported_at` must be null exactly when the four-outcome total is zero, and must fall inside the window and not in the future.
   - `failed_hours` holds at most 24 whole hours inside the window, strictly ascending.
   - Bounds: a positive total needs at least one reporting user; each outcome is at most users × 24 × cap; failures are at most users × failed hours × cap; capped buckets are at most users × 96, at most stored buckets, and capped × cap is at most the total.
   - Any violation raises inside the app savepoint, so the app source is `unavailable` and no app alert changes.
2. **Blocker 2, clock taken before the lock: fixed.** The evaluator takes the try-lock first, then sets `v_now := clock_timestamp()`. Its body contains no statement or transaction time.
3. **Recipient wording.** The page provenance now says the owner chose email plus this admin page, that email is requested but not connected (pending an email service), and that no email has been sent or is promised. Support hours stay unassigned. No email code, provider or dependency was added. Connecting an email service is root work outside this isolated copy.
4. **Mutation checks, run once each and then reverted.**
   - Restoring the statement-start clock made the new clock regression test fail with the heartbeat check-constraint error the review predicted.
   - Removing the latest-report/total rule made three of the new tests fail: the false-clear regression and two parity fixtures.
   - Both fixes were restored before the final run.

## Tests (actual local results, PGlite + vitest)

Review follow-up run, focused only; the full isolated suite was not re-run, per instructions:

- 8 files, **386 passed**:
  - `tests/sql/m5-operations-alerts` (152) and `tests/unit/m5-operations-alerts` (45)
  - The existing `tests/unit/m5-operations`, `tests/unit/m5-application-outcomes` and `tests/unit/m4-cron`
  - The existing `tests/sql/m5-operator-monitoring`, `tests/sql/m5-application-outcomes` and `tests/sql/migration`
- `npm run typecheck` and `npm run lint` passed.
- New in this run:
  - 44 more app parity fixtures, fed to both SQL and TypeScript (67 app and 26 billing in total). They cover:
    - Fable's regression list: failures with a null latest report; `success`, `replayed`, `rejected` and `capped_buckets` missing, null, negative, string or fractional; failures with zero users; `bucket_cap` 500; descending hours; and the all-zero, zero-user positive control.
    - Duplicate hours, more than 24 hours, extra keys, cap and stored-bucket field errors.
    - The legal one-user and two-user upper bounds (24 ascending hours, 96 capped buckets), and the five impossible-total cases.
  - 21 malformed or raising app-helper cases in rolled-back transactions. Each keeps the active `assessment_save` alert at zero failures, so accepting the snapshot would clear it. Every case gives `app_unavailable`, leaves the alert active and the app rows byte-identical, and billing is still evaluated and clears. A positive control shows the genuine empty snapshot does expire the alert.
  - Clock tests:
    - The source-order check on the actual function body.
    - A one-statement regression: another run's newer successful record appears after the statement starts, then this run fails billing. It still commits with a later attempt time, keeps the older successful billing read, and passes the TypeScript validator.
    - Alert times move forward across runs and are never later than the next read.
  - Single-connection PGlite cannot prove behaviour under concurrent sessions, and none is claimed.

Initial implementation run:

- `saas/tests/sql/m5-operations-alerts.test.ts`: **87 passed** at that time. It covers:
  - Grants grid and definer/invoker metadata. Wrapper → guard → actor-first. No public definers and nothing executable by anon.
  - No client access to the schema or tables; RLS on with no policy.
  - Admin (aal2), plain user, anon, service and billing roles are all denied the evaluator, every helper and the tables.
  - The migration creates no cron schema or extension.
  - Read denial for anon, plain user, workspace owner, revoked admin, spoofed metadata and missing subject.
  - The never-run state. A manual run leaves cron freshness at `never`.
  - Deterministic state:
    - First sighting, then repeated runs with no duplicate rows and no extra episode.
    - Clear only on a validated read; recurrence on the same row with episode 2.
    - App warning → high on adjacent hours → expiry when the hours leave the window.
    - Bounded slot count.
    - No business or counter rows written.
    - SQL findings equal TS findings on the live snapshot.
  - Source isolation (helpers replaced inside rolled-back transactions only):
    - A raising billing helper (no error text stored; app still evaluated).
    - Seven malformed billing shapes, plus a real future-dated queue row.
    - Four app failure shapes (billing still evaluated and still able to clear).
    - Both sources down.
    - A removed connection stays unobserved and is not cleared.
  - Heartbeat: a manual success does not mask a failed cron run.
  - Busy lock returns `busy` and writes nothing.
  - Stale and fresh boundaries.
  - Scheduler probe: absent, active, inactive and ambiguous.
  - 100-row cap with full totals and active-first ordering, and the privacy allowlist.
  - 26 billing and 23 app parity fixtures fed to both SQL and TS: exact 15 minutes, +1 ms, sub-millisecond, future, empty, unknown or invalid counts and operations, adjacent and non-adjacent hours.
  - Cron schedule file fails closed on PGlite without pg_cron, and the job name, schedule and command are fixed.
- `saas/tests/unit/m5-operations-alerts.test.ts`: **45 passed**. It covers validator fail-closed cases and page denial, unavailable and invalid states. It also checks provenance, the automatic-check condition, failing-source wording, active versus no-longer-observed sections, truncation, links that stay internal, the absence of developer detail and health claims, and the links from the Operations page and platform admin. The platform-admin link check reads the source, not a render.
- Existing focused tests with the new code: `m5-operations`, `m5-application-outcomes`, `m4-cron` (unit) and `m5-operator-monitoring`, `m5-application-outcomes`, `migration` (sql) all passed.
- `npm run typecheck` and `npm run lint` passed.
- Full `npm test`: 689 passed, 3 skipped, 16 failed.
  - 14 failures are the known environmental ones from missing references: `repo-hygiene` (11), the `m4-billing-ui` git secret scan, and the `legacy` and `sol-legacy-m3` baselines. These were not fixed.
  - 2 were 5-second timeouts under full-suite load: `m5-operator-monitoring` read-only and the `export` multi-page PDF. Re-run alone, both files passed (155 tests across the 5 files re-run).

## Not verified here (hosted or root follow-up)

- Root full real-repository suite (git scans, legacy baselines).
- Applying the migration on hosted Postgres or Supabase. Still to check there:
  - Real default privileges and advisors.
  - That `operations` stays unexposed.
  - The definer's read of `cron.job` under its RLS. The job must be owned by the same role, or the probe reports `absent`.
- Real advisory-lock contention between two connections. PGlite is single-connection, so the busy path was simulated by replacing the lock helper.
- Statement and lock timeout behaviour. Function-level settings are not a proven outer bound.
- Scheduling the job, and the `cron.job_run_details` proof.
- Next's `Cache-Control` header on the deployed dynamic page.
- The 390 px layout and 44 px targets in a real browser.
- Email delivery: the owner chose email plus the admin page, but no email service is connected and no email or message path exists in this code. Support hours and the escalation contact remain owner decisions.
- Real two-session ordering of the lock and clock. Only the in-run ordering was tested.


## Sol integrated verification — 13 October 2026

The complete actual repository suite passed772 tests, with one optional fixture skipped, using maxWorkers2 to bound embedded-database/PDF concurrency. Existing security tests and fixtures remain unchanged. Typecheck, lint and the guarded build passed. Root Firebase MVP HTML is byte-identical to5e26088.

Fable independently identified incomplete app-source validation and pre-lock heartbeat timestamps. Opus repaired both with shared malformed/valid parity fixtures and clock-order regressions. Sol corrected the pilot invitation/consent sequence and the inactive app-warning text: a warning disappears when no failure is reported in the current window, without asserting expiry was its cause or certifying recovery. Affected unit verification follows separately.

The owner confirmed self as initial recipient and selected email plus the admin inbox. Support hours remain unanswered. Read-only Vercel Marketplace discovery found Resend and no existing installations; Resend Free was proposed without paid plans/add-ons/overages. Provider selection/account access is pending, so no email integration, external send or new spending is performed.


## Hosted development checks

CLI dry run and apply affected only20261013114038_m5_operations_alerts.sql, with zero roles/seeds and Vault updates skipped. Hosted history confirms the exact timestamp. A disposable rolled-back transaction proved anonymous/non-admin/spoofed-metadata/revoked-admin read denial, denial of evaluator/helper/table access, live platform-admin AAL1 read, no actor/note leakage, tableRLS and zero public definers. A trusted manual evaluator ran successfully without counting as a scheduled run; its state rolled back.

A real contention probe attempted two concurrent Management API calls: the advisory lock was not observed overlapping the second call, so the busy path was not proved remotely. The embedded busy-path simulation and clock-order regressions pass. No claim of hosted lock contention or load benchmarking is made.

A separate savour-operations-alerts job was enabled in savour-dev at */5 * * * *, without modifying any of the four existing billing jobs. The owner selected email+admin inbox; only the internal check/inbox is active. One newly created disposable auth UUID supplies an artificial assessment_save failed counter for the scheduled delivery check. It is a QA counter, not evidence of a real failed save or an email send. Scheduled run/alert evidence and cleanup will be recorded afterward.

The later warning-copy correction passed all45 affected unit checks. The complete772-test suite and guarded local build precede that wording-only change; the hosted Preview will build final source. No earlier migration, FirebaseMVP or existingproviderconfiguration changed.
