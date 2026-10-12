# Milestone 4 independent acceptance plan

This is a verification plan, not a passing result. Baseline: 249 passing tests, one optional export fixture skipped; all nine existing migrations sealed; all 25 approved report revisions pinned by immutable body/hash/formula. Source branch feat/saas-milestone-4 starts at 92cca46. Existing Firebase MVP and static Production placeholder are outside this milestone.

## Access and tenant isolation

Use existing disposable development identities and isolated businesses. Only a current Owner may initiate checkout, cancellation or a fresh portal session. Revoke membership between request preparation and provider call and require denial. Admin, Reviewer, Assessor, Viewer, Guest, forged workspace IDs, unsigned requests and altered metadata cannot grant subscriptions or read provider objects. Customers must bind to exactly one workspace; duplicate owner emails returned as an existing provider customer must not overwrite another binding. A generic portal must reject a customer with any unrelated subscription.

Database roles may execute only their intended private intake or worker functions. Test anonymous/authenticated/service-role grants and direct table access separately. No grant through JWT user_metadata, client amount, selected product ID, redirect parameters or subscription.active alone. Secrets must stay out of source, client bundles, Next/Vercel environments, error messages, URLs and provider payload logs. Reject live keys and a non-sandbox provider base URL.

## Price and money contracts

One Business plan with two explicit monthly price configurations: NGN and USD. One subscription per workspace, exactly one pinned currency and product/version/amount. Both remain unconfigured until disposable sandbox products exist; NGN unavailable until account recurring capability is confirmed. No automatic FX or currency switch. Exact decimal parsing must reject fractional precision overflow, negative amounts, exponent notation and malformed values. Do not aggregate amounts of different currencies. Price configuration changes cannot invalidate an already pinned valid checkout or paid period.

## Durable payment reconciliation

Validate V2 signature on exact raw bytes, multiple v1 signatures, timestamp tolerance and strict account ID before durable inbox insert. Reject malformed/duplicate contradictory headers and oversized bodies. Replay of an identical event is harmless; same event ID with different bytes cannot replace the original. Provider events and redirects are hints only. Fetch checkout/payment/subscription truth outside transactions, then bind reference, checkout, customer, subscription, product, quantity, amount, currency and invoice period before granting. Only fully paid succeeded payment is accepted; accepted/processing/underpaid/active without payment grant nothing.

Exercise duplicate, unordered and stale events; checkout completed without funds; uncertain checkout timeout and retry; failed first purchase; failed renewal after a previously paid period; recovery; confirmed scheduled cancellation; terminal cancellation; full refund both before and after delayed payment event; partial refund and disputes; subsequent clean paid period. Refund revokes only its associated paid period, not later unrelated coverage. Seven-day SAVOUR grace must anchor to the renewal failure period, not retry timestamps; day 1/4/9 Bachs retries must not trigger competing charges. Never silently start a second subscription while the first checkout is uncertain.

Worker claims commit before HTTP, use SKIP LOCKED and a finite lease/fencing token. Expired claims recover after crash; an old claimant cannot finish a reclaimed row. Observe successful scheduled worker-run records, not only manual calls. In-app renewal notices at day 0/3/6 are separate from provider email/retry schedules.

## Quotas and work preservation

Default trial: 14 days from genuine workspace creation, 1 active location, 20 active subjects, 5 staff including Owner, 100 first submissions. Business: 3 active locations, 100 active subjects, 10 staff, 1000 first submissions per paid period. Guest is not a persistent staff seat. Unexpired staff invitations reserve seats; acceptance does not consume twice. Archive/revocation releases active capacity; reactivation/import/location changes enforce capacity.

Reserve accepted work when collection is opened or new assignments are accepted. At a period boundary, outstanding reservations carry over. With 90 consumed trial assessments and 10 outstanding reservations, trial usage is 100. Entering a paid period starts with 10 outstanding reservations, not 0 or 100. Completing one produces 1 consumed plus 9 outstanding = 10; identical retry and correction add zero. A second paid renewal after 990 consumed and 10 still outstanding starts with 10. If carried accepted reservations already exceed a lower cap, completion remains allowed and new work remains blocked.

Expired access preserves reading/export, already accepted submissions/corrections, approval, security/revocation, inbox reads and progress on existing actions. It rejects new drafts/collection/templates/directory additions/imports/staff/guests/assignments/findings/actions. Reopening an approved report for correction cannot accidentally become new collection capacity. Samples cannot be forged to bypass quotas. Backfill truthfully preserves original submission timestamps and every pinned approval.

## Real contention and regression

Use two live database sessions, observe a blocked backend and actual lock, then release. Compete two requests for the last seat, last directory slot and final assessment reservation. Exactly one wins; no oversubscription or deadlock. Exercise workspace/session lock ordering against reconciliation. Separate mocks, PGlite, real Postgres rollback assertions, actual contention and external sandbox evidence in the report.

Replay all migrations empty; preserve existing assertion counts and explain explicit disposable fixture overrides for older tests exceeding new trial caps. Run full unit/contract tests, typecheck, lint, isolated build, grants/FK/RLS checks and advisors. Check all 25 snapshot pins before/after remote migration and destructive disposable tests. Root MVP files and the Production placeholder remain unchanged.

## Preview and founder demonstration

Deploy protected Preview only; keep exact Auth callback hosts. Confirm unconfigured, trial, paid, grace and read-only presentations; quota warnings and failed/cancelled checkout recovery. Normal Owner and staff sign-ins must match observed accounts. For mobile verification, record actual DOM innerWidth of 390 before claiming a 390-pixel pass. CSV/PDF/history stay readable after expiry. Sandbox external lifecycle and NGN capability are required evidence; mocked responses alone do not close Milestone 4. Founder demonstration closes the development authorization.

## Platform administration and supported providers

Founder selected Bachs, Paystack and Stripe. Only adapters with completed contract and sandbox acceptance evidence may be shown as available; pending adapters must not accept credentials or claim readiness. A workspace Owner/Admin without a platform administrator row is denied. A platform administrator without business membership receives no business-data rights. Exercise every admin writer at aal1 and require MFA rejection. Test current membership and MFA server-side, never from client metadata alone.

Provider credentials are write-only browser-to-Edge input and Vault storage; verify absence from Next/Vercel, returned payloads, audit rows and error logs. Unknown providers, arbitrary endpoint URLs and live keys are refused. Verify activation only after an authenticated organization/product/price test, while separately recording actual external subscription lifecycle evidence. Two connections reusing the same provider IDs cannot collide or cross-bind. Changing the default affects newly created checkouts only. Existing subscriptions retain their pinned connection, currency, product and version through renewal, cancellation and portal access. Disabling a connection blocks new business without stopping verification of existing subscriptions. Credential and webhook rotation preserves safe overlap and in-flight work. Never present unverified NGN recurring capability as enabled.
