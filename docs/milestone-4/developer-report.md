# Milestone 4 developer report (local implementation)

Model: Claude Opus 5.5 (`claude-opus-5-5`), local sessions (11 and 12 October) on `feat/saas-milestone-4` from 92cca46. Nothing was committed, pushed, deployed or applied to any cloud database. No environment file, credential, `.vercel` file or customer data was read. No provider call was made: every Bachs interaction in tests uses a mock transport.

## Pre-subscription charge routing (12 October, branch `checkout-repair`, sanitized checkout)

Scope: worker-only compatibility after `fable-pre-subscription-review.md`. No migration, schema, grant, parser, renewal or grace change. Earlier migrations stay sealed. The open-status and contact-correction work is preserved exactly.

**Read-only fact reported by Sol (sanitized; observed by Sol, not by the developer):** after a declined test card, the full payment GET returned `status: open`, `billing_reason: purchase`, `subscription_id: null`, `invoice: null`, and a `checkout_id` matching an existing SAVOUR intent. The unchanged SQL safely queued `review:payment_not_subscription` and granted nothing.

**Worker (`supabase/functions/_shared/worker-core.ts`).** This is the only production file changed. `absorbPaymentById` gains one branch, placed after the refunded check and before the existing path:
- The predicate `isPreSubscriptionAttempt` is exact: status `open`, billing_reason `purchase`, subscription_id null, invoice null, and checkout_id present. Any other value of any field falls through to the existing `absorb_payment` path unchanged.
- On a match, the worker does a full `GET /v1/checkout-sessions/{payment.checkout_id}`. The id comes from the payment GET, never from webhook hints. It then calls the existing `billing.absorb_checkout` with the event and claim token, passing `{ checkout }` only. No `absorb_payment` or `lock_payment` call is made, so the branch writes no payment rows, facts hash, paid period, subscription, failure row or grace.
- Outcomes: `review:*` outcomes are returned verbatim. Every other outcome is prefixed `pre_subscription:` (for example `pre_subscription:checkout_unchanged`) as the routing breadcrumb in `webhook_inbox.outcome`.
- Fail closed: the checkout GET goes through the existing `need()`. A 4xx response fails as `provider_refused_checkout_<status>`. A 5xx response, a timeout or a 429 fails as `provider_*`. A malformed body, a null body or an unknown or case-drifted checkout status fails as `dto_invalid`, because `parseCheckout` and its allow-list are unchanged. A checkout GET whose `checkout_id` differs from the one requested fails as `provider_checkout_id_mismatch`. In every case the event fails through the normal `fail_event` retry and nothing is absorbed.
- **Deviation from the review:** Fable suggested falling back to the existing review path when the checkout GET returns null or an unknown status. Following the task instruction, the branch fails closed and retries instead. It never invents checkout facts.
- `parseCheckout`, `parsePayment`, discovery (`absorbDiscovered`) and the denied, non-subscription and completed handling in SQL are unchanged.

**Tests (all local; mock Bachs transport, synthetic fixtures shaped like the sanitized observation, PGlite):**
- New `tests/unit/m4-pre-subscription.test.ts` (35 tests; fake scoped DB that records calls):
  - An exact match reads only the payment and its checkout. It calls `absorb_checkout` alone with (connection, event, token) and facts with exactly one key, `checkout`.
  - Each of the four non-review checkout outcomes is prefixed. `review:unknown_checkout`, `review:checkout_mismatch` and `review:checkout_pointer_conflict` pass through verbatim.
  - Each field is toggled alone and falls through to `absorb_payment`: 9 other statuses, 4 other billing_reasons including null, subscription present, invoice present, and checkout_id null or absent. Each case reads a checkout only where the existing `subscription_create` rule says so.
  - `failed` purchase without a subscription → `absorb_payment` with checkout null, as before.
  - Refund precedence: `refunded`, `auto_refunded` and `partially_refunded` with the otherwise matching shape → `absorb_refund`, and the checkout is never read.
  - Through `processEvents`, the event is done with the prefixed outcome, and the envelope's (deliberately wrong) `checkout_id` hint is never requested.
  - Checkout GET 404, 503, timeout, 429, malformed, null, unknown status, `OPEN`, or another checkout id → `fail_event` with the matching code, and nothing absorbed.
  - `stale_claim` from SQL → neither completed nor recorded as failed.
