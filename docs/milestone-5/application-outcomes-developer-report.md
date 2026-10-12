# M5 OPS02: application outcomes (inspection saves and exports): developer report

Status: implemented and tested locally in the sanitized workspace only. Nothing was deployed, pushed or run against a hosted project. No network, cloud, git, install or credentials were used.

## What was built

The design is hybrid:

1. **Server log line (the trusted origin).** For every instrumented request, the app server writes one JSON line to stdout: `{"event":"application_outcome","id":<server UUID>,"op":<static>,"outcome":<static>,"at":<ISO time>}`. It never includes payloads, notes, labels, URLs, query strings, user/workspace/session IDs or error text. The line is written before any scheduling. If writing it throws, the error is swallowed.
2. **Counters reported by the user's own session (best effort, unverified).** After the line is written, and only when a signed-in session exists, `after()` from `next/server` schedules one call to `public.record_application_outcome(op, outcome)` through the caller's own Supabase session. There is no privileged client and no new secret. The callback is aborted with an `AbortController` and abandoned after 750 ms. Any error, timeout or scheduling failure produces one static `telemetry_recording_failed` line with only op and time: no raw text, no retry, no recursion. The callback never rejects.

Operations: `assessment_save`, `report_pdf`, `report_csv`, `analytics_pdf`, `analytics_csv`, `dashboard_csv`. Outcomes: `success`, `replayed`, `rejected`, `failed`.

- **A `failed` save does not prove that nothing was saved.** The database can commit the save before the action fails. This happens if `revalidatePath` throws after the RPC returned, or if the receipt is malformed (for example, the data is missing `version`). In both cases the error is rethrown and the outcome is `failed`, but the assessment may already be stored. An operator must not tell a user that their work was lost on the basis of this count.
- A rejection is matched exactly against an allowlist of known business and permission codes (`classifyRejection`). Anything else is `failed`, including unknown SQL, network or PostgREST text, render exceptions and unexpected nulls.
- For exports, `success` means the file was generated on the server. It does not mean the file was delivered or downloaded.
- If an error is thrown, it is observed as `failed` and the original error object is rethrown.
- The `requireUser` redirect in `submitAssessment` runs before the observation starts.
- Report and analytics exports are observed only after `format` names the operation. A bad format is still a 400 and is not observed.
- A 401 (signed out) is logged as `rejected` but not counted, because there is no session to count it through.
- When the RPC returns a technical error, the response stays the legacy 404 but the outcome is `failed`. Known `forbidden`, `not_found`, `invalid_filter` and similar codes, and null data, are `rejected`.
- The unsupported-formula 422 (report) and the `buildAnalytics` 422 keep their responses but are observed as `failed`.
- Response bodies, statuses and headers, the save receipt (version/replayed), the error message and code, and permissions are unchanged.

### Database (`supabase/migrations/20261012225745_m5_application_outcomes.sql`, the scaffolded file; no other migration touched)

- New schema `operations`. It is not in the API `schemas` list, and no client role has usage on it. Table `operations.application_outcome_counts` has RLS on, no policies and no table grants.
- One row per (auth.uid, UTC hour slot 0–23, op, outcome), with a CHECK on the enums, `hour_start` aligned to the hour and matching the slot, and `count` between 1 and 1000.
  - The primary key bounds storage to 576 rows per user.
  - A report landing in a slot that holds an older hour overwrites that row and restarts at 1. A later hour (clock moved back) is never rewound.
  - There is no cleanup job, cron or scan.
  - `actor_id` references `auth.users` with `on delete cascade`.
- Logger: `public.record_application_outcome` (SECURITY INVOKER) calls `private.record_application_outcome` (SECURITY DEFINER, `search_path=''`, UTC, 2 s statement and 1 s lock timeouts).
  - It stamps `private.require_uid()` and the database hour.
  - It has no actor, workspace or time argument and rejects unknown or null enums with `invalid_telemetry`.
  - It reads no inspection, billing or platform table.
