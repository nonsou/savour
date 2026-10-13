## Initial architecture

**Verdict first.** The hidden Vercel Preview key can support an owner-initiated verification send, but it cannot support automatic delivery. Automatic delivery needs a separate, explicitly approved dependency: a second owner-issued Resend key in Supabase Vault plus a fifth pg_cron job. Nothing in the sanitized source contradicts this. I could not verify how the four billing jobs reach their worker, because the cron SQL and Edge Function sources are not in the sanitized copy.

## Blocker: why the Vercel key cannot schedule

- **Vercel Cron runs only on Production.** Production is a frozen placeholder, so no cron can run with the Preview env.
- **Inbound calls to Preview are blocked by Vercel Authentication.** The only way for pg_cron or pg_net to reach a Preview route is a Protection Bypass for Automation secret sent as a header. That is a standing bypass of the protection you said must not be weakened, so it is out.
- **The hidden key is therefore reachable only from code running on a Preview deployment, invoked by a browser that already passed Vercel Authentication.** That is exactly an owner click, and nothing else.

## Stage 1: owner-initiated verification on Preview

Keep the alerts page a pure GET. Add one POST server action and two AAL2 RPCs.

- **Ledger table** in the existing unexposed schema, RLS on, no grants: id uuid, kind in verification or automatic, status in reserved, accepted, rejected, unknown, plus requested_at, finished_at, http_class, provider_message_id, and the exact subject and text stored at reserve time. Store text so any retry sends a byte-identical payload, which Resend's Idempotency-Key requires. No raw error body, no key, no headers.
- **Reserve RPC** calls `private.platform_actor(true)` so AAL1 admins get mfa_required. It enforces quota and spacing in SQL, inserts a reserved row, prunes rows older than 90 days, and returns id, subject, text and the recipient. Recipient comes from a single-row config set only by the database owner, never from the caller.
- **Server action** reads the key from process.env at runtime, fails closed as not configured if absent, POSTs to the fixed Resend URL with Idempotency-Key equal to savour-alert plus the ledger id, from onboarding@resend.dev, with a 10 second abort. It accepts no form fields beyond a confirmation tick.
- **Record RPC** is also AAL2 and takes only id, outcome and an optional uuid message id. Mapping: 2xx with id is accepted, 4xx is rejected, timeout or network error is unknown. Unknown rows may be re-sent once by the owner with the same ledger id inside 24 hours, so Resend dedupes. After 24 hours the row is closed and a new reservation is needed. Rows left reserved for 15 minutes become unknown.
- **Page copy** must label this as a verification by hand, mirror the cron versus manual split in the heartbeat, and never describe it as automatic delivery. The verification text itself states it is a test and carries no alert content.

Three gates protect the action: Vercel Authentication on the deployment, a live platform admin row, and AAL2 in SQL. Resend adds a fourth, since onboarding@resend.dev can deliver only to the account owner's address.

## Stage 2 dependency: automatic delivery

- **New secret, not a copy.** The owner issues a second Resend key with sending-only scope and stores it in Vault under a fixed name by a database-owner SQL session, the same out-of-band step the billing roles already use. The Vercel key is never read back.
- **Fifth pg_cron job** every 5 minutes, separate from the evaluator and the four billing jobs, calling an owner-only dispatcher. It first reconciles earlier pg_net responses into the ledger, then selects alert rows whose episode_count exceeds the last notified episode, reserves one digest row under quota, and posts through pg_net with the Vault key, a 10 second timeout and the same idempotency scheme. The URL is a literal in the function.
- **Verify pg_net is enabled** before approving. The sanitized copy only proves Vault and pg_cron are used.
- **Dedupe rule.** One email per inactive-to-active transition per alert key, batched per run. No email for clears in this stage.

Quota caps enforced in SQL, well under the free tier:

| Limit | Value |
|---|---|
| Resend free daily cap | 100 |
| Automatic emails per UTC day | 20 |
| Verification emails per UTC day | 5 |
| Minimum spacing between sends | 60 s |

**What stays unchanged.** The evaluator, its heartbeat, the AAL1 read RPC, the four billing jobs and the no service-role rule are untouched. Both stages add only owner-only functions, one ledger table, one config row and AAL2-guarded writes.

## Automatic sender decision

**Yes.** Keeping the Resend key in Edge function secrets removes the pg_net ACL dependency entirely. No provider key, Vault secret or database credential ever enters the request queue, and the five existing jobs and the extension ACL stay untouched.

**The queue-readable trigger token is not a blocker.** Anyone with SQL as a broad role could read it and invoke the function early, but the worst outcome is sending already-approved outbox rows sooner, inside the SQL quota and lease. Replays with nothing pending do nothing. It is the same exposure class as the existing billing trigger. Three conditions keep it that way: a token distinct from the billing worker token, constant-time comparison in the function, and the function deployed without JWT verification only because the bearer is the sole gate.

Critical blockers before go-live:

1. **Auto-injected Edge secrets.** Supabase injects SUPABASE_SERVICE_ROLE_KEY and SUPABASE_DB_URL into every function environment and you cannot remove them. The function must never reference them, and a unit test must assert the function source contains neither name. State this in the design, since "no broad service_role secrets" is otherwise untrue at the Edge layer, as it already is for the billing functions.

2. **Claim must bind finish.** Claim returns a per-row lease token and the static recipient, subject and body. Finish accepts only that lease token, an outcome enum and an optional uuid message id. A replayed trigger can then never close or alter a row it did not claim.

3. **Edge takes nothing from the request.** The handler reads only the Authorization header. Recipient, body and idempotency key come from the claim result. The fetch uses a 10 second abort and reports timeout as unknown. The response is a static count.

4. **Cron source must follow the billing pattern.** URL and trigger token come from Vault by fixed name, validated before scheduling, with the literal URL check already enforced by the cron test extended to the sixth job.

5. **LOGIN role bootstrap is out of band.** Create operations_mail NOLOGIN in source, set LOGIN and password only from the CLI, and confirm the pooler accepts the role before the cron job is created. Grant EXECUTE on the three definer functions only, revoke everything else, and assert its privileges in the operator monitoring test grid.

One honest caveat: the development project pausing on inactivity stops the cron silently. The heartbeat will show stale, which is the intended signal.

Root hosted check confirms postgres cannot change pg_net table grants. Use the isolated Edge sender design, not direct Resend credentials in pg_net. Existing five jobs and extension ACL remain untouched.