- New `tests/sql/m4-pre-subscription.test.ts` (12 tests; real signed intake, `processEvents` and SQL):
  - Intent `open`: the attempt → `pre_subscription:checkout_unchanged`. Row footprint is identical (paid_periods, subscriptions, payment_failures, tombstones, review_queue, intents, billing version). Trial access is unchanged. The webhook hint is never fetched.
  - Repeat: two more events, including `invoice.payment_failed`, for the same payment → the same outcome, an identical footprint, and nothing to re-claim. A second attempt payment on the same checkout is routed the same way.
  - Fencing: `absorbPaymentById` with a finished event or an unclaimed event and a forged token → `stale_claim`, and nothing is written.
  - Later success on the same checkout (completed checkout, `subscription_create` payment with a subscription) → `granted`, access active, intent paid. A late attempt observation afterwards changes nothing.
  - Intent `requesting` → `pre_subscription:checkout_open` and intent `open`.
  - Checkout GET missing, unknown status, or another id → event failed with `provider_refused_checkout_404`, `dto_invalid` or `provider_checkout_id_mismatch`, and the footprint is unchanged.
  - A payment naming an unknown checkout → `review:unknown_checkout`.
  - `failed` purchase and null-reason open charge without a subscription → still `review:payment_not_subscription`.
  - Tampered checkout amount → `review:checkout_mismatch`, and the intent goes to `review`. A later attempt → `pre_subscription:checkout_unchanged`, and the intent stays in review.
  - Attempt and `checkout.completed` in either order (two fresh databases) → both `pre_subscription:checkout_completed` and `completed_unpaid`, trialing, with identical footprints and no period, subscription or review.
- Mutation check (run locally, then reverted): with the branch disabled, 25 of the 47 new tests fail. The pure fall-through and refund tests pass, as they should.

**Actual local results:** `npm run typecheck` clean; `npm run lint` clean. A focused run of 13 files (both new files, `m4-observed-open-payment`, `m4-worker`, `m4-edge-flows`, `m4-billing`, `m4-checkout-preparation`, `m4-contact-correction`, `sol-billing-readonly`, `m4-dto`, `m4-client`, `m4-cron`, `repo-hygiene`): 115 passed, 2 failed. The 2 failures are the known `repo-hygiene.test.ts` sanitized-checkout failures (missing `.env.example`, git ignore state), unrelated and untouched. The full suite was not re-run: this change has no schema change and the focused run raised no other failure.

**Changed files (this task only):** `supabase/functions/_shared/worker-core.ts`, new `tests/unit/m4-pre-subscription.test.ts`, new `tests/sql/m4-pre-subscription.test.ts`, and this section.

**Not verified / limitations:**
- No provider call was made by the developer. Sol will run the real sandbox decline → success acceptance separately. That run must also confirm that the later success emits a payment event (or checkout completion) whose full GET is `subscription_create` with a subscription, since the grant depends on it.
- The breadcrumb exists only for non-review outcomes. A review outcome from this branch (`unknown_checkout`, `checkout_mismatch`, `checkout_pointer_conflict`) looks the same as one from a checkout event.
- `unknown_checkout` and `checkout_pointer_conflict` are queued before the fence, as on the existing checkout path. That ordering is unchanged.
- Discovery (`absorbDiscovered`) does not use the branch; only the webhook and reconcile paths route through `absorbPaymentById`. A discovered payment of this shape behaves as before. With no SAVOUR reference it is `not_savour`. With one, it reaches `absorb_payment` → `review:payment_not_subscription`. Discovery of this shape is not covered by the new tests.
- A checkout GET that keeps failing (for example a persistent `dto_invalid`) retries on the existing schedule without parking, which is the existing behaviour for any provider drift.

## Observed payment status `open` (12 October, branch `checkout-repair`, sanitized checkout)

Scope: the narrow compatibility fix recommended in `fable-open-payment-review.md`. Nothing else changed: no `apply_subscription_facts` call was added, grace semantics are unchanged, and the contact-correction work is preserved exactly.

**Read-only fact reported by Sol (observed by Sol in the real Bachs sandbox, not by the developer):** after a declined test card, `GET /v1/payments/{id}` returned status `open` while a signed `collection.failed` event was recorded. The parser failed at `payment.status` (dto_invalid), the event kept retrying, and nothing was granted. The developer made no provider call.