- Snapshot: `public.platform_application_outcomes` (invoker) calls `private.platform_application_outcomes` (definer), which calls `private.platform_actor(false)` first and then the owner-only invoker helper `private.application_outcomes_snapshot()`.
  - Output per op: summed counts, capped-bucket count, latest report time and the failed UTC hours within the window.
  - It also returns the stored-bucket and reporting-user counts.
  - It returns no actor IDs. The table does hold `actor_id`, which is the internal bucket identity: it bounds storage per user and keeps each caller to their own counters. Neither the snapshot nor the server log line exposes it. The migration comment previously said that no actor IDs existed in the table; it now states this accurately (SOL-REVIEW item 3).
- Grants: execute on the two wrappers and the two guarded entries goes to `authenticated` only. Execute is revoked from `public`, `anon`, `service_role` and the billing roles, and the data helper has no grants.

### Admin UI (`/platform/operations`)

- New `ApplicationOutcomes` section, separate from the billing checks.
- Load order: the billing snapshot is read first, so non-admins still get a 404 before the second read. Then the application snapshot is read. `forbidden` from the second read is also a 404, and `not_authenticated` goes to login.
- The two sections are independent: an unavailable billing snapshot does not hide valid application counts, and the reverse is also true.
- Validation is strict and fails closed (exact keys, op order, counts, PostgreSQL UTC timestamps, window alignment, consistency). Unavailable or invalid data is shown as an error, never as zeros. An op with nothing reported is shown as "not measured".
- Window: the last 24 UTC hours only. Hourly buckets cannot give a precise 15-minute figure, so none is shown.
- Proposed sustained signal: at least one failure in each of two consecutive UTC clock hours. The exact rule is printed on the page. It also states that the signal does not prove a continuous outage, and that rejected and replayed outcomes never count toward it.
- Layout:
  - Always visible: the provenance statement, the status, the capture time, the no-health and no-alert notice, the Refresh/Retry link, the counts table and the guide.
  - Inside a native `<details>` element: the detailed counted/not-counted limits, the sustained rule, and the storage figures (reporting users, stored buckets, bucket limit).
  - The `<summary>` gets its 44 px minimum height from the existing `details > summary` CSS rule.
- Validation upper bounds (SOL-REVIEW item 2):
  - Each outcome is at most actors × 24 × 1000.
  - Failures are at most actors × failed hours × 1000.
  - Capped buckets are at most actors × 24 × 4, and at most the number of stored buckets.
  - So one operation can legally total actors × 24 × 4 × 1000. The previous check capped the total at actors × 24 × 1000, which wrongly rejected valid multi-outcome data.
- The page states provenance, that zero failures is not a health claim, and that no alert is delivered.
- The operator guide points to host logs and asks the operator to record only op, counts and capture time. There are no execute or remediation buttons.
- Interaction: manual Refresh/Retry link. The table is in a scrolling `.table-wrap` region for 390 px screens, and links use `.btn` (44 px minimum).
- `NOT_INSTRUMENTED`: only the "failed saves" and "exports" lines were replaced with precise limitations. The authorization-denials line now notes the rejected counts. Evaluator, thresholds, codes and the billing UI are unchanged.

## Changed files (all under `saas/` unless noted)

- `supabase/migrations/20261012225745_m5_application_outcomes.sql` (filled)
- `src/lib/application-outcomes.ts` (new, pure)
- `src/lib/outcome-telemetry.ts` (new, server-only by usage; a test asserts only the 4 server modules import it; no `server-only` package added)
- `src/app/w/[ws]/sessions/[id]/actions.ts` (`submitAssessment` only)
- `src/app/w/[ws]/sessions/[id]/report/export/route.ts`, `src/app/w/[ws]/analytics/export/route.ts`, `src/app/w/[ws]/export/route.ts`
- `src/app/platform/operations/application-outcomes.tsx` (new), `src/app/platform/operations/page.tsx`
- `src/lib/operations.ts` (`NOT_INSTRUMENTED` text only)
- `tests/unit/m5-application-outcomes.test.ts`, `tests/sql/m5-application-outcomes.test.ts` (new)
- `tests/unit/m5-operations.test.ts`: **one existing assertion changed.** It pinned the page to exactly one RPC call. It now expects exactly the two no-argument read RPCs, billing first. No security test or fixture was changed.
- `docs/milestone-5/application-outcomes-developer-report.md` (this file; workspace root `docs/`)

