Nothing was written or changed. Here is the Milestone 4 architecture decision record.

**Model identity:** Claude Fable 5.1, model ID `claude-fable-5-1`, read-only review of feat/saas-milestone-4 at 92cca46. Read: the M4 brief, the PRD billing extract, the Bachs index, all nine migrations, the migration, seal and legacy tests, the SQL script harness, Next auth, proxy, guard, server actions and export routes, README, build guard, the M3 architecture and Sol verification records. Not read: any `.env*`, `.vercel`, auth or credential file.

# Verdict and binding decisions

M4 fits additively in one forward migration plus a `supabase/functions` directory. No sealed migration changes, no formula bump, no change to `build_inputs`, `redact_inputs` or the report RPC, so all 25 baseline snapshots stay byte-identical.

1. **One plan, fail-closed price.** `billing.plans` holds one row `business` with nullable `provider_product_id`, `currency`, `amount_minor`. Checkout refuses with `price_not_configured` while any is null or `active` is false. No USD default is seeded. The row's `label` text is shown verbatim as "Sandbox proposal, not the agreed price" whenever configured in dev.
2. **SAVOUR owns the trial.** `trial_ends_at = workspaces.created_at + 14 days`, set in a replaced `create_workspace` and backfilled for existing workspaces from their real `created_at`. No reset, no fabricated paid period, no Bachs trial feature, no card.
3. **Access is derived, never stored as a state column.** `private.effective_access(ws)` computes the state from the paid-period ledger, grace, trial and suspension, in that precedence. Pending checkout is a display overlay only.
4. **Two mechanical gates enforce everything in SQL.** `private.require_capacity(ws, kind, n)` fails `read_only` or `quota_exceeded`; `private.consume_reservation` never checks either. Every replaced writer calls exactly one of them, so "block new work, allow accepted work" is a property of which helper a path calls.
5. **Lock step 7.** `billing.workspace_billing` row `FOR NO KEY UPDATE`, always taken last by session, directory, membership and invitation writers, and taken alone by payment writers, which take no other lock.
6. **Truth is server reads, events are hints.** One SQL absorber `billing.absorb(kind, obj, source_event)` applies provider objects fetched by the worker. The webhook body only tells the worker which IDs to fetch. Entitlement is never granted from a body or redirect.
7. **Binding is by provider customer created by us.** One Bachs customer per workspace, created with `Idempotency-Key = 'cust:' || workspace_id`, stored before any checkout. An object binds only if its `customer_id` equals a stored workspace customer and the intent reference, product, currency and amount match. Everything else goes to `billing.review_queue` with no entitlement.
8. **Exact money.** Ledger in `bigint` minor units. `billing.to_minor(text, currency)` accepts `^\d+(\.\d{1,E})?$` with E from `billing.currencies` (NGN 2, USD 2), scales via `numeric`, and refuses any residual scale. Equality is integer equality. No float, no FX.
9. **Receiver is a Supabase Edge Function, never a Next route.** `bachs-webhook` with `verify_jwt=false`, HMAC check on the raw body, durable insert, then 2xx. Vercel Preview protection stays `all_except_custom_domains`; the only Preview traffic is the owner's browser on return URLs.
10. **No Bachs secret in Vercel.** All provider calls live in Edge Functions using Supabase secrets. Next calls them with the user's own Supabase JWT via `functions.invoke`. Start-up refuses any key not prefixed `sk_sandbox_` and any base URL other than `https://sandbox-api.bachs.io`.
11. **Two scoped Postgres roles, not service_role.** `billing_intake` executes only `billing.ingest_event`. `billing_worker` executes only claim, absorb, complete, housekeeping and attach functions. Both connect through the pooler with passwords Sol sets out of band. Code must never read the auto-injected service-role variable; a test asserts the functions' source never references it.
12. **Scheduled versus manual is recorded, not claimed.** `pg_cron` plus `pg_net` call `bachs-worker` every five minutes in `process` mode and daily in `reconcile` mode with a token from Vault. The worker records `trigger='cron'` or `'manual'` in `billing.worker_runs`. Only cron rows count as proof of the job path.

# Facts and exact risks in the existing schema