**Adapter (`supabase/functions/_shared/bachs-dto.ts`).** `PAYMENT_STATUS` is now `PAYMENT_STATUS_DOCUMENTED` (the saved OpenAPI enum, unchanged) plus `PAYMENT_STATUS_OBSERVED = ["open"]`, with a provenance comment.
- The match is exact and case-sensitive. `open` is kept as-is in the facts and is not rewritten to `created`.
- `OPEN`, `pending`, `authorized` and every other unlisted status are still dto_invalid.
- `parsePaymentList` already used a format check rather than the enum, so it needed no change. List items remain hints only.

**Migration: `supabase/migrations/20261012164322_m4_observed_open_payment.sql`** (the CLI-generated stub; the only migration touched). It does `create or replace` on `billing.absorb_payment` with the sealed body unchanged except one line: `'open'` joins the existing `('created', 'processing')` branch, which returns `payment_pending`. It has the same signature, `security definer` and `search_path`. Owner and grants are preserved, and a test asserts both.
- First payment: an `open` charge grants no period, binds no subscription, writes no `payment_failures` row (no grace), and leaves the intent and trial limits unchanged. A later `succeeded` GET grants normally. A later `failed` GET returns `payment_failed_no_access` as before.
- Renewal: an `open` `subscription_cycle` charge records no failure observation and no grace. A later `failed` GET returns `renewal_failed` and records the failure exactly as before. The pending branch still does not call `apply_subscription_facts`.
- The full GET stays the only authority. The `collection.failed` envelope (even one with `status: "FAILED"`) establishes nothing by itself.
- Worker code is unchanged. `payment_pending` completes the event (status `done`, claim released, no retry). Discovery still schedules a pending payment for a later look, as before.

**Return page and poller: unchanged.** The pending branch does not touch the intent, so the page looks the same as before the decline: "Payment processing: Waiting for payment", then the bounded 4-minute automatic schedule, then "Bachs has not confirmed the payment yet … Check again". This is true (nothing is confirmed) but not specific to a decline. I judged it not materially misleading, so the copy is untouched (see risks).

**Tests (all local; mock Bachs transport, synthetic fixtures shaped like the sandbox observation, PGlite):**
- `tests/unit/m4-dto.test.ts`: `open` parses and is preserved. `OPEN`, `Open`, `open `, `pending`, `authorized`, `requires_payment_method`, empty and null are rejected at `payment.status`. A list item with `open` remains a hint.
- `tests/sql/m4-observed-open-payment.test.ts` runs the real signed webhook intake, `processEvents` and the SQL:
  - signed `collection.failed` plus GET `open` → `payment_pending`, event done, claim released, attempts 1, nothing to re-claim; access, intents and all billing rows unchanged;
  - repeated `open` (two more events, including `invoice.payment_failed`) → idempotent, with an identical row footprint;
  - the same payment later `succeeded` → `granted`, access active, intent paid;
  - renewal `open` → `payment_pending` with zero `payment_failures`, then `failed` → `renewal_failed` with one failure row anchored at the invoice period;
  - a separate workspace: `open` then `failed` → `payment_failed_no_access`, with no period, binding, failure row or review;
  - `OPEN`, `pending` and `authorized` from the GET → event `failed` with `dto_invalid`, nothing written;
  - the replaced function's definition equals the sealed one except the single branch line and its comment. Security definer, config, owner and ACL are identical.
- Mutation check (run locally, then reverted): without the SQL line, 5 of these SQL tests fail, because `open` lands in `review:payment_not_exact`. Without the parser change, the DTO test and 4 SQL tests fail. Both halves are needed.

**Actual local results:** `npm run typecheck` clean; `npm run lint` clean. The full `npx vitest run` was run once: 356 passed, 2 skipped and 4 failed. The 4 failures are the known sanitized-harness failures and were not touched: `legacy.test.ts` saved QA snapshots, `sol-legacy-m3.test.ts` recorded bodies, and two in `repo-hygiene.test.ts`, because this checkout lacks those local files and git state.

**Changed files (this task only):** `supabase/migrations/20261012164322_m4_observed_open_payment.sql` (stub filled), `supabase/functions/_shared/bachs-dto.ts`, `tests/unit/m4-dto.test.ts`, new `tests/sql/m4-observed-open-payment.test.ts`, and this report.

**Not verified:** no real provider test was run by the developer. Whether the sandbox later moves an `open` charge to `failed`, `expired` or `succeeded` (and emits an event when it does) is unknown. Sol needs to re-run the declined-card and later-successful-card flows against a deployed build.

