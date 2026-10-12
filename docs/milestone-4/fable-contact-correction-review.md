I have everything needed. Here is the recommendation.

## Root cause

Two different predicates decide the same thing. The sealed `set_billing_contact` refuses whenever any `provider_customers` row exists (`20261012090945_m4_billing.sql:2613`), while `get_billing` reports `locked` only when `bound_at` is set (prep migration line 186). The row is inserted by `gateway_checkout_context` on the first checkout attempt and can never be deleted or re-keyed, because `guard_row` forbids deletes and any change to `customer_idempotency_key` (sealed lines 698-703). So every workspace whose first checkout stopped before binding is locked forever, not only the 400 case.

## Step 1: accurate UI lock, ship now

- **One predicate function.** Add `billing.contact_lock(p_ws) returns text` in the untracked prep migration. It returns null when editable, else a reason: `bound`, `customer_request_in_progress` when a lease is live, `customer_request_uncertain` when `create_uncertain_since` is set or a lease exists but was never released, `review_pending` when an unresolved customer review row exists, and for now `customer_request_pending` for any other unbound row.
- **get_billing uses it.** Expose `billing_contact.locked = lock_reason is not null` plus `lock_reason`. Replace nothing else yet. The UI hides the edit form when locked and shows the reason text. The server action maps `billing_contact_locked` to the same copy as a fallback.
- No sealed function changes. This alone makes the UI truthful today.

## Step 2: safe correction flow

Keep the correction in SQL only, no provider call, as an explicit audited action rather than a silent branch of the existing edit.

- **Record definitive refusal per claim.** Add `create_refused_at` and `create_refused_detail` to `provider_customers`. In `gateway_record_preparation`, set them only when `create_claim_token = p_claim` and the outcome is `refused`, in the same update that releases the lease. `gateway_customer_claim` clears both when it issues a new claim. A late result from an expired or superseded claim therefore never produces proof. Definitive means the detail matches an allowlist, `http_400` or `http_422` with an error code not containing `IDEMPOT`. 409, 429 and everything else are not proof.
- **Correctable predicate, evaluated under the billing lock and then the row lock.** All unbound rows of the workspace must satisfy: no claim token, `create_lease_until is null` so the last claim was closed by its own recorded outcome rather than by expiry, `create_uncertain_since is null`, `history_unknown = false`, and either `create_attempts = 0` or `create_refused_at is not null`. Plus no intent in requesting, open, uncertain, completed_unpaid or review, and no unresolved customer review row. `contact_lock` returns null exactly in this state, so UI and server cannot disagree again.
- **Rotate the request identity without touching the guard.** Add nullable `customer_request_key text unique` and `customer_key_generation integer default 0`. The correction sets the new key from the new email and generation, bumps generation, updates `billing_email` on the row, which the guard allows while unbound, and nulls the refusal proof. Replace `gateway_checkout_context` with `create or replace` so it returns `coalesce(customer_request_key, customer_idempotency_key)` and fails with `billing_contact_mismatch` if the row email ever differs from `workspace_billing`. Do not replace `guard_row`. It protects ten tables and a transcription slip would silently weaken unrelated invariants.
- **Abandon before change.** Under the same billing lock, mark any `created` intent `abandoned` with `last_error_code = 'contact_corrected'`, as `begin_checkout` already does for superseded intents. `gateway_customer_claim` re-reads the intent under that lock and fails on any non-created status, so an in-flight gateway run cannot claim with the old email afterwards.
- **Then the workspace write.** Reuse the `set_billing_contact` rules: live Owner check, expected version, email validation, consent required, unique violation mapped to `billing_email_in_use`, version bump, audit `billing.contact_corrected` carrying the previous refusal detail and the generation but no email values.
- **Late results after correction stay harmless.** A late success bind for the old email hits the email comparison in `gateway_bind_customer` and goes to review. A late uncertain outcome still sticks regardless of token, which is stricter than needed but safe. Adoption by metadata and the live Owner and version checks remain untouched.
- **Entry point.** Add `correct_billing_contact` as a new public and private pair granted to `authenticated` only. Expose `billing_contact.correctable` from `get_billing` so the UI can offer correction instead of a pointless retry when the preparation error is `customer_create_refused` with definitive detail.

## The old test row

It has no outcome history, so it cannot prove "never sent". Add `history_unknown boolean not null default false` and backfill it to true for every unbound row existing when the migration runs. Those rows lock with reason `customer_request_unverified` and the checkout path is unaffected. Add an operator-only `billing.operator_clear_customer_history(p_ws, p_conn, p_note)` that flips the flag after a manual Bachs customer search by the old email finds nothing, logged to `operator_log` like `operator_release_intent`. If the search finds a customer carrying our metadata, do nothing and let the next checkout adopt and bind it. No blanket reset.

## Tests

SQL concurrency, two sessions where noted:
- Live lease held by a proceed claim blocks correction with `customer_request_in_progress`.
- Expired lease with no recorded outcome blocks with `customer_request_uncertain`.
- Refused outcome with the current claim token sets proof; correction succeeds, abandons the created intent, rotates key and generation, bumps version, writes the audit row.
- Refused outcome with a stale claim token after a newer claim sets no proof.
- A late bind with the old email after correction is refused into `customer_email_mismatch` review.
- A new claim after correction clears proof and the context returns the rotated key.
- Backfilled `history_unknown` rows block until the operator function clears them.

Authorization:
- Admin, guest and non-member callers get `forbidden` or `not_found`; stale version fails; bound customer fails with `bound` for the Owner too.
- Unresolved customer review row blocks; email used by another workspace yields `billing_email_in_use`.
- `billing_gateway` cannot execute the correction RPC and `authenticated` cannot execute the gateway functions.

Hosted sandbox acceptance:
1. Invalid email, checkout stops with `customer_create_refused` and `http_400:VALIDATION_ERROR`; `get_billing` shows `correctable` true and the UI offers correction.
2. Correct the email; the created intent shows `abandoned` with `contact_corrected`; audit row present.
3. New checkout creates the customer with the new key and binds; `locked` becomes true with reason `bound` and the edit form disappears.
4. Old test workspace shows `customer_request_unverified`; after operator verification and clearing, the Owner corrects and binds.
5. Bachs dashboard shows exactly one customer for the workspace and none with the old email.