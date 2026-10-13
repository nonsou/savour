# M5 Stage 1: owner-initiated Resend email verification (developer report)

Status: implemented in development. Not deployed, not committed, never run against Resend. No email has been sent by this work.

## What it is

One button on `/platform/alerts` that sends one fixed test email, by hand, at most once per UTC day:

- From `onboarding@resend.dev` to `nonsou@gmail.com` (both fixed in SQL and in `src/lib/alert-email.ts`; the action sends only when both agree).
- Fixed subject and text. No alert, customer or user content.
- Purpose: prove the hidden Vercel Preview key and the Resend account can accept a request. Nothing more.

## What it is NOT

- **Not automatic alert delivery.** No warning is ever emailed. The evaluator, heartbeat, alert read RPC and their grants are unchanged. Automatic delivery needs a separately reviewed secure worker with its own key (see `fable-resend-review.md`, Stage 2) and is not built.
- **Not proof of delivery.** "Accepted" means Resend returned 2xx with a message id *to the admin session that pressed the button*. Confirm arrival in the inbox.
- **No pg_net, Vault or cron.** The hosted pg_net request/response tables carry PUBLIC grants, so a key must never pass through them. The migration contains no `net.`, `vault.`, `cron.` or HTTP reference (a test enforces this).

## Pieces

| Piece | File |
|---|---|
| Ledger, RPCs, grants | `saas/supabase/migrations/20261013201621_m5_resend_owner_alerts.sql` |
| Fixed message, request, outcome mapping, read validator, text | `saas/src/lib/alert-email.ts` |
| Server action (POST only) | `saas/src/app/platform/alerts/actions.ts` |
| UI | `saas/src/app/platform/alerts/email-verification.tsx`, `verification-form.tsx`; integrated in `page.tsx` |
| Tests | `saas/tests/sql/m5-resend-verification.test.ts`, `saas/tests/unit/m5-resend-verification.test.ts` |

### Database

- `operations.alert_email_verifications`: `id, utc_day (unique), status (reserved|accepted|rejected|unknown), requested_at, finished_at, provider_message_id (uuid)`. RLS on, no policy, no grant. No actor, recipient, body, note, raw error, header or key column.
- `public.platform_reserve_alert_email_verification()` → private SECURITY DEFINER: `platform_actor(true)` first (live admin + aal2), prunes rows older than 90 days, claims today's row once (`on conflict do nothing`), returns `{id, from, to, subject, text}`. A second claim the same day raises `verification_daily_limit`.
- `public.platform_finish_alert_email_verification(id, outcome, provider_message_id)` → private DEFINER: `platform_actor(true)` first; outcome must be `accepted|rejected|unknown`; a message id is required for, and only allowed with, `accepted`. Moves `reserved` → outcome once (`recorded`); later calls return `already_recorded` and change nothing; after 15 minutes it returns `expired` and the row stays reserved.
- `public.platform_alert_email_verifications()` → private DEFINER: `platform_actor(false)` (aal1 read), latest 14 UTC days, no ledger id. A reservation older than 15 minutes is shown as `unknown`; one under 15 minutes as `in_progress`.
- Wrappers are SECURITY INVOKER. All six entry points are revoked from PUBLIC, anon, service_role and the billing roles and granted to authenticated only; the two helpers have no grant.

### Server action order

1. `requireUser` (signed out → login redirect; no RPC, no fetch).
2. Form field `confirm === "on"`; every other field is ignored.
3. `VERCEL_ENV === "preview"` and non-empty `SAVOUR_ALERT_RESEND_API_KEY`, else "not configured" (production fails closed). The day is not claimed.
4. Reserve RPC (live admin + aal2 in SQL). `mfa_required` returns a link to `/platform#mfa`.
5. Reservation must equal the fixed constants exactly, else nothing is sent.
6. One `fetch` to the literal `https://api.resend.com/emails`: POST, `Authorization: Bearer <key>`, `Content-Type: application/json`, `Idempotency-Key: savour-verify-<ledger id>`, `redirect: "error"`, `cache: "no-store"`, `AbortSignal.timeout(10000)`.
7. Mapping: 2xx with a uuid `id` in a body of at most 4096 bytes → accepted; 4xx except 409 → rejected; 409 → unknown; 5xx, other status, redirect, timeout, network error, oversized or invalid body → unknown.
8. Finish RPC. If it errors or returns anything but `recorded`, the user sees "uncertain", never success.

