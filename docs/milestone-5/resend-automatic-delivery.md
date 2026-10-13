# M5: development-only automatic owner email (summary and configuration steps)

Status: **development setup in progress; automatic sending remains off.** The migration is applied in savour-dev. The restricted login and bounded trigger have been provisioned. Strict TLS with the official Supabase CA and hosted rollback checks passed. The worker is deployed and its HTTP gates verified (401 unauthenticated, 405 wrong method, 200 not_configured with zero claims). The separate automatic Resend key, schedule and actual scheduled delivery test remain pending. The manual verification email was delivered by Resend; that does not verify automatic delivery or complete Milestone 5.

## What it does

When the root operator has set it up and an owner switches it on, each eligible active warning episode on `/platform/alerts` produces one development email to `nonsou@gmail.com`, sent from `onboarding@resend.dev`. That includes episodes that were already active when it was switched on. That sender is a Resend test domain, so Resend delivers only to the account owner.

- **At most one email per warning episode, whatever the outcome.** Nothing is sent when a warning clears.
- **Quota:** two fixed budgets, kept separate on purpose: at most 5 automatic attempts per UTC day plus the manual verification's own 1 per day, so at most 6 a day. At most 20 new rows queued per run (high severity first, then oldest change, then key), at most 3 leased per run, 5 attempts per email, and no attempt more than 23 hours after the first.
- **Fixed text only:** alert title and code, operation label, count, and the time it was observed. The text says it describes an observation, not necessarily a current incident. It never includes connection ids, actors, customer or vendor labels, errors or secrets.
- **"Accepted" is not "delivered".** It means Resend accepted the request, as reported by the worker. No response time is promised.

## Pieces

| Piece | File |
|---|---|
| Role, tables, worker and admin functions | `saas/supabase/migrations/20261013203437_m5_operations_mailer.sql` |
| Worker logic (pure, Node-tested) | `saas/supabase/functions/operations-mailer/core.ts` |
| Worker Deno entry with its own `operations_mail` adapter | `saas/supabase/functions/operations-mailer/index.ts` |
| Operator cron (not migrations) | `saas/supabase/cron/operations_mailer_schedule.sql`, `operations_mailer_unschedule.sql` |
| Read validator and text | `saas/src/lib/operations-mailer.ts` |
| Page section and switch | `saas/src/app/platform/alerts/automatic-email.tsx`, `mailer-form.tsx`, `mailer-actions.ts` |
| Tests | `saas/tests/sql/m5-operations-mailer.test.ts`, `saas/tests/unit/m5-operations-mailer.test.ts` |

### Database
- **Role:** `operations_mail` is created NOLOGIN NOINHERIT. This migration gives it USAGE on `operations` and exactly three application EXECUTE grants, all SECURITY DEFINER functions:
  - `operations.mailer_heartbeat(ready|not_configured)`. It locks the singleton row before reading the clock, so overlapping calls write in lock order.
  - `operations.mailer_claim()`
  - `operations.mailer_finish(lease uuid, accepted|rejected|unknown, provider uuid)`

  It gets no table grants from this migration. Like every role, it still holds whatever PUBLIC holds by baseline: built-in functions, plus any PUBLIC grants that an extension such as pg_net puts on its own tables. That cannot be excluded per role and is not changed here; no extension ACL is modified. PUBLIC, anon, authenticated, service_role and the billing roles are revoked from the three entry points.
- **Tables** (RLS on, no policy, no grants):
  - `mailer_config`: singleton, `enabled = false` initially. `changed_at` and `changed_by` record the admin returned by `private.platform_actor(true)` in the switch. The caller never supplies it, and the read never returns it.
  - `mailer_heartbeat`: what the worker last reported.
  - `mail_ledger`: unique `(alert_key, episode)`. A trigger keeps subject, body and identity immutable and keeps terminal states terminal. Statuses are pending, leased, accepted, rejected, unknown, review and cancelled. Cancelled means the warning cleared before the first send.
  - `mail_attempt_days`: per-UTC-day counter, at most 5.
- **What can be enqueued:** `operations.alert_state` rows that are active, have `unobserved_since` null, were seen within 10 minutes, and whose source read ok in the latest evaluator attempt with a success within 10 minutes. A sighting or source success dated in the future is never eligible. Enqueueing happens only while enabled, at most 20 rows per run.
- **Scheduler probe:** a read-only lookup of `cron.job` and the latest `cron.job_run_details` row, for the named job `savour-operations-mailer` only.
  - It reports the job as active, inactive, absent or not_measured. Not_measured covers a missing catalog (as in PGlite), duplicate names or errors, and never means healthy.
  - It reports the latest scheduled start, and that run's status as succeeded, failed, running or other.
  - "Succeeded" means pg_cron queued the HTTP request. It does not mean an email was sent or delivered, and it is not a health statement.
  - A manual worker call refreshes only the worker heartbeat, never the scheduled time.
