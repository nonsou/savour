# Fable 5.1: pre-subscription sandbox attempt

**Verdict: the candidate is safe and I would ship it over retaining manual review, with the guards below.** It is a synthetic checkout observation, not a payment absorption. The only state it can write is state a checkout event already writes today.

**Why it is safe**
- Nothing from the payment is trusted beyond routing. The five-field predicate selects the branch, and the checkout_id comes from the payment GET, not the webhook. The checkout itself is a fresh full GET.
- absorb_checkout cannot grant. It only pins provider_checkout_id, verifies binding, moves requesting/uncertain to open, or routes to review. It never touches paid_periods, subscriptions, or trial limits.
- The predicate does not need "declined" semantics. An open purchase payment with no subscription and no invoice is also what an in-flight 3DS attempt looks like, and refreshing the checkout is correct for both.
- Fencing still consumes the event exactly once, because absorb_checkout fences on event and token.

**Races and later success**
- Concurrent checkout events on the same intent are serialized by lock_billing and the intent row lock, which the existing checkout path already relies on. No new race class.
- Payment succeeds between the two GETs. The checkout GET may already read completed, so the intent goes to completed_unpaid. That is identical to today's checkout.completed handling. The grant still comes only from the later payment GET with subscription_create and a subscription.
- The candidate writes no payment rows and no facts hash, so a later paid state on the same payment id is absorbed fresh. Pinning provider_checkout_id can only help find_intent later.
- An intent already in review returns checkout_unchanged. There is no auto-resolve.

**Guards**
- Order in absorbPaymentById: REFUNDED check first, then the candidate, then the existing path.
- Closed allow-list: status open, billing_reason purchase, subscription_id null, invoice null, checkout_id present. Any other non-final status falls through unchanged.
- Pass only the checkout object to absorb_checkout. Do not call lock_payment or absorb_payment on this path.
- Checkout GET returning null or a status outside open/completed/expired/cancelled falls back to the existing review path, so the branch never adds a failure mode. Transient GET errors throw for normal retry.
- Record the routing reason in the worker outcome or structured log, since the review breadcrumb disappears. This is the one real cost. Confirm in sandbox that a decline followed by success on the same checkout emits a payment event with subscription_create. If it does not, the breadcrumb matters more and a reconciliation sweep of aged open intents is the fix, not widening this branch.

**Tests**
- Worker unit: each predicate field toggled individually routes to the existing path. Exact match calls getCheckout and absorb_checkout with event and token. Refunded still wins. Null checkout GET and unknown checkout status fall back. Transient throw propagates.
- SQL harness: open checkout against intent in open returns checkout_unchanged with no paid_periods, no subscriptions, no review rows, and unchanged trial limits. Intent in requesting returns checkout_open. Tampered amount returns review:checkout_mismatch and marks the intent. Unknown checkout returns review:unknown_checkout. Intent in review stays in review.
- Sequence: candidate event, then real success payment, grants normally. Replay of the candidate event is rejected by the fence. Candidate and checkout.completed in either order reach the same final state.
- Existing open-status compatibility test stays green. No migration changes, no renewal or grace changes.