All user-facing messages are static. Nothing logs; the key, response body and errors are never returned.

## Exact limitations

- **Self-reported status.** The finish RPC is callable by any live aal2 platform admin directly (the same trust as other admin writes in this registry). The ledger records what a session claims, not what Resend did. The UI says so.
- **No retries.** A rejected, unknown, expired or unrecorded attempt still uses the UTC day. A browser/network failure between reserve and finish leaves the row `reserved`, shown as `unknown` after 15 minutes.
- **Concurrency.** The guard is the unique `utc_day` index. The PGlite tests issue duplicate reservations together, but PGlite has one connection, so true parallel transactions are not exercised there.
- **Sender restriction.** `onboarding@resend.dev` can deliver only to the Resend account owner's address; there is no owned domain.
- **Preview only.** Production has no key and fails closed. Vercel Authentication on Preview is the outer gate; nothing here weakens or bypasses it.
- **Delivery is unverified by the system.** Bounces, spam filtering and delivery events are not read (no webhook is built).

## Manual vs automatic

| | Manual verification (this stage) | Automatic alert email |
|---|---|---|
| Trigger | Admin click, POST server action | Not built |
| Key | Hidden Vercel Preview env var, read at request time | Would need a separate owner-issued key, reviewed worker |
| Content | Fixed test text, no alert data | n/a |
| Rate | 1 per UTC day, no retries | n/a |
| Status meaning | Self-reported request acceptance | n/a |

## Test results in this sanitized copy

- `tests/sql/m5-resend-verification.test.ts`: 18 passed. It is self-contained because the shared `m4-harness.ts` imports Edge Function sources that the sanitized copy does not include.
- `tests/unit/m5-resend-verification.test.ts`: 21 passed. `tests/unit/m5-operations-alerts.test.ts`: passed; two provenance assertions and the read-RPC call list were updated to the new accurate wording.
- `npm run lint`: clean. `npm run typecheck`: errors only in files that import `supabase/functions/**` or `next.config`, which are absent from this copy. None are in changed files.
- Not run here: the harness-based SQL suites and `repo-hygiene`/runbook tests. They need git, `.env.example`, `docs/milestone-5/operations-runbooks.md` or Edge Function sources that are missing from the sanitized copy.


## Independent verification in the real repository

Sol corrected the exact owner-stored Preview secret name (SAVOUR_ALERT_RESEND_API_KEY) and made HTTP409 unknown because Resend documents concurrent idempotent requests as ambiguous. The affected test includes that case. Full real-repository suite:811 passed,1 optional skipped; TypeScript, lint and guarded local build passed. Hosted migration history confirms only20261013201621_m5_resend_owner_alerts was applied; no roles, seeds, Vault update, email, cron or existing grant changed. A rolled-back real-database check passed AAL1 admin read/write denial, AAL2 reservation, one-per-day quota, unknown result recording, repeated-finish idempotency, direct table/helper denial and zero public definers. No verification rows remain from that transaction.

Before external verification, all25 report revisions have whole-row hash92ffc939a313f530e7b4814b54deae46 (md5(string_agg(row::text,'|' order by id))). This is a newly recorded checksum method, not the earlier approved-pin evidence hash. Root Firebase HTML remains identical to5e26088.

Fable approved a separate scoped SupabaseEdge email worker for the next stage; the provider key must remain outside pg_net. Automatic email is not enabled by this verification slice. Root is preparing its code independently.