**Risks:**
- If Bachs leaves a declined first charge `open` indefinitely, it never becomes `payment_failed_no_access`. Access stays trial, so this fails closed, but the intent stays `open` until the checkout expires. Discovery keeps re-reading a pending payment on its retry schedule.
- If a renewal charge stays `open` after a decline and Bachs sends no later `failed` GET, no payment-failure grace starts from the payment. Renewal state then depends on subscription events (`absorb_subscription`), which is the conservative reading chosen here. Whether this is enough is a product decision; adding `apply_subscription_facts` to the pending branch was explicitly out of scope.
- The return page cannot tell a declined-then-open charge from a slow one. After the poll window it says confirmation "can take a few minutes", which is weaker than "not completed, try again".
- Other unexpected statuses still retry as dto_invalid and are marked dead after eight attempts by the existing fail_event function; this task does not change that policy.

## Billing contact correction and truthful contact locking (12 October, branch `checkout-repair`, sanitized checkout)

Scope: contact-correction files, new tests and this report only. The checkout-preparation and payment-refresh fixes are preserved; Edge code (`owner-core.ts`, `db.ts`, `bachs-checkout`) is unchanged by this task.

**Read-only facts reported by Sol (observed by Sol in the real Bachs sandbox, not by the developer):**
- Passed: the initial successful payment; five signed events; duplicate handling; the portal; scheduled cancellation.
- **Refund: did not pass.** A simulated refund failed, and SAVOUR processed it without revoking access. This report does not claim a successful refund and does not guess the provider-side cause. Nothing in this task touches refund handling.
- The payment-refresh fix (bounded 4-minute automatic schedule plus manual Check again) is complete, and Sol's local browser check passed. That supersedes the "browser run pending" note in the next section.

**Defect (from `fable-contact-correction-review.md`):** two predicates decided one thing. The sealed `set_billing_contact` refuses once any `provider_customers` row exists, and that row is written on the first checkout attempt. `get_billing` reported `locked` only once a customer was bound. So after any early stop, the page offered an email edit that the server always refused, with copy saying "linked to the payment provider".

**Migration: `supabase/migrations/20261012163920_m4_customer_contact_correction.sql`** (the CLI-generated stub; the only migration touched). All earlier migrations, including `20261012134720_m4_checkout_preparation.sql`, are unchanged. `billing.guard_row` is not replaced. No row is deleted, no bound customer is replaced, and metadata adoption and binding are unchanged.
- **One state function, `billing.contact_state(ws)`**, used by both `get_billing` and the correction RPC. The states are:
  - `editable`: no customer request row yet; the existing `set_billing_contact` applies.
  - `bound`: a customer is bound.
  - `in_progress`: a live creation lease, or an intent in `requesting`, `open`, `uncertain`, `completed_unpaid` or `review`.
  - `uncertain`: sticky uncertainty, *or an expired lease*, or a leftover claim token.
  - `review`: an unresolved `customer_*` review row.
  - `unverified`: legacy history unknown.
  - `request_sent`: a claim was made with the current identity and there is no definitive refusal proof.
  - `correctable`: none of the above.
- **Refusal proof, current claim only.** New `provider_customers.create_refused_at` and `create_refused_detail` columns. A check constraint limits the detail to `http_400:VALIDATION_ERROR` and `http_422:VALIDATION_ERROR`.
  - `gateway_record_preparation` (replaced, same signature and grants) sets the proof in the same `UPDATE` that releases the lease. All of these must hold:
    - the outcome's token equals the current `create_claim_token`;
    - the outcome is `refused` with code `customer_create_refused`;
    - the detail equals one of the two allowlisted strings exactly;
    - the lease is still live;
    - nothing is uncertain.
  - Any other outcome of the current claim clears the proof. A late outcome from a superseded claim leaves the proof untouched.
  - `gateway_customer_claim` (replaced) clears the proof on every new claim, including the review branch.
  - Claim fencing, attempt fencing and sticky uncertainty are otherwise unchanged.
- **Request identity rotation.** New columns `customer_request_key` (unique, format-checked), `customer_key_generation`, `customer_key_attempts_base` and `history_unknown`.
  - The original `customer_idempotency_key` never changes, and `guard_row` still enforces that.
  - `gateway_checkout_context` (replaced) returns `coalesce(customer_request_key, customer_idempotency_key)` in the existing `customer_idempotency_key` field, plus `customer_key_generation`. So `owner-core` uses the effective key without code changes.
  - The context now fails with `billing_contact_mismatch` if the request row's email differs from the workspace contact.
