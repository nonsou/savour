# M4 two-connection checks (real Postgres; not run locally)

PGlite has one connection, so these races are **unverified locally**. Run on a disposable database
(savour-dev scratch or a local `supabase start`) with two `psql` sessions, A and B, as the database owner.
Load fixtures first by running `m4_billing.sql` up to the sections named below with the final
`rollback` replaced by nothing, inside a transaction you keep open only in session A for setup, then
`commit` the fixture in a scratch database you will drop. Never run this against data you keep.

For each case: start both transactions, run A's statement, run B's statement, confirm in a third
session that B is blocked (`select pid, wait_event_type, wait_event, query from pg_stat_activity where
state = 'active'` shows B waiting on a `Lock`/`transactionid` or advisory lock), then `commit` A and
observe B's outcome. Record the observed rows and outcomes; do not claim a pass without the waiting
backend observed.

| # | Session A (commit last) | Session B | Expected |
| - | - | - | - |
| 1 | `select public.create_invitation(ws, 'a@x.test', 'viewer', true, '{}', null, null)` at staff = limit - 1 | same with another email | B waits on the billing row; after A commits B fails `quota_exceeded`. Exactly one seat taken. |
| 2 | `select public.upsert_subject(ws, null, 'S-a', 'vendor', false)` at subjects = limit - 1 | `public.commit_subject_import` creating 1 | B waits on the directory advisory lock, then `quota_exceeded`. |
| 3 | `public.open_session(D1, v)` needing the last N reservations | `public.set_assignment(D2, ...)` needing 1 | B waits on the billing row; one succeeds, the other `quota_exceeded`; no oversubscription. |
| 4 | `public.create_invitation(ws, 'g@x.test', 'guest', false, '{}', S, array[subj])` | `public.set_assignment(S, ...)` on the same session | Both take the session row first (lock step 2) and the billing row last (step 7): B waits on the session row, never a deadlock. Repeat with B = `public.open_session` / `approve_session` on S. |
| 5 | `billing.absorb_payment(conn, null, null, facts_succeeded, now())` (as billing_worker) | `billing.absorb_refund(conn, null, null, facts_refunded_same_payment, now())` | B waits on the per-payment advisory lock. If A commits first, B revokes the new period; if B commits first (swap order), A returns `review:payment_tombstoned`. Never a valid period plus a tombstone. Repeat with `absorb_dispute` (status `lost`). |
| 6 | `select * from billing.claim_events(conn, 'w1', 10, 60)` (do not commit) | `select * from billing.claim_events(conn, 'w2', 10, 60)` | B returns immediately with no rows for the locked events (`SKIP LOCKED`), never the same event. |
| 7 | `public.begin_checkout(ws, 'USD', price, terms)` | same | B waits on the billing row, then `checkout_in_progress` or supersedes only a `created` intent; never two pending provider requests. |
| 8 | `billing.absorb_payment(...)` for workspace W | `public.open_session(...)` in W | No cycle: payment writers take only the payment lock then the billing row; evidence writers never take a payment lock. |
| 9 | `billing.discovery_record_page(conn, scan, 0, items, n, true)` (do not commit) | same call with the same scan and offset | B waits on the discovery state row, then returns `stale_page`; the cursor advances once. |
| 10 | `select * from billing.discovery_claim(conn, 'w1', 7, 300)` (do not commit) | `select * from billing.discovery_claim(conn, 'w2', 7, 300)` | B never receives A's payments (SKIP LOCKED). |
| 11 | `billing.claim_events(...)`, then wait past `lease_until` before `billing.complete_event(...)` | `billing.claim_events(...)` after the lease expires | A's completion fails `stale_claim`; B owns the event with a new token and attempts + 1. |
| 12 | `public.platform_store_secret(conn, 'api_key', ...)` (admin, aal2; do not commit) | `platform.gateway_record_test(test, admin, ...)` for a test of the same connection | Both lock the connection row first (C2): B waits, then sees the new pending version and returns `credential_changed`; it never promotes the replaced key. |
| 13 | `public.platform_propose_price(conn, ...)` (do not commit) | `platform.gateway_record_test(...)` | B waits on C2, then returns `prices_changed`; nothing is configured from the stale read-back. |
| 14 | `public.platform_set_expected_org(conn, ...)` (do not commit) | `public.platform_begin_test(conn)` | B waits on C2 and snapshots the committed organization. |

Also run `sol_m4_snapshot_pin.sql` before and after applying `20261012090945_m4_billing.sql` and after
these checks; all 25 pins must still match.
