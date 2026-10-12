# Milestone 4 developer report (local implementation)

Model: Claude Opus 5.5 (`claude-opus-5-5`), local sessions (11 and 12 October) on `feat/saas-milestone-4` from 92cca46. Nothing was committed, pushed, deployed or applied to any cloud database. No environment file, credential, `.vercel` file or customer data was read. No provider call was made: every Bachs interaction in tests uses a mock transport.

## Checkout preparation recovery (12 October, branch `checkout-repair`, sanitized checkout)

Witnessed blocker: in the real Bachs sandbox, `begin_checkout` persisted the intent (status `created`, `request_attempts` 0, no `provider_checkout_id`). The page then showed "Preparing", with no error and no retry, and no `checkout.failed` log appeared.

**What is and is not known (corrected after Sol's review):**
- **Confirmed:** Sol saw `GET /v1/customers` return 200 with no items.
- **Not observed:** a refusal of `POST /v1/customers`. No `POST /v1/customers` response from Bachs has been observed at all. Sol's diagnostic POST never reached the provider: it first hit a database connection timeout, then the stale-intent guard.
- **Unknown:** what stopped the original attempt. The "Preparing" symptom fits any early return before the checkout request that leaves no record. That includes:
  - a refused or uncertain customer creation;
  - a refused or unavailable lookup;
  - a customer review outcome;
  - a thrown error whose `checkout.failed` log line was not captured or not looked at.

  The repair below covers all of these generically. Nothing here assumes which one happened. The synthetic 422 refusal in the tests is a mock, not an observation.

**What the code did (confirmed by reading it, not by a provider response):**
- `ensureCustomer` returned early on a refused creation (`provider_refused`) or a refused/unavailable lookup.
- Those early returns had no log line and no database record. `provider_refused` also had no message, so the Owner saw the generic "request failed" text.
- That error lived in the purchase form's action state. Revalidation then rendered the `created` intent, which hides the purchase form, so the error disappeared with it.
- An uncertain creation returned `processing`, which sent the Owner to the return page. That page polled a `created` intent that nothing would ever move.

**Repairs:**
- **New forward migration `20261012134720_m4_checkout_preparation.sql`** (additive; all earlier migrations, including Sol's default-guard migration, are unchanged):
  - New columns `checkout_intents.prepare_error_detail`, `checkout_intents.prepare_attempt`, and `provider_customers.create_attempts`, `create_last_attempt_at`, `create_lease_until`, `create_uncertain_since`, `create_uncertain_retries`, `create_claim_token`.
  - New functions:
    - `billing.gateway_customer_claim`: lock order billing → intent → customer, live Owner check, intent must be fresh and `created`.
    - `billing.gateway_record_preparation`
    - `billing.preparation_retryable`
    - `private.resume_checkout` / `public.resume_checkout`
  - `private.get_billing` is replaced with the same output plus `pending_checkout.preparation`.
  - Grants: the two gateway functions to `billing_gateway` only; `resume_checkout` to `authenticated`; nothing to `anon`.
- **Precise, sanitized reason on the intent.**
  - When preparation stops, the intent stays `created` and gets `last_error_code`. The codes are `customer_lookup_refused`, `customer_lookup_unavailable`, `customer_create_refused`, `customer_create_uncertain`, `customer_create_in_progress`, `customer_create_unresolved`, `billing_customer_review`, `provider_response_invalid`, `provider_config_invalid`, `preparation_failed`, and the existing database codes.
  - `prepare_error_detail` holds only the HTTP status plus the provider's already-parsed `error_code` (or `timeout` / `network` / `response_invalid`). A check constraint enforces that format, so response bodies, emails and URLs cannot be stored.
  - The Edge function logs `checkout.preparation_stopped` with that code and detail only, through `logLine` redaction.
- **Customer creation cannot be sent twice at once, or outside its idempotency window.**
  - Every `POST /v1/customers` uses the existing per-workspace/connection `customer_idempotency_key` and first takes a 60-second database claim. A second request during a live claim gets `customer_create_in_progress` and makes no provider call.
  - These count as uncertain: a claim whose result was never recorded, a timeout, a 5xx/408/409/429, or a 2xx that fails the customer DTO.
  - Uncertainty is sticky until a customer is bound. After it, a retry searches first and adopts the customer only if its metadata is SAVOUR's for this workspace and connection. Otherwise it repeats the identical request with the same key. That is allowed only within 23 hours of the first uncertain attempt and at most 3 more times; after that the database queues a `customer_creation_unresolved` review and sends nothing further.
  - Definite refusals are not capped.
  - **Claim fencing (Sol review repair).** Each claim gets a new `create_claim_token`, which travels through `owner-core` and back into `gateway_record_preparation`.
    - **Lease.** Under the billing and intent row locks, a refused or uncertain outcome releases the lease only if its token is still the current one. Previously any late outcome cleared the lease by workspace and connection.
    - **Late outcomes from an expired claim.** They leave the newer claim's lease and token untouched. A late *uncertain* outcome can still mark the customer state uncertain, which only makes it stricter.
    - **Preparation reason.** Every Owner retry gets a new `prepare_attempt` from `resume_checkout`; the first attempt's is null. A reason is written only when the outcome's attempt matches the intent's current one, otherwise the function returns `superseded`. So A's late outcome cannot overwrite the reason B (or later C) records.
    - **Late success.** A success from an expired claim is a provider fact, so it still binds. The same idempotency key yields the same customer, and `gateway_bind_customer` returns `bound` for it; a different customer would be refused into review. `gateway_mark_requesting` stays the single atomic gate, so the late flow cannot send a second checkout request (it gets `checkout_intent_stale`). Its fenced preparation record then changes nothing.
    - **Authorization.** Fresh checks are unchanged: the claim re-checks the live Owner, and `resume_checkout` re-checks role and suspension.
  - Nothing changed after `gateway_mark_requesting`: the checkout request, its key and the worker's identical retry rules are as before.
- **Same-intent retry by the consenting Owner.**
  - `bachs-checkout` accepts `{workspace_id, intent_id}` and calls `resume_checkout`. That function:
    - re-checks the live Owner role and workspace suspension;
    - requires the intent to belong to that workspace and to the same Owner;
    - requires it to be `created`, under 15 minutes old, on the current terms version and with a retryable reason;
    - clears the old reason and audits `billing.checkout_intent_resumed`.
  - The gateway then re-checks the pinned connection, price, currency and billing contact exactly as on first use. No new intent, reference, checkout key or customer key is created, and there is still one pending intent per workspace.
- **UI.**
  - The billing page renders the stored reason from `get_billing`, so it survives the re-render. It adds a "Try again" form for the same intent and says when a customer request is unconfirmed.
  - A `created` intent that is stale or not retryable no longer hides the purchase form. The form shows "Your last checkout attempt did not start: …", and fresh consent supersedes the old intent as before.
  - Preparation errors now stay on the billing page instead of redirecting to the return page. The return page no longer polls a `created` intent.
  - New messages are in `src/lib/errors.ts`.
- **Admin default selector.** The uncontrolled `<select>` in `/platform` is keyed by `settings_version`. After a saved default it remounts with the server's latest default, so React's post-action form reset can no longer restore "None". Only the select remounts; the form and its success message stay. `SecretForm` (stored-key refresh) and `MfaPanel` are untouched.

**New tests (mock transport and PGlite only; the status and error codes in them are synthetic):**
- `tests/sql/m4-checkout-preparation.test.ts` (8), over the real SQL through the scoped gateway role:
  - Lookup 200/empty then a mock refused creation: the reason and detail are stored and shown, `request_attempts` stays 0, and nothing raw is logged. The retry uses the same intent, the same customer `Idempotency-Key` and `savour-checkout-<intent>`, and still leaves one intent.
  - **Fencing:**
    1. A claims and stalls inside a held mock POST, and A's lease expires.
    2. B retries and takes a new claim with a different token.
    3. A's late 422 arrives. B's lease and token are unchanged, and the intent's reason is not overwritten.
    4. C's retry gets `customer_create_in_progress`, with no third POST.
    5. B completes. There is one customer key and one checkout request, and the intent is `open`.
  - **Late success:** after B has opened the checkout, A's identical late success binds the same customer idempotently. A gets `checkout_intent_stale`, and there is still one checkout request and no review row.
  - A live claim blocks a concurrent creation. An expired unrecorded claim counts as uncertain, and a customer it created is adopted with no second POST.
  - Three uncertain retries go to review with exactly 4 identical POSTs and no fifth. Fresh consent after that still sends none.
  - A 24-hour-old uncertainty sends nothing.
  - Lookup 503/401 and an unreadable 2xx are recorded and the lease is released.
  - Stranger, wrong-workspace and stale retries are refused.
- `tests/unit/m4-checkout-preparation-ui.test.ts` (7): the billing page server-rendered for refused, preparing, not-retryable and other pending states; detail sanitization; the retry action's request body, validation and redirect allow-list; the admin select remounting with the new server default.
- **Mutation checks:** each mutation was restored afterwards.
  - Disabling the claim lease and raising the retry cap failed 2 tests.
  - Restoring the old unfenced lease release failed the fencing test.
  - Disabling the attempt fence failed the fencing test.

**Actual local results (this checkout, after the fencing repair):**

| Check | Result |
| - | - |
| New tests | 8/8 and 7/7 pass |
| Existing M4 flow tests (`m4-edge-flows`, `m4-worker`, `m4-billing-ui`) | Pass (part of the full run) |
| `npm test` | 43 files: 38 passed, 3 failed, 2 skipped. 332 tests: 326 passed, 4 failed, 2 skipped. All four failures are caused by this sanitized checkout and none touch billing. `legacy.test.ts` and `sol-legacy-m3.test.ts` need `docs/milestone-2` and `docs/milestone-3/qa-snapshot-baseline.json`, which are absent. `repo-hygiene.test.ts` needs `.env.example` (absent) and expects git to ignore `node_modules/pkg/index.js`, which it doesn't because `node_modules` is a symlink here. |
| `npm run typecheck` / `npm run lint` | Clean |
| Isolated build | **Not run.** Local tool policy blocked the command, so nothing was built and there is no result. Pending: `NEXT_DIST_DIR=.next-checkout-repair NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_TESTONLY npm run build` |
| `deno check` | **Not run.** Local tool policy blocked the command, so there is no result. Pending: `DENO_DIR=/tmp/savour-m4-deno <deno binary> check --cached-only` on `owner-core.ts`, `db.ts` and `bachs-checkout/index.ts` |

**Findings (not changed here; awaiting a real provider response or a decision):**
1. **Billing contact locks before any customer is bound.** `set_billing_contact` refuses once a `provider_customers` row exists, and `gateway_checkout_context` creates that row on the first attempt. The page's `locked` flag uses `bound_at`, so the contact form still shows, but saving fails with "linked to the payment provider". If a real customer-creation refusal ever turns out to depend on the email, the Owner cannot change it. The customer idempotency key also embeds the email hash.
2. **Unknown: does Bachs replay a refusal for the same key?** No refusal has been observed. If Bachs's idempotency layer caches 4xx responses per key, retrying after a definite refusal may repeat it for up to 24 hours even after the cause is fixed. The docs available here don't say.
3. **A 2xx checkout response that fails the DTO leaves the intent stuck.** After `mark_requesting`, such a response leaves the intent `requesting` with no worker path; only operator release clears it. This depends on the real response shape, so it is left alone.
4. **Co-owners cannot retry another Owner's checkout.** Only the consenting Owner may retry. A co-owner sees "Try again", gets `forbidden`, and can start fresh only once the intent is stale (15 minutes).
5. **The admin select fix is verified only by structure.** The test checks the element tree (key and default). The client-side form reset was not exercised in a browser.

**External checks still pending:**
- Sol applies the new migration and deploys `bachs-checkout`.
- Repeat the browser flow with a new disposable workspace and a `.test` email:
  - Whatever stops preparation is now shown with its code (and HTTP status and code when Bachs answered), and the function log has `checkout.preparation_stopped`. That identifies which early return actually happens.
  - "Try again" reuses the same intent and customer key. Sol confirms this in the sandbox request log.
- Observe a real `POST /v1/customers` response. None has been observed yet; the diagnostic attempt never reached Bachs. Make any provider-specific repair only after that.
- Re-check the `/platform` default selector in a browser after saving.
- Run the claim races on real Postgres with independent connections:
  - two tabs retrying together;
  - lease expiry under real latency;
  - a late outcome from an expired claim (covered locally only through the single PGlite connection).
- Run the isolated build and `deno check`.

## Second review repairs (12 October, `sol-second-review.md`)

1. **Missed-renewal discovery without a webhook (bounded, resumable).**
   - **List scan.** New worker mode `discover` (hourly cron job `savour-billing-discover`) reads the official `GET /v1/payments` with `limit`/`offset` only. That endpoint has no date filter, and I deliberately don't use `status_filter`, because a status change would move an item between pages and could cause a skip.
   - **Per run.** At most 5 list pages are recorded into `billing.discovered_payments`. The cursor in `billing.payment_discovery_state` advances in the same transaction as the IDs it records, and a repeated or concurrent page returns `stale_page`.
   - **Scan end and overlap.** A scan stops at the previous high-water mark minus 48 hours (62 days back on the first scan). Newest-first order means new payments only cause re-reads, never skips. A failed list call leaves the cursor unchanged.
   - **Detail reads.** Up to 7 payments are read per run as a separate leased, fenced queue (oldest first). Each item is classified from server reads:
     - **SAVOUR:** its subscription is bound here, or its reference is one of our checkout intents. It goes through the same strict `absorb_payment`/`absorb_refund` binding as webhooks.
     - **SAVOUR customer, subscription not yet bound:** deferred and retried, then dead-lettered with a review row after 10 attempts.
     - **Unrelated:** recorded once and never absorbed or reviewed.
   - **Retries.** Retries back off and keep their progress. List fields never grant anything.
2. **Lease-safe event batches.**
   - The batch size is derived from the lease and a worst-case per-item budget (3 events per 120 s lease at 40 s each). Claims are still committed before any HTTP call, with SKIP LOCKED.
   - An event without enough lease left is released with `billing.release_event`, which consumes no attempt.
   - `complete_event` now requires a live lease, so an event whose lease expired during a provider call can never be marked done; it is reclaimed and retried.
   - The same budget check applies to discovery items.
3. **Per-connection run accounting.** Each connection's `worker_runs` row carries only that connection's claimed/done/failed counts. Only the returned summary aggregates across connections.
4. **Bounded request bodies.**
   - `readBodyLimited` counts streamed bytes and refuses an oversized or malformed `Content-Length` before reading.
   - `readJson` returns code-only results: 413 `payload_too_large`, or 400 `body_unreadable` / `invalid_encoding` / `invalid_json` / `invalid_request`.
   - The webhook (256 KiB), the worker (1 KiB) and every Owner/admin function (16 KiB) use it. Bodies are never echoed or logged.

## Credential-overlap repairs (12 October, Sol counterexamples in `tests/sql/sol-platform-invariants.test.ts`)

All three of Sol's tests failed on the earlier draft (Sol's log: `/tmp/savour-m4-sol-platform-counterexamples.log`). They now pass, and I did not change them.

- **Webhook secrets.** A still-valid previous secret is never deleted. A new webhook secret is refused with `rotation_overlap_active` while the previous one is inside its 26-hour overlap; the error detail gives the UTC time it ends. Once the overlap has expired, the old secret is removed at the next rotation or by `platform.retire_secrets`.
- **API keys.**
  - A new key is refused while the previous key is inside its 25-hour retention.
  - Promotion re-checks the same rule as a second guard.
  - A not-yet-tested pending key may be replaced, because it serves no traffic. Each stored key gets a strictly increasing `pending_version`.
- **Asynchronous connection tests.**
  - When a test starts, `connection_tests` records the credential version and Vault secret ID, the expected organization, the connection version, and a fingerprint of the proposed and configured prices (id, version, status, amount, product).
  - `gateway_test_context` and `gateway_record_test` both refuse a test that is expired (10 minutes), started by a revoked admin, or out of date: credential, organization or price set changed.
  - A refused test is closed as `failed` with the reason, audited as `connection.test_rejected` (no secret), and certifies nothing.
  - The test context returns exactly the snapshotted credential.
- **Lock order.**
  - Platform paths take the settings row, then the connection row, then the test row, then the connection's price rows, and re-check the snapshot after taking them.
  - `begin_test`, `propose_price` and `operator_configure_price` now lock the connection row first. `gateway_record_test` locks the connection before the test row; the earlier draft locked the test first.
  - No lock cycle was ever observed; this is preventive ordering only, and it is untested under real concurrency. Two-connection cases 12–14 were added to `supabase/tests/m4_two_connection_checks.md`.
- **Operator messages.**
  - `rotation_overlap_active` explains that the previous credential is still kept for in-flight retries and webhook resends, and gives the time the next rotation is allowed. `platform-credentials` returns HTTP 409 with only `{error, retry_after}`.
  - The admin page shows the retention or overlap windows and when the next rotation is possible.
  - New stale-test codes have readable messages: `credential_changed`, `organization_changed`, `prices_changed`, `test_expired`, `admin_revoked`.
- **New tests in `tests/sql/m4-platform-rotation.test.ts` (5):**
  - API-key retention and refusal, then the allowed rotation after retention ends: only the expired key is deleted and the active key keeps serving until the new one passes.
  - Webhook overlap: secrets served during and after the overlap, plus the Edge 409 response with no secret in the body or logs.
  - The operator message includes the retry time.
  - A replaced pending key's older test returns `credential_changed`, and the replaced key is removed.
  - Price-set change, expiry and revoked admin each refuse both the key read and the completion, with no secret in the audit.

## Changed paths (all under `saas/` and `docs/milestone-4/`)

- New forward migration `supabase/migrations/20261012090945_m4_billing.sql` (created with the bundled `supabase migration new`; still unapplied, repaired in place after Sol's findings). The nine applied migrations are unchanged, and a test pins their SHA-256.
- Edge Functions in `supabase/functions/`: `bachs-webhook`, `bachs-worker`, `bachs-checkout`, `bachs-portal`, `bachs-cancel`, `platform-credentials`, `platform-provider-test`. Pure shared modules live in `_shared/` (money, signature, redact, bachs-dto, bachs-client, db, http, webhook-core, worker-core, owner-core, platform-core). Deno-only wiring is in `_shared/deno/runtime.ts`. Also added `deno.json` and a placeholder-only `.env.example`.
- `supabase/config.toml`: function `verify_jwt` and import map. `supabase/cron/` holds the schedule and unschedule scripts. They are source only and nothing is scheduled.
- Next app:
  - `src/lib/billing.ts`
  - `src/app/w/[ws]/billing/` (page, actions, return page, poller)
  - `src/app/platform/` (founder-only admin)
  - role-aware banner and Billing link in `src/app/w/[ws]/layout.tsx`
  - `access` field added to `WorkspaceContext`
  - new error codes in `src/lib/errors.ts`
  - `tsconfig.json`: `allowImportingTsExtensions`, and the Deno entrypoints are excluded
- Tests:
  - `supabase/tests/m4_billing.sql`
  - `supabase/tests/m4_two_connection_checks.md`
  - `tests/sql/m4-billing.test.ts`, `tests/sql/m4-edge-flows.test.ts`
  - `tests/unit/m4-{signature,money,dto,client,redact,cron,billing-ui}.test.ts`
  - a Vault stand-in in `tests/sql/supabase-stub.sql`, marked LOCAL ONLY
- Fixture-only edits to older tests. They add no assertions and change no counts. After `create_workspace`, the database owner calls `billing.fixture_uncap_trial` (owner-only, audited, requires `savour.fixture_mode = 'disposable'`) in these files:
  - `m1_security.sql`, `m2_directory.sql`, `m2_lifecycle.sql`, `m3_actions.sql`, `m3_analytics.sql`
  - `tests/sql/import.test.ts`, `tests/sql/sol-action-invariants.test.ts`
  - Each of these exercises more than the trial limits, for example several locations or six staff. `m1_guest_closure.sql` did not need the override and is untouched.

## Design summary

- **Schemas.** New `billing` and `platform` schemas. RLS is on with no policies and there are no table grants to anyone. `config.toml` keeps exposing only `public`/`graphql_public`.
- **Scoped roles.** Three NOLOGIN, no-inherit roles with no table privileges and no passwords in source:
  - `billing_intake`: `ingest_event` and `get_webhook_secrets` only
  - `billing_gateway`: owner checkout, portal and cancel bookkeeping, plus the admin-started connection test
  - `billing_worker`: claim, fence, absorb, complete, reconcile and housekeeping
  - No extra credential-management role was needed. The admin secret write goes through the admin's own JWT to `public.platform_store_secret`, and SQL checks the `platform.admins` row and `aal2`.
- **Access is derived, not stored.** Precedence: suspended, then active or cancel_scheduled, then past_due (7 days, anchored at the failed renewal period start, previously-paid only), then trialing (14 days from real creation), then read_only.
  - The usage window is the paid period, the failed renewal period, or the trial.
  - When nothing is current, the last allocation applies open-ended. Once a business has paid, that allocation is the paid one.
  - Assessment usage is consumed-in-window plus all outstanding reservations, carried across periods. Samples never count.
- **Gates.**
  - `require_capacity` takes the billing row lock as lock step 7.
  - `require_writable` gates every new or edit writer, including categories, contacts, draft edits, adding reviewers, window changes, action edits and reopen-collection.
  - These stay allowed in read-only:
    - Pure archive (same name and fields) and contact removal
    - Revoke and update_member
    - Submitting accepted reserved work, review, outcome, waiver, correction, approval and report reopen
    - Action transitions, reads, exports and inbox
  - `consume_assessment` refuses any initial submission without an accepted reservation. The only exception is a reviewer amendment on a session that already has an approved revision.
- **Lock order.**
  - Guest `create_invitation` takes the session lock before the billing lock.
  - Payment, refund and dispute absorption take a per-payment advisory lock (lock P) before the billing row, so the refund-before-payment race serializes.
- **Pricing.**
  - One Business plan with prices per connection and currency, pinned on the intent, the subscription and each paid period. A price change retires the old row.
  - No price is seeded, so both currencies start unavailable with explicit reasons.
  - NGN needs DB-owner-recorded account evidence. A methods toggle is not accepted.
  - Ledger totals are grouped by currency and never summed across currencies.
- **Checkout.**
  - The intent, with a unique reference and idempotency key, is persisted before any provider call. A never-requested intent is superseded by fresh consent.
  - Only one pending intent per workspace is allowed, including uncertain and completed-unpaid states.
  - After a timeout, an identical retry with the same key and stored body is allowed only inside 23 hours and at most 4 attempts. A 409 conflict, or anything after that window, goes to manual review.
- **Payment binding.** These must all hold before a period is granted:
  - Status `succeeded` only. `accepted`, `underpaid`, `overpaid` and `processing` never grant.
  - Exact amount, with `amount_paid` required and equal to the amount, and `amount_remaining` zero.
  - Currency, product (from line items or exactly one subscription item), quantity 1 and monthly cadence.
  - Invoice kind `cycle`, with a 28 to 31 day period. It must be the subscription's current period, or an explicitly older one.
  - Customer, taken from the server-read subscription and, for a first payment, from the server-read checkout (reference, customer, status, amount). A payment email, when present, must equal the billing contact.
  - A duplicate subscription is recorded and never granted.
  - Refund and dispute handling:
    - A full refund revokes only its own period.
    - A partial refund or an open dispute flags the period for review.
    - A lost dispute revokes the period.
    - A refund or lost dispute before verification tombstones the payment.
    - A refunded status found on re-read is routed to refund handling.
- **Platform admin.**
  - Registry seeded by migration: Bachs is available (sandbox). Paystack and Stripe are `adapter_pending` and cannot be connected.
  - Connections hold Vault secret IDs, versions and fingerprints. Key rotation stays pending until a test passes, and the previous key is retained for 25 hours with no in-flight run.
  - The webhook secret overlap is 26 hours.
  - Enabling needs a passing test from the last day. Disabling stops new checkouts only.
  - The default connection applies to new intents only.
  - Credential deletion is refused while a subscription or intent is pinned to the connection.
  - Every write is audited with its assurance level.

## Local verification (actual results)

| Check | Result |
| - | - |
| `npm test` | 39 files passed, 1 skipped. 310 tests passed, 1 skipped, including Sol's `sol-platform-invariants.test.ts` (3) and `m4-platform-rotation.test.ts` (5). Previous checkpoint: 37 files and 302 tests (baseline was 249 + 1). New since the first report: `tests/sql/m4-worker.test.ts` (6) and `tests/unit/m4-http.test.ts` (4). In one full run the unchanged M3 PDF test "2000-character unbroken note" hit its 5 s timeout under parallel load (5.37 s); it passes alone (22/22) and on the full rerun. |
| `supabase/tests/m4_billing.sql` (PGlite) | 257 assertions, rolled back. Leaves 0 workspaces, 0 connections, 0 Vault rows. |
| Pre-M4 SQL scripts | Unchanged counts: m1_security 153 (≥100), guest closure 23, m2_directory 82, m2_lifecycle 158, m3_actions 205, m3_analytics 36 |
| Seal | Nine migration SHA-256 pins. All 25 baseline approvals found in `sol_m4_snapshot_pin.sql`. Backfill test shows `report_revisions` byte-identical before and after M4. |
| Sol's read-only reproduction script | Re-run to a separate output file. All four writes now DENIED with `read_only`. |
| `npm run typecheck` / `npm run lint` | Clean |
| `NEXT_DIST_DIR=.next-m4-devcheck npm run build` | Succeeds into a fresh directory, guard passed. Build-added tsconfig include lines were reverted. |
| `deno check` (2.9.6, cached packages) | All `_shared` modules and all seven entrypoints pass |
| `deno lint` | Clean (19 files) |
| Root MVP files | `index.html`, `admin.html`, `review.html` unchanged |

**What the tests cover**

- **Billing privileges.** RLS, grants and FK coverage across billing and platform, including role-to-function confinement and Vault privileges.
- **Isolation.** The same owner across two businesses. Malicious member, guest, anonymous and outsider RPC attempts.
- **Trial and limits.** Trial creation, limits and 80% warnings, staff seats including pending invitations, and reactivation and import capacity.
- **Reservations.** Draft, open, duplicate, consume-once, edit and replay, release, guest acceptance, samples, and carry-over windows.
- **Read-only.** Expiry blocks every new or edit path while completion, approval, export, revocation and pure archive still work.
- **Pricing and checkout.** Price pinning and retirement, NGN and USD capability, currency pin, and the gateway refusing cross-business customers.
- **Checkout outcomes.** Uncertain, retry window, review, operator release, and refused.
- **Inbox.** Collision, duplicate and quarantine handling.
- **Worker.** Claims, lease reclaim, fencing, backoff and dead-lettering.
- **Payment mismatches.** Each one in the binding list is refused.
- **Payment ordering.** Out-of-order failure after a later payment; refund and dispute before or after payment; reconciliation re-read of a refunded payment.
- **Lifecycle.** Cancellation pending versus confirmed, grace with day-milestone notices and dedupe, grace expiry.
- **Platform admin.** Identity separation, MFA, live-key refusal, two connections reusing the same provider IDs, rotation, disable, default change, deletion refusal, and no key-shaped value in any non-Vault table.
- **Worker (mock transport).**
  - **Discovery.** A missed first payment and a missed renewal are discovered with no webhook. The renewal grants only after its complete facts arrive: it is first processing, then succeeded. A payment with incomplete facts is reviewed and never granted. An unrelated payment never binds, and its subscription is never fetched. A SAVOUR customer's unbound subscription is deferred.
  - **Discovery cursor.** A timeout is retried with progress kept. Paging is bounded by the run budget (observed offsets 0, 2, 2, 4 across runs). A failed list call keeps the cursor, and a stale page is refused.
  - **Lease safety.** Trailing events are released with attempts unchanged, nothing is claimed beyond the batch, and an event whose lease expired mid-call is not completed but retried later.
  - **Two connections.** Each run row carries its own counts.
- **HTTP body limits.** Bytes rather than characters, early `Content-Length` refusal, streamed-limit enforcement, and the encoding, JSON and read-failure codes.
- **Edge cores over real SQL through scoped roles (mock transport).** Connection test, checkout request contents, webhook raw-byte verification (tamper, stale, wrong secret, oversize, foreign account), worker grant, timeout retry, portal refusal and minting, cancellation, refund and reconciliation, cron run rows, and no service-role reference in function code.

## Not verified (required later; mock or PGlite only so far)

- **Real Bachs sandbox:** customer creation and email matching, checkout success, decline and recovery, renewal, portal, cancel, webhook delivery and resend, signature headers, dispute and refund payloads, the `checkout.completed` data shape, and the scope covering `DELETE /v1/subscriptions`. Mock contract tests are not external evidence. NGN recurring remains unverified, and USD recurring is only documented.
- **Real Postgres:** `m4_billing.sql` on real Postgres and Supabase Vault, and every two-connection race in `supabase/tests/m4_two_connection_checks.md` (last seat, slot or reservation, guest invitation versus session writers, refund versus payment, SKIP LOCKED claims, overlapping checkouts).
- **Discovery against a real account:** real `GET /v1/payments` pagination and `transaction_date` ordering, real volume and cadence, and real renewal payment detail fields.
- **Two-connection checks still to add for the new paths:** two workers running discovery at once (expect `stale_page` and SKIP LOCKED to serialize them), and a lease expiring under real latency.
- **Cron:** cron rows have not been observed. The browser, mobile 390×844 layout and protected Preview have not been checked. Deployment is Sol's.
- **Known limitations:**
  - Discovery has a cost: every new account payment gets one detail read (two if it has a subscription that isn't SAVOUR's), bounded to 7 per hourly run. A very busy shared provider account would fall behind, though the cursor makes the backlog resumable rather than lost; a dedicated SAVOUR Bachs account avoids this. The 62-day first lookback, the 48-hour overlap and the hourly cadence are design choices that need checking against real sandbox volume.
  - The renewal period rule allows 28 to 31 days plus 1 hour and must be validated against real invoices.
  - `billing_email_in_use` reveals that an email is used by another business. This is owner-only.
  - `update_member` and `update_session_window` behaviour in read-only: `update_member` stays allowed as access management, and window changes are blocked.

## Setup Sol will need (placeholders only; no credentials here)

1. Apply the migration to savour-dev after review. Run `sol_m4_snapshot_pin.sql` before and after.
2. Enable login and set passwords out of band, for example `alter role billing_intake with login password '<generated>'` (and the same for `billing_worker` and `billing_gateway`). Put the pooler URLs in Supabase function secrets named in `supabase/functions/.env.example`, together with `SAVOUR_BILLING_WORKER_TOKEN` (32+ random characters) and `SAVOUR_APP_ORIGIN`.
3. Deploy the seven functions. The webhook and worker run with `verify_jwt = false`; the rest require a JWT.
4. Enroll the disposable founder QA admin as database owner: `insert into platform.admins (user_id, note) values ('<auth-user-uuid>', 'disposable founder QA');`. The admin enables TOTP.
5. In `/platform` (requires aal2):
   1. Create a Bachs connection.
   2. Store the sandbox API key and webhook secret. The browser sends them directly to the Edge function and they go into Vault.
   3. Set the expected account ID and propose sandbox-labelled prices.
   4. Run the test, then enable the connection and set it as default.
   5. Register `https://<project-ref>.supabase.co/functions/v1/bachs-webhook?connection=<id>` in the Bachs portal.
   6. Configure the Bachs portal to disallow plan switching.
6. Create Vault secrets `savour_billing_worker_token` and `savour_billing_worker_url`, then run `supabase/cron/bachs_worker_schedule.sql`. It schedules four jobs: process every minute, housekeeping every 15 minutes, discover hourly, reconcile daily. Proof of scheduling is a `cron.job_run_details` row plus `billing.worker_runs.trigger = 'cron'`.
7. Record NGN recurring only from a real sandbox recurring test: `select platform.operator_verify_ngn_recurring('<connection-id>', '<evidence reference>');`.

## Sol integration verification — 12 October 2026

The reviewed Opus bundle was integrated into the complete development repository. Full local suite: 331 passed, one optional fixture skipped. Application build passed. The checkout Edge function passed cached Deno type checking with the existing pinned import configuration. The additive checkout preparation migration was applied only to savour-dev; its filename matches hosted migration history. Backend/Preview deployment and actual browser/provider acceptance remain pending. The original POST /v1/customers result is still unobserved; no provider-specific diagnosis is claimed.

## Sol observed sandbox subscription acceptance — 12 October 2026

The founder approved a dedicated Gmail alias for Bachs sandbox receipts. A fresh disposable workspace completed the real hosted sandbox checkout with Bachs's displayed success test card. The signed inbox recorded five events; all processed with no error: subscription.created, invoice.paid and subscription.updated waited for verified payment; checkout.completed granted a single paid period; collection.succeeded was duplicate. Hosted facts show one current active USD subscription, exactly one USD 2900-minor-unit paid period, no unresolved reviews, and correct Business limits.

The provider customer portal opened and showed an active subscription and paid invoice. SAVOUR's cancellation action was confirmed by a fresh provider subscription read: cancel_at_period_end=true, access remains cancel_scheduled through 12 November 2026. The billing screen clearly shows confirmed cancellation. At 390×844, document width stayed 390 and visible buttons were 44px high. No live account transaction occurred.

An observed UI defect remains under repair: the return page stopped automatic refresh at 60 seconds, before the second cron batch completed. Reload showed the correctly verified paid status. Opus implemented bounded four-minute refresh (5s then15s) and a manual Check again control; six focused integrated tests passed. The local timer/manual-button check, build and deployment are still pending. Renewal, failed-payment, refund/dispute and true separate-connection concurrency acceptance are not complete; NGN recurring remains unverified.

### Final payment-status refresh verification

Sol exercised the actual React component in a temporary local Next.js screen with fake public Supabase configuration and no provider calls. A server-confirmed result after 90 seconds replaced pending state automatically; no stale checking message remained in that section. The second fixture stayed pending: automatic checks stopped at four minutes, Check again appeared, and its real browser click refreshed/restarted checking. Screenshots were saved. The local test screen and server were removed before build/deployment. The six focused return-status tests passed in the complete repository; type checking passed. Lint had flagged Date.now only in the temporary server fixture; canonical lint is re-run after removing it.

Canonical lint and final application build passed after the temporary fixture and its stale generated dev route types were removed. No test route remains in source.
