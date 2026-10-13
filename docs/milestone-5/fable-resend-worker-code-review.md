**Overall:** no recipient, body or key escape is possible. The ledger trigger at `20261013203437_m5_operations_mailer.sql:107` freezes subject, body and identity, the only recipient is the immutable target at line 123, and the worker at `core.ts:111` sends the constants, not the claim values. The worker role can reach only the three definer functions. One true blocker remains, plus the four root concerns, all fixable in the unapplied migration directly rather than additively.

## Blocker

**Database TLS is encrypt-only, not authenticated.** `index.ts:14` uses `ssl: "require"`. In postgres.js that maps to rejectUnauthorized false, so a man in the middle between the Edge runtime and the pooler could capture the operations_mail password and forge finish calls, including false accepted rows. Switch to `verify-full` against the pooler hostname, whose certificate chains to public roots, and confirm the mapping in the pinned driver version.

## Root concerns, confirmed

- **Heartbeat clock before lock, `mailer_heartbeat` line 169.** Two overlapping calls, for example a cron tick plus a manual invocation, can write an older timestamp last. With differing statuses the check at line 66 raises, the Edge returns 500 and that tick never claims. Fix: `select ... for update` on the singleton, then read the clock, or add `where last_checked_at is null or last_checked_at < v_now`. `mailer_finish` line 256 has the same shape but is harmless, since the token cannot exist before the lease commits.
- **Enqueue has no per-run limit, lines 218 to 222.** Bounded only by alert_state size, which is small, so not a defect. Note the behavioural consequence: enabling emails every currently active episode, including ones active for days, which contradicts the "new active warnings" label at `operations-mailer.ts:108`.
- **No independent scheduler signal, lines 275 to 310.** A manual trigger refreshes freshness and satisfies the enable gate at line 325. Add a fixed-name probe of cron.job and the latest succeeded start_time in cron.job_run_details for savour-operations-mailer, mirroring the evaluator read at `20261013114038:420`, with not_measured under PGlite. The validator allowlist at `operations-mailer.ts:44` must gain the keys in the same change.
- **Manual verification text is now false once enabled.** The applied migration `20261013201621:59` and `alert-email.ts:13` both say automatic emails are not connected. This needs a new migration with create or replace on the message helper and the TypeScript constant in the same release. Between the two steps the exact match at `alert-email.ts:38` fails closed, but the reservation at `20261013201621:106` has already consumed the day. Word the new text so it never needs changing again, for example by pointing to the page for automatic status.

## Other findings

- **Leased count cap can false-fail the UI.** `operations-mailer.ts:84` rejects leased above 3, but a worker that dies after claim twice inside 15 minutes leaves 6 leased rows, and the page then shows unavailable. Raise the cap to 5 or drop it.
- **No audit row for enable or disable, lines 320 to 340.** Only changed_at is kept, so there is no actor record, unlike the M4 platform writes.
- **Budget is separate, not shared.** Line 25 and `MANUAL_LIMIT` give 5 plus 1 per day. Your last brief said shared. Harmless against the daily cap, but confirm the intent.

## Acceptance cases to add

1. Two concurrent heartbeats with different statuses both succeed and the newer timestamp wins.
2. A claim 14 minutes after a lease returns the same leased row untouched; at 15 minutes it is unknown, re-leasable after 4 more minutes, and the old token returns stale on finish.
3. Attempts 5 or first dispatch older than 23 hours move an unknown row to review from both housekeeping and finish.
4. Five leases on one UTC day, then a sixth eligible row stays pending; the next day it leases.
5. A pending row whose alert clears, or whose episode advances, becomes cancelled with attempts 0; an unknown row still retries after a clear.
6. A direct update of body or a terminal status raises from the trigger, even as the migration owner.
7. operations_mail can execute exactly three functions, cannot select any operations or net table beyond pre-existing PUBLIC grants, and cannot read private.operations_mail_target.
8. Edge function source references neither SUPABASE_SERVICE_ROLE_KEY nor SUPABASE_DB_URL, and a claim item with a changed to address sends nothing.
9. Enable refuses when the heartbeat is ready but older than 10 minutes, and when the scheduler probe reports absent.