## Review follow-up (SOL-REVIEW.md)

1. Nested aggregate in the snapshot SQL: already fixed before this review. The migration now uses an inner per-op grouped select and an outer `jsonb_agg`. `tests/sql/m5-application-outcomes.test.ts` runs both the empty and the populated snapshot on real SQL (PGlite) and passes the output through `validateAppSnapshot`.
2. Validator bound: fixed as described above. New regression tests:
   - A fully valid upper-bound fixture: one actor, 24 hours, all 4 outcomes capped (96,000 on one operation, 96 capped buckets). A two-actor variant is also included.
   - Five impossible-total fixtures:
     - one outcome above the bound;
     - failures above the failed-hours bound;
     - a single failed hour holding more than one bucket's worth;
     - capped buckets above 24 × 4 per actor;
     - capped buckets above the stored count.
3. Migration comment: corrected.
4. Export audit records: per the verified Fable review, they describe data released for export, not files generated or downloaded. No extra signal was added in this slice.
5. The original throw, status and header behaviour is preserved. Validation, denial and replay outcomes are not failures and do not feed the sustained signal. The page does not claim that failures in two clock hours prove a continuous outage.

No behaviour, permission or security test was changed in this follow-up. The changes are to text, the validator bound, the UI grouping and new tests.

## Local results (2026-10-13, this workspace)

Review follow-up run:
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- Focused tests, 8 files: 229 tests passed (187 + 42).
  - 187 from `tests/unit/m5-application-outcomes`, `tests/unit/m5-operations`, `tests/sql/m5-application-outcomes`, `tests/sql/m5-operator-monitoring` and `tests/sql/migration`.
  - 42 from `tests/unit/export`, `tests/unit/report-actions` and `tests/unit/assessment-draft`.
- The full isolated suite was not re-run for this follow-up. Its only failures were the known missing references (no `.git`, `.env.example` or baseline files) listed below.

Initial implementation run:

- `npm run typecheck`: passed.
- `npm run lint`: passed (no output).
- Focused: `tests/unit/m5-application-outcomes`, `tests/unit/m5-operations`, `tests/sql/m5-application-outcomes`, `tests/sql/m5-operator-monitoring`, `tests/sql/migration`, `tests/unit/export`, `tests/unit/report-actions` and `tests/unit/assessment-draft`: 8 files, 222 tests passed.
- Full `npm test`: 552 passed, 3 skipped, 14 failed. All 14 failures are environmental, because this sanitized copy has no `.git`, no `.env.example` and no `docs/milestone-2|3/qa-snapshot-baseline.json`:
  - `repo-hygiene` (11)
  - the `m4-billing-ui` secret scan (uses `git ls-files`)
  - `legacy` and `sol-legacy-m3` baseline reads

  As a substitute for the git-based secret scans, the changed source files were checked with grep for service-role and secret patterns. They had no matches. The real scans still need to run in the full repository.

## Not verified here (hosted or full repository)

- Running the full suite in the real git checkout (repo-hygiene, secret scans, legacy baselines).
- Applying the migration on hosted Supabase or Postgres. PGlite was the only engine used. Still to check there:
  - The FK and cascade to `auth.users` under the real auth admin role.
  - That `operations` stays unexposed by PostgREST.
  - The real default privileges for `service_role` and `postgres`.
  - The supabase advisors.
- `after()` behaviour on the deployed Next 16.4 runtime: that the work actually runs after the response, the effect of the 750 ms bound on function duration, and that the cookie-bound client works inside `after()` in route handlers and server actions. The unit tests use an injected scheduler and mocked `after`.
- That stdout JSON lines reach the hosting log search, and that log retention and access are acceptable.
- Two-connection behaviour of concurrent counter upserts on real Postgres. PGlite has one connection.
- The 390 px layout and 44 px targets in a real browser. Only the markup and existing CSS classes were checked.