- **New trigger `provider_customers_request_guard`.** It runs in addition to `guard_row` and enforces:
  - the new identity fields are immutable once a customer is bound;
  - the generation never decreases;
  - the key changes exactly when the generation changes;
  - the attempts base never decreases;
  - `history_unknown` can never go from true to false.
- **Legacy rows.** Every unbound row that exists when the migration runs is backfilled to `history_unknown = true`. Those rows predate per-claim outcome records, so a past POST may have succeeded even if a later lookup by email finds nothing.
  - They show `unverified`, and correction is refused with `customer_request_unverified`.
  - There is no operator clear endpoint and no override. Checkout itself is unaffected: same key, same adoption and binding rules.
- **`private.correct_billing_contact` / `public.correct_billing_contact`** (Owner RPC, granted to `authenticated` only):
  1. `require_owner`, then the billing row lock, then the expected-version check.
  2. Locks the active and created intents, then the customer rows (the checkout lock order).
  3. Re-reads `contact_state` under those locks. Anything but `correctable` is refused with a state-specific code.
  4. Email format, consent and a changed-email check.
  5. **Abandons created intents** (`last_error_code = 'contact_corrected'`).
  6. Updates the workspace contact, mapping a unique violation to `billing_email_in_use`. Any failure rolls back the whole call, including step 5.
  7. Sets each unbound row's email, `generation + 1`, a new effective key, `attempts_base = create_attempts`, and clears the proof.
  8. Audits `billing.contact_corrected` with the version, generation, previous refusal detail and abandoned-intent count. No email values are audited.
- **`get_billing`** (replaced) adds `billing_contact.state` and `correctable`. `locked` now means "neither editable nor correctable".
- **Grants.** The correction RPC goes to `authenticated` only. `contact_state` and the trigger function are executable by none of `anon`, `authenticated` or the billing roles. The replaced gateway functions keep `billing_gateway`-only grants. The Edge allowlist in `db.ts` is unchanged.

**UI (`src/app/w/[ws]/billing/page.tsx`, `actions.ts`, `src/lib/billing.ts`, `src/lib/errors.ts`):**
- `editable`: the existing save form.
- `correctable`: only a "Correct billing email" form, using the new `correctBillingContact` action. The action validates the workspace UUID and calls the Owner RPC with the user's own session.
- Every locked state: its own explanation and no email form. "Linked to Bachs" is now used only for `bound`.
- When preparation stopped with `customer_create_refused` and the contact is correctable, the card links to the correction form instead of offering "Try again", which would repeat the rejected request. A refusal the server does not certify keeps "Try again".
- Bundled Next.js guides read: `forms.md` and `server-actions.md` (authorize inside each action; `revalidatePath` re-renders in the same response).

**Tests (mock transport and PGlite; every provider status and error code is synthetic):**
- `tests/sql/m4-contact-correction.test.ts` (9, real SQL through the scoped gateway role and the real `owner-core` flow):
  1. **Definitive current-claim refusal → correction succeeds.** The created intent is abandoned with `contact_corrected`. The old intent can no longer claim, load context, mark requesting or resume (`checkout_intent_stale`).
     - Old and new keys differ. The new checkout's POST uses only the new key; the original `customer_idempotency_key` is unchanged.
     - The audit has no `@`. Afterwards the state is `bound` and correction is refused.
     - Even the table owner cannot change the identity fields or the original key, or delete the row.
  2. **Late results from the pre-correction run.** Run with a new claim in flight:
     - The old token's late refusal neither sets proof nor releases the new lease.
     - The old token's late uncertain outcome leaves the new token and lease intact and only makes the state stricter.
     - A late bind with the old email is refused (`billing_customer_review`) and nothing is bound.
     - The new run then binds with the new key.
  3. **Live lease → `customer_request_in_progress`; expired lease → `customer_request_uncertain`.** The claim's own late 422 VALIDATION_ERROR, arriving after expiry with the still-current token, certifies nothing (`request_sent`).
  4. **Recorded uncertainty stays sticky.** A later 422 VALIDATION_ERROR on the same key does not make the contact correctable.
  5. **Allowlist.** None of these certify, each tested through a real current claim:
     - other statuses: 400 INVALID_REQUEST, 409 CONFLICT, and 429, 409 or 401 with VALIDATION_ERROR;
     - incomplete details: `http_422` or `http_400` with no code;
     - malformed details: wrong case, extra characters, leading space, trailing newline, four-digit status, `VALIDATION_ERRORS`, null;
     - the right detail with the wrong code.

     Only the exact detail certifies. A new claim clears the proof, and replaying the superseded claim's refusal does not restore it. The column check rejects a non-allowlisted detail.
  6. **Unresolved customer review** (ambiguous lookup) blocks correction.
  7. **Refusals without side effects.** Each of these is refused and nothing changes:
     - stale version;
     - another workspace's email (`billing_email_in_use`, with the intent abandonment rolled back);
     - unchanged email, invalid email, no consent;
     - an admin member (`forbidden`), a stranger or another Owner (`not_found`).
  8. **Privileges.**
     - The correction RPC is executable by `authenticated` only, not by `anon`, `billing_gateway`, `billing_worker` or `billing_intake`.
     - `contact_state` is executable by none of them.
     - The gateway functions stay `billing_gateway`-only, and an authenticated call to `gateway_customer_claim` is `permission denied`.
  9. **Legacy backfill.** This test uses a separate PGlite instance that applies migrations only up to `20261012134720` and writes rows with the previous schema: one 422 VALIDATION_ERROR refusal and one lookup-only stop with zero POSTs. It then applies the new migration.
     - Both rows end up `unverified`, and correction is refused for both.
     - The flag cannot be cleared, even by the table owner, and no history or override function exists.
     - Checkout still binds with the original key.

  `tests/sql/m4-harness.ts` gained an optional `stopBefore` and `migrateRest()` for this; existing callers are unchanged.
