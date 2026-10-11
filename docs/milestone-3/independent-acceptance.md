# Milestone 3 independent acceptance plan

Baseline: 164 passing tests, one optional PDF fixture skipped. All 15 approved development snapshots are pinned before changes. Base source b76b400; branch feat/saas-milestone-3. Results are pending: this plan is not test evidence.

## Permissions and integrity

Use two disposable businesses and Owner, Admin, scoped Reviewer, Assessor, Viewer and Guest identities. Check direct SELECT, RPC, action history, exports, inbox and analysis, including forged business/session/subject/location/member/notification IDs. Hiding navigation is insufficient. Revocation, expiry, reassignment and location/session scope changes must deny the next read or save. An assigned action must not grant its Assessor full inspection access. Viewer receives approved scoped reports and redacted data; Guest is denied all new modules. Reviewer self-verification is blocked. Owner/Admin may verify their own resolution only through an explicit recorded override reason.

## Transactions and retries

Identical create requests return one action and receipt; reusing a key with changed content fails. Mutations require a non-null expected version, valid state transition, permitted actor and required evidence/reason. Failures leave no partial events, notifications or snapshots. Replays check live permission before revealing the prior receipt.

Prove actual contention through two independent live database connections, observing the waiting backend/lock. Compete ready-to-verify against return-for-work from the same valid starting state: one wins, the other rejects stale state. Compete action creation against approval: the action is either frozen at approval or clearly separate afterwards. Compare frozen IDs/versions as well as timestamps recorded after acquiring the serialization lock. Timed scripts alone are not concurrency evidence.

## Historical reports

Run sol_m3_snapshot_pin.sql before/after each migration and after transitions, races and exports. All 15 original body hashes, recorded hashes and formula labels must remain identical. New approvals freeze the then-current action state; later edits and reapproval never rewrite an earlier revision. Legacy approvals show that no action state was recorded. Current appendices are separately dated and identify later/changed actions for the viewed revision. Generated findings retain their source revision, including after later resolutions. Contacts and redacted actor/assignee IDs stay private across UI, CSV, PDF content and metadata. Exercise formula-like text, long text and Unicode.

## Analysis

Use fixed expected results, independent of implementation, for all three packs. Include attendance Off and attendance-only, early/middle/late/absent/unknown, all N/A, differing N/A patterns, missing/waived work, multiple assessors, version/formula changes, samples and legacy categories. Equal weight is per subject-session. One subject-session with assessor scores 20% and 100% contributes 60%; another at 100% produces an 80% mean, not a response-weighted 73.3%.

Three 80% inspections followed by three 70% inspections trigger exactly a 10 percentage-point decline. Five compatible inspections show insufficient data. Formula/version/applicability changes split groups. Two late/absent outcomes in the last three eligible attendance-enabled inspections trigger the attendance rule; Off never participates. Unknown remains visible. A critical criterion can raise a finding even when the overall mean is high. No data is null rather than zero. Category/subject renames and archives must not rewrite approval-time evidence; legacy category is Not recorded at approval.

All filters, comparisons, source links, table totals, CSV and PDF must reconcile to one authorized dataset. Samples are excluded even with direct forced filters. Provisional mode is separately labelled and cannot blend with approved results. Show denominators, coverage, missing responses, waivers, excluded outcomes and comparable sample size.

## Inbox and due dates

Creation is transactional with the business event. Deduplication prevents repeated assignment, correction, verification, approval and due reminders. Due date is a workspace-local calendar day; overdue begins after that day ends. Ready for verification remains unfinished; Closed/Cancelled are not overdue. Date/status changes invalidate old reminder payloads. Check timezone and day boundaries.

Only the active recipient can mark an entry read. Revoked/reassigned/out-of-scope/closed-correction entries expose no stale payload or link. Due reminders use the documented idempotent inbox-visit sync, not a claimed background job. No email, SMS or WhatsApp is sent in M3.

## Browser and development release

Use normal signed-in Owner/Assessor/Guest sessions at desktop and 390×844. Complete finding, action assignment, progress, evidence, verification, closure, reasoned reopen/cancel, stale-save errors, frozen report/current appendix, filtered analysis and inbox. Give the founder clear steps only when email or MFA entry is required.

Review forward migrations before savour-dev application. Required checks: empty replay, sealed migration hashes, real Postgres rollback scripts, RLS/grants/FK advisors, full tests, typecheck, lint, isolated build, upload manifest excluding secrets/artifacts, feature-branch push, protected Preview and exact Auth callback. Firebase root HTML and the existing static Production placeholder remain unchanged. Founder demonstrates closure/report/analysis before acceptance. This is not a production-readiness claim.