- `private.create_workspace` (`saas/supabase/migrations/20261010202119_m1_core.sql:633`) has no trial concept; it must be replaced, and the backfill must cover the founder's demo workspaces truthfully as trialing.
- Scheduled window expiry has no writer: nothing runs when `closes_at` passes. Reservations therefore cannot be time-released. Reviewable default: reservations are held from `open_session` until `approve_session` or `cancel_session`, since in-review work is still accepted work that reviewers may complete.
- `submit_assessment` (`20261010231001_m2_session_lifecycle.sql:679`) can insert a brand-new assessment on the reviewer amend path. The counting point is the insert branch, regardless of amend, after the idempotent replay return, so retries and edits never count twice.
- `accept_invitation` guest path inserts assignments with `on conflict do nothing` and can replace an expired membership. Reservation inserts must use the same conflict rule, keyed `(session_id, subject_id, user_id)`.
- Legacy `set_assignment` 5-arg and `publish_template` 6-arg delegate to the newer overloads, so only the 6-arg and 7-arg bodies are replaced. Legacy `create_session` opens immediately and is used by `m1_legacy_fixture.sql`; it must reserve.
- The lock-order test (`saas/tests/sql/migration.test.ts:176`) forbids `now()` in `create_finding`, `create_action`, `transition_action` bodies and checks ordering strings in `approve_session`. Replacement bodies must keep those strings; release of unconsumed reservations goes after the snapshot insert.
- `notifications.kind` and the `num_nonnulls` CHECK (`20261011144333_m3_actions_inbox.sql:297`) exclude billing notices. The forward migration drops and re-adds both constraints with `billing_past_due` allowed without an entity, and replaces `render_notification`.
- Trial caps will break existing SQL scripts: `m1_security.sql` creates several locations and six persistent roles. Add `trial_limits jsonb` to `workspace_billing`, defaulted from `billing.trial_defaults()`, adjustable only by the database owner. Each script sets uncapped trial limits in its owner-side fixture after `create_workspace`, labelled "fixture: uncapped trial". Pass counts in `migration.test.ts` change only where assertions are added.
- `legacy.test.ts` treats every file after the M3 prefix as the M3 upgrade and expects labels `savour-m1.1` then `savour-m3.1`; M4 passes as long as snapshots and formula are untouched.
- `workspace_context` is called on every page; it gains an `access` object so banners cost no extra round trip. The `WorkspaceContext` type gains the field.
- Supabase Data API exposes only `public` and `graphql_public`; the `billing` schema is unreachable through PostgREST by construction. The RLS sweep test should be extended to include `billing`.

# Schema, functions and privileges

| Object in `billing` | Columns and constraints |
| --- | --- |
| `currencies` | `code pk`, `exponent int` |
| `plans` | `code pk`, `name`, `interval='month'`, `limits jsonb`, `provider_product_id`, `currency`, `amount_minor bigint`, `active bool`, `label`, `version` |
| `workspace_billing` | `workspace_id pk fk`, `trial_ends_at`, `trial_limits jsonb`, `plan_code`, `provider_customer_id unique`, `provider_subscription_id unique`, `subscription_status_provider`, `status_as_of timestamptz`, `cancel_requested_at`, `cancel_confirmed_at`, `cancel_at_period_end bool`, `past_due_invoice_id`, `past_due_since`, `suspended_at/reason/by`, `version`, `updated_at` |
| `checkout_intents` | `id`, `workspace_id`, `owner_id`, `plan_code`, `currency`, `amount_minor`, `provider_product_id`, `reference unique`, `provider_checkout_id unique`, `status check in (created, redirected, completed_unpaid, paid, expired, failed, mismatch, abandoned)`, `version`, timestamps. Partial unique `(workspace_id) where status in (created, redirected)` |
| `paid_periods` | `id`, `workspace_id`, `provider_subscription_id`, `provider_invoice_id unique`, `provider_payment_id unique`, `amount_minor`, `currency`, `period_start`, `period_end`, `verified_at`, `source_event_id`, `refunded_minor default 0`, `review_flag`, `revoked_at`, `revoke_reason` |
| `webhook_inbox` | `event_id pk`, `type`, `provider_created_at`, `organization_id`, `raw_body text`, `body_sha256`, `signature_meta jsonb`, `received_at`, `status check in (pending, processing, done, failed, dead, ignored)`, `attempts`, `next_attempt_at`, `locked_at`, `locked_by`, `last_error`, `processed_at` |
| `assessment_reservations` | `(session_id, subject_id, user_id) pk`, `workspace_id`, `state check in (reserved, consumed, released)`, `reserved_at`, `consumed_at`, `released_at` |
| `review_queue` | `id`, `workspace_id null`, `kind`, `provider_ids jsonb`, `detail jsonb`, `created_at`, `resolved_at` |
| `worker_runs` | `id`, `mode`, `trigger`, `started_at`, `finished_at`, `claimed`, `done`, `failed`, `error` |