- `tests/unit/m4-contact-correction-ui.test.ts` (7): the server-rendered page, with forms identified by the action they are bound to.
  - `editable` offers only save; `correctable` offers only correct.
  - All six locked states have distinct explanations and no email input.
  - A certified refusal offers correction and no retry; an uncertified one offers retry and no correction.
  - The correction action's RPC arguments, error mapping and UUID validation.
- `tests/unit/m4-checkout-preparation-ui.test.ts`: fixture shape only (adds `state` and `correctable`); no assertion changed.
- **Mutation checks.** Each mutation was applied to the migration, run, and reverted; a grep confirmed no residue.

  | Mutation | Tests that failed |
  | - | - |
  | Any 4xx certifies | 1 (allowlist) |
  | Proof without a live lease | 1 (expired lease) |
  | New claim keeps old proof | 1 (allowlist) |
  | Proof ignores the claim token | 3 |
  | Correction does not abandon created intents | 1 |
  | Context returns the original key | 2 |
  | State ignores `history_unknown` | 1 (legacy) |

**Actual local results (this checkout):**

| Check | Result |
| - | - |
| `vitest run` `m4-contact-correction`, `m4-checkout-preparation` (SQL), `m4-contact-correction-ui` | 3 files, 24/24 pass |
| `vitest run` on the four billing UI files | 4 files, 26/26 pass |
| `npm test` (justified by the schema change and the replaced `get_billing` and gateway functions) | 46 files: 41 passed, 3 failed, 2 skipped. 354 tests: 348 passed, 4 failed, 2 skipped. The 4 failures are the same sanitized-checkout ones as before, re-confirmed by their errors: missing `docs/milestone-2/` and `docs/milestone-3/qa-snapshot-baseline.json`, missing `.env.example`, and the `node_modules` symlink gitignore check. None touch billing. |
| `npm run typecheck` / `npm run lint` | Clean |
| Build, `deno check` | Not run. No Edge code changed in this task. |

**Limits of PGlite.** PGlite has one connection, so every "concurrent" case above is a deterministic interleaving of serialized transactions: a mock POST held open between two transactions, and leases expired by an `UPDATE`. That proves the fencing logic for those orders. It does not exercise:
- row-lock waits;
- the correction/claim/bind lock order under contention, or deadlock behaviour;
- `clock_timestamp()` lease expiry under real latency;
- two Edge invocations on separate pooler connections.

These need real Postgres with independent sessions.

**Finding in sealed code (not changed here).** `gateway_bind_customer` queues its review (`customer_email_mismatch`, `customer_replacement_refused`, `customer_bound_elsewhere`) and then raises `private.fail`. The raise rolls the review insert back with the rest of the statement, so those refusals block correctly but leave no review row and no `review_required` banner. Test 2 asserts the refusal only. Fixing this needs a separate reviewed change, for example recording the review in a committed step before failing.