## Sol integrated repository verification — 13 October 2026

Actual feature branch feat/saas-milestone-5: complete repository suite 575 passed, one optional fixture skipped; typecheck, lint and guarded Next build passed. No existing security tests or fixtures were weakened. Existing monitoring test now expects the additional read-only snapshot. Root index.html/admin.html/review.html remain byte-identical to 5e26088. Fable verified the actual source and independently flagged the corrected per-outcome bound. Opus fixed it with regression evidence; Sol corrected the page title to Operations.

Reviewed React components are server components with no extra dependencies, client effects or polling. Native details, table captions/scoped headers, keyboard-scrollable table region and existing 44px control styles are used. Hosted Supabase/Preview/browser proof follows separately; local results are not hosted acceptance.


## Hosted Supabase verification

The CLI dry run listed only 20261012225745_m5_application_outcomes.sql, zero seeds/roles, with Vault updates skipped. The exact migration was applied only to ilhutasrxnbtssswmgam (savour-dev); hosted history confirms 20261012225745. Catalog checks show zero public SECURITY DEFINER functions, authenticated execute only on the wrappers/guarded entries, and no client/scoped billing execution on the owner-only helper.

A disposable transaction on real hosted PostgreSQL verified anonymous logger/snapshot denial, non-admin and spoofed metadata snapshot denial (public and private guard), revoked admin denial, direct table/helper denial, unknown-operation rejection, database-stamped actor/time and two exact counter increments. A live registry admin at AAL1 read aggregate counts without actor IDs or markers. All test auth/admin/counter rows rolled back; no business data or provider call changed. This is permission/atomic increment evidence, not a concurrent load benchmark.

Security advisors retain the existing RLS-without-policy informational records and leaked-password-protection warning. No new exposed-table access was introduced.


## Protected Preview and browser verification

Application commit b137fd74890c233b80a5186c03f724441b44e0a6 is hosted at dpl_9oe71w7P8kFPP8k1xhEe92dvYwww / https://savour-jch5bezja-nonsous-projects.vercel.app, READY and target Preview. Exact project/team/commit were verified before updating https://savour-dev-preview-nonsous-projects.vercel.app. Vercel Authentication remains enabled; project protection remains all_except_custom_domains; static production placeholder dpl_GsAftswtQAZtJ2Y5kdiL5Ff8iLgx is unchanged.

The existing owner session accessed Operations. With an empty counter table, every operation showed not measured. Actual approved SAMPLE practice report CSV and PDF downloaded to the owner's Downloads folder; after() recorded exactly one success each in hosted counters. The matching structured application_outcome lines were verified in logs from this exact Preview. A deliberately nonexistent UUID report CSV request produced a rejected event/count, separate from failure; the browser blocked rendering of its404 page, so error-page UI rendering was not claimed as verified. No render/network failure was injected into hosted business paths; those failure branches are covered by unit tests. No new hosted inspection save was performed by this slice.

Manual Refresh updated the capture time and displayed recorded counters. Native details expanded/collapsed and its control measured44px at desktop. Browser viewport.set(390,844) was attempted on the existing and a fresh verification tab; both retained a1280px document viewport. The override was reset. Therefore the new390px responsive check remains unverified due to the browser control limitation; no mobile overflow claim is made. Desktop screenshot: /tmp/savour-m5-application-outcomes-preview.jpg.

After hosted verification all25 approved report revisions retain fingerprint bb58536f3bb01def94a69e24898d1f74. Disposable transaction auth/admin/counter fixtures left zero rows. Only three legitimate test-request outcomes remain (report_pdf success1, report_csv success1/rejected1); unexercised operations still report not measured. Root MVP HTML remains unchanged.

This verifies this development instrumentation slice, not OPS01/M5 completion. Automatic alert delivery, other action-save errors, auth-abuse/tenant-denial telemetry, concurrent load,390px browser proof and support ownership remain pending. Deferred Bachs lifecycle, NGN capability, Paystack/Stripe and real migration/restore/pilot gates remain unchanged. No production, Firebase, billing configuration, provider request, cron or spending change occurred.