- **Claim:**
  - Serialized by `pg_try_advisory_xact_lock`; the clock is read only after the lock is taken.
  - A lease older than 15 minutes becomes unknown and its token is void.
  - Unknown is retried with the same body and idempotency key `savour-alert-<ledger id>` under a fresh lease, at least 4 minutes later, within 23 hours and 5 attempts. Otherwise it goes to review. Pending rows older than 23 hours go to review.
  - Terminal rows older than 90 days are pruned, except the current episode.
- **Admin:**
  - `public.platform_operations_mailer()` needs AAL1 and returns sanitized data: the worker heartbeat (its own key-present report, last check, status), the scheduler probe as a separate block, counters and the latest 14 summaries. No bodies, leases, keys, alert slots or actor.
  - `platform_enable_operations_mailer()` and `platform_disable_operations_mailer()` need AAL2 and take no arguments. Enable refuses with `mailer_not_ready` unless the worker reported ready within the last 10 minutes and not in the future. It refuses with `mailer_not_scheduled` unless the named job is active.
  - No RPC stores or returns a key.

### Worker (`operations-mailer`)
- **Request gates:** POST only. The opaque `SAVOUR_MAIL_TRIGGER_TOKEN` (at least 32 characters) is compared in constant time. `SUPABASE_URL` must be exactly `https://ilhutasrxnbtssswmgam.supabase.co`, or the worker fails closed.
- **What it reads:** only the Authorization header. No body, query, recipient or text comes from the request.
- **Key check:** it reads `SAVOUR_MAIL_RESEND_API_KEY` before claiming. If the key is missing it records heartbeat `not_configured` and sends nothing. If present it records `ready`, then claims.
- **Claim check:** every claimed item must match the fixed recipient, sender and shape exactly; otherwise nothing is sent.
- **The Resend request:** a literal `https://api.resend.com/emails` with `redirect: "error"`, `cache: "no-store"`, a 10 second abort, and a response read of at most 4 KB.
- **Outcome mapping:** 2xx with a UUID id is accepted. 409, 5xx, other statuses, timeout and malformed responses are unknown. Other 4xx are rejected.
- **Finishing:** each item is finished only with its own lease token.
- **Responses and logging:** responses are a static status plus counts. Nothing is logged.
- **Database access:** through its own adapter as `operations_mail`, using `SAVOUR_MAIL_DATABASE_URL`. The adapter uses the existing pinned driver `npm:postgres@3.4.5`; `deno.json` is unchanged.
- **Database TLS (strict):** `ssl: { rejectUnauthorized: true, ca: SUPABASE_ROOT_2021_CA }`.
  - **Why not `verify-full`:** the root's real pooler test failed with `SELF_SIGNED_CERT_IN_CHAIN`, because the pooler's chain ends at Supabase's own root, not a public one.
  - **The CA:** the public Supabase Root 2021 CA from the official dashboard link (`prod-ca-2021.crt`). It is bundled as a TypeScript constant in `operations-mailer/supabase-ca.ts`, so the function never reads it from disk at runtime. When `ca` is given, the connection trusts only that root.
  - **Integrity:** the constant is byte-identical to the downloaded file. Its SHA-256 certificate fingerprint (over the DER encoding, not the PEM text) is `807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA`, and a unit test checks it. The test also checks that it is a single self-signed CA certificate valid until 2031-04-26.
  - **Host name:** still checked. postgres@3.4.5 passes `servername` (the URL host) to `tls.connect`, and the default identity check runs.
  - **Guarded by a source test:** the worker has no `rejectUnauthorized: false`, `checkServerIdentity` override, `servername` override, `NODE_TLS_REJECT_UNAUTHORIZED`, string `ssl` modes (`require`/`prefer`/`allow`/`verify-ca`/`disable`) or runtime certificate file read.
  - **Expiry:** the CA expires on 2031-04-26. Replace the constant (and its fingerprint test) before then.
- **Injected secrets:** Supabase injects `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` into every function and they cannot be removed. This function never references them, and a unit test asserts that. So "no broad secrets" holds for the code, not for the runtime environment.