All tables: RLS enabled with no policies, no grants to `anon`, `authenticated` or the two roles. Keep-workspace trigger on rows with `workspace_id`. Insert-only trigger on `paid_periods` except `refunded_minor`, `review_flag`, `revoked_at`, `revoke_reason`. Backfill: one `workspace_billing` row per workspace; reservations for every non-sample session with status open or in_review as `reserved`, or `consumed` where a submitted assessment exists; approved and cancelled sessions get `consumed` rows for submitted assessments only. Existing over-cap data is never deleted; caps bite only on new creation.

| Function | Role | Checks |
| --- | --- | --- |
| `private.effective_access(ws)` | internal | Precedence: suspended; verified unrevoked period containing now, with `cancel_scheduled` when cancel confirmed; `past_due` only if a prior paid period exists and now < `past_due_since + 7 days`; trialing; else read_only. Returns state, mode, limits, usage with percent, `trial_ends_at`, `paid_through`, `grace_ends_at`, `pending_checkout`, timezone |
| `private.lock_billing(ws)` | internal | Step 7 row lock |
| `private.require_capacity(ws, kind, n)` | internal | kinds `location`, `subject`, `staff`, `assessment`; samples exempt from counts |
| `private.reserve/consume/release` | internal | Idempotent on the composite key |
| `public.get_billing(ws)` | member read, owner detail | Owner sees intents, periods, cancel state; others get the access summary |
| `public.create_checkout_intent(ws)` | owner | Fails `price_not_configured`, `subscription_exists`, `checkout_in_progress`; persists intent with reference before any provider call; audited |
| `public.request_cancellation(ws, expected_version)` | owner | Sets `cancel_requested_at`; confirmation only through absorb |
| `billing.ingest_event(...)` | `billing_intake` | `on conflict (event_id) do nothing`; same id with different `body_sha256` returns `collision` and queues review |
| `billing.claim_events(worker, limit)` | `billing_worker` | `for update skip locked`, `next_attempt_at <= clock_timestamp()` |
| `billing.absorb(kind, obj, source)` | `billing_worker` | Binding, exact amount, product, currency, period, status; never grants on a body |
| `billing.complete_event(id, outcome, error)` | `billing_worker` | Backoff 1m, 5m, 30m, 2h, 12h; `dead` after eight attempts plus review row |
| `billing.attach_provider_ids(intent, customer, checkout)` | `billing_worker` | Only path that stores provider IDs; never callable by users, so an owner of two businesses cannot cross-attach |
| `billing.housekeeping()` | `billing_worker` | Abandons intents older than 24h, emits day 0, 3, 6 past-due notices with dedupe `billing_past_due:<invoice>:<day>`, lists reconcile candidates |

Replaced via CREATE OR REPLACE with diff comments: `create_workspace`, `workspace_context`, `upsert_location`, `upsert_subject`, `save_subject`, `commit_subject_import`, `publish_template` 7-arg, `create_session`, `create_session_draft`, `open_session`, `set_assignment` 6-arg, `set_roster_subject`, `submit_assessment`, `approve_session`, `cancel_session`, `create_invitation`, `accept_invitation`, `create_finding`, `create_action`, `create_sample_session`, `render_notification`. Read-only blocks every path that calls `require_capacity` or creates a top-level entity; it never blocks reads, exports, `revoke_member`, `revoke_invitation`, security operations, mark-read, outcome, N/A confirmation, close, approve, reopen, waivers, corrections or action transitions.

