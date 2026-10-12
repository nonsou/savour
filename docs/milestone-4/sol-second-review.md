# Sol second review — October 12

Independent full suite: 292 passed, one optional fixture skipped. All seven Edge entrypoints type-check with pinned Deno 2.9.6 and the pinned official npm packages resolved. No remote migration or deployment yet.

## Repair before deployment

1. Missed-renewal discovery: the reported limitation that payment list items lack subscription_id is not a reason to omit discovery. Official GET /v1/payments returns items with id, reference, transaction_date, status and pagination; GET /v1/payments/{id} supplies subscription_id. Add bounded, resumable discovery of payment IDs with server detail fetch, then existing strict binding only for SAVOUR-owned subscriptions/intents. Avoid scanning an unbounded account on every tick, avoid processing unrelated provider payments as grant candidates, respect offset/has_more and persist progress safely with overlapping discovery windows. No amount/subscription grant from list fields. Tests must demonstrate an unknown renewal ID with no webhook becomes discovered and grants only after complete verified payment/subscription facts; unrelated payments do not bind, partial failures are retried without losing progress. Inspect the official OpenAPI in /tmp/savour-m4-bachs-docs/openapi.json; do not invent unsupported filters (documented payment list supports limit, offset and status_filter, not from_date).

2. Lease-safe event batches: processEvents claims 20 events with a 120-second lease, then processes them serially with several 8-second provider calls per event. Later events can expire before processing; repeated leases may exhaust attempts for work never actually tried. Claim only a safely bounded batch or implement fenced renewals with bounded execution. Test with an injected clock/slow transport so the trailing event cannot be falsely completed after expiry and does not starve or exhaust attempts merely waiting in the batch. Preserve commit-before-HTTP and SKIP LOCKED.

3. Per-connection run accounting: runWorker passes aggregate done/failed counters into each connection finish_run. Second connection reports work done for first connection. Keep per-connection counters for its durable run record and aggregate only in the returned invocation summary. Add two-connection success/failure coverage.

4. HTTP body limits: readJson reads the entire body before checking text.length, and text.length is UTF-16 characters, not bytes. Use a bounded byte stream reader, reject excess Content-Length early but also enforce actual streamed bytes, handle decoding errors and read failure with a deterministic redacted 400/413. Preserve secret body no logging.

Do not change sealed migrations or cloud state. Continue actual Opus implementation and tests; report precise new counts and remaining external verification. Platform providers are Bachs working adapter, Paystack/Stripe pending.

## Additional credential-overlap review

private.platform_store_secret currently deletes previous_webhook_secret_id on every new webhook rotation, even while previous_webhook_valid_until is still in the future. A rapid third rotation therefore removes a key required by the documented 26-hour retry overlap. platform.gateway_record_test similarly deletes previous_secret_id when promoting a second rotation inside the previous 25-hour retention window. Refuse overlapping rotations or retain all still-valid versions. Validate connection and credential/organization versions when completing an asynchronous test, so a stale test cannot certify newer credentials or changed account/price state. Review transaction lock ordering when adding the needed test/connection locks; the current begin_test only reads the connection and does not lock it. Add actual counterexamples before fixing, and preserve the no-secret audit.