## Configuration steps (root operator, later)
1. Apply migration `20261013203437_m5_operations_mailer.sql` to the development project.
2. Out of band, give `operations_mail` LOGIN and a password. Confirm the pooler accepts the role.
3. Deploy `operations-mailer` without JWT verification. Set its function secrets: `SAVOUR_MAIL_DATABASE_URL` (logging in as `operations_mail`), `SAVOUR_MAIL_TRIGGER_TOKEN` (new, distinct from the billing token) and `SAVOUR_MAIL_RESEND_API_KEY`.
4. Create the Vault secrets `savour_operations_mailer_url` (exactly `https://ilhutasrxnbtssswmgam.supabase.co/functions/v1/operations-mailer`) and `savour_operations_mailer_trigger` (the same trigger token). The Resend key never goes into Vault, SQL or pg_net.
5. Run `supabase/cron/operations_mailer_schedule.sql` as the database owner. It is one transaction (`begin`/`commit`), so any failed check rolls back everything. It checks pg_cron, pg_net, the job functions and the migration, and validates the URL and token. It then creates the owner-only helper and schedules the sixth job, `savour-operations-mailer`, every 5 minutes. The five existing jobs are untouched.
6. Confirm that the worker connects through the pooler with the bundled CA and certificate verification on. A failure means stop and review; never weaken TLS. Within 10 minutes the page should show "Ready but off", with the scheduled job active. An owner at AAL2 ticks the confirmation and switches it on.
7. To stop: switch it off on the page, or run `operations_mailer_unschedule.sql` (also one transaction), which removes only that job and its helper.

## Honest caveats
- **The trigger token can be read from the request queue.** pg_net keeps request rows, including headers. A broad SQL role can read the token and call the worker early. It can only make already-approved, quota-bounded outbox rows send sooner. It cannot read a secret, choose a recipient or body, or finish a row it did not lease. This is the same exposure class as the billing trigger.
- **Statuses are self-reported by the worker.** Bounces and delivery events are not read.
- **A paused or unavailable development project stops the job.** The page then shows the worker as stale; this is not external outage monitoring.
- **The manual verification text was replaced, not edited in place.** The additive migration `20261013203437` ends with a `create or replace` of `private.alert_email_verification_message()`. The new text points to the alerts page for automatic status instead of saying it is not connected. `VERIFICATION_TEXT` in `src/lib/alert-email.ts` changed in the same bundle. The applied file `20261013201621` is unchanged. Ship both together: if only one side is updated, the exact match fails closed and nothing is sent, but that day's single manual attempt is still used up.
- **Hosted concurrency checks cover the claim busy-lock path and two simultaneous heartbeat writes.** They do not prove all possible races or high-volume performance.
- **`index.ts` is excluded from the Node typecheck like the other entries.** The root ran Deno check against the final runtime and bundled CA successfully; ESLint ignores `supabase/**`.

## Checks run in the isolated copy
- `tests/sql/m5-operations-mailer.test.ts`: 35 passed (existing harness, plus a minimal local stand-in for the pg_cron catalog).
- `tests/unit/m5-operations-mailer.test.ts`: all passed.
- Edited baselines `tests/unit/m5-operations-alerts.test.ts` and `tests/unit/m5-resend-verification.test.ts` pass. Only the provenance wording assertions and the page's RPC call list changed.
- `npm run lint`: clean. `npm run typecheck`: one error, for `scripts/build-guard.mjs`, which is missing from this copy (in `next.config.ts`). None in changed files.

## Independent root verification

- Full pre-CA repository suite: 875 passed, one optional skip; type checking, lint, guarded local build and Deno check passed. Final CA change passed 65 affected worker tests plus Deno/type/lint checks again.
- Actual pinned driver is postgres 3.4.5. Certificate-chain and hostname verification succeeded with the published Supabase CA; the worker login cannot read the ledger or Vault and reaches only three application functions.
- Hosted rollback check passed owner AAL1 read/AAL2 write gates, off-state zero claims, episode deduplication and unknown retry delay. No outbox or attempt rows remain; the mailer job is absent. All 25 report revisions retain whole-row fingerprint 92ffc939a313f530e7b4814b54deae46.
- Two real restricted connections verified advisory-lock contention returns busy with no claimed items; overlapping not_configured heartbeat calls both succeeded. No emails were sent by these checks.
- The manual verification provider message 01a13706-01d9-7ee2-8033-1304bc58d6d4 is Delivered in Resend. Provider delivery is not proof the owner read it. The UTC-day manual attempt remains recorded and is not reset.

- Runtime HTTP verification passed: unauthorized POST 401, authorized GET 405, authorized POST with caller-supplied recipient/body ignored returns not_configured with all send counters zero. Function deployed alone; five earlier jobs unchanged.
- Bootstrap kept generated raw password and trigger in private operator files. ALTER ROLE used an offline-generated SCRAM hash; provider credentials never entered SQL. No existing passwords were reset or hidden credentials read back.