Absorb rules that matter: a paid period is inserted once per `provider_payment_id`, so duplicates and replays are no-ops. Subscription status fields update only when the object's provider timestamp is newer than `status_as_of`. `past_due_since` is set only when no verified period ends at or after the failed invoice's period end, and is cleared by any later verified period. Full refund revokes only its period; partial refund and dispute creation set `review_flag` without revoking; a lost dispute revokes. A second subscription for an already-active workspace is queued as `duplicate_subscription` and grants nothing. Initial failed payment leaves the intent `failed` and the workspace in its prior state.

# Topology, first slice and acceptance

**Edge Functions** under `saas/supabase/functions/`: `bachs-webhook` (public, raw-body HMAC over `t + '.' + body`, constant-time compare over every `v1`, strict integer timestamp within 300 s before parsing, legacy headers rejected, 400 on bad signature, 500 on DB failure, 200 only after commit, then `EdgeRuntime.waitUntil` nudges the worker as a fast path), `bachs-worker` (bearer worker token, modes process, reconcile, housekeeping), `bachs-checkout`, `bachs-portal`, `bachs-cancel` (verify_jwt, owner assertion runs as the user through PostgREST, provider calls with `Idempotency-Key` from the intent id, portal URL returned to the browser and never stored or logged). Shared pure modules `signature.ts` and `money.ts` are testable in both Vitest and Deno.

**Next** holds the billing page, consent screen with price, currency, interval, tax wording, renewal date, included usage, cancellation and refund terms, the return page that shows "Payment processing" and polls `get_billing` for 60 s, layout banners from `workspace_context.access` including 80 percent warnings and trial end in workspace timezone, and quota error messages in `errors.ts`.

**Development proof** uses `supabase start`, `supabase functions serve bachs-webhook --no-verify-jwt` and the Bachs CLI local forwarder, so the identical receiver code runs locally and in savour-dev. For the Preview demonstration the savour-dev function URL is registered as the sandbox endpoint.

**First slice, needs no keys or price decision:** the forward migration created with `supabase migration new m4_billing`, the SQL script `m4_billing.sql`, pure-TS signature and money tests, Edge Function code with a fake provider adapter, and the billing UI in unconfigured state. Slice two adds live sandbox calls once Sol installs scoped secrets.

**Local contract tests, rolled back on real Postgres:** replay from empty; nine SHA pins plus the 25 baseline hashes before and after; RLS and grant sweep including `billing`; same owner with two businesses cannot read, attach or pay across them; anonymous, member, guest and forged direct RPC attempts grant nothing; absorb rejects wrong amount, currency, product, customer, reference, period and status; unpaid created subscription grants nothing; duplicate and colliding event IDs; out-of-order failed after paid, refund before paid; partial and full refund; dispute; cancel pending versus confirmed; trial caps and 80 percent; reservation reserve, consume once on retry and amend, release on remove, approve and cancel; read-only allows approve and export and blocks open; backfill truthfulness on fixtures; two-connection races by Sol for overlapping checkout intents, reservation versus submission, and worker claims; typecheck, lint, isolated build, root MVP bytes unchanged.

**External sandbox evidence, clearly labelled:** customer created once under retry; checkout success, decline and recovery; portal URL opens; cancel confirmed by absorbed subscription read; webhook resend from the developer portal produces no second period; cron rows in `cron.job_run_details` and `worker_runs` with `trigger='cron'`; owner notices at days 0, 3, 6 with fixture time travel; mobile 390x844 verified by a method that actually changes the DOM width, which the M3 record shows is still open.

# Remaining provider and account unknowns

State these as verification blockers; Opus must not invent field names. Confirm from the official references before slice two:

- NGN recurring card enablement on the account, final currency and price, and who creates the sandbox product.
- Checkout session object: customer parameter, reference or metadata field, linked `subscription` and `payment` ids, status values, expiry.
- Subscription object: status enum, current period fields, `cancel_at_period_end` semantics, whether DELETE cancels immediately or at period end, product and price fields.
- Invoice, payment, refund and dispute objects: amount and currency field names, period fields, links between them, terminal statuses and the lost-dispute indicator.
- Webhook `data` shape, meaning of `organization_id`, exact header casing, per-endpoint secret and rotation, sandbox resend behaviour.
- Customer creation required fields; the owner's email would be sent to Bachs for receipts and needs founder consent.
- Provider recovery retry schedule, to align the 7-day grace and avoid competing charges.
- Portal session response field and TTL; test card numbers for success and decline.