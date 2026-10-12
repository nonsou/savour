# Fable 5.1: observed pending payment status

**Recommendation: accept `open` as a named, non-final status. Do not rewrite it to `created`.**

Treat it as a third member of the existing pending branch, with its own documented provenance. This keeps the stored facts honest about what the provider actually said, costs the same one-line SQL change as normalizing, and leaves room to split `open` semantics later if the provider ever documents it differently. Normalizing in the parser would make the parsed `status` field lie, and review payloads and failure rows would record a status the provider never sent.

## Adapter change

Split the enum into the documented list and an explicit observed-extension list, then union them for `oneOf`. Something like a `PAYMENT_STATUS_OBSERVED` constant containing only `open`, with a comment stating the source: Sol sandbox, 2026-10-12, seen on a checkout charge after a declined test card, absent from the saved OpenAPI PaymentResponse enum, treated as non-final with no grant and no grace. The match stays exact and case-sensitive. `OPEN`, `pending`, `authorized`, and anything else still fail as dto_invalid. No wildcard.

Check the PaymentListResponse item parser too. If its status hint uses the same `oneOf`, a list reconciliation pass would hit the same dto_invalid on an open charge.

## SQL change

Add `open` to the `created`/`processing` branch so absorb_payment returns `payment_pending`. Nothing else in the branch changes. The worker then completes the event normally and the collection.failed event stops retrying.

Two consequences to state explicitly in the migration comment and the developer report:

- **First payment.** An open charge grants no period, binds no subscription, starts no grace, and preserves trial limits. The checkout can still be retried. A later succeeded GET grants normally. A later expired, failed, or cancelled GET takes the existing no-access path.
- **Renewal.** A `subscription_cycle` payment left open after a decline does not insert a payment_failures row, so no failure observation and no grace comes from the payment. This is the conservative fail-closed reading the user asked for. If the pending branch does not currently call apply_subscription_facts for a bound subscription, consider adding that call so the subscription's own state, such as past_due, remains the authority for renewal grace. That is a small scope extension, so decide it before implementation rather than slipping it in.

Nothing in the collection.failed envelope or the card UI feeds the decision. The full GET remains the only authority, as today.

## Tests

Parser unit tests:
- `open` parses to `open`.
- `OPEN`, `pending`, `authorized` are rejected with the existing dto_invalid path.

SQL tests against a synthetic fixture shaped like the sandbox payment. Use `billing_reason` of `subscription_create`, a checkout id, status `open`, `amount_paid` of zero or null, `amount_remaining` equal to `amount`, null invoice, and a synthetic customer email:
- Open first payment returns `payment_pending`. No paid period, no subscription binding, no grace row, trial limits unchanged, event marked complete.
- Same payment observed open twice is idempotent and creates nothing on the second pass.
- Same payment later observed `succeeded` grants normally. The earlier pending observation must not block it.
- Same payment later observed `expired` or `failed` returns `payment_failed_no_access` with still nothing granted.
- A `subscription_cycle` open payment on a current binding returns `payment_pending` with no payment_failures row. A subsequent `failed` observation inserts the failure as today.

Worker test:
- A collection.failed envelope with a payment id, where the stubbed GET returns open, yields `payment_pending`, releases the claim, and schedules no retry.

## Two things to check during implementation

- **Return page and poller.** If the billing return page keeps polling while the absorbed status is `payment_pending`, an open charge after a decline could show "processing" indefinitely. It should resolve to "not completed, try again" after the existing poll window. Confirm how the poller currently treats pending before shipping.
- **Retry policy for dto_invalid.** This incident shows a schema drift loops the worker until someone notices. A follow-on to park an event for review after N dto_invalid retries is worth a ticket, but it is out of scope here.

**Why not normalize to `created`:** it hides provider drift in the audit trail, it makes the parser's declared status type untrue, and it gains nothing over a named status since both land in the same SQL branch. The only cost of the named approach is that the enum diverges from the OpenAPI file, which the split constant makes visible rather than hidden.