**Pending hosted and provider checks (not done; no cloud or API access here):**
1. Sol reviews and applies `20261012163920`. Before and after, count unbound `provider_customers` rows; all of them should become `history_unknown`. The old test workspace should show `unverified`.
2. Hosted acceptance with a disposable `.test` workspace:
   1. A rejected email ends in `customer_create_refused` with an allowlisted detail, and `get_billing` shows `correctable`.
   2. Correct the email. Confirm the abandoned intent shows `contact_corrected` and the audit row is present.
   3. The new checkout's `POST /v1/customers` carries the new `Idempotency-Key` (Sol checks the Bachs request log).
   4. The customer binds and the state becomes `bound`.
   5. The Bachs dashboard shows one customer for the workspace and none for the rejected email.
3. Confirm Bachs accepts the effective key. It is 109 characters for generation 1, against 106 for the original; Bachs's maximum key length is not known here.
4. Confirm the rejection allowlist against the real response. The developer has not seen a Bachs `POST /v1/customers` response; the allowlist is the one specified in Sol's review.
5. Run the two-session races on real Postgres:
   - correction against a claim taken at the same moment;
   - correction against a late bind;
   - two Owners correcting at once (expect one `stale_version`).
6. Legacy rows: there is deliberately no resolution path. Any future one must be an explicit, reviewed change, and the trigger forbids clearing `history_unknown` in place.
7. Browser check of the contact section in each state, including keyboard focus for the "Correct the billing email below" link.

**Risks:**
- Any Owner (not only the consenting one) can correct, and that abandons a co-owner's created intent. This matches how `begin_checkout` already supersedes created intents.
- Correction is refused for an unchanged email even when only the key would need rotating. That choice is deliberate, but it means support must handle any non-email cause of a validation error.

## Sandbox acceptance and return-page refresh (12 October, branch `checkout-repair`, sanitized checkout)

**Acceptance evidence observed by Sol in the real Bachs sandbox (reported to the developer; identifiers omitted):**
- Checkout succeeded in the sandbox. Signed webhook intake and cron-triggered worker processing were observed.
- Five valid signed events arrived. `subscription.created`, `invoice.paid` and `subscription.updated` were each held safely as `awaiting_payment`. `checkout.completed` granted exactly one verified paid period. `collection.succeeded` was handled as a duplicate.
- Result in the database: the verified subscription is `active`, paid period count 1, and there is no unresolved review. Access became active correctly.
- The developer did not observe any of this directly. Nothing in this checkout talks to Bachs or the database.

**Observed UX defect:** the return page still showed "Waiting for payment" and "Still confirming" after access became active. `RefreshPoller` stopped re-reading after 60 s (12 checks, 5 s apart). The worker processes a batch of 3 events once a minute, so the five events needed two cron runs, and confirmation landed after the page had stopped checking. The server state was correct; only the page was stale.

**Fix (`src/app/w/[ws]/billing/refresh-poller.tsx` only; no page, SQL, Edge or migration change):**
- Automatic checks run on a bounded schedule: every 5 s for the first minute, then every 15 s, 4 minutes in total (24 refreshes). That covers two worker runs plus processing time without polling forever.
- After automatic checks stop, the page says Bachs has not confirmed yet and shows a **Check again** button. The button calls `router.refresh()` right away, restarts the bounded schedule, and is disabled while the refresh is in flight. Copy stays in the existing `aria-live="polite"` region.
- When `active` is false (paid, no pending checkout, or a `created` intent), the poller renders nothing and schedules nothing, so no "checking" or "not confirmed" copy remains beside the server-verified status. If a checkout becomes pending again, the schedule starts over.
- The poller only triggers `router.refresh()`, which re-runs `get_billing` on the server. It reads no query string, redirect or browser state. Whether the page shows "Payment confirmed" is still decided only by the server-verified `access.state` with no pending checkout. Paid-status handling in `return/page.tsx` is unchanged.

**New test `tests/unit/m4-return-refresh.test.ts` (6):**
- The automatic schedule lasts at least 3 minutes, ends, never checks more often than every 5 s, and stays within 10 minutes.
- The return page, rendered on the server: a pending checkout shows its status and "Checking with Bachs". Verified paid access shows "Payment confirmed by Bachs" and none of the waiting, checking, not-confirmed or Check-again copy. Active access with a checkout still pending is not shown as paid. An inactive poller renders empty markup.
- Limitation: there is no DOM test library in this project (none was added), so timer ticks and the Check again click were not exercised. They are covered only by code reading and the browser check below.

**Actual local results (this checkout):**

| Check | Result |
| - | - |
| `vitest run` on `m4-return-refresh`, `m4-checkout-preparation-ui`, `m4-billing-ui` | 3 files, 19/19 pass |
| `vitest run tests/unit` | 29 files: 27 passed, 1 failed, 1 skipped. 262 tests: 259 passed, 2 failed, 1 skipped. Both failures are in `repo-hygiene.test.ts` and come from this sanitized checkout, as before: `.env.example` is absent, and `node_modules` is a symlink. |
| `npm run typecheck` / `npm run lint` | Clean |

**External check still pending:** a browser run of the sandbox checkout against the deployed app. It should confirm that the return page switches to "Payment confirmed by Bachs" on its own when confirmation takes two cron runs. It should also confirm that after automatic checks stop, Check again refreshes and restarts checking, and that a screen reader announces the status changes.

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


## Sol acceptance checkpoint — contact correction and declined-payment compatibility

The two Opus changes were independently reviewed and integrated into the complete development repository. Full suite: 361 passed, one optional fixture skipped; typecheck and lint passed. The contact UI build passed. Cached Deno checks passed for bachs-worker and bachs-checkout. Both additive migrations were applied only to savour-dev; local filenames match hosted history (20261012163920 contact correction; 20261012164322 observed open payment). Existing migration bodies and Firebase MVP HTML files remain unchanged.

Hosted contact predicates and privileges passed: legacy unbound test contact is unverified; the paid customer remains bound; authenticated has the Owner correction RPC but anon and billing_gateway do not. Security advisors remain at the existing baseline of 26 informational deny-by-default RLS notices and the existing leaked-password warning. The isolated checkout’s four unrelated fixture/hygiene failures did not occur in the complete repository.

Real sandbox evidence: the declined card displayed “Your card has been declined.” The charge GET returned open, explaining the old dto_invalid retry. Before the repair, paid periods and subscriptions remained zero, trial limits unchanged, and no grace began. Hosted post-repair event completion is still pending.

A separate successful sandbox payment confirmed automatically in the hosted return page; its server ledger and Business limits became active. This is the first actual provider-backed acceptance of the four-minute polling fix, beyond the earlier local timer fixture.

The first simulated refund failed and did not revoke paid access (safety passed). A fresh full-refund simulation was refused with 403 until the owner approved and saved Write Refunds on the existing sandbox key; all nine earlier scopes were preserved. The request then returned 201 processing. Its refund.created event was processed safely without revocation while the full payment GET still said succeeded. Successful refund completion/revocation is pending; no success is claimed from the request or event alone. No real money moved.

Remaining: deploy/repoint only a protected Ready Preview, verify contact correction against Bachs, post-repair declined-event handling, real two-connection fencing, completed refund, renewal/failure/dispute cases and NGN account-specific capability. Milestone 4 is not complete.


## Sol hosted acceptance follow-up

Protected Ready Preview dpl_2uAWb9MQB9wN5ttZf3jx98AmBJ9f (commit d54b22e) is on the stable development alias; anonymous access still redirects to Vercel authentication. Both applied migration names and filenames match hosted history. All 25 approved report snapshots passed.

Actual contact acceptance: Bachs rejected the synthetic test email with HTTP 400 VALIDATION_ERROR. The UI displayed Correct billing email, correction succeeded, the old intent became abandoned, and request generation became 1. A new checkout bound a provider customer with the corrected approved sandbox alias. Exact provider GET confirmed its ID, email, workspace and connection metadata. The corrected 109-character request key was accepted. Customer search did not reliably find this new plus-address record, so no uniqueness claim is based on search results.

A real two-connection Postgres test on the disposable corrected intent proved connection B waited behind connection A's billing/customer claim lock, then proceeded after A rolled back. Both transactions rolled back; no provider POST occurred and no claim mutation remained. This proves real row-lock waiting, not every possible race or deadlock.

Actual full refund completed: refund.paid was processed as period_revoked. The exact original USD paid period became full-refunded and revoked; access returned to the remaining free trial and trial limits. Earlier refund.failed preserved its separate paid period. No real money moved.

After the open-status repair, the old declined event completed with review:payment_not_subscription, exposing the actual pre-subscription shape (open purchase, null subscription and invoice). The worker-only follow-up routes precisely this shape through the verified checkout path, never through a paid grant. New hosted decline-to-success acceptance is pending; the earlier review is retained.
