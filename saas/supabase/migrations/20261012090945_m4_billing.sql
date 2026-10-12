-- SAVOUR Milestone 4: Nigeria-first Business subscription (Bachs sandbox), SAVOUR-owned cardless
-- trial, plan limits enforced in SQL, durable signed-webhook inbox, a verified paid-period ledger and a
-- founder-only platform admin registry of provider connections.
--
-- Nothing in the nine sealed migrations changes. No formula bump: build_inputs, redact_inputs and the
-- report RPC are untouched, so every approved snapshot keeps its bytes. Existing rows are never
-- rewritten; the backfill below only adds billing rows next to them.
--
-- Security model
-- * New tables live in schemas billing and platform (neither exposed by the Data API: config.toml
--   exposes only public and graphql_public). RLS is enabled with no policies and nothing is granted on
--   any of their tables, so neither clients nor the scoped roles can read or write a table directly.
-- * User-facing reads/writes follow the M1 pattern: public SECURITY INVOKER wrapper over a private
--   SECURITY DEFINER implementation with search_path='' that resolves auth.uid() to a live membership.
--   Billing details and every billing write are Owner-only; other roles get a minimal access summary.
-- * Platform administration is a separate identity: a row in platform.admins inserted only by the
--   database owner (disposable founder QA). Workspace roles confer nothing there and platform admins
--   gain no workspace membership. Every platform write needs aal2 (TOTP) read from the verified JWT.
-- * Provider-facing entry points are SECURITY DEFINER functions executable only by one NOLOGIN role
--   each (created here without passwords; enabling LOGIN and setting passwords is a deployment step
--   done out of band, never in source):
--     billing_intake   ingest_event and the webhook signing secrets of one connection
--     billing_gateway  owner-initiated checkout / portal / cancellation bookkeeping and admin-started
--                      connection tests (callers already validated the Supabase JWT; SQL re-checks the
--                      live Owner or platform admin by user id)
--     billing_worker   claim/fence/absorb/complete events, reconciliation and housekeeping
--   None of them is service_role and none has table privileges. Provider API keys and webhook secrets
--   live only in Supabase Vault; platform.get_credential / get_webhook_secrets are the only readers.
-- * Every provider identifier is scoped by provider_connection_id; a subscription, intent, payment,
--   customer, failure, tombstone and event stays pinned to the connection it was created under. The
--   platform default connection affects new checkouts only.
-- * Entitlement is never granted from a webhook body, a redirect, metadata or an email. Webhooks are
--   durable hints; the worker fetches the provider objects over authenticated HTTP and absorb_* binds
--   them (customer, intent reference/checkout, subscription, product, currency, exact collected amount,
--   monthly cadence, quantity 1, invoice period) before one paid period is written. Anything else goes
--   to billing.review_queue and grants nothing.
-- * Operator-only (database owner) functions have no grants at all: NGN recurring verification,
--   suspension, review resolution, intent release, price fixtures and the disposable trial override.
--
-- Access (derived on every read, never stored as a state column), precedence:
--   suspended > active (verified, unrevoked paid period containing now; cancel_scheduled when the
--   provider confirmed cancel_at_period_end) > past_due (only after a previously paid period, renewal
--   failure anchored at the failed invoice period start, 7 days, never reset by retries) > trialing
--   (14 days from workspace creation) > read_only.
-- Usage window: the current paid period, the failed renewal period during grace, or the trial; when
-- nothing is current, the last allocation stays in force from its start onward so accepted work
-- completed after expiry is still counted. Assessment usage = reservations consumed inside the window
-- + every outstanding reservation (carried across period boundaries). Samples never reserve.
--
-- Lock order (extends 20261011144333):
--   1. invitation row  2. session row  3. directory advisory lock  4. workspace row
--   5. membership/subject/category/contact rows  6. finding/action rows
--   P. per-payment advisory lock (payment, refund and dispute absorption only; before step 7)
--   7. billing.workspace_billing row FOR NO KEY UPDATE (always the last lock an evidence/directory
--      writer takes; payment writers take only P before it and no public lock at all)
--   8. billing rows of that workspace (reservations, customers, intents, subscriptions, periods) then
--      the webhook_inbox event row (fence), each FOR NO KEY UPDATE.
--   Platform locks (admin writers, connection tests, retirement; never taken by evidence or payment
--   writers): C1. platform.settings row  C2. provider_connections row  C3. connection_tests row
--   C4. billing.plan_prices rows of that connection. Every path takes them in this order and
--   revalidates under them.
-- Event claims run in their own committed transaction with FOR UPDATE SKIP LOCKED; provider HTTP is
-- never called inside a database transaction.

create schema if not exists billing;
revoke all on schema billing from public;
create schema if not exists platform;
revoke all on schema platform from public;

-- ---------------------------------------------------------------------------
-- Scoped roles (NOLOGIN; no passwords in source)
-- ---------------------------------------------------------------------------
do $$
declare r text;
begin
  foreach r in array array['billing_intake', 'billing_gateway', 'billing_worker'] loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('create role %I nologin noinherit', r);
    end if;
  end loop;
end $$;
grant usage on schema billing to billing_intake, billing_gateway, billing_worker;
grant usage on schema platform to billing_intake, billing_gateway, billing_worker;

-- ---------------------------------------------------------------------------
-- Platform: supported-provider registry, connections, admins (founder-only surface)
-- ---------------------------------------------------------------------------
-- The registry is seeded by migration only. A provider without a shipped, tested adapter is listed
-- truthfully as adapter_pending and cannot be connected; nothing here is admin-editable.
create table platform.providers (
  code text primary key check (code in ('bachs', 'paystack', 'stripe')),
  display_name text not null,
  adapter_status text not null check (adapter_status in ('available', 'adapter_pending')),
  adapter_version text,
  environment text not null default 'sandbox' check (environment = 'sandbox'),
  sandbox_base_url text check (sandbox_base_url is null or sandbox_base_url ~ '^https://[a-z0-9.-]+$'),
  key_pattern text,
  capabilities jsonb not null default '{}',
  note text not null,
  check ((adapter_status = 'available') = (adapter_version is not null and sandbox_base_url is not null and key_pattern is not null))
);
insert into platform.providers (code, display_name, adapter_status, adapter_version, sandbox_base_url, key_pattern, capabilities, note) values
  ('bachs', 'Bachs', 'available', 'bachs-v1-2026-10', 'https://sandbox-api.bachs.io', '^sk_sandbox_[A-Za-z0-9_]{16,200}$',
   '{"USD": {"recurring": "documented_standard"}, "NGN": {"recurring": "account_verification_required"}}',
   'Sandbox adapter shipped in Milestone 4. USD card subscriptions are documented as standard by Bachs but not yet verified on this sandbox account; NGN card subscriptions need account-specific enablement.'),
  ('paystack', 'Paystack', 'adapter_pending', null, null, null, '{}',
   'Selected by the founder. No adapter, contract tests or sandbox evidence exist yet; engineering work is required before it can be connected.'),
  ('stripe', 'Stripe', 'adapter_pending', null, null, null, '{}',
   'Selected by the founder. No adapter, contract tests or sandbox evidence exist yet; engineering work is required before it can be connected.');

create table platform.admins (
  user_id uuid primary key,
  environment text not null default 'sandbox' check (environment = 'sandbox'),
  granted_by text not null default current_user,
  granted_at timestamptz not null default now(),
  note text not null check (length(btrim(note)) between 1 and 300),
  revoked_at timestamptz
);

-- One connection = one provider account + its credential and webhook secret versions. Secrets are
-- Vault IDs only; fingerprints are 12 hex characters of SHA-256 (not reversible, not the key).
create table platform.provider_connections (
  id uuid primary key default gen_random_uuid(),
  provider_code text not null references platform.providers (code),
  label text not null check (length(btrim(label)) between 1 and 80),
  status text not null default 'draft' check (status in ('draft', 'tested', 'enabled', 'disabled')),
  accepting_new boolean not null default false,
  credential_secret_id uuid,
  credential_version integer not null default 0,
  credential_fingerprint text check (credential_fingerprint ~ '^[0-9a-f]{12}$'),
  credential_stored_at timestamptz,
  pending_secret_id uuid,
  pending_version integer,
  pending_fingerprint text check (pending_fingerprint ~ '^[0-9a-f]{12}$'),
  previous_secret_id uuid,
  previous_retire_after timestamptz,
  webhook_secret_id uuid,
  webhook_secret_version integer not null default 0,
  webhook_fingerprint text check (webhook_fingerprint ~ '^[0-9a-f]{12}$'),
  previous_webhook_secret_id uuid,
  previous_webhook_valid_until timestamptz,
  expected_organization_id text check (expected_organization_id ~ '^[A-Za-z0-9_]{3,128}$'),
  ngn_recurring_verified_at timestamptz,
  ngn_recurring_evidence text,
  last_test_id uuid,
  last_test_passed_at timestamptz,
  version integer not null default 1,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'enabled' or (credential_secret_id is not null and webhook_secret_id is not null and expected_organization_id is not null)),
  check (accepting_new = false or status = 'enabled'),
  check ((pending_secret_id is null) = (pending_version is null)),
  check ((ngn_recurring_verified_at is null) = (ngn_recurring_evidence is null))
);
create index provider_connections_provider_fk_idx on platform.provider_connections (provider_code);

create table platform.connection_tests (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references platform.provider_connections (id),
  credential_version integer not null,
  -- Snapshot taken when the test starts (under the connection lock). Completion is refused unless the
  -- connection still has exactly this credential, organization and price set.
  credential_secret_id uuid not null,
  expected_organization_id text not null,
  connection_version integer not null,
  prices_fingerprint text not null check (prices_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'running' check (status in ('running', 'passed', 'failed')),
  checks jsonb not null default '{}',
  organization_matched boolean,
  started_by uuid not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  check ((status = 'running') = (finished_at is null))
);
create index connection_tests_conn_idx on platform.connection_tests (connection_id, started_at desc);

create table platform.settings (
  id boolean primary key default true check (id),
  default_connection_id uuid references platform.provider_connections (id),
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
create index settings_default_fk_idx on platform.settings (default_connection_id);
insert into platform.settings default values;

-- Admin audit: actor, aal, action and non-secret before/after values only.
create table platform.admin_audit (
  id bigint generated always as identity primary key,
  actor_id uuid,
  aal text,
  action text not null,
  connection_id uuid,
  credential_version integer,
  fingerprint text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index admin_audit_created_idx on platform.admin_audit (created_at desc);

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------
create table billing.currencies (
  code text primary key check (code in ('NGN', 'USD')),
  exponent smallint not null check (exponent between 0 and 4),
  card_corridor text not null unique
);
insert into billing.currencies (code, exponent, card_corridor) values ('NGN', 2, 'NGN_CARD'), ('USD', 2, 'USD_CARD');

create table billing.plans (
  code text primary key check (code = 'business'),
  name text not null,
  billing_interval text not null check (billing_interval = 'month'),
  interval_count integer not null check (interval_count = 1),
  limits jsonb not null,
  created_at timestamptz not null default now()
);
insert into billing.plans (code, name, billing_interval, interval_count, limits)
values ('business', 'Business', 'month', 1, '{"locations": 3, "subjects": 100, "staff": 10, "assessments": 1000}');

-- One Business plan; prices are per provider connection and currency (product IDs are provider
-- specific). No price exists until a platform admin proposes one and a connection test reads the
-- provider product back with the same currency, amount and monthly cadence; then it is configured.
-- A configured row is immutable; a change retires it and configures the next version, so intents and
-- paid periods keep the exact price they were sold at. recurring_capability gates checkout: USD card
-- subscriptions are documented as standard by Bachs; NGN needs account-specific verification recorded
-- by the database owner from real evidence.
create table billing.plan_prices (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references platform.provider_connections (id),
  plan_code text not null references billing.plans (code),
  currency text not null references billing.currencies (code),
  version integer not null default 1 check (version >= 1),
  status text not null default 'proposed' check (status in ('proposed', 'configured', 'retired', 'rejected')),
  amount_minor bigint not null check (amount_minor > 0),
  provider_product_id text not null check (provider_product_id ~ '^[A-Za-z0-9_]{1,128}$'),
  environment text not null default 'sandbox' check (environment = 'sandbox'),
  recurring_capability text not null check (recurring_capability in ('unverified', 'documented_standard', 'account_verified')),
  recurring_note text,
  label text not null default 'Sandbox proposal for testing. Not an approved commercial price.',
  proposed_by uuid,
  configured_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  unique (connection_id, plan_code, currency, version),
  check ((status in ('configured', 'retired')) = (configured_at is not null) or status = 'rejected'),
  check ((status = 'retired') = (retired_at is not null)),
  check (currency <> 'NGN' or recurring_capability <> 'documented_standard')
);
create unique index plan_prices_one_configured on billing.plan_prices (connection_id, plan_code, currency) where status = 'configured';
create unique index plan_prices_one_proposed on billing.plan_prices (connection_id, plan_code, currency) where status = 'proposed';
create index plan_prices_plan_fk_idx on billing.plan_prices (plan_code);
create index plan_prices_currency_fk_idx on billing.plan_prices (currency);

create function billing.trial_defaults() returns jsonb
language sql immutable set search_path = '' as $$
  select '{"locations": 1, "subjects": 20, "staff": 5, "assessments": 100}'::jsonb
$$;

-- Terms shown on the consent screen. The UI shows the same version string (src/lib/billing.ts) and
-- checkout refuses a consent given to any other version.
create function billing.terms_version() returns text
language sql immutable set search_path = '' as $$ select 'savour-m4-sandbox-terms-1'::text $$;

create function billing.valid_limits(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object'
    and (select count(*) from jsonb_object_keys(p)) = 4
    and coalesce((select bool_and(jsonb_typeof(p -> k) = 'number' and (p ->> k)::numeric = trunc((p ->> k)::numeric)
                   and (p ->> k)::numeric between 0 and 100000000)
        from unnest(array['locations', 'subjects', 'staff', 'assessments']) k), false)
$$;

-- ---------------------------------------------------------------------------
-- Exact money: provider decimal strings <-> integer minor units. No floats, no FX, no mixing.
-- ---------------------------------------------------------------------------
create function billing.to_minor(p_amount text, p_currency text) returns bigint
language plpgsql stable set search_path = '' as $$
declare
  v_exp integer;
  v_frac text;
  v_n numeric;
begin
  select exponent into v_exp from billing.currencies where code = p_currency;
  if v_exp is null then perform private.fail('invalid_currency', coalesce(p_currency, 'null')); end if;
  if p_amount is null or p_amount !~ '^(0|[1-9][0-9]{0,14})(\.[0-9]+)?$' then
    perform private.fail('invalid_amount', 'malformed decimal');
  end if;
  v_frac := substring(p_amount from '\.([0-9]+)$');
  if v_frac is not null and length(v_frac) > v_exp then perform private.fail('invalid_amount', 'out of scale'); end if;
  v_n := p_amount::numeric * power(10::numeric, v_exp);
  if v_n <> trunc(v_n) or v_n > 900000000000000 then perform private.fail('invalid_amount', 'out of range'); end if;
  return v_n::bigint;
end $$;

create function billing.from_minor(p_minor bigint, p_currency text) returns text
language sql stable set search_path = '' as $$
  select to_char(p_minor::numeric / power(10::numeric, c.exponent), 'FM999999999999990' ||
    case when c.exponent > 0 then '.' || repeat('0', c.exponent) else '' end)
  from billing.currencies c where c.code = p_currency
$$;

-- ---------------------------------------------------------------------------
-- Per-workspace billing state
-- ---------------------------------------------------------------------------
create table billing.workspace_billing (
  workspace_id uuid primary key references public.workspaces (id),
  plan_code text not null default 'business' references billing.plans (code),
  trial_started_at timestamptz not null,
  trial_ends_at timestamptz not null,
  trial_limits jsonb not null default billing.trial_defaults() check (billing.valid_limits(trial_limits)),
  limits_source text not null default 'default' check (limits_source in ('default', 'fixture_uncapped')),
  backfilled boolean not null default false,
  -- Pinned by the first verified subscription; never switched by renewal or by a later checkout.
  billing_currency text references billing.currencies (code),
  -- Nominated explicitly by the Owner, distinct across workspaces (provider customers are unique by
  -- email); receives provider receipts and payment-recovery messages.
  billing_email text check (billing_email is null or (billing_email = lower(billing_email) and length(billing_email) <= 254)),
  billing_email_consent_at timestamptz,
  billing_email_consent_by uuid,
  suspended_at timestamptz,
  suspended_reason text check (length(suspended_reason) <= 500),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (trial_ends_at >= trial_started_at),
  check ((billing_email is null) = (billing_email_consent_at is null)),
  check ((suspended_at is null) = (suspended_reason is null))
);
create unique index workspace_billing_email_uq on billing.workspace_billing (billing_email) where billing_email is not null;
create index workspace_billing_plan_fk_idx on billing.workspace_billing (plan_code);
create index workspace_billing_currency_fk_idx on billing.workspace_billing (billing_currency);

-- The provider customer of a workspace on one connection. A provider customer ID binds to exactly one
-- workspace per connection and is never replaced.
create table billing.provider_customers (
  workspace_id uuid not null references public.workspaces (id),
  connection_id uuid not null references platform.provider_connections (id),
  provider_customer_id text check (provider_customer_id ~ '^cust_[A-Za-z0-9_]{1,120}$'),
  billing_email text not null,
  customer_idempotency_key text not null unique,
  requested_at timestamptz not null default now(),
  bound_at timestamptz,
  primary key (workspace_id, connection_id),
  unique (connection_id, provider_customer_id),
  check ((provider_customer_id is null) = (bound_at is null))
);
create index provider_customers_conn_idx on billing.provider_customers (connection_id);

create table billing.checkout_intents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  connection_id uuid not null references platform.provider_connections (id),
  owner_id uuid not null,
  plan_code text not null references billing.plans (code),
  price_id uuid not null references billing.plan_prices (id),
  price_version integer not null,
  currency text not null references billing.currencies (code),
  amount_minor bigint not null check (amount_minor > 0),
  provider_product_id text not null,
  terms_version text not null,
  consented_at timestamptz not null,
  reference text not null unique check (reference ~ '^savour_ck_[0-9a-f]{32}$'),
  idempotency_key text not null unique,
  status text not null default 'created' check (status in ('created', 'requesting', 'open', 'uncertain',
    'completed_unpaid', 'review', 'paid', 'failed', 'expired', 'abandoned', 'mismatch')),
  request_body text check (length(request_body) <= 8192),
  request_started_at timestamptz,
  request_attempts integer not null default 0,
  provider_checkout_id text check (provider_checkout_id ~ '^[A-Za-z0-9_]{1,128}$'),
  checkout_url text check (checkout_url ~ '^https://'),
  checkout_expires_at timestamptz,
  provider_subscription_id text,
  last_error_code text check (length(last_error_code) <= 80),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (workspace_id, id),
  unique (connection_id, provider_checkout_id)
);
-- One pending checkout per workspace, including network-uncertain outcomes and completed checkouts
-- whose payment is not yet verified.
create unique index checkout_intents_one_pending on billing.checkout_intents (workspace_id)
  where status in ('created', 'requesting', 'open', 'uncertain', 'completed_unpaid', 'review');
create index checkout_intents_price_fk_idx on billing.checkout_intents (price_id);
create index checkout_intents_plan_fk_idx on billing.checkout_intents (plan_code);
create index checkout_intents_currency_fk_idx on billing.checkout_intents (currency);
create index checkout_intents_status_idx on billing.checkout_intents (status, updated_at);

create table billing.subscriptions (
  connection_id uuid not null references platform.provider_connections (id),
  provider_subscription_id text not null check (provider_subscription_id ~ '^sub_[A-Za-z0-9_]{1,120}$'),
  workspace_id uuid not null references public.workspaces (id),
  binding text not null check (binding in ('current', 'duplicate', 'ended')),
  intent_id uuid references billing.checkout_intents (id),
  price_id uuid references billing.plan_prices (id),
  provider_product_id text not null,
  currency text not null references billing.currencies (code),
  amount_minor bigint not null check (amount_minor > 0),
  provider_customer_id text not null,
  provider_status text not null check (provider_status in ('trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused')),
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  status_observed_at timestamptz not null,
  cancel_requested_at timestamptz,
  cancel_requested_by uuid,
  facts_sha256 text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (connection_id, provider_subscription_id)
);
create unique index subscriptions_one_current on billing.subscriptions (workspace_id) where binding = 'current';
create index subscriptions_ws_idx on billing.subscriptions (workspace_id);
create index subscriptions_intent_fk_idx on billing.subscriptions (intent_id);
create index subscriptions_price_fk_idx on billing.subscriptions (price_id);
create index subscriptions_currency_fk_idx on billing.subscriptions (currency);

-- Verified paid periods. Insert-only except the refund/dispute/review/revocation columns.
create table billing.paid_periods (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null,
  workspace_id uuid not null references public.workspaces (id),
  provider_subscription_id text not null,
  provider_invoice_id text not null,
  provider_payment_id text not null,
  price_id uuid references billing.plan_prices (id),
  currency text not null references billing.currencies (code),
  amount_minor bigint not null check (amount_minor > 0),
  period_start timestamptz not null,
  period_end timestamptz not null,
  billing_reason text not null check (billing_reason in ('subscription_create', 'subscription_cycle')),
  verified_at timestamptz not null default clock_timestamp(),
  source_event_id text,
  facts_sha256 text not null check (facts_sha256 ~ '^[0-9a-f]{64}$'),
  refund_state text not null default 'none' check (refund_state in ('none', 'partial', 'full')),
  dispute_state text not null default 'none' check (dispute_state in ('none', 'open', 'won', 'lost', 'closed')),
  review_flag boolean not null default false,
  revoked_at timestamptz,
  revoke_reason text,
  unique (connection_id, provider_invoice_id),
  unique (connection_id, provider_payment_id),
  foreign key (connection_id, provider_subscription_id) references billing.subscriptions (connection_id, provider_subscription_id),
  check (period_end > period_start),
  check ((revoked_at is null) = (revoke_reason is null))
);
create index paid_periods_ws_period_idx on billing.paid_periods (workspace_id, period_end desc);
create index paid_periods_sub_fk_idx on billing.paid_periods (connection_id, provider_subscription_id);
create index paid_periods_price_fk_idx on billing.paid_periods (price_id);
create index paid_periods_currency_fk_idx on billing.paid_periods (currency);

-- A payment fully refunded (or lost in dispute, or partially refunded) before its period was
-- verified: a delayed "succeeded" read can never resurrect it.
create table billing.payment_tombstones (
  connection_id uuid not null references platform.provider_connections (id),
  provider_payment_id text not null,
  provider_invoice_id text,
  reason text not null check (reason in ('refunded', 'partially_refunded', 'dispute_lost')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (connection_id, provider_payment_id)
);
create index payment_tombstones_invoice_idx on billing.payment_tombstones (connection_id, provider_invoice_id);

-- Renewal failures, one per subscription period. The grace anchor is the period start of the failed
-- renewal invoice: retries update last_failed_at only, never the anchor.
create table billing.payment_failures (
  connection_id uuid not null,
  provider_subscription_id text not null,
  period_start timestamptz not null,
  workspace_id uuid not null references public.workspaces (id),
  period_end timestamptz,
  provider_invoice_id text,
  first_failed_at timestamptz not null default clock_timestamp(),
  last_failed_at timestamptz not null default clock_timestamp(),
  observations integer not null default 1,
  resolved_at timestamptz,
  primary key (connection_id, provider_subscription_id, period_start),
  foreign key (connection_id, provider_subscription_id) references billing.subscriptions (connection_id, provider_subscription_id)
);
create index payment_failures_ws_idx on billing.payment_failures (workspace_id, period_start);

-- Durable inbox. Raw bytes are stored exactly as signed; a colliding event ID never replaces them.
create table billing.webhook_inbox (
  connection_id uuid not null references platform.provider_connections (id),
  event_id text not null check (event_id ~ '^evt_[A-Za-z0-9_]{1,120}$'),
  event_type text not null check (length(event_type) between 1 and 100),
  provider_created_at timestamptz not null,
  organization_id text not null check (length(organization_id) between 1 and 128),
  raw_body bytea not null check (octet_length(raw_body) between 2 and 262144),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  signature_timestamp bigint not null,
  received_at timestamptz not null default clock_timestamp(),
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed', 'dead', 'ignored', 'quarantined')),
  quarantine_reason text,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  claim_token uuid,
  claimed_by text,
  lease_until timestamptz,
  last_error_code text check (length(last_error_code) <= 80),
  outcome text check (length(outcome) <= 80),
  processed_at timestamptz,
  primary key (connection_id, event_id),
  check ((status = 'processing') = (claim_token is not null and lease_until is not null)),
  check ((status = 'quarantined') = (quarantine_reason is not null))
);
create index webhook_inbox_due_idx on billing.webhook_inbox (connection_id, status, next_attempt_at);

create table billing.inbox_collisions (
  id bigint generated always as identity primary key,
  connection_id uuid not null references platform.provider_connections (id),
  event_id text not null,
  body_sha256 text not null,
  received_at timestamptz not null default clock_timestamp()
);
create index inbox_collisions_event_idx on billing.inbox_collisions (connection_id, event_id);

-- Anything that must not grant automatically. Identifiers and codes only (no provider bodies, no PII).
create table billing.review_queue (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references platform.provider_connections (id),
  workspace_id uuid references public.workspaces (id),
  kind text not null check (kind ~ '^[a-z_]{3,60}$'),
  dedupe_key text not null unique check (length(dedupe_key) <= 300),
  provider_refs jsonb not null default '{}',
  detail jsonb not null default '{}',
  source_event_id text,
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  resolution_note text
);
create index review_queue_ws_idx on billing.review_queue (workspace_id, resolved_at);
create index review_queue_conn_fk_idx on billing.review_queue (connection_id);

create table billing.worker_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid references platform.provider_connections (id),
  mode text not null check (mode in ('process', 'reconcile', 'housekeeping', 'discover')),
  trigger text not null check (trigger in ('cron', 'manual')),
  worker text not null check (length(worker) between 1 and 80),
  credential_version integer,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  claimed integer not null default 0,
  done integer not null default 0,
  failed integer not null default 0,
  error_code text check (length(error_code) <= 80)
);
create index worker_runs_started_idx on billing.worker_runs (started_at desc);
create index worker_runs_conn_fk_idx on billing.worker_runs (connection_id);

-- Missed-payment discovery (no webhook needed). Bachs lists payments newest first with limit/offset
-- only (no date filter), and list items carry no subscription. A bounded, resumable scan records
-- payment IDs page by page (the cursor advances only with the IDs it recorded); a separate fenced
-- queue fetches each payment's full detail. Only payments whose server-read subscription or reference
-- belongs to SAVOUR on this connection are absorbed, with the same strict binding as webhooks; list
-- fields never grant anything. All statuses are scanned (a status filter could shift page membership
-- and skip an item); new payments only push older ones to higher offsets, so a resumed scan can re-read
-- but never skip. Each scan stops at the previous high-water mark minus a 48-hour overlap.
create table billing.payment_discovery_state (
  connection_id uuid primary key references platform.provider_connections (id),
  scan_id uuid,
  scan_offset integer not null default 0 check (scan_offset >= 0),
  scan_floor timestamptz,
  scan_high_water timestamptz,
  scan_started_at timestamptz,
  high_water timestamptz,
  last_completed_at timestamptz,
  pages_read bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  check ((scan_id is null) = (scan_started_at is null))
);

create table billing.discovered_payments (
  connection_id uuid not null references platform.provider_connections (id),
  provider_payment_id text not null check (provider_payment_id ~ '^[A-Za-z0-9_]{1,128}$'),
  list_status text check (length(list_status) <= 40),
  listed_at timestamptz,
  first_seen_at timestamptz not null default clock_timestamp(),
  state text not null default 'pending' check (state in ('pending', 'processing', 'retry', 'absorbed', 'unrelated', 'dead')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  claim_token uuid,
  lease_until timestamptz,
  outcome text check (length(outcome) <= 80),
  last_error_code text check (length(last_error_code) <= 80),
  processed_at timestamptz,
  primary key (connection_id, provider_payment_id),
  check ((state = 'processing') = (claim_token is not null and lease_until is not null))
);
create index discovered_payments_due_idx on billing.discovered_payments (connection_id, state, next_attempt_at);

create table billing.operator_log (
  id bigint generated always as identity primary key,
  action text not null,
  detail jsonb not null default '{}',
  actor text not null default current_user,
  created_at timestamptz not null default clock_timestamp()
);

-- Assessment capacity. One row per (session, subject, assessor): reserved when work is accepted
-- (opening, assigning or restoring while collecting, guest acceptance), consumed exactly once by
-- the first stored submission (retries and edits never count again), released when unused work is
-- removed, approved or cancelled. Consumed rows are never released or deleted.
create table billing.assessment_reservations (
  workspace_id uuid not null,
  session_id uuid not null,
  subject_id uuid not null,
  user_id uuid not null,
  state text not null check (state in ('reserved', 'consumed', 'released')),
  unreserved boolean not null default false,
  backfilled boolean not null default false,
  reserved_at timestamptz,
  consumed_at timestamptz,
  released_at timestamptz,
  primary key (session_id, subject_id, user_id),
  foreign key (workspace_id, session_id) references public.sessions (workspace_id, id),
  check ((state = 'consumed') = (consumed_at is not null)),
  check ((state = 'released') = (released_at is not null))
);
create index assessment_reservations_ws_session_fk_idx on billing.assessment_reservations (workspace_id, session_id);
create index assessment_reservations_usage_idx on billing.assessment_reservations (workspace_id, state, consumed_at);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['checkout_intents', 'subscriptions', 'paid_periods', 'payment_failures', 'assessment_reservations',
    'provider_customers'] loop
    execute format('create trigger %I before update on billing.%I for each row execute function private.keep_workspace_id()',
      t || '_keep_workspace', t);
  end loop;
end $$;

create trigger operator_log_immutable before update or delete on billing.operator_log
  for each row execute function private.forbid_change();
create trigger payment_tombstones_immutable before update or delete on billing.payment_tombstones
  for each row execute function private.forbid_change();
create trigger inbox_collisions_immutable before update or delete on billing.inbox_collisions
  for each row execute function private.forbid_change();
create trigger providers_immutable before update or delete on platform.providers
  for each row execute function private.forbid_change();
create trigger admin_audit_immutable before update or delete on platform.admin_audit
  for each row execute function private.forbid_change();

create function billing.guard_row() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'immutable_record' using detail = tg_table_name; end if;
  if tg_table_name = 'paid_periods' then
    if (to_jsonb(new) - array['refund_state', 'dispute_state', 'review_flag', 'revoked_at', 'revoke_reason'])
       is distinct from (to_jsonb(old) - array['refund_state', 'dispute_state', 'review_flag', 'revoked_at', 'revoke_reason'])
       or (old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at) then
      raise exception 'immutable_record' using detail = 'paid_periods';
    end if;
  elsif tg_table_name = 'checkout_intents' then
    if (new.workspace_id, new.connection_id, new.owner_id, new.plan_code, new.price_id, new.price_version, new.currency, new.amount_minor,
        new.provider_product_id, new.terms_version, new.consented_at, new.reference, new.idempotency_key)
       is distinct from (old.workspace_id, old.connection_id, old.owner_id, old.plan_code, old.price_id, old.price_version, old.currency,
        old.amount_minor, old.provider_product_id, old.terms_version, old.consented_at, old.reference, old.idempotency_key)
       or (old.provider_checkout_id is not null and new.provider_checkout_id is distinct from old.provider_checkout_id)
       or (old.request_body is not null and new.request_body is distinct from old.request_body) then
      raise exception 'immutable_record' using detail = 'checkout_intents';
    end if;
  elsif tg_table_name = 'subscriptions' then
    if (new.connection_id, new.provider_subscription_id, new.workspace_id, new.intent_id, new.price_id, new.provider_product_id,
        new.currency, new.amount_minor, new.provider_customer_id)
       is distinct from (old.connection_id, old.provider_subscription_id, old.workspace_id, old.intent_id, old.price_id,
        old.provider_product_id, old.currency, old.amount_minor, old.provider_customer_id) then
      raise exception 'immutable_record' using detail = 'subscriptions';
    end if;
  elsif tg_table_name = 'webhook_inbox' then
    if (new.connection_id, new.event_id, new.event_type, new.provider_created_at, new.organization_id, new.raw_body, new.body_sha256,
        new.signature_timestamp)
       is distinct from (old.connection_id, old.event_id, old.event_type, old.provider_created_at, old.organization_id, old.raw_body,
        old.body_sha256, old.signature_timestamp) then
      raise exception 'immutable_record' using detail = 'webhook_inbox';
    end if;
  elsif tg_table_name = 'plan_prices' then
    if old.status in ('retired', 'rejected')
       or (to_jsonb(new) - array['status', 'retired_at', 'configured_at', 'recurring_capability', 'recurring_note'])
          is distinct from (to_jsonb(old) - array['status', 'retired_at', 'configured_at', 'recurring_capability', 'recurring_note'])
       or (old.status = 'configured' and (new.status not in ('configured', 'retired') or new.configured_at is distinct from old.configured_at))
       or (old.status = 'proposed' and new.status not in ('proposed', 'configured', 'rejected')) then
      raise exception 'immutable_record' using detail = 'plan_prices';
    end if;
  elsif tg_table_name = 'workspace_billing' then
    if new.trial_started_at is distinct from old.trial_started_at
       or (old.billing_currency is not null and new.billing_currency is distinct from old.billing_currency) then
      raise exception 'immutable_record' using detail = 'workspace_billing';
    end if;
  elsif tg_table_name = 'provider_customers' then
    if new.connection_id is distinct from old.connection_id or new.customer_idempotency_key is distinct from old.customer_idempotency_key
       or (old.provider_customer_id is not null and (new.provider_customer_id is distinct from old.provider_customer_id
         or new.billing_email is distinct from old.billing_email)) then
      raise exception 'immutable_record' using detail = 'provider_customers';
    end if;
  elsif tg_table_name = 'assessment_reservations' then
    if old.state = 'consumed' and (new.state <> 'consumed' or new.consumed_at is distinct from old.consumed_at) then
      raise exception 'immutable_record' using detail = 'assessment_reservations';
    end if;
  elsif tg_table_name = 'connection_tests' then
    if old.status <> 'running' or (new.connection_id, new.credential_version, new.started_by, new.started_at, new.credential_secret_id,
        new.expected_organization_id, new.connection_version, new.prices_fingerprint)
       is distinct from (old.connection_id, old.credential_version, old.started_by, old.started_at, old.credential_secret_id,
        old.expected_organization_id, old.connection_version, old.prices_fingerprint) then
      raise exception 'immutable_record' using detail = 'connection_tests';
    end if;
  elsif tg_table_name = 'provider_connections' then
    if new.provider_code is distinct from old.provider_code or new.created_by is distinct from old.created_by then
      raise exception 'immutable_record' using detail = 'provider_connections';
    end if;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['paid_periods', 'checkout_intents', 'subscriptions', 'webhook_inbox', 'plan_prices',
    'workspace_billing', 'assessment_reservations', 'provider_customers'] loop
    execute format('create trigger %I before update or delete on billing.%I for each row execute function billing.guard_row()',
      t || '_guard', t);
  end loop;
  foreach t in array array['connection_tests', 'provider_connections'] loop
    execute format('create trigger %I before update or delete on platform.%I for each row execute function billing.guard_row()',
      t || '_guard', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Access derivation
-- ---------------------------------------------------------------------------
create function private.valid_period(p billing.paid_periods) returns boolean
language sql immutable set search_path = '' as $$
  select p.revoked_at is null and p.refund_state <> 'full' and p.dispute_state <> 'lost'
$$;

-- State, usage window and limits without usage counts (cheap; used by require_writable).
create function private.billing_core(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_b billing.workspace_billing;
  v_plan jsonb;
  v_now timestamptz := now();
  v_cur billing.paid_periods;
  v_last billing.paid_periods;
  v_fail billing.payment_failures;
  v_sub billing.subscriptions;
  v_state text;
  v_start timestamptz;
  v_end timestamptz;
  v_limits jsonb;
  v_grace_end timestamptz;
  v_last_kind text;
begin
  select * into v_b from billing.workspace_billing where workspace_id = p_ws;
  if not found then return null; end if;
  select limits into v_plan from billing.plans where code = v_b.plan_code;
  select * into v_sub from billing.subscriptions where workspace_id = p_ws and binding = 'current';
  select * into v_cur from billing.paid_periods p where p.workspace_id = p_ws and private.valid_period(p)
    and p.period_start <= v_now and v_now < p.period_end order by p.period_end desc limit 1;
  select * into v_last from billing.paid_periods p where p.workspace_id = p_ws and private.valid_period(p)
    and p.period_start <= v_now order by p.period_end desc limit 1;

  if v_cur.id is not null then
    v_state := case when v_sub.provider_subscription_id = v_cur.provider_subscription_id and v_sub.connection_id = v_cur.connection_id
      and v_sub.cancel_at_period_end
      then 'cancel_scheduled' else 'active' end;
    v_start := v_cur.period_start; v_end := v_cur.period_end; v_limits := v_plan;
  elsif v_last.id is not null then
    -- Renewal failure right after the previously paid period of the same subscription.
    select * into v_fail from billing.payment_failures f
    where f.connection_id = v_last.connection_id and f.provider_subscription_id = v_last.provider_subscription_id and f.resolved_at is null
      and f.period_start >= v_last.period_start + interval '1 day' and f.period_start <= v_last.period_end + interval '1 day'
      and f.period_start <= v_now
    order by f.period_start limit 1;
    if v_fail.provider_subscription_id is not null then
      v_grace_end := v_fail.period_start + interval '7 days';
      if v_now < v_grace_end then
        v_state := 'past_due';
        v_start := v_fail.period_start; v_end := coalesce(v_fail.period_end, v_fail.period_start + interval '1 month');
        v_limits := v_plan;
      end if;
    end if;
  end if;

  if v_state is null and v_now < v_b.trial_ends_at then
    v_state := 'trialing'; v_start := v_b.trial_started_at; v_end := v_b.trial_ends_at; v_limits := v_b.trial_limits;
  end if;

  if v_state is null then
    -- The last allocation stays in force from its start onward (open-ended), so accepted work
    -- completed after expiry is still counted against it.
    v_state := 'read_only'; v_end := null;
    v_start := v_b.trial_started_at; v_limits := v_b.trial_limits; v_last_kind := 'trial';
    -- Once a business has paid, its last allocation is the paid one (the trial is history).
    if v_last.id is not null then
      v_start := v_last.period_start; v_limits := v_plan; v_last_kind := 'paid';
      if v_fail.provider_subscription_id is not null then v_start := v_fail.period_start; v_last_kind := 'grace'; end if;
    end if;
  end if;

  return jsonb_build_object(
    'state', case when v_b.suspended_at is not null then 'suspended' else v_state end,
    'underlying_state', v_state,
    'writable', v_b.suspended_at is null and v_state in ('trialing', 'active', 'cancel_scheduled', 'past_due'),
    'window_start', v_start, 'window_end', v_end, 'last_allocation', v_last_kind,
    'limits', v_limits, 'limits_source', case when v_limits = v_b.trial_limits then v_b.limits_source else 'plan' end,
    'trial_started_at', v_b.trial_started_at, 'trial_ends_at', v_b.trial_ends_at,
    'paid_through', coalesce(v_cur.period_end, v_last.period_end),
    'grace_ends_at', case when v_state = 'past_due' then v_grace_end end,
    'grace_anchor', case when v_state = 'past_due' then v_fail.period_start end,
    'subscription_currency', v_sub.currency,
    'cancel_at_period_end', coalesce(v_sub.cancel_at_period_end, false),
    'suspended', v_b.suspended_at is not null);
end $$;

create function private.billing_usage(p_ws uuid, p_window_start timestamptz, p_window_end timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'locations', (select count(*) from public.locations where workspace_id = p_ws and archived_at is null),
    'subjects', (select count(*) from public.subjects where workspace_id = p_ws and archived_at is null and not is_sample),
    'staff', (select count(*) from public.memberships where workspace_id = p_ws and status = 'active' and role <> 'guest'
                and (expires_at is null or expires_at > now()))
           + (select count(*) from public.invitations where workspace_id = p_ws and role <> 'guest' and accepted_at is null
                and revoked_at is null and expires_at > now()),
    'assessments', (select count(*) from billing.assessment_reservations r where r.workspace_id = p_ws
      and (r.state = 'reserved' or (r.state = 'consumed' and r.consumed_at >= p_window_start
        and (p_window_end is null or r.consumed_at < p_window_end)))))
$$;

create function private.effective_access(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_core jsonb := private.billing_core(p_ws);
  v_usage jsonb;
  v_pct jsonb := '{}';
  k text;
  v_lim numeric;
  v_use numeric;
  v_warn text[] := '{}';
  v_full text[] := '{}';
begin
  if v_core is null then return null; end if;
  v_usage := private.billing_usage(p_ws, (v_core ->> 'window_start')::timestamptz, (v_core ->> 'window_end')::timestamptz);
  foreach k in array array['locations', 'subjects', 'staff', 'assessments'] loop
    v_lim := (v_core -> 'limits' ->> k)::numeric;
    v_use := (v_usage ->> k)::numeric;
    v_pct := v_pct || jsonb_build_object(k, case when v_lim > 0 then floor(v_use * 100 / v_lim) else 100 end);
    if v_use >= v_lim then v_full := v_full || k;
    elsif v_lim > 0 and v_use * 100 >= v_lim * 80 then v_warn := v_warn || k;
    end if;
  end loop;
  return v_core || jsonb_build_object('usage', v_usage, 'percent', v_pct, 'warnings', to_jsonb(v_warn),
    'at_limit', to_jsonb(v_full),
    'pending_checkout', exists (select 1 from billing.checkout_intents i where i.workspace_id = p_ws
      and i.status in ('created', 'requesting', 'open', 'uncertain', 'completed_unpaid', 'review')),
    'timezone', (select timezone from public.workspaces where id = p_ws));
end $$;

-- Role-aware summary for every page (workspace_context). Guests get nothing; non-managers get the
-- state only; admins also get usage (they manage capacity); owners also get billing timing.
create function private.access_summary(p_ws uuid, p_role public.member_role) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  if p_role is null or p_role = 'guest' then return null; end if;
  if p_role not in ('owner', 'admin') then
    v := private.billing_core(p_ws);
    return case when v is null then null else jsonb_build_object('state', v ->> 'state', 'writable', (v ->> 'writable')::boolean) end;
  end if;
  v := private.effective_access(p_ws);
  if v is null then return null; end if;
  if p_role = 'admin' then
    return jsonb_build_object('state', v ->> 'state', 'writable', (v ->> 'writable')::boolean, 'limits', v -> 'limits',
      'usage', v -> 'usage', 'percent', v -> 'percent', 'warnings', v -> 'warnings', 'at_limit', v -> 'at_limit',
      'trial_ends_at', v -> 'trial_ends_at', 'timezone', v -> 'timezone');
  end if;
  return jsonb_build_object('state', v ->> 'state', 'writable', (v ->> 'writable')::boolean, 'limits', v -> 'limits',
    'usage', v -> 'usage', 'percent', v -> 'percent', 'warnings', v -> 'warnings', 'at_limit', v -> 'at_limit',
    'trial_ends_at', v -> 'trial_ends_at', 'paid_through', v -> 'paid_through', 'grace_ends_at', v -> 'grace_ends_at',
    'cancel_at_period_end', v -> 'cancel_at_period_end', 'pending_checkout', v -> 'pending_checkout',
    'timezone', v -> 'timezone', 'billing', true);
end $$;

-- ---------------------------------------------------------------------------
-- Gates (the only two ways a writer touches capacity)
-- ---------------------------------------------------------------------------
create function private.lock_billing(p_ws uuid) returns billing.workspace_billing
language plpgsql security definer set search_path = '' as $$
declare v billing.workspace_billing;
begin
  select * into v from billing.workspace_billing where workspace_id = p_ws for no key update;
  if not found then perform private.fail('billing_not_initialized'); end if;
  return v;
end $$;

-- New work needs a writable workspace (trialing, active, cancel scheduled, or in grace; not
-- suspended). No lock: it adds nothing that is counted.
create function private.require_writable(p_ws uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v jsonb := private.billing_core(p_ws);
begin
  if v is null then perform private.fail('billing_not_initialized'); end if;
  if (v ->> 'state') = 'suspended' then perform private.fail('workspace_suspended'); end if;
  if not (v ->> 'writable')::boolean then perform private.fail('read_only', v ->> 'state'); end if;
end $$;

-- Count-increasing work: takes the billing row lock (step 7) so concurrent writers serialize, then
-- checks write access and the limit for one kind. Samples are never counted.
create function private.require_capacity(p_ws uuid, p_kind text, p_n integer) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v jsonb;
  v_lim integer;
  v_use integer;
begin
  if p_kind not in ('locations', 'subjects', 'staff', 'assessments') or p_n is null or p_n < 0 then
    perform private.fail('invalid_capacity_request');
  end if;
  perform private.lock_billing(p_ws);
  v := private.effective_access(p_ws);
  if (v ->> 'state') = 'suspended' then perform private.fail('workspace_suspended'); end if;
  if not (v ->> 'writable')::boolean then perform private.fail('read_only', v ->> 'state'); end if;
  v_lim := (v -> 'limits' ->> p_kind)::integer;
  v_use := (v -> 'usage' ->> p_kind)::integer;
  if p_n > 0 and v_use + p_n > v_lim then
    perform private.fail('quota_exceeded', format('%s: %s in use of %s, %s more requested', p_kind, v_use, v_lim, p_n));
  end if;
end $$;

-- Reserve every accepted assignment of a collecting (open/in_review) real session that has no live
-- or consumed reservation yet. Capacity is checked for exactly the new rows; an exact duplicate
-- retry reserves nothing. Never called for drafts or samples.
create function private.reserve_session_work(p_session uuid, p_subject uuid default null, p_user uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions;
  v_n integer;
begin
  select * into v_s from public.sessions where id = p_session;
  if v_s.is_sample or v_s.status not in ('open', 'in_review') then return 0; end if;
  select count(*) into v_n
  from public.session_assignments a
  join public.session_subjects ss on ss.session_id = a.session_id and ss.subject_id = a.subject_id and ss.removed_at is null
  left join billing.assessment_reservations r on r.session_id = a.session_id and r.subject_id = a.subject_id and r.user_id = a.user_id
  where a.session_id = p_session and (p_subject is null or a.subject_id = p_subject) and (p_user is null or a.user_id = p_user)
    and (r.state is null or r.state = 'released');
  if v_n = 0 then return 0; end if;
  perform private.require_capacity(v_s.workspace_id, 'assessments', v_n);
  insert into billing.assessment_reservations (workspace_id, session_id, subject_id, user_id, state, reserved_at)
  select v_s.workspace_id, a.session_id, a.subject_id, a.user_id, 'reserved', now()
  from public.session_assignments a
  join public.session_subjects ss on ss.session_id = a.session_id and ss.subject_id = a.subject_id and ss.removed_at is null
  where a.session_id = p_session and (p_subject is null or a.subject_id = p_subject) and (p_user is null or a.user_id = p_user)
  on conflict (session_id, subject_id, user_id) do update set state = 'reserved', reserved_at = now(), released_at = null
    where billing.assessment_reservations.state = 'released';
  return v_n;
end $$;

-- Releases unused reservations only; consumed accounting is never touched.
create function private.release_session_work(p_session uuid, p_subject uuid default null, p_user uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  update billing.assessment_reservations set state = 'released', released_at = now()
  where session_id = p_session and state = 'reserved'
    and (p_subject is null or subject_id = p_subject) and (p_user is null or user_id = p_user);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- The first stored submission consumes its reservation. Never checks capacity or write access:
-- completing accepted work is always allowed. Without a live reservation the only accepted case is a
-- reviewer amendment on a session that already has an approved revision (a correction of reported
-- evidence after the reservation was released at approval); it is recorded consumed and unreserved.
-- Anything else (no accepted reservation) is refused, so no path creates unaccounted initial work.
create function private.consume_assessment(p_ws uuid, p_session uuid, p_subject uuid, p_user uuid, p_amend boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_state text;
begin
  if (select is_sample from public.sessions where id = p_session) then return; end if;
  select state into v_state from billing.assessment_reservations
  where session_id = p_session and subject_id = p_subject and user_id = p_user for no key update;
  if v_state = 'reserved' then
    update billing.assessment_reservations set state = 'consumed', consumed_at = now()
    where session_id = p_session and subject_id = p_subject and user_id = p_user;
    return;
  end if;
  if v_state = 'consumed' then return; end if;
  if not (coalesce(p_amend, false) and exists (select 1 from public.report_revisions r where r.session_id = p_session)) then
    perform private.fail('assessment_not_reserved');
  end if;
  insert into billing.assessment_reservations (workspace_id, session_id, subject_id, user_id, state, unreserved, consumed_at)
  values (p_ws, p_session, p_subject, p_user, 'consumed', true, now())
  on conflict (session_id, subject_id, user_id) do update set state = 'consumed', consumed_at = now(), unreserved = true,
    released_at = null where billing.assessment_reservations.state = 'released';
end $$;

-- ---------------------------------------------------------------------------
-- Backfill (historical rows are read, never rewritten)
-- ---------------------------------------------------------------------------
-- Every existing workspace gets its truthful trial from its real creation time (default trial
-- limits; existing data over a limit is kept, only new creation is blocked). No paid period is
-- fabricated. Existing assessments in real sessions are consumed at their original first
-- submission time; other accepted assignments of open/in-review real sessions are reserved.
insert into billing.workspace_billing (workspace_id, trial_started_at, trial_ends_at, backfilled)
select w.id, w.created_at, w.created_at + interval '14 days', true from public.workspaces w
on conflict (workspace_id) do nothing;

insert into billing.assessment_reservations (workspace_id, session_id, subject_id, user_id, state, backfilled, consumed_at)
select a.workspace_id, a.session_id, a.subject_id, a.assessor_id, 'consumed', true,
  coalesce((select min(e.created_at) from public.assessment_events e where e.assessment_id = a.id and e.kind in ('submit', 'amend')),
    a.updated_at)
from public.assessments a join public.sessions s on s.id = a.session_id
where not s.is_sample
on conflict do nothing;

insert into billing.assessment_reservations (workspace_id, session_id, subject_id, user_id, state, backfilled, reserved_at)
select a.workspace_id, a.session_id, a.subject_id, a.user_id, 'reserved', true, now()
from public.session_assignments a
join public.sessions s on s.id = a.session_id
join public.session_subjects ss on ss.session_id = a.session_id and ss.subject_id = a.subject_id and ss.removed_at is null
where not s.is_sample and s.status in ('open', 'in_review')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Replaced writers. Each body is the latest sealed version with only the marked billing lines added.
-- ---------------------------------------------------------------------------
-- Diff from 20261010202119_m1_core.sql: inserts the workspace's billing row with the SAVOUR trial
-- (14 days from creation, default trial limits) and audits it. The creator is the Owner.
create or replace function private.create_workspace(p_name text, p_country text, p_timezone text, p_display_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_email text;
  v_ws uuid;
  v_created timestamptz;
begin
  select u.email into v_email from auth.users u where u.id = v_uid and u.email_confirmed_at is not null;
  if v_email is null then perform private.fail('email_not_verified'); end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    perform private.fail('invalid_timezone', p_timezone);
  end if;
  insert into public.workspaces (name, country, timezone, created_by)
  values (btrim(p_name), btrim(p_country), p_timezone, v_uid) returning id, created_at into v_ws, v_created;
  insert into public.memberships (workspace_id, user_id, role, display_name, email, all_locations)
  values (v_ws, v_uid, 'owner', btrim(p_display_name), lower(v_email), true);
  perform private.audit(v_ws, 'workspace.created', v_ws, jsonb_build_object('name', btrim(p_name)));
  -- M4: SAVOUR-owned cardless trial.
  insert into billing.workspace_billing (workspace_id, trial_started_at, trial_ends_at)
  values (v_ws, v_created, v_created + interval '14 days');
  perform private.audit(v_ws, 'billing.trial_started', v_ws, jsonb_build_object('trial_ends_at', v_created + interval '14 days'));
  return v_ws;
end $$;

-- Diff from m1_core: adds "access" (role-aware billing summary) so banners need no extra request.
create or replace function private.workspace_context(p_ws uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'workspace', jsonb_build_object('id', w.id, 'name', w.name, 'country', w.country, 'timezone', w.timezone),
    'role', m.role, 'display_name', m.display_name, 'all_locations', m.all_locations,
    'guest_session_id', m.guest_session_id,
    'location_ids', coalesce((select jsonb_agg(ml.location_id) from public.membership_locations ml
                              where ml.membership_id = m.id), '[]'),
    'aal', coalesce((select auth.jwt()) ->> 'aal', 'aal1'),
    'access', private.access_summary(w.id, m.role))
  from public.workspaces w
  join lateral (select * from private.active_membership(p_ws)) m on m.id is not null
  where w.id = p_ws
$$;

-- Diff from 20261010230959_m2_directory.sql: a new or reactivated location needs location capacity;
-- any other edit needs write access, except a pure archive (same name, archived) which is an allowed
-- reduction for a read-only workspace.
create or replace function private.upsert_location(p_ws uuid, p_id uuid, p_name text, p_archived boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_l public.locations;
begin
  perform private.lock_directory(p_ws);
  if p_id is null then
    perform private.require_capacity(p_ws, 'locations', 1);  -- M4
    insert into public.locations (workspace_id, name) values (p_ws, btrim(p_name)) returning id into v_id;
  else
    -- M4: archive-to-active counts like a new location; renames need write access.
    select * into v_l from public.locations where id = p_id and workspace_id = p_ws;
    if v_l.archived_at is not null and not coalesce(p_archived, false) then
      perform private.require_capacity(p_ws, 'locations', 1);
    elsif not (coalesce(p_archived, false) and v_l.name is not distinct from btrim(p_name)) then
      perform private.require_writable(p_ws);
    end if;
    update public.locations set name = btrim(p_name),
      archived_at = case when p_archived then coalesce(archived_at, now()) end
    where id = p_id and workspace_id = p_ws returning id into v_id;
    if v_id is null then perform private.fail('not_found', 'location'); end if;
  end if;
  perform private.audit(p_ws, 'location.saved', v_id, jsonb_build_object('name', btrim(p_name), 'archived', p_archived));
  return v_id;
end $$;

-- Diff from 20261010230959_m2_directory.sql: a new or reactivated (non-sample) subject needs subject capacity;
-- other edits need write access except a pure archive (same name and type).
create or replace function private.upsert_subject(p_ws uuid, p_id uuid, p_name text, p_type public.subject_type, p_archived boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_x public.subjects;
begin
  perform private.lock_directory(p_ws);
  if p_id is null then
    perform private.require_capacity(p_ws, 'subjects', 1);  -- M4
    insert into public.subjects (workspace_id, name, subject_type)
    values (p_ws, btrim(p_name), p_type) returning id into v_id;
  else
    -- M4: reactivation counts (samples never count); other edits need write access except a pure archive.
    select * into v_x from public.subjects where id = p_id and workspace_id = p_ws;
    if v_x.archived_at is not null and not coalesce(p_archived, false) then
      perform private.require_capacity(p_ws, 'subjects', case when v_x.is_sample then 0 else 1 end);
    elsif not (coalesce(p_archived, false) and v_x.name is not distinct from btrim(p_name) and v_x.subject_type is not distinct from p_type) then
      perform private.require_writable(p_ws);
    end if;
    update public.subjects set name = btrim(p_name), subject_type = p_type,
      archived_at = case when p_archived then coalesce(archived_at, now()) end, version = version + 1
    where id = p_id and workspace_id = p_ws returning id into v_id;
    if v_id is null then perform private.fail('not_found', 'subject'); end if;
  end if;
  perform private.audit(p_ws, 'subject.saved', v_id, jsonb_build_object('name', btrim(p_name), 'archived', p_archived));
  return v_id;
end $$;

-- Diff from 20261010230959_m2_directory.sql: creating an active subject or reactivating an archived
-- one needs subject capacity; creating an archived subject or editing needs write access.
create or replace function private.save_subject(p_ws uuid, p_id uuid, p_name text, p_type public.subject_type,
  p_category uuid, p_external_id text, p_location_ids uuid[], p_archived boolean, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name text := private.clean_text(p_name);
  v_ext text := private.clean_text(p_external_id);
  v_locs uuid[] := array(select distinct unnest(coalesce(p_location_ids, '{}')));
  v_s public.subjects;
begin
  perform private.lock_directory(p_ws);
  if v_name is null or length(v_name) > 120 or v_name ~ '[[:cntrl:]]' then perform private.fail('invalid_name'); end if;
  if p_type is null then perform private.fail('invalid_type'); end if;
  if v_ext is not null and (length(v_ext) > 64 or v_ext ~ '[[:cntrl:]]') then perform private.fail('invalid_external_id'); end if;
  if p_id is not null then
    select * into v_s from public.subjects where id = p_id and workspace_id = p_ws for no key update;
    if not found then perform private.fail('not_found', 'subject'); end if;
    if p_expected_version is null or v_s.version <> p_expected_version then perform private.fail('stale_version'); end if;
  end if;
  if p_category is not null and not exists (select 1 from public.categories c where c.id = p_category
      and c.workspace_id = p_ws and (c.archived_at is null or c.id is not distinct from v_s.category_id)) then
    perform private.fail('not_found', 'category');
  end if;
  if (select count(*) from public.locations l where l.workspace_id = p_ws and l.id = any (v_locs)
      and (l.archived_at is null or exists (select 1 from public.subject_locations x
                                            where x.subject_id = p_id and x.location_id = l.id)))
     <> cardinality(v_locs) then
    perform private.fail('not_found', 'location');
  end if;
  if v_ext is not null and exists (select 1 from public.subjects x where x.workspace_id = p_ws
      and lower(x.external_id) = lower(v_ext) and x.id is distinct from p_id) then
    perform private.fail('duplicate_external_id', v_ext);
  end if;
  -- Never create a second subject under an existing name (legacy duplicates are left alone).
  if (p_id is null or private.norm_name(v_s.name) <> private.norm_name(v_name))
     and exists (select 1 from public.subjects x where x.workspace_id = p_ws
                 and private.norm_name(x.name) = private.norm_name(v_name) and x.id is distinct from p_id) then
    perform private.fail('duplicate_name', v_name);
  end if;
  -- M4: capacity for a new active subject or an archive-to-active change; write access for any other
  -- creation or edit. Only a pure archive (every field and location link unchanged) is allowed read-only.
  if p_id is null then
    perform private.require_capacity(p_ws, 'subjects', case when coalesce(p_archived, false) then 0 else 1 end);
  elsif v_s.archived_at is not null and not coalesce(p_archived, false) then
    perform private.require_capacity(p_ws, 'subjects', case when v_s.is_sample then 0 else 1 end);
  elsif not (coalesce(p_archived, false) and v_s.name = v_name and v_s.subject_type = p_type
      and v_s.category_id is not distinct from p_category and v_s.external_id is not distinct from v_ext
      and coalesce((select array_agg(sl.location_id order by sl.location_id) from public.subject_locations sl where sl.subject_id = v_s.id), '{}')
        = coalesce((select array_agg(x order by x) from unnest(v_locs) x), '{}')) then
    perform private.require_writable(p_ws);
  end if;

  if p_id is null then
    insert into public.subjects (workspace_id, name, subject_type, category_id, external_id, archived_at)
    values (p_ws, v_name, p_type, p_category, v_ext, case when p_archived then now() end) returning * into v_s;
  else
    update public.subjects set name = v_name, subject_type = p_type, category_id = p_category, external_id = v_ext,
      archived_at = case when p_archived then coalesce(archived_at, now()) end, version = version + 1
    where id = p_id returning * into v_s;
  end if;
  delete from public.subject_locations where subject_id = v_s.id and location_id <> all (v_locs);
  insert into public.subject_locations (workspace_id, subject_id, location_id)
  select p_ws, v_s.id, unnest(v_locs) on conflict do nothing;
  perform private.audit(p_ws, 'subject.saved', v_s.id, jsonb_build_object('name', v_name, 'archived', coalesce(p_archived, false),
    'category_id', p_category, 'external_id', v_ext, 'locations', to_jsonb(v_locs), 'version', v_s.version));
  return jsonb_build_object('id', v_s.id, 'version', v_s.version);
end $$;

-- Diff from 20261010230959_m2_directory.sql: an import commit needs write access and subject capacity
-- for every row it creates (checked inside the directory lock, after the idempotent replay).
create or replace function private.commit_subject_import(p_ws uuid, p_idempotency_key uuid, p_rows jsonb, p_expected_plan_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_payload_hash text := private.sha256_hex(coalesce(p_rows, 'null'::jsonb)::text);
  v_prior public.subject_imports;
  v_plan jsonb;
  r jsonb;
  v_id uuid;
  v_import_id uuid;
  v_created uuid[] := '{}';
  v_updated uuid[] := '{}';
  v_result jsonb;
  v_n integer;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  perform private.lock_directory(p_ws);

  select * into v_prior from public.subject_imports where workspace_id = p_ws and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.payload_hash <> v_payload_hash then perform private.fail('idempotency_conflict'); end if;
    return v_prior.result || jsonb_build_object('replayed', true);
  end if;

  v_plan := private.plan_subject_import(p_ws, p_rows);
  if not (v_plan ->> 'valid')::boolean then
    perform private.fail('import_invalid', (v_plan -> 'counts' ->> 'error') || ' row(s) have errors');
  end if;
  if p_expected_plan_hash is null or p_expected_plan_hash <> v_plan ->> 'plan_hash' then
    perform private.fail('stale_preview');
  end if;
  perform private.require_capacity(p_ws, 'subjects', (v_plan -> 'counts' ->> 'create')::integer);  -- M4

  for r in select * from jsonb_array_elements(v_plan -> 'rows') loop
    continue when r ->> 'action' = 'unchanged';
    if r ->> 'action' = 'create' then
      insert into public.subjects (workspace_id, name, subject_type, category_id, external_id)
      values (p_ws, r ->> 'name', (r ->> 'type')::public.subject_type, (r ->> 'category_id')::uuid, r ->> 'external_id')
      returning id into v_id;
      v_created := v_created || v_id;
    else
      v_id := (r ->> 'subject_id')::uuid;
      update public.subjects set
        name = coalesce(r ->> 'name', name),
        subject_type = coalesce((r ->> 'type')::public.subject_type, subject_type),
        category_id = coalesce((r ->> 'category_id')::uuid, category_id),
        version = version + 1
      where id = v_id and workspace_id = p_ws and version = (r ->> 'expected_version')::integer
        and archived_at is null and not is_sample;
      get diagnostics v_n = row_count;
      if v_n <> 1 then perform private.fail('stale_preview'); end if;
      v_updated := v_updated || v_id;
    end if;
    if jsonb_typeof(r -> 'location_ids') = 'array' then
      delete from public.subject_locations where subject_id = v_id
        and location_id not in (select (x #>> '{}')::uuid from jsonb_array_elements(r -> 'location_ids') x);
      insert into public.subject_locations (workspace_id, subject_id, location_id)
      select p_ws, v_id, (x #>> '{}')::uuid from jsonb_array_elements(r -> 'location_ids') x on conflict do nothing;
    end if;
    if jsonb_typeof(r -> 'contact') = 'object' then
      insert into public.subject_contacts (workspace_id, subject_id, name, phone, email, updated_by)
      values (p_ws, v_id, r -> 'contact' ->> 'name', r -> 'contact' ->> 'phone', r -> 'contact' ->> 'email', v_uid)
      on conflict (subject_id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email,
        version = public.subject_contacts.version + 1, updated_by = excluded.updated_by, updated_at = now();
    end if;
  end loop;

  -- The stored receipt is complete (including its own ID), so a replay returns exactly the
  -- original receipt apart from "replayed".
  v_import_id := gen_random_uuid();
  v_result := jsonb_build_object('import_id', v_import_id, 'created', cardinality(v_created), 'updated', cardinality(v_updated),
    'unchanged', (v_plan -> 'counts' ->> 'unchanged')::integer, 'rows', jsonb_array_length(v_plan -> 'rows'),
    'created_ids', to_jsonb(v_created), 'updated_ids', to_jsonb(v_updated));
  insert into public.subject_imports (id, workspace_id, idempotency_key, payload_hash, plan_hash, row_count, result, created_by)
  values (v_import_id, p_ws, p_idempotency_key, v_payload_hash, v_plan ->> 'plan_hash', jsonb_array_length(v_plan -> 'rows'), v_result, v_uid);
  perform private.audit(p_ws, 'subjects.imported', v_import_id, jsonb_build_object('created', cardinality(v_created),
    'updated', cardinality(v_updated), 'unchanged', v_result -> 'unchanged', 'plan_hash', v_plan ->> 'plan_hash'));
  return v_result || jsonb_build_object('replayed', false);
end $$;

-- Diff from 20261011144333_m3_actions_inbox.sql: publishing needs write access.
create or replace function private.publish_template(p_ws uuid, p_template_id uuid, p_name text,
  p_pack public.starter_pack, p_attendance_mode public.attendance_mode, p_criteria jsonb, p_settings jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_criteria jsonb;
  v_settings jsonb;
  v_tid uuid := p_template_id;
  v_version integer;
  v_id uuid;
begin
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  perform private.require_writable(p_ws);  -- M4
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then perform private.fail('invalid_name'); end if;
  v_criteria := private.validate_criteria(p_criteria);
  v_settings := private.validate_template_settings(p_settings);
  if jsonb_array_length(v_criteria) = 0 and p_attendance_mode <> 'scored' then
    perform private.fail('template_needs_criteria');
  end if;
  if v_tid is null then
    insert into public.templates (workspace_id, name, pack) values (p_ws, btrim(p_name), p_pack)
    returning id into v_tid;
  end if;
  update public.templates set latest_version = latest_version + 1, name = btrim(p_name)
  where id = v_tid and workspace_id = p_ws returning latest_version into v_version;
  if v_version is null then perform private.fail('not_found', 'template'); end if;
  insert into public.template_versions (workspace_id, template_id, version, name, attendance_mode,
    criteria, formula_version, published_by, settings)
  values (p_ws, v_tid, v_version, btrim(p_name), p_attendance_mode, v_criteria, 'savour-m1.1', v_uid, v_settings)
  returning id into v_id;
  perform private.audit(p_ws, 'template.published', v_id, jsonb_build_object('template_id', v_tid, 'version', v_version,
    'triggers', (select count(*) from jsonb_array_elements(v_criteria) c where private.criterion_trigger(c) is not null),
    'critical', (select count(*) from jsonb_array_elements(v_criteria) c where coalesce((c ->> 'critical')::boolean, false)),
    'settings', v_settings));
  return v_id;
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: write access first; every assignment of the
-- immediately opened session is reserved (assessment capacity) after the inserts.
create or replace function private.create_session(p_ws uuid, p_location uuid, p_template_version uuid, p_name text,
  p_local_date date, p_subject_ids uuid[], p_assessor_ids uuid[], p_reviewer_ids uuid[],
  p_window_hours integer, p_ready_time time)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_id uuid;
  v_subjects uuid[] := array(select distinct unnest(coalesce(p_subject_ids, '{}')));
  v_assessors uuid[] := array(select distinct unnest(coalesce(p_assessor_ids, '{}')));
  v_reviewers uuid[] := array(select distinct unnest(coalesce(p_reviewer_ids, '{}')));
  v_hours integer := coalesce(p_window_hours, 48);
begin
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  perform private.require_writable(p_ws);  -- M4
  if not exists (select 1 from public.locations where id = p_location and workspace_id = p_ws and archived_at is null) then
    perform private.fail('not_found', 'location');
  end if;
  if not exists (select 1 from public.template_versions where id = p_template_version and workspace_id = p_ws) then
    perform private.fail('not_found', 'template version');
  end if;
  if v_hours not between 1 and 168 then perform private.fail('invalid_window'); end if;
  if p_ready_time is null and (select attendance_mode from public.template_versions
                               where id = p_template_version) = 'scored' then
    perform private.fail('ready_time_required');
  end if;
  if p_local_date is null then perform private.fail('invalid_date'); end if;
  if cardinality(v_subjects) = 0 then perform private.fail('roster_required'); end if;
  if (select count(*) from public.subjects where workspace_id = p_ws and archived_at is null and not is_sample
      and id = any (v_subjects)) <> cardinality(v_subjects) then
    perform private.fail('not_found', 'subject');
  end if;
  if (select count(*) from public.memberships where workspace_id = p_ws and status = 'active'
      and role in ('owner', 'admin', 'reviewer', 'assessor') and user_id = any (v_assessors)
      and private.user_in_location(p_ws, user_id, p_location)) <> cardinality(v_assessors) then
    perform private.fail('invalid_assessor', 'assessors must be active staff holding the session location');
  end if;
  if (select count(*) from public.memberships where workspace_id = p_ws and status = 'active'
      and role in ('owner', 'admin', 'reviewer') and user_id = any (v_reviewers)
      and private.user_in_location(p_ws, user_id, p_location)) <> cardinality(v_reviewers) then
    perform private.fail('invalid_reviewer', 'reviewers must be active and hold the session location');
  end if;
  if cardinality(v_reviewers) = 0 then perform private.fail('reviewer_required'); end if;

  insert into public.sessions (workspace_id, location_id, template_version_id, name, local_date,
    opens_at, closes_at, expected_ready_time, created_by, opened_at, planned_window_hours)
  values (p_ws, p_location, p_template_version, btrim(p_name), p_local_date,
    now(), now() + make_interval(hours => v_hours), p_ready_time, v_uid, now(), v_hours)
  returning id into v_id;
  insert into public.session_subjects (workspace_id, session_id, subject_id, subject_name)
  select p_ws, v_id, s.id, s.name from public.subjects s where s.id = any (v_subjects);
  insert into public.session_assignments (workspace_id, session_id, subject_id, user_id)
  select p_ws, v_id, s, a from unnest(v_subjects) s, unnest(v_assessors) a;
  insert into public.session_reviewers (workspace_id, session_id, user_id)
  select p_ws, v_id, r from unnest(v_reviewers) r;
  perform private.reserve_session_work(v_id);  -- M4
  perform private.audit(p_ws, 'session.created', v_id, jsonb_build_object(
    'subjects', cardinality(v_subjects), 'assessors', cardinality(v_assessors), 'window_hours', v_hours));
  return v_id;
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: a new draft needs write access.
create or replace function private.create_session_draft(p_ws uuid, p_location uuid, p_template_version uuid, p_name text,
  p_local_date date, p_subject_ids uuid[], p_assessor_ids uuid[], p_reviewer_ids uuid[],
  p_window_hours integer, p_ready_time time)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_id uuid;
  v_subjects uuid[] := array(select distinct unnest(coalesce(p_subject_ids, '{}')));
  v_assessors uuid[] := array(select distinct unnest(coalesce(p_assessor_ids, '{}')));
  v_reviewers uuid[] := array(select distinct unnest(coalesce(p_reviewer_ids, '{}')));
  v_hours integer := coalesce(p_window_hours, 48);
begin
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  perform private.require_writable(p_ws);  -- M4
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then perform private.fail('invalid_name'); end if;
  if not exists (select 1 from public.locations where id = p_location and workspace_id = p_ws and archived_at is null) then
    perform private.fail('not_found', 'location');
  end if;
  if not exists (select 1 from public.template_versions where id = p_template_version and workspace_id = p_ws) then
    perform private.fail('not_found', 'template version');
  end if;
  if v_hours not between 1 and 168 then perform private.fail('invalid_window'); end if;
  if p_local_date is null then perform private.fail('invalid_date'); end if;
  if (select count(*) from public.subjects where workspace_id = p_ws and archived_at is null and not is_sample
      and id = any (v_subjects)) <> cardinality(v_subjects) then
    perform private.fail('not_found', 'subject');
  end if;
  if (select count(*) from public.memberships where workspace_id = p_ws and status = 'active'
      and role in ('owner', 'admin', 'reviewer', 'assessor') and user_id = any (v_assessors)
      and private.user_in_location(p_ws, user_id, p_location)) <> cardinality(v_assessors) then
    perform private.fail('invalid_assessor', 'assessors must be active staff holding the session location');
  end if;
  if (select count(*) from public.memberships where workspace_id = p_ws and status = 'active'
      and role in ('owner', 'admin', 'reviewer') and user_id = any (v_reviewers)
      and private.user_in_location(p_ws, user_id, p_location)) <> cardinality(v_reviewers) then
    perform private.fail('invalid_reviewer', 'reviewers must be active and hold the session location');
  end if;
  insert into public.sessions (workspace_id, location_id, template_version_id, name, local_date, status,
    opens_at, closes_at, expected_ready_time, created_by, planned_window_hours)
  values (p_ws, p_location, p_template_version, btrim(p_name), p_local_date, 'draft',
    now(), now() + make_interval(hours => v_hours), p_ready_time, v_uid, v_hours)
  returning id into v_id;
  insert into public.session_subjects (workspace_id, session_id, subject_id, subject_name)
  select p_ws, v_id, s.id, s.name from public.subjects s where s.id = any (v_subjects);
  insert into public.session_assignments (workspace_id, session_id, subject_id, user_id)
  select p_ws, v_id, s, a from unnest(v_subjects) s, unnest(v_assessors) a;
  insert into public.session_reviewers (workspace_id, session_id, user_id)
  select p_ws, v_id, r from unnest(v_reviewers) r;
  perform private.audit(p_ws, 'session.draft_created', v_id, jsonb_build_object(
    'subjects', cardinality(v_subjects), 'assessors', cardinality(v_assessors), 'reviewers', cardinality(v_reviewers),
    'window_hours', v_hours));
  return v_id;
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: opening needs write access and reserves every
-- accepted assignment (assessment capacity) under the session lock, billing lock last.
create or replace function private.open_session(p_session uuid, p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_problems text[] := '{}';
  v_hours integer;
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status <> 'draft' then perform private.fail('invalid_state'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  perform private.require_writable(v_s.workspace_id);  -- M4
  v_hours := coalesce(v_s.planned_window_hours, 48);
  if not exists (select 1 from public.locations where id = v_s.location_id and archived_at is null) then
    v_problems := v_problems || 'the location is archived'::text;
  end if;
  if v_s.expected_ready_time is null and (select attendance_mode from public.template_versions
      where id = v_s.template_version_id) = 'scored' then
    v_problems := v_problems || 'scored readiness needs an expected ready time'::text;
  end if;
  if not exists (select 1 from public.session_subjects where session_id = p_session and removed_at is null) then
    v_problems := v_problems || 'the roster is empty'::text;
  end if;
  if exists (select 1 from public.session_subjects ss join public.subjects x on x.id = ss.subject_id
             where ss.session_id = p_session and ss.removed_at is null and (x.archived_at is not null or x.is_sample <> v_s.is_sample)) then
    v_problems := v_problems || 'the roster contains an archived subject'::text;
  end if;
  if exists (select 1 from public.session_assignments a join public.memberships m
               on m.workspace_id = a.workspace_id and m.user_id = a.user_id
             where a.session_id = p_session and m.role = 'guest') then
    v_problems := v_problems || 'guests are invited after opening'::text;
  end if;
  v_problems := v_problems || private.scope_problems(p_session);
  if cardinality(v_problems) > 0 then perform private.fail('open_blocked', array_to_string(v_problems, '; ')); end if;
  update public.sessions set status = 'open', opens_at = now(), closes_at = now() + make_interval(hours => v_hours),
    opened_at = now(), planned_window_hours = v_hours, data_version = data_version + 1
  where id = p_session;
  perform private.reserve_session_work(p_session);  -- M4
  perform private.audit(v_s.workspace_id, 'session.opened', p_session, jsonb_build_object('window_hours', v_hours,
    'closes_at', now() + make_interval(hours => v_hours)));
  return v_s.data_version + 1;
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: adding to a roster needs write access; restoring
-- a subject while collecting re-reserves its assignments; removing it while collecting releases them.
create or replace function private.set_roster_subject(p_session uuid, p_subject uuid, p_on boolean, p_reason text,
  p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_ss public.session_subjects;
  v_reason text;
  v_retained integer;
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status not in ('draft', 'open', 'in_review') then perform private.fail('session_locked'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  v_reason := case when v_s.status = 'draft' then nullif(btrim(coalesce(p_reason, '')), '') else private.require_reason(p_reason) end;
  select * into v_ss from public.session_subjects where session_id = p_session and subject_id = p_subject for update;
  select count(*) into v_retained from public.assessments a
  where a.session_id = p_session and a.subject_id = p_subject and a.state = 'submitted';

  if coalesce(p_on, false) then
    perform private.require_writable(v_s.workspace_id);  -- M4
    if not exists (select 1 from public.subjects x where x.id = p_subject and x.workspace_id = v_s.workspace_id
                   and x.archived_at is null and x.is_sample = v_s.is_sample) then
      perform private.fail('not_found', 'subject');
    end if;
    if v_ss.subject_id is not null and v_ss.removed_at is null then perform private.fail('already_on_roster'); end if;
    if v_ss.subject_id is null then
      insert into public.session_subjects (workspace_id, session_id, subject_id, subject_name)
      select v_s.workspace_id, p_session, x.id, x.name from public.subjects x where x.id = p_subject;
      perform private.audit(v_s.workspace_id, 'roster.added', p_session, jsonb_build_object(
        'subject_id', p_subject, 'reason', v_reason, 'status', v_s.status));
    else
      -- Same row, same label and outcome; retained responses become current again (disclosed).
      update public.session_subjects set removed_at = null, removed_by = null, removal_reason = null,
        restored_at = now(), restored_by = (select auth.uid()), restore_reason = v_reason
      where session_id = p_session and subject_id = p_subject;
      perform private.audit(v_s.workspace_id, 'roster.restored', p_session, jsonb_build_object(
        'subject_id', p_subject, 'reason', v_reason, 'retained_responses', v_retained));
    end if;
    perform private.reserve_session_work(p_session, p_subject);  -- M4
  else
    if v_ss.subject_id is null or v_ss.removed_at is not null then perform private.fail('not_found', 'roster subject'); end if;
    if v_s.status = 'draft' then
      delete from public.session_assignments where session_id = p_session and subject_id = p_subject;
      delete from public.session_subjects where session_id = p_session and subject_id = p_subject;
    else
      update public.session_subjects set removed_at = now(), removed_by = (select auth.uid()), removal_reason = v_reason
      where session_id = p_session and subject_id = p_subject;
      perform private.release_session_work(p_session, p_subject);  -- M4
    end if;
    perform private.audit(v_s.workspace_id, 'roster.removed', p_session, jsonb_build_object(
      'subject_id', p_subject, 'reason', v_reason, 'status', v_s.status, 'retained_responses', v_retained));
  end if;
  update public.sessions set data_version = data_version + 1 where id = p_session;
  return v_s.data_version + 1;
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: assigning needs write access; while collecting the
-- new assignment is reserved (an exact duplicate reserves nothing); removal releases unused work.
create or replace function private.set_assignment(p_session uuid, p_subject uuid, p_user uuid, p_assigned boolean,
  p_expected_data_version integer, p_reason text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_role public.member_role;
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status not in ('draft', 'open', 'in_review') then perform private.fail('session_locked'); end if;
  if p_expected_data_version is null or v_s.data_version <> p_expected_data_version then perform private.fail('stale_version'); end if;
  if not exists (select 1 from public.session_subjects where session_id = p_session and subject_id = p_subject) then
    perform private.fail('not_found', 'roster subject');
  end if;
  if p_assigned then
    perform private.require_writable(v_s.workspace_id);  -- M4
    perform private.require_active_roster(p_session, p_subject);
    select m.role into v_role from public.memberships m where m.workspace_id = v_s.workspace_id
      and m.user_id = p_user and m.status = 'active' and m.role in ('owner', 'admin', 'reviewer', 'assessor', 'guest');
    if v_role is null then perform private.fail('invalid_assessor'); end if;
    if v_role = 'guest' and (v_s.is_sample or v_s.status = 'draft') then
      perform private.fail('invalid_assessor', 'guests cannot be assigned to samples or drafts');
    end if;
    if not private.assignment_in_scope(p_session, p_user) then
      perform private.fail('invalid_assessor', 'assignee must hold the session location (guests: this session)');
    end if;
    insert into public.session_assignments (workspace_id, session_id, subject_id, user_id)
    values (v_s.workspace_id, p_session, p_subject, p_user) on conflict do nothing;
    perform private.reserve_session_work(p_session, p_subject, p_user);  -- M4
  else
    delete from public.session_assignments
    where session_id = p_session and subject_id = p_subject and user_id = p_user;
    perform private.release_session_work(p_session, p_subject, p_user);  -- M4
  end if;
  update public.sessions set data_version = data_version + 1 where id = p_session;
  perform private.audit(v_s.workspace_id, case when p_assigned then 'assignment.added' else 'assignment.removed' end,
    p_session, jsonb_build_object('subject_id', p_subject, 'user_id', p_user,
      'reason', nullif(btrim(coalesce(p_reason, '')), ''), 'status', v_s.status));
  return v_s.data_version + 1;
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: the insert branch (first stored assessment for this
-- session/subject/assessor, after the idempotent replay return) consumes the reservation once.
-- Edits, resubmissions after a clear and replays never count again. Never blocked by billing.
create or replace function private.submit_assessment(p_session uuid, p_subject uuid, p_assessor uuid,
  p_observed public.subject_outcome, p_answers jsonb, p_notes text, p_expected_version integer,
  p_idempotency_key uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_s public.sessions := private.lock_session(p_session);
  v_tv public.template_versions;
  v_ss public.session_subjects;
  v_a public.assessments;
  v_prior public.assessment_events;
  v_amend boolean := p_assessor is distinct from v_uid
    or (length(btrim(coalesce(p_reason, ''))) > 0 and private.can_review(p_session));
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_hash text;
  v_answers jsonb;
  v_name text;
  v_version integer;
  v_cr uuid;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  v_hash := private.sha256_hex(jsonb_build_object('session', p_session, 'subject', p_subject,
    'assessor', p_assessor, 'observed', p_observed, 'answers', p_answers, 'notes', p_notes,
    'expected_version', p_expected_version, 'reason', p_reason)::text);

  -- Authorization first (revoked/unassigned callers never get a receipt).
  if v_amend then
    if not private.can_review(p_session) then perform private.fail('forbidden'); end if;
  elsif not private.is_assigned(p_session, p_subject) then
    perform private.fail('not_assigned');
  end if;

  -- Idempotent replay: same key + same payload returns the original receipt.
  select * into v_prior from public.assessment_events
  where actor_id = v_uid and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.payload_hash <> v_hash then perform private.fail('idempotency_conflict'); end if;
    return jsonb_build_object('assessment_id', v_prior.assessment_id, 'version', v_prior.version, 'replayed', true);
  end if;

  if v_s.status not in ('open', 'in_review') then perform private.fail('session_locked'); end if;
  v_ss := private.require_active_roster(p_session, p_subject);
  if v_amend then
    if length(btrim(coalesce(p_reason, ''))) = 0 then perform private.fail('reason_required'); end if;
    if not exists (select 1 from public.session_assignments where session_id = p_session
                   and subject_id = p_subject and user_id = p_assessor) then
      perform private.fail('not_assigned');
    end if;
  elsif not private.session_collecting(v_s) then
    perform private.fail('window_closed');
  end if;

  select * into v_tv from public.template_versions where id = v_s.template_version_id;

  if p_observed is not null and (p_observed = 'unknown' or v_tv.attendance_mode = 'off'
      or not private.outcome_allowed(v_tv.attendance_mode, p_observed)) then
    perform private.fail('invalid_attendance');
  end if;
  if p_observed = 'absent' then
    if p_answers is not null and p_answers <> '{}'::jsonb then
      perform private.fail('absent_clears_scores');
    end if;
    v_answers := null;
  else
    if v_ss.outcome in ('absent', 'not_assessed') then perform private.fail('subject_not_assessable'); end if;
    v_answers := private.validate_answers(v_tv.criteria, coalesce(p_answers, '{}'));
  end if;
  if length(coalesce(p_notes, '')) > 2000 then perform private.fail('notes_too_long'); end if;

  select * into v_a from public.assessments
  where session_id = p_session and subject_id = p_subject and assessor_id = p_assessor for update;
  if p_expected_version is null or coalesce(v_a.version, 0) <> p_expected_version then
    perform private.fail('stale_version');
  end if;

  select display_name into v_name from public.memberships
  where workspace_id = v_s.workspace_id and user_id = p_assessor;

  if v_a.id is null then
    insert into public.assessments (workspace_id, session_id, subject_id, assessor_id, assessor_name,
      observed_attendance, answers, notes, absence_reason, state, na_confirmed, version, updated_by)
    values (v_s.workspace_id, p_session, p_subject, p_assessor, v_name, p_observed, v_answers,
      case when p_observed = 'absent' then null else v_notes end,
      case when p_observed = 'absent' then v_notes end, 'submitted',
      v_amend or not private.has_na(v_answers), 1, v_uid)
    returning * into v_a;
    perform private.consume_assessment(v_s.workspace_id, p_session, p_subject, p_assessor, v_amend);  -- M4
  else
    update public.assessments set observed_attendance = p_observed, answers = v_answers,
      notes = case when p_observed = 'absent' then null else v_notes end,
      absence_reason = case when p_observed = 'absent' then v_notes end, state = 'submitted',
      na_confirmed = v_amend or not private.has_na(v_answers),
      version = version + 1, updated_by = v_uid, updated_at = now()
    where id = v_a.id returning * into v_a;
  end if;
  v_version := v_a.version;

  insert into public.assessment_events (workspace_id, assessment_id, session_id, revision, kind, version,
    actor_id, payload, payload_hash, idempotency_key, reason)
  values (v_s.workspace_id, v_a.id, p_session, v_s.revision, case when v_amend then 'amend' else 'submit' end,
    v_version, v_uid, jsonb_build_object('observed', p_observed, 'answers', v_answers, 'notes', v_a.notes,
      'absence_reason', v_a.absence_reason),
    v_hash, p_idempotency_key, nullif(btrim(coalesce(p_reason, '')), ''));

  if v_answers is not null then
    update public.session_assignments set waived_at = null, waived_by = null, waiver_reason = null
    where session_id = p_session and subject_id = p_subject and user_id = p_assessor and waived_at is not null;
    if found then
      perform private.audit(v_s.workspace_id, 'assignment.waiver_cleared', p_session, jsonb_build_object(
        'subject_id', p_subject, 'user_id', p_assessor, 'by', 'submission', 'version', v_version));
    end if;
  end if;
  update public.correction_requests set status = 'resolved', resolution = case when v_amend then 'amended' else 'resubmitted' end,
    resolved_by = v_uid, resolved_at = now()
  where session_id = p_session and subject_id = p_subject and assessor_id = p_assessor and status = 'open'
  returning id into v_cr;
  if v_cr is not null then
    perform private.audit(v_s.workspace_id, 'correction.resolved', v_cr, jsonb_build_object(
      'session_id', p_session, 'resolution', case when v_amend then 'amended' else 'resubmitted' end, 'version', v_version));
  end if;
  update public.sessions set data_version = data_version + 1 where id = p_session;
  return jsonb_build_object('assessment_id', v_a.id, 'version', v_version, 'replayed', false);
end $$;

-- Diff from 20261011144335_m3_report_snapshot.sql: after the snapshot and status update, unused
-- reservations of the session are released. Approval itself is never blocked by billing.
create or replace function private.approve_session(p_session uuid, p_expected_data_version integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_s public.sessions := private.lock_session(p_session);
  v_tv public.template_versions;
  v_problems text[] := '{}';
  r record;
  v_inputs jsonb;
  v_name text;
  v_id uuid;
  v_now timestamptz;
  v_generated integer;
begin
  if not private.can_review(p_session) then perform private.fail('forbidden'); end if;
  if v_s.status not in ('open', 'in_review') then perform private.fail('invalid_state'); end if;
  if p_expected_data_version is null or v_s.data_version <> p_expected_data_version then perform private.fail('stale_version'); end if;
  select * into v_tv from public.template_versions where id = v_s.template_version_id;
  if not exists (select 1 from public.session_subjects where session_id = p_session and removed_at is null) then
    v_problems := v_problems || 'no active roster subjects'::text;
  end if;

  for r in
    select ss.subject_name, ss.outcome,
      count(sa.user_id) as required,
      count(sa.user_id) filter (where a.state = 'submitted' and a.answers is not null) as complete,
      count(sa.user_id) filter (where sa.waived_at is not null
        and not (coalesce(a.state = 'submitted', false) and a.answers is not null)) as waived,
      count(sa.user_id) filter (where a.state = 'submitted' and private.has_na(a.answers) and not a.na_confirmed) as unconfirmed_na,
      (select count(*) from public.correction_requests cr where cr.session_id = ss.session_id
        and cr.subject_id = ss.subject_id and cr.status = 'open') as open_corrections
    from public.session_subjects ss
    left join public.session_assignments sa on sa.session_id = ss.session_id and sa.subject_id = ss.subject_id
    left join public.assessments a on a.session_id = sa.session_id and a.subject_id = sa.subject_id
      and a.assessor_id = sa.user_id
    where ss.session_id = p_session and ss.removed_at is null
    group by ss.session_id, ss.subject_id, ss.subject_name, ss.outcome
    order by ss.subject_name
  loop
    if r.outcome = 'unknown' then
      v_problems := v_problems || (r.subject_name || ': outcome not recorded');
    elsif r.open_corrections > 0 then
      v_problems := v_problems || (r.subject_name || ': correction requested and not yet resolved');
    elsif r.outcome in ('absent', 'not_assessed') or jsonb_array_length(v_tv.criteria) = 0 then
      continue;
    elsif r.required = 0 then
      v_problems := v_problems || (r.subject_name || ': no assessor assigned');
    elsif r.complete + r.waived < r.required then
      v_problems := v_problems || (r.subject_name || ': ' || (r.required - r.complete - r.waived) || ' required response(s) missing');
    elsif r.unconfirmed_na > 0 then
      v_problems := v_problems || (r.subject_name || ': N/A answers need reviewer confirmation');
    end if;
  end loop;
  if cardinality(v_problems) > 0 then
    perform private.fail('approval_blocked', array_to_string(v_problems, '; '));
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_generated := private.generate_findings(p_session, v_uid, v_now);
  v_inputs := private.build_inputs(p_session);
  select display_name into v_name from public.memberships
  where workspace_id = v_s.workspace_id and user_id = v_uid;
  insert into public.report_revisions (workspace_id, session_id, revision, inputs, inputs_hash,
    formula_version, approved_by, approver_name, approved_at)
  values (v_s.workspace_id, p_session, v_s.revision, v_inputs, private.sha256_hex(v_inputs::text),
    v_inputs ->> 'formula_version', v_uid, v_name, v_now)
  returning id into v_id;
  update public.sessions set status = 'approved', current_report_id = v_id, data_version = data_version + 1
  where id = p_session;
  perform private.release_session_work(p_session);  -- M4
  for r in select sr.user_id from public.session_reviewers sr where sr.session_id = p_session union select v_s.created_by loop
    perform private.notify(v_s.workspace_id, r.user_id, 'session_approved', 'approved:' || v_id, null, p_session, null,
      jsonb_build_object('revision', v_s.revision));
  end loop;
  perform private.audit(v_s.workspace_id, 'session.approved', p_session,
    jsonb_build_object('revision', v_s.revision, 'report_id', v_id, 'waived', (
      select count(*) from public.session_assignments where session_id = p_session and waived_at is not null),
      'findings_generated', v_generated, 'actions_frozen', jsonb_array_length(v_inputs -> 'actions')));
  return v_id;
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: unused reservations are released.
create or replace function private.cancel_session(p_session uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_s public.sessions := private.lock_session(p_session);
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status not in ('draft', 'open', 'in_review') then perform private.fail('invalid_state'); end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then perform private.fail('reason_required'); end if;
  update public.sessions set status = 'cancelled', cancel_reason = btrim(p_reason), data_version = data_version + 1
  where id = p_session;
  perform private.release_session_work(p_session);  -- M4
  perform private.audit(v_s.workspace_id, 'session.cancelled', p_session, jsonb_build_object('reason', btrim(p_reason)));
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: reopening collection is new collection and needs
-- write access even when every assignment is already consumed; assignments whose reservations were
-- released at approval are re-reserved (capacity). Reopening a REPORT for correction (reopen_session)
-- stays allowed in read-only.
create or replace function private.reopen_collection(p_session uuid, p_hours integer, p_reason text, p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_reason text;
  v_close timestamptz;
  v_moved integer;
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status = 'approved' then perform private.fail('reopen_report_first'); end if;
  if not ((v_s.status = 'in_review' and v_s.current_report_id is null)
          or (v_s.status = 'open' and now() >= v_s.closes_at)) then
    perform private.fail('invalid_state');
  end if;
  perform private.require_version(v_s, p_expected_data_version);
  perform private.require_writable(v_s.workspace_id);  -- M4: new collection always needs write access
  v_reason := private.require_reason(p_reason);
  if coalesce(p_hours, 0) not between 1 and 168 then perform private.fail('invalid_window'); end if;
  v_close := now() + make_interval(hours => p_hours);
  update public.sessions set status = 'open', closes_at = v_close, collection_reopens = collection_reopens + 1,
    last_collection_reopen_reason = v_reason, data_version = data_version + 1
  where id = p_session;
  v_moved := private.move_guest_grants(p_session, v_s.closes_at, v_close);
  perform private.reserve_session_work(p_session);  -- M4
  perform private.audit(v_s.workspace_id, 'session.collection_reopened', p_session, jsonb_build_object(
    'reason', v_reason, 'hours', p_hours, 'from_status', v_s.status, 'revision', v_s.revision,
    'from_closes_at', v_s.closes_at, 'to_closes_at', v_close, 'guest_grants_moved', v_moved));
  return v_s.data_version + 1;
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: a staff invitation reserves a staff seat (pending
-- invitations count, so accepting it later does not count again); a guest invitation needs write access
-- and locks its session before the billing row (lock order 2 before 7).
create or replace function private.create_invitation(p_ws uuid, p_email text, p_role public.member_role,
  p_all_locations boolean, p_location_ids uuid[], p_session uuid, p_subject_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_role public.member_role := private.member_role(p_ws);
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_locs uuid[] := array(select distinct unnest(coalesce(p_location_ids, '{}')));
  v_all boolean := coalesce(p_all_locations, false);
  v_subjects uuid[] := array(select distinct unnest(coalesce(p_subject_ids, '{}')));
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_id uuid;
  v_expires timestamptz := now() + interval '7 days';
begin
  if v_role is null or v_role not in ('owner', 'admin') then perform private.fail('forbidden'); end if;
  if p_role is null or p_role = 'owner' then perform private.fail('role_not_invitable'); end if;
  if v_role = 'admin' and p_role = 'admin' then perform private.fail('role_not_invitable'); end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then perform private.fail('invalid_email'); end if;
  if p_role = 'guest' then
    -- M4: take the session evidence lock (step 2) before the billing lock (step 7), then validate
    -- collection and roster under it. The invitation insert's foreign-key check (FOR KEY SHARE on the
    -- session) therefore never waits behind an evidence writer that would later need the billing row.
    if p_session is null or not exists (select 1 from public.sessions where id = p_session and workspace_id = p_ws) then
      perform private.fail('not_found', 'open session');
    end if;
    perform private.lock_session(p_session);
    if not exists (select 1 from public.sessions where id = p_session
        and workspace_id = p_ws and status = 'open' and closes_at > now() and not is_sample) then
      perform private.fail('not_found', 'open session');
    end if;
    if cardinality(v_subjects) = 0 then perform private.fail('subjects_required'); end if;
    if (select count(*) from public.session_subjects where session_id = p_session and removed_at is null
        and subject_id = any (v_subjects)) <> cardinality(v_subjects) then
      perform private.fail('not_found', 'roster subject');
    end if;
    v_all := false; v_locs := '{}';
  else
    if p_session is not null or cardinality(v_subjects) > 0 then perform private.fail('invalid_scope'); end if;
    if p_role = 'admin' then v_all := true; v_locs := '{}'; end if;
    if (select count(*) from public.locations where workspace_id = p_ws and archived_at is null
        and id = any (v_locs)) <> cardinality(v_locs) then
      perform private.fail('not_found', 'location');
    end if;
    if not v_all and cardinality(v_locs) = 0 then perform private.fail('locations_required'); end if;
  end if;
  -- M4: staff seat (pending invitations count) or write access for a guest.
  perform private.require_capacity(p_ws, 'staff', case when p_role = 'guest' then 0 else 1 end);
  insert into public.invitations (workspace_id, email, role, all_locations, location_ids, session_id,
    subject_ids, token_hash, expires_at, created_by)
  values (p_ws, v_email, p_role, v_all, v_locs, case when p_role = 'guest' then p_session end, v_subjects,
    private.sha256_hex(v_token), v_expires, v_uid)
  returning id into v_id;
  perform private.audit(p_ws, 'invitation.created', v_id, jsonb_build_object('email', v_email, 'role', p_role));
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_expires);
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: acceptance needs write access (no second staff
-- count: the pending invitation already holds the seat); a guest's assignments are reserved
-- (assessment capacity) with the billing lock taken last.
create or replace function private.accept_invitation(p_token text, p_display_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_inv public.invitations;
  v_user record;
  v_status text;
  v_m public.memberships;
  v_s public.sessions;
  v_name text := btrim(coalesce(p_display_name, ''));
  v_conflict text;
  v_dropped integer := 0;
  v_replaced boolean;
begin
  if length(v_name) not between 1 and 80 then perform private.fail('invalid_name'); end if;
  select * into v_inv from public.invitations where token_hash = private.sha256_hex(coalesce(p_token, '')) for update;
  if not found then perform private.fail('invitation_invalid'); end if;
  select email, email_confirmed_at is not null as confirmed into v_user from auth.users where id = v_uid;
  v_status := private.invitation_status(v_inv, v_user.email, v_user.confirmed);
  if v_status <> 'valid' then perform private.fail(v_status); end if;

  if v_inv.role = 'guest' then
    select * into v_s from public.sessions where id = v_inv.session_id for update;
    if not private.session_collecting(v_s) or v_s.is_sample then perform private.fail('session_closed'); end if;
  end if;
  perform 1 from public.workspaces where id = v_inv.workspace_id for no key update;  -- serialize membership changes
  select * into v_m from public.memberships where workspace_id = v_inv.workspace_id and user_id = v_uid for no key update;
  if found and v_m.status = 'active' and (v_m.expires_at is null or v_m.expires_at > now()) then
    perform private.fail('already_member');
  end if;
  perform private.require_writable(v_inv.workspace_id);  -- M4

  v_replaced := v_m.id is not null;
  if v_replaced and v_inv.role = 'guest' then
    select string_agg(ss.subject_name, ', ' order by ss.subject_name) into v_conflict
    from public.session_assignments a
    join public.session_subjects ss on ss.session_id = a.session_id and ss.subject_id = a.subject_id
    where a.session_id = v_inv.session_id and a.user_id = v_uid and not (a.subject_id = any (v_inv.subject_ids))
      and (a.waived_at is not null or exists (select 1 from public.assessments x where x.session_id = a.session_id
             and x.subject_id = a.subject_id and x.assessor_id = a.user_id));
    if v_conflict is not null then perform private.fail('invitation_scope_conflict', v_conflict); end if;
    delete from public.session_assignments a
    where a.session_id = v_inv.session_id and a.user_id = v_uid and not (a.subject_id = any (v_inv.subject_ids));
    get diagnostics v_dropped = row_count;
    -- M4: release unused reservations of the dropped assignments only.
    update billing.assessment_reservations set state = 'released', released_at = now()
    where session_id = v_inv.session_id and user_id = v_uid and state = 'reserved' and not (subject_id = any (v_inv.subject_ids));
  end if;

  if v_m.id is null then
    insert into public.memberships (workspace_id, user_id, role, display_name, email, all_locations,
      guest_session_id, expires_at)
    values (v_inv.workspace_id, v_uid, v_inv.role, v_name, lower(v_user.email), v_inv.all_locations,
      v_inv.session_id, v_s.closes_at)
    returning * into v_m;
  else
    update public.memberships set role = v_inv.role, status = 'active', display_name = v_name,
      all_locations = v_inv.all_locations, guest_session_id = v_inv.session_id, expires_at = v_s.closes_at,
      revoked_at = null, revoked_by = null
    where id = v_m.id returning * into v_m;
    delete from public.membership_locations where membership_id = v_m.id;
  end if;
  insert into public.membership_locations (workspace_id, membership_id, location_id)
  select v_inv.workspace_id, v_m.id, l.id from public.locations l
  where l.workspace_id = v_inv.workspace_id and l.id = any (v_inv.location_ids);

  if v_inv.role = 'guest' then
    insert into public.session_assignments (workspace_id, session_id, subject_id, user_id)
    select v_inv.workspace_id, v_inv.session_id, ss.subject_id, v_uid
    from public.session_subjects ss
    where ss.session_id = v_inv.session_id and ss.subject_id = any (v_inv.subject_ids) and ss.removed_at is null
    on conflict do nothing;
    perform private.reserve_session_work(v_inv.session_id, null, v_uid);  -- M4
    update public.sessions set data_version = data_version + 1 where id = v_inv.session_id;
  end if;
  update public.invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  perform private.audit(v_inv.workspace_id, 'invitation.accepted', v_inv.id, jsonb_build_object('role', v_inv.role,
    'replaced_membership', v_replaced, 'dropped_assignments', v_dropped));
  return v_inv.workspace_id;
end $$;

-- Diff from 20261011144333_m3_actions_inbox.sql: a new finding needs write access (checked after the
-- session lock and the idempotent replay, so a retry of an earlier accepted create still replays).
create or replace function private.create_finding(p_session uuid, p_subject uuid, p_severity text, p_title text,
  p_note text, p_criterion_key text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_s public.sessions;
  v_tv public.template_versions;
  v_prior public.findings;
  v_hash text;
  v_label text;
  v_id uuid;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  if not private.can_review(p_session) then perform private.deny_session(p_session); end if;
  v_s := private.lock_session(p_session);
  if not private.can_review(p_session) then perform private.fail('forbidden'); end if;
  v_hash := private.sha256_hex(jsonb_build_object('session', p_session, 'subject', p_subject, 'severity', p_severity,
    'title', p_title, 'note', p_note, 'criterion', p_criterion_key)::text);
  select * into v_prior from public.findings where created_by = v_uid and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.payload_hash <> v_hash then perform private.fail('idempotency_conflict'); end if;
    -- The original create receipt (version 1), even if the finding was withdrawn since.
    return jsonb_build_object('finding_id', v_prior.id, 'version', 1, 'replayed', true);
  end if;

  if v_s.is_sample then perform private.fail('sample_not_allowed'); end if;
  if v_s.status not in ('open', 'in_review', 'approved') then perform private.fail('invalid_state'); end if;
  perform private.require_writable(v_s.workspace_id);  -- M4
  perform private.require_active_roster(p_session, p_subject);
  perform private.require_severity(p_severity);
  if length(btrim(coalesce(p_title, ''))) not between 1 and 200 then perform private.fail('invalid_title'); end if;
  if length(coalesce(p_note, '')) > 2000 then perform private.fail('notes_too_long'); end if;
  if p_criterion_key is not null then
    select * into v_tv from public.template_versions where id = v_s.template_version_id;
    select c ->> 'label' into v_label from jsonb_array_elements(v_tv.criteria) c where c ->> 'key' = p_criterion_key;
    if v_label is null then perform private.fail('unknown_criterion', p_criterion_key); end if;
  end if;
  insert into public.findings (workspace_id, session_id, subject_id, revision, kind, criterion_key, severity, title,
    detail, created_by, created_at, idempotency_key, payload_hash)
  values (v_s.workspace_id, p_session, p_subject, v_s.revision, 'manual', p_criterion_key, p_severity, btrim(p_title),
    jsonb_strip_nulls(jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), ''), 'criterion_label', v_label,
      'rule', 'Raised manually by a reviewer.')),
    v_uid, pg_catalog.clock_timestamp(), p_idempotency_key, v_hash)
  returning id into v_id;
  perform private.audit(v_s.workspace_id, 'finding.created', v_id, jsonb_build_object('session_id', p_session,
    'subject_id', p_subject, 'severity', p_severity, 'kind', 'manual', 'revision', v_s.revision));
  return jsonb_build_object('finding_id', v_id, 'version', 1, 'replayed', false);
end $$;

-- Diff from 20261011144333_m3_actions_inbox.sql: a new action needs write access (after the session lock,
-- the finding row lock and the idempotent replay). Existing actions keep every transition.
create or replace function private.create_action(p_finding uuid, p_issue text, p_action_required text, p_severity text,
  p_assignee uuid, p_due_date date, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_f public.findings;
  v_s public.sessions;
  v_a public.actions;
  v_prior public.action_events;
  v_hash text;
  v_now timestamptz;
  v_event uuid;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  select * into v_f from public.findings where id = p_finding;
  if not found then perform private.fail('not_found', 'finding'); end if;
  if not private.can_review(v_f.session_id) then
    if private.member_role(v_f.workspace_id) is null then perform private.fail('not_found', 'finding'); end if;
    perform private.fail('forbidden');
  end if;
  v_s := private.lock_session(v_f.session_id);
  if not private.can_review(v_f.session_id) then perform private.fail('forbidden'); end if;
  v_hash := private.sha256_hex(jsonb_build_object('finding', p_finding, 'issue', p_issue, 'action_required', p_action_required,
    'severity', p_severity, 'assignee', p_assignee, 'due_date', p_due_date)::text);
  select * into v_prior from public.action_events where actor_id = v_uid and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.kind <> 'create' or v_prior.payload_hash <> v_hash then perform private.fail('idempotency_conflict'); end if;
    return jsonb_build_object('action_id', v_prior.action_id, 'version', (v_prior.after ->> 'version')::integer,
      'status', v_prior.to_status, 'replayed', true);
  end if;

  select * into v_f from public.findings where id = p_finding for no key update;
  if v_f.withdrawn_at is not null then perform private.fail('finding_withdrawn'); end if;
  if v_s.is_sample then perform private.fail('sample_not_allowed'); end if;
  if v_s.status not in ('open', 'in_review', 'approved') then perform private.fail('invalid_state'); end if;
  perform private.require_writable(v_s.workspace_id);  -- M4
  perform private.require_active_roster(v_f.session_id, v_f.subject_id);
  if length(btrim(coalesce(p_issue, ''))) not between 1 and 300 then perform private.fail('invalid_issue'); end if;
  if length(btrim(coalesce(p_action_required, ''))) not between 1 and 2000 then perform private.fail('invalid_action_required'); end if;
  perform private.require_severity(p_severity);
  perform private.require_due_date(v_s.workspace_id, p_due_date);
  if p_assignee is null or not private.can_be_assignee(v_s.workspace_id, p_assignee, v_s.location_id) then
    perform private.fail('invalid_assignee');
  end if;

  v_now := pg_catalog.clock_timestamp();
  insert into public.actions (workspace_id, finding_id, session_id, subject_id, location_id, issue, action_required,
    severity, assignee_id, due_date, created_by, created_at, updated_at)
  values (v_s.workspace_id, v_f.id, v_f.session_id, v_f.subject_id, v_s.location_id, btrim(p_issue), btrim(p_action_required),
    p_severity, p_assignee, p_due_date, v_uid, v_now, v_now)
  returning * into v_a;
  insert into public.action_events (workspace_id, action_id, kind, from_status, to_status, before, after, actor_id,
    idempotency_key, payload_hash, created_at)
  values (v_s.workspace_id, v_a.id, 'create', null, 'open', null, private.action_state(v_a), v_uid,
    p_idempotency_key, v_hash, v_now)
  returning id into v_event;
  perform private.notify(v_s.workspace_id, p_assignee, 'action_assigned', 'assigned:' || v_event, v_a.id, null, null,
    jsonb_build_object('due_date', p_due_date));
  perform private.audit(v_s.workspace_id, 'action.created', v_a.id, jsonb_build_object('finding_id', v_f.id,
    'session_id', v_f.session_id, 'subject_id', v_f.subject_id, 'severity', p_severity, 'assignee_id', p_assignee,
    'due_date', p_due_date));
  return jsonb_build_object('action_id', v_a.id, 'version', v_a.version, 'status', v_a.status, 'replayed', false);
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: a new sample needs write access. Samples never
-- reserve or count (their subjects are created here with is_sample, which no caller can set).
create or replace function private.create_sample_session(p_ws uuid, p_location uuid, p_template_version uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_id uuid;
  v_subjects uuid[] := '{}';
  v_mode public.attendance_mode;
  v_pack public.starter_pack;
  v_sid uuid;
  r record;
begin
  perform private.lock_directory(p_ws);
  perform private.require_writable(p_ws);  -- M4
  if not exists (select 1 from public.locations where id = p_location and workspace_id = p_ws and archived_at is null) then
    perform private.fail('not_found', 'location');
  end if;
  select tv.attendance_mode, t.pack into v_mode, v_pack from public.template_versions tv
  join public.templates t on t.id = tv.template_id
  where tv.id = p_template_version and tv.workspace_id = p_ws;
  if v_mode is null then perform private.fail('not_found', 'template version'); end if;
  for r in select * from private.sample_subjects_for(v_pack) order by name loop
    v_sid := null;
    select id into v_sid from public.subjects where workspace_id = p_ws and is_sample and archived_at is null
      and name = r.name and subject_type = r.subject_type;
    if v_sid is null then
      if exists (select 1 from public.subjects where workspace_id = p_ws and private.norm_name(name) = private.norm_name(r.name)) then
        perform private.fail('duplicate_name', r.name);
      end if;
      insert into public.subjects (workspace_id, name, subject_type, is_sample) values (p_ws, r.name, r.subject_type, true)
      returning id into v_sid;
    end if;
    v_subjects := v_subjects || v_sid;
  end loop;
  insert into public.sessions (workspace_id, location_id, template_version_id, name, local_date, opens_at, closes_at,
    expected_ready_time, created_by, is_sample, opened_at, planned_window_hours)
  values (p_ws, p_location, p_template_version, 'SAMPLE - Practice inspection',
    (now() at time zone (select timezone from public.workspaces where id = p_ws))::date, now(), now() + interval '48 hours',
    case when v_mode = 'scored' then time '09:00' end, v_uid, true, now(), 48)
  returning id into v_id;
  insert into public.session_subjects (workspace_id, session_id, subject_id, subject_name)
  select p_ws, v_id, s.id, s.name from public.subjects s where s.id = any (v_subjects);
  insert into public.session_assignments (workspace_id, session_id, subject_id, user_id)
  select p_ws, v_id, s, v_uid from unnest(v_subjects) s;
  insert into public.session_reviewers (workspace_id, session_id, user_id) values (p_ws, v_id, v_uid);
  perform private.audit(p_ws, 'session.sample_created', v_id, jsonb_build_object('subjects', cardinality(v_subjects),
    'pack', v_pack));
  return v_id;
end $$;


-- ---------------------------------------------------------------------------
-- Remaining edit writers gated for read-only (M4 review finding 2)
-- ---------------------------------------------------------------------------
-- Diff from 20261010230959_m2_directory.sql: needs write access except a pure archive (same name).
create or replace function private.save_category(p_ws uuid, p_id uuid, p_name text, p_archived boolean, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name text := private.clean_text(p_name);
  v_c public.categories;
begin
  perform private.lock_directory(p_ws);
  -- M4: write access, except a pure archive of an existing category (same name).
  if not (p_id is not null and coalesce(p_archived, false) and exists (select 1 from public.categories c
      where c.id = p_id and c.workspace_id = p_ws and c.name = v_name)) then
    perform private.require_writable(p_ws);
  end if;
  if v_name is null or length(v_name) > 80 or v_name ~ '[[:cntrl:]]' then perform private.fail('invalid_name'); end if;
  if exists (select 1 from public.categories c where c.workspace_id = p_ws
             and private.norm_name(c.name) = private.norm_name(v_name) and c.id is distinct from p_id) then
    perform private.fail('duplicate_name', v_name);
  end if;
  if p_id is null then
    insert into public.categories (workspace_id, name, archived_at)
    values (p_ws, v_name, case when p_archived then now() end) returning * into v_c;
  else
    select * into v_c from public.categories where id = p_id and workspace_id = p_ws for no key update;
    if not found then perform private.fail('not_found', 'category'); end if;
    if p_expected_version is null or v_c.version <> p_expected_version then perform private.fail('stale_version'); end if;
    update public.categories set name = v_name,
      archived_at = case when p_archived then coalesce(archived_at, now()) end, version = version + 1
    where id = p_id returning * into v_c;
  end if;
  perform private.audit(p_ws, 'category.saved', v_c.id, jsonb_build_object('name', v_name, 'archived', coalesce(p_archived, false)));
  return jsonb_build_object('id', v_c.id, 'version', v_c.version);
end $$;

-- Diff from 20261010230959_m2_directory.sql: saving a contact needs write access; removal stays allowed.
create or replace function private.save_subject_contact(p_ws uuid, p_subject uuid, p_name text, p_phone text, p_email text,
  p_expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_name text := private.clean_text(p_name);
  v_phone text := private.clean_text(p_phone);
  v_email text := lower(private.clean_text(p_email));
  v_c public.subject_contacts;
begin
  perform private.lock_directory(p_ws);
  -- M4: removing a contact (all blank) is an allowed reduction; adding or changing one needs write access.
  if coalesce(v_name, v_phone, v_email) is not null then perform private.require_writable(p_ws); end if;
  if not exists (select 1 from public.subjects where id = p_subject and workspace_id = p_ws) then
    perform private.fail('not_found', 'subject');
  end if;
  select * into v_c from public.subject_contacts where subject_id = p_subject for no key update;
  if p_expected_version is null or coalesce(v_c.version, 0) <> p_expected_version then perform private.fail('stale_version'); end if;
  if length(v_name) > 120 or length(v_phone) > 40 or v_phone ~ '[[:cntrl:]]' then perform private.fail('invalid_contact'); end if;
  if v_email is not null and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254) then
    perform private.fail('invalid_email');
  end if;
  if coalesce(v_name, v_phone, v_email) is null then
    delete from public.subject_contacts where subject_id = p_subject;
    perform private.audit(p_ws, 'subject.contact_removed', p_subject);
    return 0;
  end if;
  insert into public.subject_contacts (workspace_id, subject_id, name, phone, email, updated_by)
  values (p_ws, p_subject, v_name, v_phone, v_email, (select auth.uid()))
  on conflict (subject_id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email,
    version = public.subject_contacts.version + 1, updated_by = excluded.updated_by, updated_at = now()
  returning * into v_c;
  -- Field names only: contact values are not copied into the audit trail.
  perform private.audit(p_ws, 'subject.contact_saved', p_subject, jsonb_build_object('version', v_c.version,
    'fields', to_jsonb(array_remove(array[case when v_name is not null then 'name' end,
      case when v_phone is not null then 'phone' end, case when v_email is not null then 'email' end], null))));
  return v_c.version;
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: editing a draft needs write access.
create or replace function private.update_session_draft(p_session uuid, p_name text, p_local_date date, p_location uuid,
  p_template_version uuid, p_window_hours integer, p_ready_time time, p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_s public.sessions := private.lock_session(p_session);
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status <> 'draft' then perform private.fail('invalid_state'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  perform private.require_writable(v_s.workspace_id);  -- M4
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then perform private.fail('invalid_name'); end if;
  if p_local_date is null then perform private.fail('invalid_date'); end if;
  if coalesce(p_window_hours, 0) not between 1 and 168 then perform private.fail('invalid_window'); end if;
  if not exists (select 1 from public.locations where id = p_location and workspace_id = v_s.workspace_id and archived_at is null) then
    perform private.fail('not_found', 'location');
  end if;
  if not exists (select 1 from public.template_versions where id = p_template_version and workspace_id = v_s.workspace_id) then
    perform private.fail('not_found', 'template version');
  end if;
  update public.sessions set name = btrim(p_name), local_date = p_local_date, location_id = p_location,
    template_version_id = p_template_version, planned_window_hours = p_window_hours, expected_ready_time = p_ready_time,
    opens_at = now(), closes_at = now() + make_interval(hours => p_window_hours), data_version = data_version + 1
  where id = p_session;
  perform private.audit(v_s.workspace_id, 'session.draft_updated', p_session, jsonb_build_object(
    'name', btrim(p_name), 'local_date', p_local_date, 'location_id', p_location, 'template_version_id', p_template_version,
    'window_hours', p_window_hours));
  return v_s.data_version + 1;
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: adding a reviewer needs write access.
create or replace function private.set_session_reviewer(p_session uuid, p_user uuid, p_on boolean, p_reason text,
  p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_reason text;
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status not in ('draft', 'open', 'in_review') then perform private.fail('session_locked'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  v_reason := case when v_s.status = 'draft' then nullif(btrim(coalesce(p_reason, '')), '') else private.require_reason(p_reason) end;
  if coalesce(p_on, false) then
    perform private.require_writable(v_s.workspace_id);  -- M4: adding scope; removal stays allowed
    if not exists (select 1 from public.memberships m where m.workspace_id = v_s.workspace_id and m.user_id = p_user
        and m.status = 'active' and (m.expires_at is null or m.expires_at > now()) and m.role in ('owner', 'admin', 'reviewer')
        and private.user_in_location(v_s.workspace_id, p_user, v_s.location_id)) then
      perform private.fail('invalid_reviewer', 'reviewers must be active and hold the session location');
    end if;
    insert into public.session_reviewers (workspace_id, session_id, user_id) values (v_s.workspace_id, p_session, p_user)
    on conflict do nothing;
  else
    delete from public.session_reviewers where session_id = p_session and user_id = p_user;
    if not found then perform private.fail('not_found', 'reviewer'); end if;
    if v_s.status <> 'draft' and not exists (select 1 from public.session_reviewers where session_id = p_session) then
      perform private.fail('reviewer_required');
    end if;
  end if;
  update public.sessions set data_version = data_version + 1 where id = p_session;
  perform private.audit(v_s.workspace_id, case when p_on then 'reviewer.added' else 'reviewer.removed' end, p_session,
    jsonb_build_object('user_id', p_user, 'reason', v_reason, 'status', v_s.status));
  return v_s.data_version + 1;
end $$;

-- Diff from 20261010231001_m2_session_lifecycle.sql: changing a window (draft or collecting) needs write access.
create or replace function private.update_session_window(p_session uuid, p_hours integer, p_reason text, p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_reason text;
  v_close timestamptz;
  v_moved integer := 0;
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  perform private.require_writable(v_s.workspace_id);  -- M4
  if coalesce(p_hours, 0) not between 1 and 168 then perform private.fail('invalid_window'); end if;
  if v_s.status = 'draft' then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    update public.sessions set planned_window_hours = p_hours, closes_at = opens_at + make_interval(hours => p_hours),
      data_version = data_version + 1 where id = p_session;
  elsif private.session_collecting(v_s) then
    v_reason := private.require_reason(p_reason);
    v_close := now() + make_interval(hours => p_hours);
    update public.sessions set closes_at = v_close, data_version = data_version + 1 where id = p_session;
    v_moved := private.move_guest_grants(p_session, v_s.closes_at, v_close);
  else
    perform private.fail('invalid_state');
  end if;
  perform private.audit(v_s.workspace_id, 'session.window_changed', p_session, jsonb_build_object(
    'hours', p_hours, 'reason', v_reason, 'from_closes_at', v_s.closes_at, 'to_closes_at', v_close,
    'guest_grants_moved', v_moved, 'status', v_s.status));
  return v_s.data_version + 1;
end $$;

-- Diff from 20261011144333_m3_actions_inbox.sql: editing an action needs write access (after the session
-- lock, row lock and idempotent replay). Transitions of existing actions (progress) stay allowed.
create or replace function private.update_action(p_action uuid, p_expected_version integer, p_issue text, p_action_required text,
  p_severity text, p_assignee uuid, p_due_date date, p_reason text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_a public.actions;
  v_new public.actions;
  v_s public.sessions;
  v_prior public.action_events;
  v_hash text;
  v_now timestamptz;
  v_event uuid;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  select * into v_a from public.actions where id = p_action;
  if not found or private.member_role(v_a.workspace_id) is null then perform private.fail('not_found', 'action'); end if;
  if not private.can_review(v_a.session_id) then perform private.fail('forbidden'); end if;
  v_s := private.lock_session(v_a.session_id);
  if not private.can_review(v_a.session_id) then perform private.fail('forbidden'); end if;
  select * into v_a from public.actions where id = p_action for no key update;
  v_hash := private.sha256_hex(jsonb_build_object('action', p_action, 'command', 'update', 'expected_version', p_expected_version,
    'issue', p_issue, 'action_required', p_action_required, 'severity', p_severity, 'assignee', p_assignee,
    'due_date', p_due_date, 'reason', p_reason)::text);
  select * into v_prior from public.action_events where actor_id = v_uid and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.action_id <> p_action or v_prior.kind <> 'update' or v_prior.payload_hash <> v_hash then
      perform private.fail('idempotency_conflict');
    end if;
    return jsonb_build_object('action_id', v_prior.action_id, 'version', (v_prior.after ->> 'version')::integer,
      'status', v_prior.to_status, 'replayed', true);
  end if;
  if p_expected_version is null or v_a.version <> p_expected_version then perform private.fail('stale_version'); end if;
  perform private.require_writable(v_a.workspace_id);  -- M4: editing work needs write access; transitions stay allowed
  if v_a.status not in ('open', 'in_progress', 'ready_for_verification') then perform private.fail('invalid_state'); end if;
  if length(coalesce(btrim(p_reason), '')) > 500 then perform private.fail('reason_too_long'); end if;

  v_new := v_a;
  if p_issue is not null then
    if length(btrim(p_issue)) not between 1 and 300 then perform private.fail('invalid_issue'); end if;
    v_new.issue := btrim(p_issue);
  end if;
  if p_action_required is not null then
    if length(btrim(p_action_required)) not between 1 and 2000 then perform private.fail('invalid_action_required'); end if;
    v_new.action_required := btrim(p_action_required);
  end if;
  if p_severity is not null then v_new.severity := private.require_severity(p_severity); end if;
  if p_due_date is not null and p_due_date <> v_a.due_date then
    v_new.due_date := private.require_due_date(v_a.workspace_id, p_due_date);
  end if;
  if p_assignee is not null and p_assignee <> v_a.assignee_id then
    if not private.can_be_assignee(v_a.workspace_id, p_assignee, v_a.location_id) then perform private.fail('invalid_assignee'); end if;
    v_new.assignee_id := p_assignee;
  end if;
  if private.action_state(v_new) = private.action_state(v_a) then perform private.fail('no_change'); end if;
  -- Submitted evidence answers the work as it was. While it awaits verification only the due date
  -- may change; changing the work or its owner first needs a reasoned return (which clears the
  -- resolution), so old evidence can never close different work.
  if v_a.status = 'ready_for_verification' and (v_new.issue <> v_a.issue or v_new.action_required <> v_a.action_required
      or v_new.severity <> v_a.severity or v_new.assignee_id <> v_a.assignee_id) then
    perform private.fail('return_required', 'return the action for more work before changing the work, severity or assignee');
  end if;

  v_now := pg_catalog.clock_timestamp();
  update public.actions set issue = v_new.issue, action_required = v_new.action_required, severity = v_new.severity,
    due_date = v_new.due_date, assignee_id = v_new.assignee_id, version = version + 1, updated_at = v_now
  where id = p_action returning * into v_new;
  insert into public.action_events (workspace_id, action_id, kind, from_status, to_status, before, after, actor_id, reason,
    idempotency_key, payload_hash, created_at)
  values (v_a.workspace_id, p_action, 'update', v_a.status, v_new.status, private.action_state(v_a), private.action_state(v_new),
    v_uid, nullif(btrim(coalesce(p_reason, '')), ''), p_idempotency_key, v_hash, v_now)
  returning id into v_event;
  if v_new.assignee_id <> v_a.assignee_id then
    perform private.notify(v_a.workspace_id, v_new.assignee_id, 'action_assigned', 'assigned:' || v_event, p_action, null, null,
      jsonb_build_object('due_date', v_new.due_date));
  end if;
  perform private.audit(v_a.workspace_id, case when v_new.assignee_id <> v_a.assignee_id then 'action.reassigned' else 'action.updated' end,
    p_action, jsonb_build_object('before', private.action_state(v_a), 'after', private.action_state(v_new),
      'reason', nullif(btrim(coalesce(p_reason, '')), '')));
  return jsonb_build_object('action_id', p_action, 'version', v_new.version, 'status', v_new.status, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- In-app past-due notices (Owner only; days 0, 3 and 6 of SAVOUR's 7-day grace)
-- ---------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_catalog.pg_constraint
           where conrelid = 'public.notifications'::regclass and contype = 'c'
             and (pg_catalog.pg_get_constraintdef(oid) like '%kind%' or pg_catalog.pg_get_constraintdef(oid) like '%num_nonnulls%')
  loop
    execute format('alter table public.notifications drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.notifications add constraint notifications_kind_check check (kind in ('correction_requested',
  'action_assigned', 'action_ready', 'action_returned', 'action_verified', 'action_cancelled', 'action_reopened',
  'action_due_today', 'action_overdue', 'session_approved', 'billing_past_due'));
alter table public.notifications add constraint notifications_entity_check
  check (kind = 'billing_past_due' or num_nonnulls(action_id, session_id, correction_id) >= 1);

-- Diff from 20261011144333_m3_actions_inbox.sql: billing_past_due is live only for a current Owner
-- while the workspace is still in grace for the same anchor.
create or replace function private.render_notification(n public.notifications) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_a public.actions;
  v_s public.sessions;
  v_cr public.correction_requests;
  v_subject text;
  v_base text := '/w/' || n.workspace_id;
  v_access jsonb;
begin
  if n.recipient_id is distinct from v_uid then return null; end if;
  if n.kind = 'billing_past_due' then
    if not private.has_role(n.workspace_id, '{owner}') then return null; end if;
    v_access := private.billing_core(n.workspace_id);
    if v_access ->> 'state' <> 'past_due' or v_access ->> 'grace_anchor' is distinct from n.meta ->> 'anchor' then return null; end if;
    return jsonb_build_object('title', 'Renewal payment failed',
      'body', 'Paid access continues until ' || to_char((v_access ->> 'grace_ends_at')::timestamptz at time zone
        (select timezone from public.workspaces where id = n.workspace_id), 'YYYY-MM-DD HH24:MI')
        || ' (workspace time). Bachs retries the card on its own schedule and emails your billing contact; SAVOUR never charges again itself.',
      'link', v_base || '/billing');
  end if;
  if n.kind = 'correction_requested' then
    select * into v_cr from public.correction_requests where id = n.correction_id;
    if not found or v_cr.status <> 'open' or v_cr.assessor_id <> v_uid
       or not private.is_assigned(v_cr.session_id, v_cr.subject_id) then
      return null;
    end if;
    select * into v_s from public.sessions where id = v_cr.session_id;
    select subject_name into v_subject from public.session_subjects where session_id = v_cr.session_id and subject_id = v_cr.subject_id;
    return jsonb_build_object('title', 'Correction requested', 'body', v_subject || ' — ' || v_s.name,
      'link', v_base || '/sessions/' || v_s.id || '/assess/' || v_cr.subject_id);
  elsif n.kind = 'session_approved' then
    if not private.can_review(n.session_id) then return null; end if;
    select * into v_s from public.sessions where id = n.session_id;
    return jsonb_build_object('title', 'Session approved', 'body', v_s.name || ' — revision ' || coalesce(n.meta ->> 'revision', '?'),
      'link', v_base || '/sessions/' || v_s.id || '/report?revision=' || coalesce(n.meta ->> 'revision', ''));
  end if;
  select * into v_a from public.actions where id = n.action_id;
  if not found or not (private.can_review(v_a.session_id) or private.is_live_assignee(v_a.id)) then return null; end if;
  if n.kind = 'action_assigned' and not private.is_live_assignee(v_a.id) then return null; end if;
  -- A due reminder is live only while its own condition holds today (workspace-local date): a
  -- due-today notice goes stale once the day has ended, an overdue notice once finished.
  if n.kind in ('action_due_today', 'action_overdue') and (v_a.status in ('closed', 'cancelled')
      or v_a.due_date::text is distinct from n.meta ->> 'due_date'
      or private.due_state(v_a.status, v_a.due_date, private.workspace_today(v_a.workspace_id))
         <> case n.kind when 'action_due_today' then 'due_today' else 'overdue' end
      or not ((v_a.assignee_id = v_uid and private.is_live_assignee(v_a.id))
              or (v_a.created_by = v_uid and private.can_review(v_a.session_id)))) then
    return null;
  end if;
  select subject_name into v_subject from public.session_subjects where session_id = v_a.session_id and subject_id = v_a.subject_id;
  return jsonb_build_object('title', case n.kind
      when 'action_assigned' then 'Action assigned to you' when 'action_ready' then 'Action ready for verification'
      when 'action_returned' then 'Action returned for more work' when 'action_verified' then 'Action verified and closed'
      when 'action_cancelled' then 'Action cancelled' when 'action_reopened' then 'Action reopened'
      when 'action_due_today' then 'Action due today' else 'Action overdue' end,
    'body', left(v_a.issue, 120) || ' — ' || v_subject || ' · due ' || v_a.due_date,
    'status', v_a.status, 'link', v_base || '/actions/' || v_a.id);
end $$;

-- ---------------------------------------------------------------------------
-- Owner billing reads and commands (public invoker wrapper -> private definer)
-- ---------------------------------------------------------------------------
create function private.require_owner(p_ws uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_role public.member_role;
begin
  perform private.require_uid();
  v_role := private.member_role(p_ws);
  if v_role is null then perform private.fail('not_found', 'workspace'); end if;
  if v_role <> 'owner' then perform private.fail('forbidden'); end if;
end $$;

-- One price row as the Owner sees it, with an explicit availability reason.
-- What an Owner may buy in one currency right now, with an explicit reason when it is unavailable.
-- New checkouts use the platform default connection; a business with a subscription sees its own
-- pinned subscription price instead (it never moves to the default).
create function private.currency_offer(p_ws uuid, p_currency text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_b billing.workspace_billing;
  v_conn platform.provider_connections;
  v_p billing.plan_prices;
  v_reason text;
begin
  select * into v_b from billing.workspace_billing where workspace_id = p_ws;
  select c.* into v_conn from platform.settings s join platform.provider_connections c on c.id = s.default_connection_id;
  if v_conn.id is not null then
    select * into v_p from billing.plan_prices where connection_id = v_conn.id and plan_code = v_b.plan_code and currency = p_currency
      and status = 'configured';
  end if;
  v_reason := case
    when v_conn.id is null then 'provider_not_connected'
    when not v_conn.accepting_new then 'provider_unavailable'
    when v_p.id is null then 'price_not_configured'
    when v_p.recurring_capability = 'unverified' then 'recurring_not_verified'
    when v_b.billing_currency is not null and v_b.billing_currency <> p_currency then 'currency_pinned'
    end;
  return jsonb_build_object('currency', p_currency, 'exponent', (select exponent from billing.currencies where code = p_currency),
    'provider', (select display_name from platform.providers where code = v_conn.provider_code),
    'price_id', v_p.id, 'version', v_p.version, 'amount_minor', v_p.amount_minor,
    'amount', case when v_p.id is not null then billing.from_minor(v_p.amount_minor, v_p.currency) end,
    'label', coalesce(v_p.label, 'Sandbox proposal for testing. Not an approved commercial price.'),
    'recurring_capability', v_p.recurring_capability, 'environment', 'sandbox', 'unavailable_reason', v_reason);
end $$;
create function private.get_billing(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role public.member_role;
  v_b billing.workspace_billing;
  v_sub billing.subscriptions;
  v_intent billing.checkout_intents;
begin
  perform private.require_uid();
  v_role := private.member_role(p_ws);
  if v_role is null then perform private.fail('not_found', 'workspace'); end if;
  if v_role = 'guest' then perform private.fail('forbidden'); end if;
  if v_role <> 'owner' then
    return jsonb_build_object('view', 'member', 'access', private.access_summary(p_ws, v_role));
  end if;
  select * into v_b from billing.workspace_billing where workspace_id = p_ws;
  if not found then perform private.fail('billing_not_initialized'); end if;
  select * into v_sub from billing.subscriptions where workspace_id = p_ws and binding = 'current';
  select * into v_intent from billing.checkout_intents where workspace_id = p_ws
    and status in ('created', 'requesting', 'open', 'uncertain', 'completed_unpaid', 'review');
  return jsonb_build_object('view', 'owner',
    'version', v_b.version,
    'access', private.effective_access(p_ws),
    'plan', (select jsonb_build_object('code', p.code, 'name', p.name, 'interval', p.billing_interval, 'limits', p.limits)
             from billing.plans p where p.code = v_b.plan_code),
    'trial_limits', v_b.trial_limits,
    'terms_version', billing.terms_version(),
    'environment', 'sandbox',
    'prices', jsonb_build_array(private.currency_offer(p_ws, 'NGN'), private.currency_offer(p_ws, 'USD')),
    'billing_currency', v_b.billing_currency,
    'billing_contact', case when v_b.billing_email is not null then jsonb_build_object('email', v_b.billing_email,
      'consent_at', v_b.billing_email_consent_at,
      'locked', exists (select 1 from billing.provider_customers c where c.workspace_id = p_ws and c.bound_at is not null)) end,
    'customer_bound', exists (select 1 from billing.provider_customers c where c.workspace_id = p_ws and c.bound_at is not null),
    'subscription', case when v_sub.provider_subscription_id is not null then jsonb_build_object(
      'status', v_sub.provider_status, 'currency', v_sub.currency, 'amount_minor', v_sub.amount_minor,
      'amount', billing.from_minor(v_sub.amount_minor, v_sub.currency),
      'cancel_at_period_end', v_sub.cancel_at_period_end, 'cancel_requested_at', v_sub.cancel_requested_at,
      'cancellation', case when v_sub.provider_status = 'canceled' then 'ended'
        when v_sub.cancel_at_period_end then 'confirmed'
        when v_sub.cancel_requested_at is not null then 'pending' else 'none' end,
      'canceled_at', v_sub.canceled_at, 'current_period_end', v_sub.current_period_end,
      'status_observed_at', v_sub.status_observed_at) end,
    'pending_checkout', case when v_intent.id is not null then jsonb_build_object('id', v_intent.id, 'status', v_intent.status,
      'currency', v_intent.currency, 'amount_minor', v_intent.amount_minor,
      'amount', billing.from_minor(v_intent.amount_minor, v_intent.currency), 'created_at', v_intent.created_at,
      'checkout_url', case when v_intent.status = 'open' and v_intent.checkout_expires_at > now() then v_intent.checkout_url end,
      'checkout_expires_at', v_intent.checkout_expires_at) end,
    'recent_checkouts', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'status', i.status, 'currency', i.currency,
        'amount', billing.from_minor(i.amount_minor, i.currency), 'created_at', i.created_at) order by i.created_at desc)
      from (select * from billing.checkout_intents where workspace_id = p_ws order by created_at desc limit 5) i), '[]'),
    'ledger', coalesce((select jsonb_agg(jsonb_build_object('currency', x.currency, 'amount_minor', x.amount_minor,
        'amount', billing.from_minor(x.amount_minor, x.currency), 'period_start', x.period_start, 'period_end', x.period_end,
        'refund_state', x.refund_state, 'dispute_state', x.dispute_state, 'review_flag', x.review_flag,
        'revoked', x.revoked_at is not null) order by x.period_start desc)
      from (select * from billing.paid_periods where workspace_id = p_ws order by period_start desc limit 24) x), '[]'),
    -- Grouped by currency; NGN and USD are never added together.
    'totals_by_currency', coalesce((select jsonb_agg(jsonb_build_object('currency', t.currency, 'paid_minor', t.total,
        'paid', billing.from_minor(t.total, t.currency)) order by t.currency)
      from (select currency, sum(amount_minor)::bigint as total from billing.paid_periods
            where workspace_id = p_ws and revoked_at is null and refund_state = 'none' group by currency) t), '[]'),
    'review_required', exists (select 1 from billing.review_queue r where r.workspace_id = p_ws and r.resolved_at is null));
end $$;

-- The Owner nominates a billing email for THIS workspace (never the login email by default) and
-- consents that Bachs uses it for receipts and payment recovery. Distinct across workspaces.
create function private.set_billing_contact(p_ws uuid, p_email text, p_consent boolean, p_expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_b billing.workspace_billing;
begin
  perform private.require_owner(p_ws);
  v_b := private.lock_billing(p_ws);
  if p_expected_version is null or v_b.version <> p_expected_version then perform private.fail('stale_version'); end if;
  if exists (select 1 from billing.provider_customers c where c.workspace_id = p_ws) then perform private.fail('billing_contact_locked'); end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 or v_email ~ '[[:cntrl:]]' then
    perform private.fail('invalid_email');
  end if;
  if not coalesce(p_consent, false) then perform private.fail('consent_required'); end if;
  begin
    update billing.workspace_billing set billing_email = v_email, billing_email_consent_at = now(),
      billing_email_consent_by = (select auth.uid()), version = version + 1, updated_at = now()
    where workspace_id = p_ws;
  exception when unique_violation then
    perform private.fail('billing_email_in_use');
  end;
  perform private.audit(p_ws, 'billing.contact_set', p_ws, jsonb_build_object('version', v_b.version + 1));
  return v_b.version + 1;
end $$;

-- Persists the checkout intent (pinned plan, price row and version, currency, exact amount, product,
-- consent, unique reference and idempotency key) BEFORE any provider call. Exclusive per workspace.
create function private.begin_checkout(p_ws uuid, p_currency text, p_price_id uuid, p_terms_version text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_b billing.workspace_billing;
  v_conn platform.provider_connections;
  v_p billing.plan_prices;
  v_id uuid := gen_random_uuid();
  v_ref text := 'savour_ck_' || replace(gen_random_uuid()::text, '-', '');
begin
  perform private.require_owner(p_ws);
  v_b := private.lock_billing(p_ws);
  if v_b.suspended_at is not null then perform private.fail('workspace_suspended'); end if;
  if p_terms_version is distinct from billing.terms_version() then perform private.fail('terms_changed'); end if;
  if p_currency is null or p_currency not in ('NGN', 'USD') then perform private.fail('currency_unavailable'); end if;
  -- The default connection is read here and pinned on the intent (new checkouts only).
  select c.* into v_conn from platform.settings s join platform.provider_connections c on c.id = s.default_connection_id;
  if v_conn.id is null then perform private.fail('provider_not_connected'); end if;
  if not v_conn.accepting_new then perform private.fail('provider_unavailable'); end if;
  select * into v_p from billing.plan_prices where connection_id = v_conn.id and plan_code = v_b.plan_code and currency = p_currency
    and status = 'configured';
  if not found then perform private.fail('price_not_configured', p_currency); end if;
  if v_p.recurring_capability = 'unverified' then perform private.fail('recurring_not_verified', p_currency); end if;
  if v_p.id is distinct from p_price_id then perform private.fail('price_changed'); end if;
  if v_b.billing_currency is not null and v_b.billing_currency <> p_currency then perform private.fail('currency_pinned', v_b.billing_currency); end if;
  if v_b.billing_email is null then perform private.fail('billing_contact_required'); end if;
  -- An intent that never reached the provider (status created) is superseded by this new consent.
  update billing.checkout_intents set status = 'abandoned', resolved_at = now(), last_error_code = 'superseded', version = version + 1,
    updated_at = now() where workspace_id = p_ws and status = 'created';
  if exists (select 1 from billing.checkout_intents where workspace_id = p_ws
             and status in ('requesting', 'open', 'uncertain', 'completed_unpaid', 'review')) then
    perform private.fail('checkout_in_progress');
  end if;
  if exists (select 1 from billing.subscriptions where workspace_id = p_ws and binding = 'current' and provider_status <> 'canceled')
     or (private.billing_core(p_ws) ->> 'underlying_state') in ('active', 'cancel_scheduled', 'past_due') then
    perform private.fail('subscription_exists');
  end if;
  insert into billing.checkout_intents (id, workspace_id, connection_id, owner_id, plan_code, price_id, price_version, currency,
    amount_minor, provider_product_id, terms_version, consented_at, reference, idempotency_key)
  values (v_id, p_ws, v_conn.id, v_uid, v_b.plan_code, v_p.id, v_p.version, v_p.currency, v_p.amount_minor, v_p.provider_product_id,
    p_terms_version, now(), v_ref, 'savour-checkout-' || v_id);
  perform private.audit(p_ws, 'billing.checkout_intent_created', v_id, jsonb_build_object('currency', v_p.currency,
    'amount_minor', v_p.amount_minor, 'price_version', v_p.version, 'connection_id', v_conn.id));
  return jsonb_build_object('intent_id', v_id);
end $$;

-- Records the Owner's cancellation request (pending). Only a provider read can confirm it.
create function private.request_cancellation(p_ws uuid, p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_b billing.workspace_billing;
  v_sub billing.subscriptions;
begin
  perform private.require_owner(p_ws);
  v_b := private.lock_billing(p_ws);
  if p_expected_version is null or v_b.version <> p_expected_version then perform private.fail('stale_version'); end if;
  select * into v_sub from billing.subscriptions where workspace_id = p_ws and binding = 'current' for no key update;
  if not found or v_sub.provider_status = 'canceled' then perform private.fail('no_active_subscription'); end if;
  if v_sub.cancel_at_period_end then return jsonb_build_object('cancellation', 'confirmed'); end if;
  update billing.subscriptions set cancel_requested_at = now(), cancel_requested_by = (select auth.uid()), updated_at = now()
  where provider_subscription_id = v_sub.provider_subscription_id;
  update billing.workspace_billing set version = version + 1, updated_at = now() where workspace_id = p_ws;
  perform private.audit(p_ws, 'billing.cancellation_requested', p_ws, '{}'::jsonb);
  return jsonb_build_object('cancellation', 'pending');
end $$;

create function private.authorize_portal(p_ws uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_owner(p_ws);
  if not exists (select 1 from billing.provider_customers where workspace_id = p_ws and bound_at is not null) then
    perform private.fail('billing_portal_unavailable');
  end if;
  perform private.audit(p_ws, 'billing.portal_requested', p_ws, '{}'::jsonb);
  return true;
end $$;

create function public.get_billing(p_ws uuid) returns jsonb language sql stable security invoker set search_path = '' as
$$ select private.get_billing(p_ws) $$;
create function public.set_billing_contact(p_ws uuid, p_email text, p_consent boolean, p_expected_version integer) returns integer
language sql security invoker set search_path = '' as $$ select private.set_billing_contact(p_ws, p_email, p_consent, p_expected_version) $$;
create function public.begin_checkout(p_ws uuid, p_currency text, p_price_id uuid, p_terms_version text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.begin_checkout(p_ws, p_currency, p_price_id, p_terms_version) $$;
create function public.request_cancellation(p_ws uuid, p_expected_version integer) returns jsonb
language sql security invoker set search_path = '' as $$ select private.request_cancellation(p_ws, p_expected_version) $$;
create function public.authorize_portal(p_ws uuid) returns boolean
language sql security invoker set search_path = '' as $$ select private.authorize_portal(p_ws) $$;

-- ---------------------------------------------------------------------------
-- Shared internals for provider facts (no grants; called by the role entry points below)
-- ---------------------------------------------------------------------------
create function billing.review(p_conn uuid, p_ws uuid, p_kind text, p_dedupe text, p_refs jsonb, p_detail jsonb, p_event text)
returns void language sql security definer set search_path = '' as $$
  insert into billing.review_queue (connection_id, workspace_id, kind, dedupe_key, provider_refs, detail, source_event_id)
  values (p_conn, p_ws, p_kind, p_kind || ':' || coalesce(p_conn::text, '-') || ':' || p_dedupe, coalesce(p_refs, '{}'),
    coalesce(p_detail, '{}'), p_event)
  on conflict (dedupe_key) do nothing
$$;

-- Fencing: the caller must still hold the claim it received. Locks the event row (after the
-- workspace billing row, step 8). A null event means reconciliation without an event.
create function billing.fence(p_conn uuid, p_event text, p_token uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_event is null then return; end if;
  perform 1 from billing.webhook_inbox where connection_id = p_conn and event_id = p_event and status = 'processing' and claim_token = p_token
    and lease_until > clock_timestamp() for no key update;
  if not found then perform private.fail('stale_claim'); end if;
end $$;

create function billing.ts(p jsonb, k text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if p ->> k is null then return null; end if;
  return (p ->> k)::timestamptz;
exception when others then
  perform private.fail('invalid_facts', k);
end $$;

-- Applies a server-read subscription to the bound row when it is newer than what is stored.
create function billing.apply_subscription_facts(p_sub billing.subscriptions, p_facts jsonb, p_observed_at timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_observed_at <= p_sub.status_observed_at then return false; end if;
  update billing.subscriptions set provider_status = p_facts ->> 'status',
    cancel_at_period_end = coalesce((p_facts ->> 'cancel_at_period_end')::boolean, false),
    canceled_at = billing.ts(p_facts, 'canceled_at'),
    current_period_start = billing.ts(p_facts, 'current_period_start'),
    current_period_end = billing.ts(p_facts, 'current_period_end'),
    status_observed_at = p_observed_at,
    binding = case when p_facts ->> 'status' = 'canceled' and binding = 'current' then 'ended' else binding end,
    facts_sha256 = private.sha256_hex(p_facts::text), updated_at = now()
  where connection_id = p_sub.connection_id and provider_subscription_id = p_sub.provider_subscription_id;
  return true;
end $$;

-- Mismatches between a server-read subscription and what this workspace bought. Empty = consistent.
create function billing.subscription_problems(p_facts jsonb, p_customer text, p_product text, p_currency text, p_amount bigint)
returns text[] language plpgsql stable security definer set search_path = '' as $$
declare v text[] := '{}';
begin
  if p_facts ->> 'customer_id' is distinct from p_customer then v := v || 'customer'::text; end if;
  if p_facts ->> 'currency' is distinct from p_currency then v := v || 'currency'::text;
  elsif billing.to_minor(p_facts ->> 'amount', p_facts ->> 'currency') <> p_amount then v := v || 'amount'::text;
  end if;
  if p_facts ->> 'interval' is distinct from 'month' or (p_facts ->> 'frequency') is distinct from '1' then v := v || 'cadence'::text; end if;
  if (p_facts ->> 'quantity') is distinct from '1' then v := v || 'quantity'::text; end if;
  if p_facts ->> 'product_id' is distinct from p_product
     or (jsonb_typeof(p_facts -> 'item_product_ids') = 'array' and jsonb_array_length(p_facts -> 'item_product_ids') > 0
         and (jsonb_array_length(p_facts -> 'item_product_ids') <> 1 or p_facts -> 'item_product_ids' ->> 0 is distinct from p_product)) then
    v := v || 'product'::text;
  end if;
  if p_facts ->> 'status' in ('trialing', 'paused') then v := v || 'status'::text; end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- billing_intake: durable webhook receipt (called after the Edge receiver verified the signature)
-- ---------------------------------------------------------------------------
create function billing.ingest_event(p_conn uuid, p_event_id text, p_type text, p_created_at timestamptz, p_organization_id text,
  p_raw_body bytea, p_body_sha256 text, p_signature_timestamp bigint, p_quarantine_reason text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_existing billing.webhook_inbox;
  v_sha text := encode(sha256(p_raw_body), 'hex');
begin
  if v_sha is distinct from p_body_sha256 then perform private.fail('body_hash_mismatch'); end if;
  if p_quarantine_reason is not null and p_quarantine_reason !~ '^[a-z_]{3,60}$' then perform private.fail('invalid_quarantine_reason'); end if;
  if not exists (select 1 from platform.provider_connections where id = p_conn) then perform private.fail('unknown_connection'); end if;
  insert into billing.webhook_inbox (connection_id, event_id, event_type, provider_created_at, organization_id, raw_body, body_sha256,
    signature_timestamp, status, quarantine_reason)
  values (p_conn, p_event_id, p_type, p_created_at, p_organization_id, p_raw_body, v_sha, p_signature_timestamp,
    case when p_quarantine_reason is null then 'pending' else 'quarantined' end, p_quarantine_reason)
  on conflict (connection_id, event_id) do nothing;
  if found then
    if p_quarantine_reason is not null then
      perform billing.review(p_conn, null, 'webhook_quarantined', p_event_id, jsonb_build_object('event_id', p_event_id),
        jsonb_build_object('reason', p_quarantine_reason), p_event_id);
      return 'quarantined';
    end if;
    return 'inserted';
  end if;
  select * into v_existing from billing.webhook_inbox where connection_id = p_conn and event_id = p_event_id;
  if v_existing.body_sha256 = v_sha then return 'duplicate'; end if;
  -- Same ID, different bytes: keep the original untouched and record the collision for review.
  insert into billing.inbox_collisions (connection_id, event_id, body_sha256) values (p_conn, p_event_id, v_sha);
  perform billing.review(p_conn, null, 'webhook_id_collision', p_event_id || ':' || v_sha, jsonb_build_object('event_id', p_event_id),
    '{}'::jsonb, p_event_id);
  return 'collision';
end $$;

-- ---------------------------------------------------------------------------
-- billing_worker: claim, fence, absorb, complete
-- ---------------------------------------------------------------------------
create function billing.start_run(p_conn uuid, p_mode text, p_trigger text, p_worker text) returns uuid
language sql security definer set search_path = '' as $$
  insert into billing.worker_runs (connection_id, mode, trigger, worker, credential_version)
  values (p_conn, p_mode, p_trigger, p_worker, (select credential_version from platform.provider_connections where id = p_conn)) returning id
$$;

create function billing.finish_run(p_run uuid, p_claimed integer, p_done integer, p_failed integer, p_error_code text)
returns void language sql security definer set search_path = '' as $$
  update billing.worker_runs set finished_at = clock_timestamp(), claimed = coalesce(p_claimed, 0), done = coalesce(p_done, 0),
    failed = coalesce(p_failed, 0), error_code = p_error_code
  where id = p_run and finished_at is null
$$;

-- Claims due events (pending, failed past their backoff, or processing with an expired lease after a
-- worker crash). Committed on return; the caller then works outside any transaction.
create function billing.claim_events(p_conn uuid, p_worker text, p_limit integer, p_lease_seconds integer)
returns table (event_id text, event_type text, body text, claim_token uuid, attempts integer, lease_until timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if p_limit not between 1 and 50 or p_lease_seconds not between 30 and 900 then perform private.fail('invalid_claim'); end if;
  return query
  with due as (
    select i.connection_id, i.event_id from billing.webhook_inbox i
    where i.connection_id = p_conn
      and ((i.status in ('pending', 'failed') and i.next_attempt_at <= clock_timestamp())
       or (i.status = 'processing' and i.lease_until < clock_timestamp()))
    order by i.next_attempt_at, i.received_at
    limit p_limit
    for update skip locked)
  update billing.webhook_inbox w set status = 'processing', claim_token = gen_random_uuid(), claimed_by = p_worker,
    lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), attempts = w.attempts + 1
  from due where w.connection_id = due.connection_id and w.event_id = due.event_id
  returning w.event_id, w.event_type, convert_from(w.raw_body, 'UTF8'), w.claim_token, w.attempts, w.lease_until;
end $$;

create function billing.complete_event(p_conn uuid, p_event text, p_token uuid, p_outcome text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update billing.webhook_inbox set status = case when p_outcome like 'ignored%' then 'ignored' else 'done' end,
    outcome = left(p_outcome, 80), processed_at = clock_timestamp(), claim_token = null, lease_until = null, last_error_code = null
  where connection_id = p_conn and event_id = p_event and status = 'processing' and claim_token = p_token
    and lease_until > clock_timestamp();  -- an expired claim can never be marked done
  if not found then perform private.fail('stale_claim'); end if;
end $$;

-- Gives back a claimed event the worker did not start (not enough lease left): no attempt is consumed
-- and it is due immediately, so waiting in a batch can never exhaust its attempts.
create function billing.release_event(p_conn uuid, p_event text, p_token uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update billing.webhook_inbox set status = 'pending', attempts = greatest(attempts - 1, 0), next_attempt_at = clock_timestamp(),
    claim_token = null, lease_until = null, claimed_by = null
  where connection_id = p_conn and event_id = p_event and status = 'processing' and claim_token = p_token;
  if not found then perform private.fail('stale_claim'); end if;
end $$;

-- Retryable failure (provider timeout, 5xx, database error). Backoff 1m, 5m, 30m, 2h, 12h, 24h...;
-- dead after 8 attempts, with a review row. Never acknowledges anything to the provider.
create function billing.fail_event(p_conn uuid, p_event text, p_token uuid, p_error_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare v billing.webhook_inbox;
begin
  select * into v from billing.webhook_inbox where connection_id = p_conn and event_id = p_event and status = 'processing' and claim_token = p_token
  for no key update;
  if not found then perform private.fail('stale_claim'); end if;
  update billing.webhook_inbox set status = case when v.attempts >= 8 then 'dead' else 'failed' end,
    next_attempt_at = clock_timestamp() + (array['1 minute', '5 minutes', '30 minutes', '2 hours', '12 hours', '24 hours',
      '24 hours', '24 hours']::interval[])[least(greatest(v.attempts, 1), 8)],
    last_error_code = left(coalesce(p_error_code, 'error'), 80), claim_token = null, lease_until = null
  where connection_id = p_conn and event_id = p_event;
  if v.attempts >= 8 then
    perform billing.review(p_conn, null, 'webhook_dead', p_event, jsonb_build_object('event_id', p_event),
      jsonb_build_object('error', left(coalesce(p_error_code, 'error'), 80)), p_event);
  end if;
end $$;

-- Per-payment serialization (lock step P, taken by payment writers BEFORE the workspace billing row;
-- evidence writers never take it). Refund, dispute and payment absorption of the same provider payment
-- therefore run one at a time, so a refund tombstone and a paid-period insert can never both miss
-- each other.
create function billing.lock_payment(p_conn uuid, p_payment_id text) returns void
language sql security definer set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('savour.payment:' || p_conn::text || ':' || p_payment_id, 0))
$$;

-- Finds the checkout intent a provider object refers to (by our unique reference and/or the checkout
-- id we stored). Contradictory pointers return a mismatch marker.
create function billing.find_intent(p_conn uuid, p_checkout_id text, p_reference text) returns billing.checkout_intents
language plpgsql stable security definer set search_path = '' as $$
declare
  a billing.checkout_intents;
  b billing.checkout_intents;
begin
  if p_checkout_id is not null then select * into a from billing.checkout_intents where connection_id = p_conn and provider_checkout_id = p_checkout_id; end if;
  if p_reference is not null then select * into b from billing.checkout_intents where reference = p_reference;
  if b.id is not null and b.connection_id <> p_conn then perform private.fail('intent_pointer_conflict'); end if; end if;
  if a.id is not null and b.id is not null and a.id <> b.id then perform private.fail('intent_pointer_conflict'); end if;
  if a.id is not null and p_reference is not null and a.reference <> p_reference then perform private.fail('intent_pointer_conflict'); end if;
  if b.id is not null and p_checkout_id is not null and b.provider_checkout_id is not null and b.provider_checkout_id <> p_checkout_id then
    perform private.fail('intent_pointer_conflict');
  end if;
  return coalesce(a, b);
end $$;

-- GET /v1/checkout-sessions/{id}: binds the checkout to its intent, closes expired/cancelled ones and
-- keeps completed-but-unverified checkouts exclusive. Never grants entitlement.
create function billing.absorb_checkout(p_conn uuid, p_event text, p_token uuid, p_facts jsonb, p_observed_at timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  c jsonb := p_facts -> 'checkout';
  v_i billing.checkout_intents;
  v_b billing.workspace_billing;
  v_cust text;
  v_problems text[] := '{}';
begin
  if c is null or c ->> 'checkout_id' is null or c ->> 'status' not in ('open', 'completed', 'expired', 'cancelled') then
    perform private.fail('invalid_facts', 'checkout');
  end if;
  begin
    v_i := billing.find_intent(p_conn, c ->> 'checkout_id', c ->> 'reference');
  exception when others then
    perform billing.review(p_conn, null, 'checkout_pointer_conflict', c ->> 'checkout_id', jsonb_build_object('checkout_id', c ->> 'checkout_id'),
      '{}'::jsonb, p_event);
    return 'review:checkout_pointer_conflict';
  end;
  if v_i.id is null then
    perform billing.review(p_conn, null, 'unknown_checkout', c ->> 'checkout_id', jsonb_build_object('checkout_id', c ->> 'checkout_id'), '{}'::jsonb, p_event);
    return 'review:unknown_checkout';
  end if;
  v_b := private.lock_billing(v_i.workspace_id);
  perform billing.fence(p_conn, p_event, p_token);
  select provider_customer_id into v_cust from billing.provider_customers where workspace_id = v_i.workspace_id and connection_id = p_conn;
  select * into v_i from billing.checkout_intents where id = v_i.id for no key update;
  -- Binding of the checkout object itself.
  if c ->> 'reference' is distinct from v_i.reference then v_problems := v_problems || 'reference'::text; end if;
  if c ->> 'customer_id' is not null and c ->> 'customer_id' is distinct from v_cust then v_problems := v_problems || 'customer'::text; end if;
  if c ->> 'currency' is distinct from v_i.currency then v_problems := v_problems || 'currency'::text;
  elsif billing.to_minor(c ->> 'amount', c ->> 'currency') <> v_i.amount_minor then v_problems := v_problems || 'amount'::text;
  end if;
  if jsonb_typeof(c -> 'product_ids') = 'array' and (jsonb_array_length(c -> 'product_ids') <> 1
     or c -> 'product_ids' ->> 0 is distinct from v_i.provider_product_id) then v_problems := v_problems || 'product'::text; end if;
  if c -> 'recurring' is null or jsonb_typeof(c -> 'recurring') = 'null' or c -> 'recurring' ->> 'interval' is distinct from 'month'
     or coalesce(c -> 'recurring' ->> 'interval_count', '1') <> '1' then v_problems := v_problems || 'recurring'::text; end if;
  if cardinality(v_problems) > 0 then
    perform billing.review(p_conn, v_i.workspace_id, 'checkout_mismatch', v_i.id::text, jsonb_build_object('checkout_id', c ->> 'checkout_id'),
      jsonb_build_object('problems', to_jsonb(v_problems)), p_event);
    if v_i.status in ('created', 'requesting', 'open', 'uncertain', 'completed_unpaid') then
      update billing.checkout_intents set status = 'review', last_error_code = 'checkout_mismatch', version = version + 1, updated_at = now()
      where id = v_i.id;
    end if;
    return 'review:checkout_mismatch';
  end if;
  if v_i.provider_checkout_id is null then
    update billing.checkout_intents set provider_checkout_id = c ->> 'checkout_id', checkout_expires_at = billing.ts(c, 'expires_at'),
      updated_at = now() where id = v_i.id;
  end if;
  if v_i.status in ('requesting', 'uncertain', 'open', 'completed_unpaid', 'review') then
    if c ->> 'status' in ('expired', 'cancelled') then
      update billing.checkout_intents set status = 'expired', resolved_at = now(), version = version + 1, updated_at = now() where id = v_i.id;
      return 'checkout_closed';
    elsif c ->> 'status' = 'completed' and v_i.status <> 'review' then
      update billing.checkout_intents set status = 'completed_unpaid', version = version + 1, updated_at = now() where id = v_i.id;
      return 'checkout_completed';
    elsif c ->> 'status' = 'open' and v_i.status in ('requesting', 'uncertain') then
      update billing.checkout_intents set status = 'open', version = version + 1, updated_at = now() where id = v_i.id;
      return 'checkout_open';
    end if;
  end if;
  return 'checkout_unchanged';
end $$;

create function billing.payment_facts_sha(p jsonb) returns text
language sql immutable set search_path = '' as $$
  select private.sha256_hex(jsonb_build_object('payment_id', p ->> 'payment_id', 'amount', p ->> 'amount', 'currency', p ->> 'currency',
    'subscription_id', p ->> 'subscription_id', 'billing_reason', p ->> 'billing_reason',
    'invoice_id', p -> 'invoice' ->> 'invoice_id', 'period_start', p -> 'invoice' ->> 'period_start',
    'period_end', p -> 'invoice' ->> 'period_end')::text)
$$;

-- GET /v1/payments/{id} plus GET /v1/subscriptions/{id}: the only path that writes a paid period.
create function billing.absorb_payment(p_conn uuid, p_event text, p_token uuid, p_facts jsonb, p_observed_at timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := p_facts -> 'payment';
  s jsonb := p_facts -> 'subscription';
  v_pid text := p ->> 'payment_id';
  v_sid text := p ->> 'subscription_id';
  v_inv jsonb := p -> 'invoice';
  v_i billing.checkout_intents;
  v_bound billing.subscriptions;
  v_cur billing.subscriptions;
  v_ws uuid;
  v_b billing.workspace_billing;
  v_cust text;
  v_problems text[] := '{}';
  v_amount bigint;
  v_start timestamptz;
  v_end timestamptz;
  v_exp_product text;
  v_exp_currency text;
  v_exp_amount bigint;
  v_exp_price uuid;
  v_existing billing.paid_periods;
  v_sha text;
  li jsonb;
begin
  if p is null or v_pid is null or p ->> 'status' is null or p ->> 'currency' is null or p ->> 'amount' is null then
    perform private.fail('invalid_facts', 'payment');
  end if;
  if v_sid is null then
    perform billing.review(p_conn, null, 'payment_not_subscription', v_pid, jsonb_build_object('payment_id', v_pid), '{}'::jsonb, p_event);
    return 'review:payment_not_subscription';
  end if;
  if s is null or s ->> 'id' is distinct from v_sid then perform private.fail('invalid_facts', 'subscription'); end if;
  perform billing.lock_payment(p_conn, v_pid);

  select * into v_bound from billing.subscriptions where connection_id = p_conn and provider_subscription_id = v_sid;
  begin
    v_i := billing.find_intent(p_conn, p ->> 'checkout_id', p ->> 'reference');
  exception when others then
    perform billing.review(p_conn, null, 'payment_pointer_conflict', v_pid, jsonb_build_object('payment_id', v_pid), '{}'::jsonb, p_event);
    return 'review:payment_pointer_conflict';
  end;
  v_ws := coalesce(v_bound.workspace_id, v_i.workspace_id,
    (select workspace_id from billing.provider_customers where connection_id = p_conn and provider_customer_id = s ->> 'customer_id'));
  if v_ws is null then
    perform billing.review(p_conn, null, 'unbound_payment', v_pid, jsonb_build_object('payment_id', v_pid, 'subscription_id', v_sid), '{}'::jsonb, p_event);
    return 'review:unbound_payment';
  end if;
  if (v_bound.workspace_id is not null and v_bound.workspace_id <> v_ws) or (v_i.id is not null and v_i.workspace_id <> v_ws) then
    perform billing.review(p_conn, null, 'workspace_conflict', v_pid, jsonb_build_object('payment_id', v_pid, 'subscription_id', v_sid), '{}'::jsonb, p_event);
    return 'review:workspace_conflict';
  end if;

  v_b := private.lock_billing(v_ws);
  perform billing.fence(p_conn, p_event, p_token);
  select provider_customer_id into v_cust from billing.provider_customers where workspace_id = v_ws and connection_id = p_conn;
  select * into v_bound from billing.subscriptions where connection_id = p_conn and provider_subscription_id = v_sid for no key update;
  if v_i.id is not null then select * into v_i from billing.checkout_intents where id = v_i.id for no key update; end if;

  if v_cust is null or s ->> 'customer_id' is distinct from v_cust then
    perform billing.review(p_conn, v_ws, 'customer_mismatch', v_pid, jsonb_build_object('payment_id', v_pid, 'subscription_id', v_sid), '{}'::jsonb, p_event);
    return 'review:customer_mismatch';
  end if;
  if exists (select 1 from billing.payment_tombstones t where t.connection_id = p_conn and (t.provider_payment_id = v_pid
             or (v_inv ->> 'invoice_id' is not null and t.provider_invoice_id = v_inv ->> 'invoice_id'))) then
    perform billing.review(p_conn, v_ws, 'payment_tombstoned', v_pid, jsonb_build_object('payment_id', v_pid), '{}'::jsonb, p_event);
    return 'review:payment_tombstoned';
  end if;
  select * into v_existing from billing.paid_periods where connection_id = p_conn
    and (provider_payment_id = v_pid or provider_invoice_id = v_inv ->> 'invoice_id');
  if v_existing.id is not null then
    if p ->> 'status' in ('refunded', 'auto_refunded', 'partially_refunded') then
      return billing.absorb_refund(p_conn, p_event, p_token, jsonb_build_object('payment', p), p_observed_at);
    end if;
    if v_existing.facts_sha256 <> billing.payment_facts_sha(p) then
      perform billing.review(p_conn, v_ws, 'payment_facts_changed', v_pid, jsonb_build_object('payment_id', v_pid), '{}'::jsonb, p_event);
      return 'review:payment_facts_changed';
    end if;
    if v_bound.provider_subscription_id is not null and v_bound.binding = 'current' then
      perform billing.apply_subscription_facts(v_bound, s, p_observed_at);
    end if;
    return 'duplicate';
  end if;

  -- Renewal failure: anchor grace at the failed invoice period (bound current subscription only).
  if p ->> 'status' in ('failed', 'expired', 'cancelled') then
    if v_bound.binding = 'current' and p ->> 'billing_reason' = 'subscription_cycle' and v_inv is not null then
      insert into billing.payment_failures (connection_id, provider_subscription_id, period_start, workspace_id, period_end, provider_invoice_id)
      values (p_conn, v_sid, billing.ts(v_inv, 'period_start'), v_ws, billing.ts(v_inv, 'period_end'), v_inv ->> 'invoice_id')
      on conflict (connection_id, provider_subscription_id, period_start) do update set last_failed_at = clock_timestamp(),
        observations = billing.payment_failures.observations + 1,
        provider_invoice_id = coalesce(billing.payment_failures.provider_invoice_id, excluded.provider_invoice_id);
      perform billing.apply_subscription_facts(v_bound, s, p_observed_at);
      return 'renewal_failed';
    end if;
    -- A failed first payment grants nothing and starts no grace; the checkout may still be retried.
    return 'payment_failed_no_access';
  end if;
  if p ->> 'status' in ('refunded', 'auto_refunded', 'partially_refunded') then
    insert into billing.payment_tombstones (connection_id, provider_payment_id, provider_invoice_id, reason)
    values (p_conn, v_pid, v_inv ->> 'invoice_id', case when p ->> 'status' = 'partially_refunded' then 'partially_refunded' else 'refunded' end)
    on conflict do nothing;
    perform billing.review(p_conn, v_ws, 'refunded_before_verification', v_pid, jsonb_build_object('payment_id', v_pid), '{}'::jsonb, p_event);
    return 'review:refunded_before_verification';
  end if;
  if p ->> 'status' in ('created', 'processing') then
    return 'payment_pending';
  end if;
  if p ->> 'status' <> 'succeeded' then
    -- accepted/underpaid/overpaid: never sufficient (documentation is contradictory for accepted).
    perform billing.review(p_conn, v_ws, 'payment_not_exact', v_pid, jsonb_build_object('payment_id', v_pid),
      jsonb_build_object('status', p ->> 'status'), p_event);
    return 'review:payment_not_exact';
  end if;

  -- Expectations: the intent's pinned price for a new subscription, the subscription's pin after that.
  if v_bound.provider_subscription_id is null then
    if p ->> 'billing_reason' is distinct from 'subscription_create' then v_problems := v_problems || 'billing_reason'::text; end if;
    if v_i.id is null then v_problems := v_problems || 'intent'::text;
    elsif v_i.status not in ('requesting', 'open', 'uncertain', 'completed_unpaid', 'review') then v_problems := v_problems || 'intent_state'::text;
    end if;
    v_exp_product := v_i.provider_product_id; v_exp_currency := v_i.currency; v_exp_amount := v_i.amount_minor; v_exp_price := v_i.price_id;
    if v_i.id is not null and not ((p ->> 'reference' is not null and p ->> 'reference' = v_i.reference)
        or (p ->> 'checkout_id' is not null and p ->> 'checkout_id' = v_i.provider_checkout_id)) then
      v_problems := v_problems || 'reference'::text;
    end if;
  else
    if v_bound.binding <> 'current' then v_problems := v_problems || 'subscription_binding'::text; end if;
    if p ->> 'billing_reason' not in ('subscription_create', 'subscription_cycle') then v_problems := v_problems || 'billing_reason'::text; end if;
    v_exp_product := v_bound.provider_product_id; v_exp_currency := v_bound.currency; v_exp_amount := v_bound.amount_minor;
    v_exp_price := v_bound.price_id;
  end if;

  if p ->> 'currency' is distinct from v_exp_currency then v_problems := v_problems || 'currency'::text;
  else
    v_amount := billing.to_minor(p ->> 'amount', p ->> 'currency');
    if v_amount <> v_exp_amount then v_problems := v_problems || 'amount'::text; end if;
    -- Fully collected must be evidenced: amount_paid is required and exact, nothing remaining.
    if p ->> 'amount_paid' is null then v_problems := v_problems || 'amount_paid_missing'::text;
    elsif billing.to_minor(p ->> 'amount_paid', p ->> 'currency') <> v_amount then v_problems := v_problems || 'amount_paid'::text;
    end if;
    if p ->> 'amount_remaining' is not null and billing.to_minor(p ->> 'amount_remaining', p ->> 'currency') <> 0 then
      v_problems := v_problems || 'amount_remaining'::text;
    end if;
  end if;
  -- The payment object carries no customer ID (OpenAPI PaymentResponse.customer is {name, email}):
  -- the customer is bound through the server-read subscription (and checkout for a first payment);
  -- a payment email, when present, must be this workspace's billing email.
  if p ->> 'customer_email' is not null and lower(p ->> 'customer_email') is distinct from v_b.billing_email then
    v_problems := v_problems || 'customer_email'::text;
  end if;
  -- Without payment line items the product must be proven by exactly one subscription item.
  if jsonb_typeof(p -> 'line_items') is distinct from 'array'
     and (jsonb_typeof(s -> 'item_product_ids') is distinct from 'array' or jsonb_array_length(s -> 'item_product_ids') <> 1) then
    v_problems := v_problems || 'product_evidence_missing'::text;
  end if;
  if jsonb_typeof(p -> 'line_items') = 'array' then
    if jsonb_array_length(p -> 'line_items') <> 1 then v_problems := v_problems || 'line_items'::text;
    else
      li := p -> 'line_items' -> 0;
      if li ->> 'product_id' is distinct from v_exp_product or (li ->> 'quantity') is distinct from '1'
         or li ->> 'currency' is distinct from v_exp_currency
         or (li ->> 'currency' = v_exp_currency and billing.to_minor(li ->> 'unit_amount', li ->> 'currency') <> v_exp_amount) then
        v_problems := v_problems || 'line_items'::text;
      end if;
    end if;
  end if;
  if v_inv is null or v_inv ->> 'invoice_id' is null or v_inv ->> 'kind' is distinct from 'cycle'
     or (v_inv ->> 'subscription_id' is not null and v_inv ->> 'subscription_id' <> v_sid) then
    v_problems := v_problems || 'invoice'::text;
  else
    v_start := billing.ts(v_inv, 'period_start'); v_end := billing.ts(v_inv, 'period_end');
    if v_start is null or v_end is null or v_end <= v_start
       or v_end - v_start < interval '28 days' or v_end - v_start > interval '31 days 1 hour' then
      v_problems := v_problems || 'period'::text;
    -- Explicit period rule: the invoice is the subscription's current period, or a genuinely older
    -- period that ended by the current period start (a late notification). Anything else is review.
    elsif billing.ts(s, 'current_period_start') is null
       or not (abs(extract(epoch from v_start - billing.ts(s, 'current_period_start'))) <= 3600
               or v_end <= billing.ts(s, 'current_period_start') + interval '1 hour') then
      v_problems := v_problems || 'period_subscription'::text;
    end if;
  end if;
  -- A first payment is also bound through the server-read checkout: same checkout, our reference,
  -- this workspace's customer, completed, exact amount/currency, the pinned product, monthly.
  if v_bound.provider_subscription_id is null then
    if p_facts -> 'checkout' is null or jsonb_typeof(p_facts -> 'checkout') <> 'object' then
      v_problems := v_problems || 'checkout_facts_missing'::text;
    else
      if p_facts -> 'checkout' ->> 'checkout_id' is distinct from coalesce(p ->> 'checkout_id', v_i.provider_checkout_id)
         or (v_i.provider_checkout_id is not null and p_facts -> 'checkout' ->> 'checkout_id' <> v_i.provider_checkout_id) then
        v_problems := v_problems || 'checkout_id'::text;
      end if;
      if p_facts -> 'checkout' ->> 'reference' is distinct from v_i.reference then v_problems := v_problems || 'checkout_reference'::text; end if;
      if p_facts -> 'checkout' ->> 'customer_id' is distinct from v_cust then v_problems := v_problems || 'checkout_customer'::text; end if;
      if p_facts -> 'checkout' ->> 'status' is distinct from 'completed' then v_problems := v_problems || 'checkout_status'::text; end if;
      if p_facts -> 'checkout' ->> 'currency' is distinct from v_exp_currency
         or billing.to_minor(p_facts -> 'checkout' ->> 'amount', v_exp_currency) <> v_exp_amount then
        v_problems := v_problems || 'checkout_amount'::text;
      end if;
      if jsonb_typeof(p_facts -> 'checkout' -> 'product_ids') is distinct from 'array'
         or jsonb_array_length(p_facts -> 'checkout' -> 'product_ids') <> 1
         or p_facts -> 'checkout' -> 'product_ids' ->> 0 is distinct from v_exp_product then
        v_problems := v_problems || 'checkout_product'::text;
      end if;
      if p_facts -> 'checkout' -> 'recurring' ->> 'interval' is distinct from 'month'
         or coalesce(p_facts -> 'checkout' -> 'recurring' ->> 'interval_count', '1') <> '1' then
        v_problems := v_problems || 'checkout_recurring'::text;
      end if;
    end if;
  end if;
  v_problems := v_problems || billing.subscription_problems(s, v_cust, v_exp_product, v_exp_currency, v_exp_amount);

  if cardinality(v_problems) > 0 then
    perform billing.review(p_conn, v_ws, 'payment_mismatch', v_pid, jsonb_build_object('payment_id', v_pid, 'subscription_id', v_sid),
      jsonb_build_object('problems', to_jsonb(v_problems)), p_event);
    if v_bound.provider_subscription_id is null and v_i.id is not null
       and v_i.status in ('requesting', 'open', 'uncertain', 'completed_unpaid') then
      update billing.checkout_intents set status = 'review', last_error_code = 'payment_mismatch', version = version + 1, updated_at = now()
      where id = v_i.id;
    end if;
    return 'review:payment_mismatch';
  end if;

  v_sha := billing.payment_facts_sha(p);
  if v_bound.provider_subscription_id is null then
    select * into v_cur from billing.subscriptions where workspace_id = v_ws and binding = 'current';
    if v_cur.provider_subscription_id is not null then
      -- A second subscription for a workspace that already has one: recorded, never granted.
      insert into billing.subscriptions (connection_id, provider_subscription_id, workspace_id, binding, intent_id, price_id, provider_product_id,
        currency, amount_minor, provider_customer_id, provider_status, cancel_at_period_end, canceled_at, current_period_start,
        current_period_end, status_observed_at, facts_sha256)
      values (p_conn, v_sid, v_ws, 'duplicate', v_i.id, v_exp_price, v_exp_product, v_exp_currency, v_exp_amount, s ->> 'customer_id',
        s ->> 'status', coalesce((s ->> 'cancel_at_period_end')::boolean, false), billing.ts(s, 'canceled_at'),
        billing.ts(s, 'current_period_start'), billing.ts(s, 'current_period_end'), p_observed_at, private.sha256_hex(s::text));
      perform billing.review(p_conn, v_ws, 'duplicate_subscription', v_sid, jsonb_build_object('subscription_id', v_sid, 'payment_id', v_pid),
        '{}'::jsonb, p_event);
      update billing.checkout_intents set status = 'mismatch', last_error_code = 'duplicate_subscription', resolved_at = now(),
        version = version + 1, updated_at = now() where id = v_i.id;
      return 'review:duplicate_subscription';
    end if;
    insert into billing.subscriptions (connection_id, provider_subscription_id, workspace_id, binding, intent_id, price_id, provider_product_id,
      currency, amount_minor, provider_customer_id, provider_status, cancel_at_period_end, canceled_at, current_period_start,
      current_period_end, status_observed_at, facts_sha256)
    values (p_conn, v_sid, v_ws, 'current', v_i.id, v_exp_price, v_exp_product, v_exp_currency, v_exp_amount, s ->> 'customer_id',
      s ->> 'status', coalesce((s ->> 'cancel_at_period_end')::boolean, false), billing.ts(s, 'canceled_at'),
      billing.ts(s, 'current_period_start'), billing.ts(s, 'current_period_end'), p_observed_at, private.sha256_hex(s::text))
    returning * into v_bound;
    update billing.checkout_intents set status = 'paid', provider_subscription_id = v_sid, resolved_at = now(), version = version + 1,
      updated_at = now() where id = v_i.id;
    update billing.workspace_billing set billing_currency = coalesce(billing_currency, v_exp_currency), version = version + 1,
      updated_at = now() where workspace_id = v_ws;
  else
    perform billing.apply_subscription_facts(v_bound, s, p_observed_at);
  end if;
  insert into billing.paid_periods (connection_id, workspace_id, provider_subscription_id, provider_invoice_id, provider_payment_id, price_id,
    currency, amount_minor, period_start, period_end, billing_reason, source_event_id, facts_sha256)
  values (p_conn, v_ws, v_sid, v_inv ->> 'invoice_id', v_pid, v_exp_price, v_exp_currency, v_amount, v_start, v_end,
    p ->> 'billing_reason', p_event, v_sha);
  update billing.payment_failures set resolved_at = clock_timestamp()
  where connection_id = p_conn and provider_subscription_id = v_sid and resolved_at is null and period_start <= v_start + interval '1 day';
  perform private.audit(v_ws, 'billing.period_verified', v_ws, jsonb_build_object('currency', v_exp_currency, 'amount_minor', v_amount,
    'period_start', v_start, 'period_end', v_end, 'billing_reason', p ->> 'billing_reason'));
  return 'granted';
end $$;

-- GET /v1/subscriptions/{id}: status, cancellation and renewal-failure observation for a bound
-- subscription. Unknown subscriptions grant nothing.
create function billing.absorb_subscription(p_conn uuid, p_event text, p_token uuid, p_facts jsonb, p_observed_at timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  s jsonb := p_facts -> 'subscription';
  v_sub billing.subscriptions;
  v_b billing.workspace_billing;
  v_cust text;
  v_ws uuid;
  v_last billing.paid_periods;
  v_problems text[];
  v_start timestamptz;
begin
  if s is null or s ->> 'id' is null or s ->> 'status' is null then perform private.fail('invalid_facts', 'subscription'); end if;
  select * into v_sub from billing.subscriptions where connection_id = p_conn and provider_subscription_id = s ->> 'id';
  v_ws := coalesce(v_sub.workspace_id, (select workspace_id from billing.provider_customers where connection_id = p_conn and provider_customer_id = s ->> 'customer_id'));
  if v_ws is null then
    perform billing.review(p_conn, null, 'unknown_subscription', s ->> 'id', jsonb_build_object('subscription_id', s ->> 'id'), '{}'::jsonb, p_event);
    return 'review:unknown_subscription';
  end if;
  v_b := private.lock_billing(v_ws);
  perform billing.fence(p_conn, p_event, p_token);
  select provider_customer_id into v_cust from billing.provider_customers where workspace_id = v_ws and connection_id = p_conn;
  select * into v_sub from billing.subscriptions where connection_id = p_conn and provider_subscription_id = s ->> 'id' for no key update;
  if v_sub.provider_subscription_id is null then
    -- Usually the subscription.created event arriving before its payment: the payment binds it.
    if exists (select 1 from billing.checkout_intents where workspace_id = v_ws
               and status in ('requesting', 'open', 'uncertain', 'completed_unpaid')) then
      return 'awaiting_payment';
    end if;
    perform billing.review(p_conn, v_ws, 'unknown_subscription', s ->> 'id', jsonb_build_object('subscription_id', s ->> 'id'), '{}'::jsonb, p_event);
    return 'review:unknown_subscription';
  end if;
  if s ->> 'customer_id' is distinct from v_sub.provider_customer_id then
    perform billing.review(p_conn, v_ws, 'subscription_customer_changed', s ->> 'id', jsonb_build_object('subscription_id', s ->> 'id'), '{}'::jsonb, p_event);
    return 'review:subscription_customer_changed';
  end if;
  v_problems := array_remove(billing.subscription_problems(s, v_sub.provider_customer_id, v_sub.provider_product_id, v_sub.currency,
    v_sub.amount_minor), 'status');
  if cardinality(v_problems) > 0 then
    perform billing.review(p_conn, v_ws, 'subscription_terms_changed', s ->> 'id', jsonb_build_object('subscription_id', s ->> 'id'),
      jsonb_build_object('problems', to_jsonb(v_problems)), p_event);
  end if;
  if not billing.apply_subscription_facts(v_sub, s, p_observed_at) then return 'stale_read'; end if;
  -- Renewal failure seen on the subscription: the period after the last verified paid period.
  if v_sub.binding = 'current' and s ->> 'status' in ('past_due', 'unpaid') then
    v_start := billing.ts(s, 'current_period_start');
    select * into v_last from billing.paid_periods p where p.connection_id = p_conn and p.provider_subscription_id = v_sub.provider_subscription_id
      and private.valid_period(p) order by p.period_end desc limit 1;
    if v_last.id is not null and v_start is not null and v_start >= v_last.period_start + interval '1 day'
       and v_start <= v_last.period_end + interval '1 day'
       and not exists (select 1 from billing.paid_periods p where p.connection_id = p_conn and p.provider_subscription_id = v_sub.provider_subscription_id
                       and p.period_start <= v_start + interval '1 day' and p.period_end > v_start + interval '1 day') then
      insert into billing.payment_failures (connection_id, provider_subscription_id, period_start, workspace_id, period_end)
      values (p_conn, v_sub.provider_subscription_id, v_start, v_ws, billing.ts(s, 'current_period_end'))
      on conflict (connection_id, provider_subscription_id, period_start) do update set last_failed_at = clock_timestamp(),
        observations = billing.payment_failures.observations + 1;
    end if;
  end if;
  if (s ->> 'cancel_at_period_end')::boolean and not v_sub.cancel_at_period_end then
    perform private.audit(v_ws, 'billing.cancellation_confirmed', v_ws, jsonb_build_object('effective', s ->> 'current_period_end'));
  end if;
  return 'subscription_updated';
end $$;

-- Refund events: re-read payment. Full refund revokes only its own period (or tombstones the payment
-- when it was never verified); partial refund flags the period for review without revoking.
create function billing.absorb_refund(p_conn uuid, p_event text, p_token uuid, p_facts jsonb, p_observed_at timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  p jsonb := p_facts -> 'payment';
  v_pid text := p ->> 'payment_id';
  v_pp billing.paid_periods;
  v_full boolean;
begin
  if p is null or v_pid is null or p ->> 'status' is null then perform private.fail('invalid_facts', 'payment'); end if;
  if p ->> 'status' not in ('refunded', 'auto_refunded', 'partially_refunded') then return 'no_refund_effect'; end if;
  v_full := p ->> 'status' in ('refunded', 'auto_refunded');
  perform billing.lock_payment(p_conn, v_pid);  -- serializes with absorb_payment of the same payment
  select * into v_pp from billing.paid_periods where connection_id = p_conn and provider_payment_id = v_pid;
  if v_pp.id is null then
    perform billing.fence(p_conn, p_event, p_token);
    insert into billing.payment_tombstones (connection_id, provider_payment_id, provider_invoice_id, reason)
    values (p_conn, v_pid, p -> 'invoice' ->> 'invoice_id', case when v_full then 'refunded' else 'partially_refunded' end)
    on conflict do nothing;
    return 'tombstoned';
  end if;
  perform private.lock_billing(v_pp.workspace_id);
  perform billing.fence(p_conn, p_event, p_token);
  select * into v_pp from billing.paid_periods where id = v_pp.id for no key update;
  if v_full then
    if v_pp.refund_state <> 'full' then
      update billing.paid_periods set refund_state = 'full', revoked_at = coalesce(revoked_at, clock_timestamp()),
        revoke_reason = coalesce(revoke_reason, 'refunded') where id = v_pp.id;
      perform private.audit(v_pp.workspace_id, 'billing.period_refunded', v_pp.workspace_id, jsonb_build_object(
        'period_start', v_pp.period_start, 'period_end', v_pp.period_end, 'refund', 'full'));
    end if;
    return 'period_revoked';
  end if;
  if v_pp.refund_state = 'none' then
    update billing.paid_periods set refund_state = 'partial', review_flag = true where id = v_pp.id;
    perform billing.review(p_conn, v_pp.workspace_id, 'partial_refund', v_pid, jsonb_build_object('payment_id', v_pid), '{}'::jsonb, p_event);
  end if;
  return 'period_flagged';
end $$;

create function billing.absorb_dispute(p_conn uuid, p_event text, p_token uuid, p_facts jsonb, p_observed_at timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  d jsonb := p_facts -> 'dispute';
  v_pid text := d ->> 'charge_id';
  v_pp billing.paid_periods;
  v_state text;
begin
  if d is null or d ->> 'dispute_id' is null or d ->> 'status' not in ('needs_response', 'under_review', 'won', 'lost', 'closed') then
    perform private.fail('invalid_facts', 'dispute');
  end if;
  v_state := case d ->> 'status' when 'needs_response' then 'open' when 'under_review' then 'open' else d ->> 'status' end;
  if v_pid is null then
    perform billing.review(p_conn, null, 'dispute_unlinked', d ->> 'dispute_id', jsonb_build_object('dispute_id', d ->> 'dispute_id'), '{}'::jsonb, p_event);
    return 'review:dispute_unlinked';
  end if;
  perform billing.lock_payment(p_conn, v_pid);  -- serializes with absorb_payment of the same payment
  select * into v_pp from billing.paid_periods where connection_id = p_conn and provider_payment_id = v_pid;
  if v_pp.id is null then
    perform billing.fence(p_conn, p_event, p_token);
    if v_state = 'lost' then
      insert into billing.payment_tombstones (connection_id, provider_payment_id, reason) values (p_conn, v_pid, 'dispute_lost') on conflict do nothing;
    end if;
    perform billing.review(p_conn, null, 'dispute_unverified_payment', d ->> 'dispute_id', jsonb_build_object('dispute_id', d ->> 'dispute_id',
      'payment_id', v_pid), '{}'::jsonb, p_event);
    return 'review:dispute_unverified_payment';
  end if;
  perform private.lock_billing(v_pp.workspace_id);
  perform billing.fence(p_conn, p_event, p_token);
  select * into v_pp from billing.paid_periods where id = v_pp.id for no key update;
  if v_pp.dispute_state in ('lost', 'won', 'closed') and v_state = 'open' then return 'stale_dispute_state'; end if;
  update billing.paid_periods set dispute_state = v_state, review_flag = review_flag or v_state = 'open',
    revoked_at = case when v_state = 'lost' then coalesce(revoked_at, clock_timestamp()) else revoked_at end,
    revoke_reason = case when v_state = 'lost' then coalesce(revoke_reason, 'dispute_lost') else revoke_reason end
  where id = v_pp.id;
  if v_state = 'open' then
    perform billing.review(p_conn, v_pp.workspace_id, 'dispute_opened', d ->> 'dispute_id', jsonb_build_object('dispute_id', d ->> 'dispute_id',
      'payment_id', v_pid), '{}'::jsonb, p_event);
  end if;
  return 'dispute_' || v_state;
end $$;

-- Connections the worker serves: every connection with an active credential, enabled or not (a
-- disabled connection still verifies renewals of its pinned subscriptions).
create function billing.worker_connections() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(id order by created_at), '{}') from platform.provider_connections where credential_secret_id is not null
$$;

-- Work for the daily reconciliation run (identifiers only).
create function billing.reconcile_candidates(p_conn uuid, p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'checkouts', coalesce((select jsonb_agg(jsonb_build_object('intent_id', i.id, 'checkout_id', i.provider_checkout_id, 'status', i.status))
      from (select * from billing.checkout_intents
            where connection_id = p_conn and provider_checkout_id is not null and (status = 'completed_unpaid' or (status = 'open' and checkout_expires_at < now()))
            order by updated_at limit p_limit) i), '[]'),
    'uncertain', coalesce((select jsonb_agg(jsonb_build_object('intent_id', i.id))
      from (select * from billing.checkout_intents where connection_id = p_conn and status = 'uncertain' and provider_checkout_id is null
            order by updated_at limit p_limit) i), '[]'),
    'subscriptions', coalesce((select jsonb_agg(s.provider_subscription_id)
      from (select * from billing.subscriptions where connection_id = p_conn and binding = 'current' order by status_observed_at limit p_limit) s), '[]'),
    -- Recent verified payments are re-read daily so a missed refund or dispute notification is still
    -- applied (the worker routes refunded statuses to absorb_refund and lists recent disputes).
    'payments', coalesce((select jsonb_agg(jsonb_build_object('payment_id', x.provider_payment_id, 'subscription_id', x.provider_subscription_id))
      from (select * from billing.paid_periods where connection_id = p_conn and revoked_at is null and verified_at > now() - interval '120 days'
            order by verified_at desc limit p_limit) x), '[]'),
    'disputes_since', now() - interval '120 days')
$$;

-- Starts or resumes this connection's discovery scan. A new scan reads from offset 0 down to the
-- previous high-water mark minus 48 hours (62 days, two billing months, back the first time).
create function billing.discovery_begin(p_conn uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v billing.payment_discovery_state;
begin
  if not exists (select 1 from platform.provider_connections where id = p_conn) then perform private.fail('unknown_connection'); end if;
  insert into billing.payment_discovery_state (connection_id) values (p_conn) on conflict (connection_id) do nothing;
  select * into v from billing.payment_discovery_state where connection_id = p_conn for no key update;
  if v.scan_id is null then
    update billing.payment_discovery_state set scan_id = gen_random_uuid(), scan_offset = 0, scan_high_water = null,
      scan_started_at = clock_timestamp(), scan_floor = coalesce(high_water - interval '48 hours', now() - interval '62 days'),
      updated_at = clock_timestamp()
    where connection_id = p_conn returning * into v;
  end if;
  return jsonb_build_object('scan_id', v.scan_id, 'offset', v.scan_offset, 'floor', v.scan_floor);
end $$;

-- Records one listed page and advances the cursor in the same transaction. The expected offset makes a
-- concurrent or repeated page a no-op ('stale_page'). Items: [{id, status, transaction_date}].
create function billing.discovery_record_page(p_conn uuid, p_scan uuid, p_offset integer, p_items jsonb, p_listed integer,
  p_has_more boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v billing.payment_discovery_state;
  v_reached boolean;
  v_max timestamptz;
begin
  if jsonb_typeof(p_items) <> 'array' or p_listed < jsonb_array_length(p_items) or p_listed < 0 or p_listed > 100 then
    perform private.fail('invalid_page');
  end if;
  select * into v from billing.payment_discovery_state where connection_id = p_conn for no key update;
  if v.scan_id is distinct from p_scan or v.scan_offset <> p_offset then return 'stale_page'; end if;
  select bool_or(billing.ts(x, 'transaction_date') < v.scan_floor), max(billing.ts(x, 'transaction_date'))
  into v_reached, v_max from jsonb_array_elements(p_items) x;
  insert into billing.discovered_payments (connection_id, provider_payment_id, list_status, listed_at, state, outcome)
  select p_conn, x ->> 'id', left(x ->> 'status', 40), billing.ts(x, 'transaction_date'),
    case when exists (select 1 from billing.paid_periods pp where pp.connection_id = p_conn and pp.provider_payment_id = x ->> 'id')
      then 'absorbed' else 'pending' end,
    case when exists (select 1 from billing.paid_periods pp where pp.connection_id = p_conn and pp.provider_payment_id = x ->> 'id')
      then 'already_verified' end
  from jsonb_array_elements(p_items) x
  where x ->> 'id' ~ '^[A-Za-z0-9_]{1,128}$'
    and (billing.ts(x, 'transaction_date') is null or billing.ts(x, 'transaction_date') >= v.scan_floor)
  on conflict (connection_id, provider_payment_id) do nothing;
  if coalesce(v_reached, false) or not coalesce(p_has_more, false) then
    update billing.payment_discovery_state set high_water = greatest(high_water, coalesce(greatest(scan_high_water, v_max), high_water)),
      scan_id = null, scan_started_at = null, scan_offset = 0, scan_high_water = null, last_completed_at = clock_timestamp(),
      pages_read = pages_read + 1, updated_at = clock_timestamp()
    where connection_id = p_conn;
    return 'complete';
  end if;
  update billing.payment_discovery_state set scan_offset = scan_offset + p_listed, scan_high_water = greatest(scan_high_water, v_max),
    pages_read = pages_read + 1, updated_at = clock_timestamp()
  where connection_id = p_conn;
  return 'continue';
end $$;

-- Claims discovered payments for a detail fetch (committed before any HTTP; SKIP LOCKED; leased).
create function billing.discovery_claim(p_conn uuid, p_worker text, p_limit integer, p_lease_seconds integer)
returns table (provider_payment_id text, claim_token uuid, lease_until timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if p_limit not between 1 and 50 or p_lease_seconds not between 30 and 900 then perform private.fail('invalid_claim'); end if;
  return query
  with due as (
    select d.connection_id, d.provider_payment_id from billing.discovered_payments d
    where d.connection_id = p_conn
      and ((d.state in ('pending', 'retry') and d.next_attempt_at <= clock_timestamp())
        or (d.state = 'processing' and d.lease_until < clock_timestamp()))
    -- Oldest first, so a first payment binds its subscription before that subscription's renewals.
    order by d.listed_at nulls last, d.next_attempt_at
    limit p_limit
    for update skip locked)
  update billing.discovered_payments x set state = 'processing', claim_token = gen_random_uuid(),
    lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds), attempts = x.attempts + 1
  from due where x.connection_id = due.connection_id and x.provider_payment_id = due.provider_payment_id
  returning x.provider_payment_id, x.claim_token, x.lease_until;
end $$;

-- Classifies a server-read payment on this connection:
--   savour           its subscription is bound here, or its reference is a SAVOUR checkout intent
--   savour_customer  its server-read subscription belongs to a SAVOUR-bound customer but is not bound yet
--                    (e.g. the first payment is still unverified): deferred and retried, never dropped
--   unrelated        anything else: never absorbed, never reviewed
create function billing.discovery_classify(p_conn uuid, p_subscription_id text, p_reference text, p_customer_id text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from billing.subscriptions s where s.connection_id = p_conn and s.provider_subscription_id = p_subscription_id)
      or exists (select 1 from billing.checkout_intents i where i.connection_id = p_conn and i.reference = p_reference) then 'savour'
    when p_customer_id is not null and exists (select 1 from billing.provider_customers c where c.connection_id = p_conn
      and c.provider_customer_id = p_customer_id) then 'savour_customer'
    else 'unrelated' end
$$;

-- Finishes a claimed discovery item. 'retry' backs off (15m, 1h, 6h, 24h...) and goes dead with a review
-- row after 10 attempts; a final state needs a live claim.
create function billing.discovery_finish(p_conn uuid, p_payment text, p_token uuid, p_state text, p_outcome text, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
declare v billing.discovered_payments;
begin
  if p_state not in ('absorbed', 'unrelated', 'retry', 'released') then perform private.fail('invalid_state'); end if;
  select * into v from billing.discovered_payments where connection_id = p_conn and provider_payment_id = p_payment
    and state = 'processing' and claim_token = p_token for no key update;
  if not found or (p_state in ('absorbed', 'unrelated') and v.lease_until <= clock_timestamp()) then perform private.fail('stale_claim'); end if;
  if p_state = 'released' then
    update billing.discovered_payments set state = 'pending', attempts = greatest(attempts - 1, 0), next_attempt_at = clock_timestamp(),
      claim_token = null, lease_until = null where connection_id = p_conn and provider_payment_id = p_payment;
  elsif p_state = 'retry' then
    update billing.discovered_payments set state = case when v.attempts >= 10 then 'dead' else 'retry' end,
      next_attempt_at = clock_timestamp() + (array['15 minutes', '1 hour', '6 hours', '24 hours']::interval[])[least(greatest(v.attempts, 1), 4)],
      last_error_code = left(coalesce(p_error, 'error'), 80), outcome = left(p_outcome, 80), claim_token = null, lease_until = null
    where connection_id = p_conn and provider_payment_id = p_payment;
    if v.attempts >= 10 then
      perform billing.review(p_conn, null, 'discovery_dead', p_payment, jsonb_build_object('payment_id', p_payment),
        jsonb_build_object('error', left(coalesce(p_error, 'error'), 80)), null);
    end if;
  else
    update billing.discovered_payments set state = p_state, outcome = left(p_outcome, 80), last_error_code = null,
      processed_at = clock_timestamp(), claim_token = null, lease_until = null
    where connection_id = p_conn and provider_payment_id = p_payment;
  end if;
end $$;

-- Identical retry of an uncertain checkout creation, only inside the provider's 24-hour idempotency
-- window and at most four attempts in total; the unique reference makes a duplicate creation fail at
-- Bachs. Returns null when no retry is allowed.
create function billing.checkout_retry_context(p_intent uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v billing.checkout_intents;
begin
  select * into v from billing.checkout_intents where id = p_intent;
  if not found or v.status <> 'uncertain' or v.request_body is null or v.provider_checkout_id is not null then return null; end if;
  perform private.lock_billing(v.workspace_id);
  select * into v from billing.checkout_intents where id = p_intent for no key update;
  if v.status <> 'uncertain' then return null; end if;
  if v.request_started_at < now() - interval '23 hours' or v.request_attempts >= 4 then
    update billing.checkout_intents set status = 'review', last_error_code = 'uncertain_unresolved', version = version + 1, updated_at = now()
    where id = p_intent;
    perform billing.review(v.connection_id, v.workspace_id, 'checkout_uncertain', p_intent::text, jsonb_build_object('reference', v.reference), '{}'::jsonb, null);
    return null;
  end if;
  update billing.checkout_intents set request_attempts = request_attempts + 1, updated_at = now() where id = p_intent;
  return jsonb_build_object('intent_id', v.id, 'connection_id', v.connection_id, 'idempotency_key', v.idempotency_key,
    'request_body', v.request_body, 'reference', v.reference);
end $$;

-- Outcome of a provider checkout-creation call (gateway first call or worker identical retry).
create function billing.record_checkout_result(p_intent uuid, p_outcome text, p_checkout_id text, p_checkout_url text,
  p_expires_at timestamptz, p_reference text, p_error_code text)
returns text language plpgsql security definer set search_path = '' as $$
declare v billing.checkout_intents;
begin
  if p_outcome not in ('created', 'refused', 'uncertain', 'conflict') then perform private.fail('invalid_outcome'); end if;
  select * into v from billing.checkout_intents where id = p_intent;
  if not found then perform private.fail('not_found', 'intent'); end if;
  perform private.lock_billing(v.workspace_id);
  select * into v from billing.checkout_intents where id = p_intent for no key update;
  if v.status not in ('requesting', 'uncertain') then return 'ignored'; end if;
  if p_outcome = 'created' then
    if p_reference is distinct from v.reference or p_checkout_id is null or p_checkout_url !~ '^https://' then
      update billing.checkout_intents set status = 'review', last_error_code = 'checkout_response_mismatch', version = version + 1,
        updated_at = now() where id = p_intent;
      perform billing.review(v.connection_id, v.workspace_id, 'checkout_response_mismatch', p_intent::text, jsonb_build_object('reference', v.reference), '{}'::jsonb, null);
      return 'review';
    end if;
    update billing.checkout_intents set status = 'open', provider_checkout_id = p_checkout_id, checkout_url = p_checkout_url,
      checkout_expires_at = p_expires_at, last_error_code = null, version = version + 1, updated_at = now() where id = p_intent;
    return 'open';
  elsif p_outcome = 'refused' then
    update billing.checkout_intents set status = 'failed', last_error_code = left(p_error_code, 80), resolved_at = now(),
      version = version + 1, updated_at = now() where id = p_intent;
    return 'failed';
  elsif p_outcome = 'conflict' then
    -- A checkout with this reference already exists at Bachs but its ID is unknown here.
    update billing.checkout_intents set status = 'review', last_error_code = left(p_error_code, 80), version = version + 1,
      updated_at = now() where id = p_intent;
    perform billing.review(v.connection_id, v.workspace_id, 'checkout_reference_exists', p_intent::text, jsonb_build_object('reference', v.reference), '{}'::jsonb, null);
    return 'review';
  end if;
  update billing.checkout_intents set status = 'uncertain', last_error_code = left(p_error_code, 80), version = version + 1,
    updated_at = now() where id = p_intent;
  return 'uncertain';
end $$;

-- Abandons never-requested intents, escalates stale uncertainty, and emits Owner notices on days 0,
-- 3 and 6 of grace (in-app only; Bachs sends its own recovery emails on its own schedule).
create function billing.housekeeping() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_abandoned integer;
  v_notices integer := 0;
  v_n integer;
  r record;
  v_day integer;
begin
  update billing.checkout_intents set status = 'abandoned', resolved_at = now(), version = version + 1, updated_at = now()
  where status = 'created' and created_at < now() - interval '30 minutes';
  get diagnostics v_abandoned = row_count;
  for r in
    select b.workspace_id, private.billing_core(b.workspace_id) as core
    from billing.workspace_billing b
    where exists (select 1 from billing.payment_failures f where f.workspace_id = b.workspace_id and f.resolved_at is null)
  loop
    continue when r.core ->> 'state' <> 'past_due';
    v_day := extract(day from now() - (r.core ->> 'grace_anchor')::timestamptz)::integer;
    v_day := case when v_day >= 6 then 6 when v_day >= 3 then 3 else 0 end;
    insert into public.notifications (workspace_id, recipient_id, kind, dedupe_key, meta, created_at)
    select r.workspace_id, m.user_id, 'billing_past_due',
      'billing_past_due:' || (r.core ->> 'grace_anchor') || ':' || v_day,
      jsonb_build_object('anchor', r.core ->> 'grace_anchor', 'day', v_day, 'grace_ends_at', r.core ->> 'grace_ends_at'),
      clock_timestamp()
    from public.memberships m where m.workspace_id = r.workspace_id and m.role = 'owner' and m.status = 'active'
    on conflict (workspace_id, recipient_id, dedupe_key) do nothing;
    get diagnostics v_n = row_count;
    v_notices := v_notices + v_n;
  end loop;
  return jsonb_build_object('abandoned', v_abandoned, 'notices', v_notices, 'secrets_retired', platform.retire_secrets());
end $$;
-- ---------------------------------------------------------------------------
-- billing_gateway: Owner-initiated provider calls (the Edge Function validated the JWT and called the
-- Owner RPC first; every function re-checks the live Owner membership immediately before use).
-- ---------------------------------------------------------------------------
create function billing.require_live_owner(p_ws uuid, p_user uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.memberships m where m.workspace_id = p_ws and m.user_id = p_user and m.role = 'owner'
                 and m.status = 'active' and (m.expires_at is null or m.expires_at > now())) then
    perform private.fail('forbidden');
  end if;
end $$;

create function billing.gateway_checkout_context(p_intent uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v billing.checkout_intents;
  v_b billing.workspace_billing;
  v_p billing.plan_prices;
  v_conn platform.provider_connections;
  v_c billing.provider_customers;
begin
  select * into v from billing.checkout_intents where id = p_intent;
  if not found or v.owner_id <> p_user then perform private.fail('not_found', 'intent'); end if;
  v_b := private.lock_billing(v.workspace_id);
  select * into v from billing.checkout_intents where id = p_intent for no key update;
  perform billing.require_live_owner(v.workspace_id, p_user);
  if v.status <> 'created' or v.created_at < now() - interval '15 minutes' then perform private.fail('checkout_intent_stale'); end if;
  select * into v_conn from platform.provider_connections where id = v.connection_id;
  if not v_conn.accepting_new then perform private.fail('provider_unavailable'); end if;
  select * into v_p from billing.plan_prices where id = v.price_id;
  -- A price changed after consent: the Owner must consent again to the current price.
  if v_p.status = 'retired' then perform private.fail('price_changed'); end if;
  if v_p.status <> 'configured' or v_p.recurring_capability = 'unverified' then perform private.fail('price_not_configured'); end if;
  if v_b.billing_email is null then perform private.fail('billing_contact_required'); end if;
  insert into billing.provider_customers (workspace_id, connection_id, billing_email, customer_idempotency_key)
  values (v.workspace_id, v.connection_id, v_b.billing_email,
    'savour-customer-' || v.connection_id || '-' || v.workspace_id || '-' || left(private.sha256_hex(v_b.billing_email), 16))
  on conflict (workspace_id, connection_id) do nothing;
  select * into v_c from billing.provider_customers where workspace_id = v.workspace_id and connection_id = v.connection_id;
  return jsonb_build_object('intent_id', v.id, 'workspace_id', v.workspace_id, 'connection_id', v.connection_id,
    'billing_email', v_c.billing_email, 'provider_customer_id', v_c.provider_customer_id,
    'customer_idempotency_key', v_c.customer_idempotency_key,
    'provider_product_id', v.provider_product_id, 'currency', v.currency, 'amount', billing.from_minor(v.amount_minor, v.currency),
    'card_corridor', (select card_corridor from billing.currencies where code = v.currency),
    'reference', v.reference, 'idempotency_key', v.idempotency_key);
end $$;

-- Binds the provider customer to this workspace on one connection. A customer already bound to another
-- workspace on that connection, or a different customer for this one, is refused and queued for
-- review; nothing is overwritten.
create function billing.gateway_bind_customer(p_ws uuid, p_conn uuid, p_user uuid, p_customer_id text, p_email text, p_source text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_b billing.workspace_billing;
  v_c billing.provider_customers;
begin
  if p_source not in ('created', 'adopted') then perform private.fail('invalid_source'); end if;
  v_b := private.lock_billing(p_ws);
  perform billing.require_live_owner(p_ws, p_user);
  select * into v_c from billing.provider_customers where workspace_id = p_ws and connection_id = p_conn for no key update;
  if not found then perform private.fail('not_found', 'customer request'); end if;
  if lower(coalesce(p_email, '')) is distinct from v_c.billing_email then
    perform billing.review(p_conn, p_ws, 'customer_email_mismatch', p_customer_id, jsonb_build_object('customer_id', p_customer_id), '{}'::jsonb, null);
    perform private.fail('billing_customer_review');
  end if;
  if v_c.provider_customer_id = p_customer_id then return 'bound'; end if;
  if v_c.provider_customer_id is not null then
    perform billing.review(p_conn, p_ws, 'customer_replacement_refused', p_customer_id, jsonb_build_object('customer_id', p_customer_id), '{}'::jsonb, null);
    perform private.fail('billing_customer_review');
  end if;
  if exists (select 1 from billing.provider_customers where connection_id = p_conn and provider_customer_id = p_customer_id and workspace_id <> p_ws) then
    perform billing.review(p_conn, p_ws, 'customer_bound_elsewhere', p_customer_id, jsonb_build_object('customer_id', p_customer_id), '{}'::jsonb, null);
    perform private.fail('billing_customer_review');
  end if;
  update billing.provider_customers set provider_customer_id = p_customer_id, bound_at = now()
  where workspace_id = p_ws and connection_id = p_conn;
  update billing.workspace_billing set version = version + 1, updated_at = now() where workspace_id = p_ws;
  perform private.audit(p_ws, 'billing.customer_bound', p_ws, jsonb_build_object('source', p_source, 'connection_id', p_conn));
  return 'bound';
end $$;

create function billing.gateway_customer_review(p_ws uuid, p_conn uuid, p_user uuid, p_kind text, p_customer_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind not in ('customer_email_exists', 'customer_lookup_ambiguous') then perform private.fail('invalid_kind'); end if;
  perform billing.require_live_owner(p_ws, p_user);
  perform billing.review(p_conn, p_ws, p_kind, p_ws::text || ':' || coalesce(p_customer_id, 'none'),
    jsonb_build_object('customer_id', p_customer_id), '{}'::jsonb, null);
end $$;

-- Persists the exact request (no secrets) and marks the intent as requesting BEFORE the HTTP call.
create function billing.gateway_mark_requesting(p_intent uuid, p_user uuid, p_request_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare v billing.checkout_intents;
begin
  select * into v from billing.checkout_intents where id = p_intent;
  if not found or v.owner_id <> p_user then perform private.fail('not_found', 'intent'); end if;
  perform private.lock_billing(v.workspace_id);
  select * into v from billing.checkout_intents where id = p_intent for no key update;
  perform billing.require_live_owner(v.workspace_id, p_user);
  if v.status <> 'created' then perform private.fail('checkout_intent_stale'); end if;
  if p_request_body is null or position(v.reference in p_request_body) = 0 or p_request_body ~* '(sk_(live|sandbox|test)_|authorization)' then
    perform private.fail('invalid_request_body');
  end if;
  update billing.checkout_intents set status = 'requesting', request_body = p_request_body, request_started_at = clock_timestamp(),
    request_attempts = 1, version = version + 1, updated_at = now() where id = p_intent;
end $$;

create function billing.gateway_record_checkout(p_intent uuid, p_user uuid, p_outcome text, p_checkout_id text,
  p_checkout_url text, p_expires_at timestamptz, p_reference text, p_error_code text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from billing.checkout_intents where id = p_intent and owner_id = p_user) then
    perform private.fail('not_found', 'intent');
  end if;
  return billing.record_checkout_result(p_intent, p_outcome, p_checkout_id, p_checkout_url, p_expires_at, p_reference, p_error_code);
end $$;

-- The portal runs on the connection of the current subscription (else the latest bound customer).
create function billing.gateway_portal_context(p_ws uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_conn uuid;
  v_c billing.provider_customers;
begin
  perform billing.require_live_owner(p_ws, p_user);
  select connection_id into v_conn from billing.subscriptions where workspace_id = p_ws and binding = 'current';
  if v_conn is null then
    select connection_id into v_conn from billing.provider_customers where workspace_id = p_ws and bound_at is not null
    order by bound_at desc limit 1;
  end if;
  select * into v_c from billing.provider_customers where workspace_id = p_ws and connection_id = v_conn and bound_at is not null;
  if v_c.provider_customer_id is null then perform private.fail('billing_portal_unavailable'); end if;
  return jsonb_build_object('connection_id', v_conn, 'provider_customer_id', v_c.provider_customer_id,
    'subscription_ids', coalesce((select jsonb_agg(provider_subscription_id) from billing.subscriptions
      where workspace_id = p_ws and connection_id = v_conn), '[]'));
end $$;

-- The verified customer has a subscription this workspace does not own: refuse the portal.
create function billing.gateway_portal_refused(p_ws uuid, p_conn uuid, p_user uuid, p_subscription_ids text[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform billing.require_live_owner(p_ws, p_user);
  perform billing.review(p_conn, p_ws, 'portal_foreign_subscription', p_ws::text || ':' || array_to_string(p_subscription_ids, ','),
    jsonb_build_object('subscription_ids', to_jsonb(p_subscription_ids)), '{}'::jsonb, null);
end $$;

create function billing.gateway_cancel_context(p_ws uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_sub billing.subscriptions;
begin
  perform billing.require_live_owner(p_ws, p_user);
  select * into v_sub from billing.subscriptions where workspace_id = p_ws and binding = 'current';
  if not found or v_sub.provider_status = 'canceled' then perform private.fail('no_active_subscription'); end if;
  if v_sub.cancel_requested_at is null or v_sub.cancel_requested_at < now() - interval '15 minutes' then
    perform private.fail('cancellation_not_requested');
  end if;
  return jsonb_build_object('connection_id', v_sub.connection_id, 'provider_subscription_id', v_sub.provider_subscription_id);
end $$;

-- The DELETE /v1/subscriptions/{id} response is itself a server read of this workspace's subscription.
create function billing.gateway_apply_subscription(p_ws uuid, p_user uuid, p_facts jsonb, p_observed_at timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare v_sub billing.subscriptions;
begin
  perform private.lock_billing(p_ws);
  perform billing.require_live_owner(p_ws, p_user);
  select * into v_sub from billing.subscriptions where workspace_id = p_ws and binding = 'current' for no key update;
  if not found or p_facts -> 'subscription' ->> 'id' is distinct from v_sub.provider_subscription_id
     or p_facts -> 'subscription' ->> 'customer_id' is distinct from v_sub.provider_customer_id then
    perform private.fail('subscription_mismatch');
  end if;
  if not billing.apply_subscription_facts(v_sub, p_facts -> 'subscription', p_observed_at) then return 'stale_read'; end if;
  if (p_facts -> 'subscription' ->> 'cancel_at_period_end')::boolean then
    perform private.audit(p_ws, 'billing.cancellation_confirmed', p_ws, jsonb_build_object('effective',
      p_facts -> 'subscription' ->> 'current_period_end'));
  end if;
  return 'applied';
end $$;

-- ---------------------------------------------------------------------------
-- Credentials (Vault). The only readers of provider secrets; values never touch a non-Vault table.
-- ---------------------------------------------------------------------------
create function platform.fingerprint(p_secret text) returns text
language sql immutable set search_path = '' as $$ select left(encode(sha256(convert_to(p_secret, 'UTF8')), 'hex'), 12) $$;

create function platform.vault_value(p_id uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if p_id is null then return null; end if;
  select decrypted_secret into v from vault.decrypted_secrets where id = p_id;
  return v;
end $$;

-- billing_gateway / billing_worker: the active API key of one connection (never the pending one).
create function platform.get_credential(p_conn uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c platform.provider_connections;
  p platform.providers;
begin
  select * into c from platform.provider_connections where id = p_conn;
  if not found then perform private.fail('unknown_connection'); end if;
  select * into p from platform.providers where code = c.provider_code;
  if p.adapter_status <> 'available' or c.credential_secret_id is null then perform private.fail('credential_unavailable'); end if;
  return jsonb_build_object('provider_code', c.provider_code, 'adapter_version', p.adapter_version, 'base_url', p.sandbox_base_url,
    'key_pattern', p.key_pattern, 'credential_version', c.credential_version, 'api_key', platform.vault_value(c.credential_secret_id));
end $$;

-- billing_intake: the webhook signing secrets of one connection (current, plus the previous one during
-- its retry overlap) and the expected provider account.
create function platform.get_webhook_secrets(p_conn uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c platform.provider_connections;
begin
  select * into c from platform.provider_connections where id = p_conn;
  if not found then perform private.fail('unknown_connection'); end if;
  if c.webhook_secret_id is null or c.expected_organization_id is null then perform private.fail('webhook_not_configured'); end if;
  return jsonb_build_object('provider_code', c.provider_code, 'expected_organization_id', c.expected_organization_id,
    'secrets', to_jsonb(array_remove(array[platform.vault_value(c.webhook_secret_id),
      case when c.previous_webhook_valid_until > now() then platform.vault_value(c.previous_webhook_secret_id) end], null)));
end $$;

-- ---------------------------------------------------------------------------
-- Platform administration (founder-only; database-owner enrollment; aal2 for every write)
-- ---------------------------------------------------------------------------
create function private.platform_actor(p_require_mfa boolean) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_uid();
begin
  if not exists (select 1 from platform.admins a where a.user_id = v_uid and a.revoked_at is null) then
    perform private.fail('forbidden');
  end if;
  if p_require_mfa and coalesce((select auth.jwt()) ->> 'aal', 'aal1') <> 'aal2' then perform private.fail('mfa_required'); end if;
  return v_uid;
end $$;

create function private.platform_audit(p_actor uuid, p_action text, p_conn uuid, p_before jsonb, p_after jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into platform.admin_audit (actor_id, aal, action, connection_id, credential_version, fingerprint, before, after)
  select p_actor, coalesce((select auth.jwt()) ->> 'aal', 'aal1'), p_action, p_conn, c.credential_version,
    coalesce(c.pending_fingerprint, c.credential_fingerprint), p_before, p_after
  from (select 1) x left join platform.provider_connections c on c.id = p_conn
$$;

-- Non-secret view of one connection (what the dashboard shows).
create function private.platform_connection_json(c platform.provider_connections) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'provider_code', c.provider_code, 'label', c.label, 'status', c.status,
    'accepting_new', c.accepting_new, 'version', c.version,
    'credential', jsonb_build_object('configured', c.credential_secret_id is not null, 'version', c.credential_version,
      'fingerprint', c.credential_fingerprint, 'stored_at', c.credential_stored_at,
      'pending', c.pending_secret_id is not null, 'pending_fingerprint', c.pending_fingerprint,
      'previous_retire_after', c.previous_retire_after),
    'webhook_secret', jsonb_build_object('configured', c.webhook_secret_id is not null, 'version', c.webhook_secret_version,
      'fingerprint', c.webhook_fingerprint, 'previous_valid_until', c.previous_webhook_valid_until),
    'expected_organization_id', c.expected_organization_id,
    'ngn_recurring_verified', c.ngn_recurring_verified_at is not null,
    'last_test_passed_at', c.last_test_passed_at,
    'tests', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'status', t.status, 'credential_version', t.credential_version,
        'organization_matched', t.organization_matched, 'checks', t.checks, 'started_at', t.started_at, 'finished_at', t.finished_at)
        order by t.started_at desc)
      from (select * from platform.connection_tests where connection_id = c.id order by started_at desc limit 5) t), '[]'),
    'prices', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'currency', p.currency, 'version', p.version, 'status', p.status,
        'amount', billing.from_minor(p.amount_minor, p.currency), 'provider_product_id', p.provider_product_id,
        'recurring_capability', p.recurring_capability, 'label', p.label) order by p.currency, p.version desc)
      from billing.plan_prices p where p.connection_id = c.id and p.status in ('proposed', 'configured')), '[]'),
    'pinned_subscriptions', (select count(*) from billing.subscriptions s where s.connection_id = c.id and s.binding <> 'ended'),
    'pending_checkouts', (select count(*) from billing.checkout_intents i where i.connection_id = c.id
      and i.status in ('created', 'requesting', 'open', 'uncertain', 'completed_unpaid', 'review')))
$$;

create function private.platform_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.platform_actor(false);
begin
  return jsonb_build_object('admin', jsonb_build_object('user_id', v_uid, 'aal', coalesce((select auth.jwt()) ->> 'aal', 'aal1')),
    'environment', 'sandbox',
    'providers', (select jsonb_agg(jsonb_build_object('code', p.code, 'display_name', p.display_name, 'adapter_status', p.adapter_status,
        'adapter_version', p.adapter_version, 'environment', p.environment, 'capabilities', p.capabilities, 'note', p.note) order by p.code)
      from platform.providers p),
    'connections', coalesce((select jsonb_agg(private.platform_connection_json(c) order by c.created_at) from platform.provider_connections c), '[]'),
    'default_connection_id', (select default_connection_id from platform.settings),
    'settings_version', (select version from platform.settings),
    'audit', coalesce((select jsonb_agg(jsonb_build_object('action', a.action, 'connection_id', a.connection_id, 'aal', a.aal,
        'credential_version', a.credential_version, 'fingerprint', a.fingerprint, 'before', a.before, 'after', a.after,
        'created_at', a.created_at) order by a.id desc)
      from (select * from platform.admin_audit order by id desc limit 50) a), '[]'));
end $$;

create function private.platform_create_connection(p_provider text, p_label text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.platform_actor(true);
  v_id uuid;
begin
  if not exists (select 1 from platform.providers where code = p_provider) then perform private.fail('provider_not_supported'); end if;
  if (select adapter_status from platform.providers where code = p_provider) <> 'available' then
    perform private.fail('provider_adapter_pending', p_provider);
  end if;
  if length(btrim(coalesce(p_label, ''))) not between 1 and 80 then perform private.fail('invalid_name'); end if;
  insert into platform.provider_connections (provider_code, label, created_by) values (p_provider, btrim(p_label), v_uid) returning id into v_id;
  perform private.platform_audit(v_uid, 'connection.created', v_id, null, jsonb_build_object('provider', p_provider, 'label', btrim(p_label)));
  return v_id;
end $$;

create function private.platform_lock_connection(p_conn uuid, p_expected_version integer) returns platform.provider_connections
language plpgsql security definer set search_path = '' as $$
declare c platform.provider_connections;
begin
  select * into c from platform.provider_connections where id = p_conn for no key update;
  if not found then perform private.fail('not_found', 'connection'); end if;
  if p_expected_version is null or c.version <> p_expected_version then perform private.fail('stale_version'); end if;
  return c;
end $$;

-- Write-only secret entry. Stores the value in Vault and records only its ID, version and fingerprint.
-- A new API key is pending until a connection test passes with it; the active key keeps working.
-- A new webhook secret becomes current at once and the previous one stays valid for 26 hours (provider
-- retries span about 80 minutes; resends need the overlap).
-- Overlap rule: a still-valid previous version is never deleted. Another rotation of the same kind is
-- refused ('rotation_overlap_active', detail = when it becomes possible) until the previous webhook
-- secret's overlap or the previous API key's retention has ended. A not-yet-tested pending key may be
-- replaced (it serves no traffic); each stored key gets a strictly new version, so a test started with
-- the replaced key can never certify the new one.
create function private.platform_store_secret(p_conn uuid, p_kind text, p_secret text, p_expected_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.platform_actor(true);
  c platform.provider_connections := private.platform_lock_connection(p_conn, p_expected_version);
  p platform.providers;
  v_secret text := btrim(coalesce(p_secret, ''));
  v_id uuid;
  v_fp text;
begin
  select * into p from platform.providers where code = c.provider_code;
  if p_kind not in ('api_key', 'webhook_secret') then perform private.fail('invalid_secret_kind'); end if;
  if p_kind = 'api_key' then
    if v_secret ~* '^sk_live_' or v_secret !~ p.key_pattern then perform private.fail('invalid_credential_format'); end if;
    if c.previous_secret_id is not null and c.previous_retire_after > now() then
      perform private.fail('rotation_overlap_active', to_char(c.previous_retire_after at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'));
    end if;
  else
    if length(v_secret) not between 16 and 512 or v_secret ~ '\s' then perform private.fail('invalid_credential_format'); end if;
    if c.previous_webhook_secret_id is not null and c.previous_webhook_valid_until > now() then
      perform private.fail('rotation_overlap_active', to_char(c.previous_webhook_valid_until at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'));
    end if;
  end if;
  v_fp := platform.fingerprint(v_secret);
  v_id := vault.create_secret(v_secret, 'savour-' || p_conn || '-' || p_kind || '-' || gen_random_uuid(),
    'SAVOUR ' || c.provider_code || ' sandbox ' || p_kind);
  if p_kind = 'api_key' then
    -- Only an untested pending key (no traffic) or a retired-out-of-window previous key is removed.
    if c.pending_secret_id is not null then delete from vault.secrets where id = c.pending_secret_id; end if;
    if c.previous_secret_id is not null then delete from vault.secrets where id = c.previous_secret_id; end if;
    update platform.provider_connections set pending_secret_id = v_id,
      pending_version = greatest(c.credential_version, coalesce(c.pending_version, 0)) + 1,
      pending_fingerprint = v_fp, previous_secret_id = null, previous_retire_after = null,
      status = case when status = 'enabled' then status else 'draft' end, version = version + 1, updated_at = now() where id = p_conn;
  else
    if c.previous_webhook_secret_id is not null then delete from vault.secrets where id = c.previous_webhook_secret_id; end if;
    update platform.provider_connections set previous_webhook_secret_id = webhook_secret_id,
      previous_webhook_valid_until = case when webhook_secret_id is not null then now() + interval '26 hours' end,
      webhook_secret_id = v_id, webhook_secret_version = webhook_secret_version + 1, webhook_fingerprint = v_fp,
      version = version + 1, updated_at = now() where id = p_conn;
  end if;
  perform private.platform_audit(v_uid, 'secret.stored', p_conn, null, jsonb_build_object('kind', p_kind, 'fingerprint', v_fp));
  return jsonb_build_object('kind', p_kind, 'fingerprint', v_fp, 'pending_test', p_kind = 'api_key');
end $$;

create function private.platform_set_expected_org(p_conn uuid, p_org text, p_expected_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.platform_actor(true);
  c platform.provider_connections := private.platform_lock_connection(p_conn, p_expected_version);
begin
  if c.status = 'enabled' then perform private.fail('disable_first'); end if;
  if p_org !~ '^[A-Za-z0-9_]{3,128}$' then perform private.fail('invalid_organization'); end if;
  update platform.provider_connections set expected_organization_id = p_org, status = 'draft', last_test_passed_at = null,
    version = version + 1, updated_at = now() where id = p_conn;
  perform private.platform_audit(v_uid, 'connection.organization_set', p_conn, jsonb_build_object('org', c.expected_organization_id),
    jsonb_build_object('org', p_org));
  return c.version + 1;
end $$;

create function private.platform_propose_price(p_conn uuid, p_currency text, p_amount text, p_product_id text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.platform_actor(true);
  v_minor bigint := billing.to_minor(p_amount, p_currency);
  v_next integer;
  v_id uuid;
begin
  perform 1 from platform.provider_connections where id = p_conn for no key update;  -- lock C2 before C4
  if not found then perform private.fail('not_found', 'connection'); end if;
  if p_product_id !~ '^[A-Za-z0-9_]{1,128}$' then perform private.fail('invalid_product'); end if;
  if v_minor <= 0 then perform private.fail('invalid_amount'); end if;
  update billing.plan_prices set status = 'rejected' where connection_id = p_conn and currency = p_currency and status = 'proposed';
  select coalesce(max(version), 0) + 1 into v_next from billing.plan_prices where connection_id = p_conn and currency = p_currency;
  insert into billing.plan_prices (connection_id, plan_code, currency, version, status, amount_minor, provider_product_id,
    recurring_capability, proposed_by)
  values (p_conn, 'business', p_currency, v_next, 'proposed', v_minor, p_product_id, 'unverified', v_uid) returning id into v_id;
  perform private.platform_audit(v_uid, 'price.proposed', p_conn, null, jsonb_build_object('currency', p_currency, 'amount_minor', v_minor,
    'product', p_product_id, 'version', v_next));
  return v_id;
end $$;

-- The price set a connection test reads back (proposed and configured rows, their versions and status).
create function platform.prices_fingerprint(p_conn uuid) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(coalesce((select string_agg(x.id::text || ':' || x.version || ':' || x.status || ':' || x.amount_minor
      || ':' || x.provider_product_id, ',' order by x.id)
    from billing.plan_prices x where x.connection_id = p_conn and x.status in ('proposed', 'configured')), ''), 'UTF8')), 'hex')
$$;

-- Why a running test may no longer certify anything (null = still valid). Called under the C2/C3 locks.
create function platform.test_problem(t platform.connection_tests, c platform.provider_connections, p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when t.status <> 'running' or t.started_by is distinct from p_user then 'test_not_running'
    when t.started_at < clock_timestamp() - interval '10 minutes' then 'test_expired'
    when not exists (select 1 from platform.admins a where a.user_id = p_user and a.revoked_at is null) then 'admin_revoked'
    when coalesce(c.pending_secret_id, c.credential_secret_id) is distinct from t.credential_secret_id
      or coalesce(c.pending_version, c.credential_version) <> t.credential_version then 'credential_changed'
    when c.expected_organization_id is distinct from t.expected_organization_id then 'organization_changed'
    when platform.prices_fingerprint(c.id) <> t.prices_fingerprint then 'prices_changed'
    end
$$;

create function private.platform_begin_test(p_conn uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.platform_actor(true);
  c platform.provider_connections;
  v_id uuid;
begin
  select * into c from platform.provider_connections where id = p_conn for no key update;  -- lock C2, then insert the test (C3)
  if not found then perform private.fail('not_found', 'connection'); end if;
  if coalesce(c.pending_secret_id, c.credential_secret_id) is null then perform private.fail('credential_unavailable'); end if;
  if c.expected_organization_id is null then perform private.fail('organization_required'); end if;
  insert into platform.connection_tests (connection_id, credential_version, credential_secret_id, expected_organization_id,
    connection_version, prices_fingerprint, started_by)
  values (p_conn, coalesce(c.pending_version, c.credential_version), coalesce(c.pending_secret_id, c.credential_secret_id),
    c.expected_organization_id, c.version, platform.prices_fingerprint(p_conn), v_uid) returning id into v_id;
  perform private.platform_audit(v_uid, 'connection.test_started', p_conn, null, jsonb_build_object('test_id', v_id));
  return v_id;
end $$;

-- billing_gateway (Edge platform-provider-test): the credential under test, only for a running test
-- started by a live platform admin in the last 10 minutes.
create function platform.gateway_test_context(p_test uuid, p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t platform.connection_tests;
  c platform.provider_connections;
  p platform.providers;
  v_problem text;
begin
  select * into t from platform.connection_tests where id = p_test;
  if not found then perform private.fail('test_not_running'); end if;
  select * into c from platform.provider_connections where id = t.connection_id;
  v_problem := platform.test_problem(t, c, p_user);
  if v_problem is not null then perform private.fail(v_problem); end if;
  select * into p from platform.providers where code = c.provider_code;
  -- Exactly the snapshotted credential and price set (validated above).
  return jsonb_build_object('connection_id', c.id, 'provider_code', c.provider_code, 'base_url', p.sandbox_base_url,
    'key_pattern', p.key_pattern, 'expected_organization_id', t.expected_organization_id,
    'api_key', platform.vault_value(t.credential_secret_id),
    'prices', coalesce((select jsonb_agg(jsonb_build_object('price_id', x.id, 'currency', x.currency, 'amount', billing.from_minor(x.amount_minor, x.currency),
        'provider_product_id', x.provider_product_id))
      from billing.plan_prices x where x.connection_id = c.id and x.status in ('proposed', 'configured')), '[]'));
end $$;

-- Result of a read-only connection test. Passing promotes a pending key (the previous key is kept for
-- in-flight work and the provider idempotency window) and configures proposed prices whose provider
-- product read matched currency, amount and monthly cadence. A passing test is NOT evidence that a
-- subscription, renewal or webhook lifecycle works.
create function platform.gateway_record_test(p_test uuid, p_user uuid, p_passed boolean, p_org_matched boolean, p_checks jsonb,
  p_price_results jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  t platform.connection_tests;
  c platform.provider_connections;
  r jsonb;
  v_p billing.plan_prices;
  v_ok boolean := coalesce(p_passed, false) and coalesce(p_org_matched, false);
  v_problem text;
begin
  -- Lock order C2 (connection) then C3 (test), then revalidate everything the test certifies.
  select * into t from platform.connection_tests where id = p_test;
  if not found then perform private.fail('test_not_running'); end if;
  select * into c from platform.provider_connections where id = t.connection_id for no key update;
  select * into t from platform.connection_tests where id = p_test for no key update;
  v_problem := platform.test_problem(t, c, p_user);
  if v_problem is not null then
    -- A stale, expired or orphaned test certifies nothing: it is closed as failed with the reason.
    if t.status = 'running' and t.started_by = p_user then
      update platform.connection_tests set status = 'failed', checks = jsonb_build_object('stale', v_problem), finished_at = clock_timestamp()
      where id = p_test;
      insert into platform.admin_audit (actor_id, aal, action, connection_id, credential_version, before, after)
      values (p_user, null, 'connection.test_rejected', c.id, t.credential_version, null, jsonb_build_object('test_id', p_test, 'reason', v_problem));
      return v_problem;
    end if;
    perform private.fail(v_problem);
  end if;
  if jsonb_typeof(coalesce(p_checks, '{}')) <> 'object' or octet_length(coalesce(p_checks, '{}')::text) > 4000
     or coalesce(p_checks, '{}')::text ~* 'sk_(live|sandbox)_' then
    perform private.fail('invalid_checks');
  end if;
  update platform.connection_tests set status = case when v_ok then 'passed' else 'failed' end, checks = coalesce(p_checks, '{}'),
    organization_matched = p_org_matched, finished_at = clock_timestamp() where id = p_test;
  if v_ok then
    if c.pending_secret_id is not null and t.credential_version = c.pending_version then
      -- Never discard a key still inside its retention window (store_secret also refuses this case).
      if c.previous_secret_id is not null and c.previous_retire_after > now() then
        perform private.fail('rotation_overlap_active', to_char(c.previous_retire_after at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'));
      end if;
      if c.previous_secret_id is not null then delete from vault.secrets where id = c.previous_secret_id; end if;
      update platform.provider_connections set previous_secret_id = credential_secret_id,
        previous_retire_after = case when credential_secret_id is not null then now() + interval '25 hours' end,
        credential_secret_id = pending_secret_id, credential_version = pending_version, credential_fingerprint = pending_fingerprint,
        credential_stored_at = now(), pending_secret_id = null, pending_version = null, pending_fingerprint = null
      where id = c.id;
    end if;
    update platform.provider_connections set status = case when status = 'draft' then 'tested' else status end,
      last_test_id = p_test, last_test_passed_at = clock_timestamp(), version = version + 1, updated_at = now() where id = c.id;
    for r in select * from jsonb_array_elements(coalesce(p_price_results, '[]')) loop
      select * into v_p from billing.plan_prices where id = (r ->> 'price_id')::uuid and connection_id = c.id and status = 'proposed' for no key update;
      continue when v_p.id is null;
      if coalesce((r ->> 'matched')::boolean, false) then
        update billing.plan_prices set status = 'retired', retired_at = now()
        where connection_id = c.id and currency = v_p.currency and status = 'configured';
        update billing.plan_prices set status = 'configured', configured_at = now(),
          recurring_capability = case when v_p.currency = 'USD' then 'documented_standard'
            when c.ngn_recurring_verified_at is not null then 'account_verified' else 'unverified' end
        where id = v_p.id;
      else
        update billing.plan_prices set status = 'rejected' where id = v_p.id;
      end if;
    end loop;
  else
    update platform.provider_connections set last_test_id = p_test, version = version + 1, updated_at = now() where id = c.id;
  end if;
  insert into platform.admin_audit (actor_id, aal, action, connection_id, credential_version, before, after)
  values (p_user, null, case when v_ok then 'connection.test_passed' else 'connection.test_failed' end, c.id, t.credential_version, null,
    jsonb_build_object('test_id', p_test, 'organization_matched', p_org_matched));
  return case when v_ok then 'passed' else 'failed' end;
end $$;

create function private.platform_enable(p_conn uuid, p_expected_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.platform_actor(true);
  c platform.provider_connections := private.platform_lock_connection(p_conn, p_expected_version);
begin
  if c.credential_secret_id is null or c.webhook_secret_id is null or c.expected_organization_id is null then
    perform private.fail('connection_incomplete');
  end if;
  if c.last_test_passed_at is null or c.last_test_passed_at < now() - interval '1 day' then perform private.fail('test_required'); end if;
  update platform.provider_connections set status = 'enabled', accepting_new = true, version = version + 1, updated_at = now()
  where id = p_conn;
  perform private.platform_audit(v_uid, 'connection.enabled', p_conn, jsonb_build_object('status', c.status), jsonb_build_object('status', 'enabled'));
  return c.version + 1;
end $$;

-- Stops new business only. Intake, worker reads and absorb continue for pinned subscriptions.
create function private.platform_disable(p_conn uuid, p_expected_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.platform_actor(true);
  c platform.provider_connections := private.platform_lock_connection(p_conn, p_expected_version);
begin
  update platform.provider_connections set status = 'disabled', accepting_new = false, version = version + 1, updated_at = now()
  where id = p_conn;
  perform private.platform_audit(v_uid, 'connection.disabled', p_conn, jsonb_build_object('status', c.status), jsonb_build_object('status', 'disabled'));
  return c.version + 1;
end $$;

-- The default is read only when a new checkout intent is created; existing subscriptions, renewals,
-- portal and cancellation stay on their pinned connection.
create function private.platform_set_default(p_conn uuid, p_expected_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.platform_actor(true);
  v_s platform.settings;
begin
  select * into v_s from platform.settings for no key update;
  if p_expected_version is null or v_s.version <> p_expected_version then perform private.fail('stale_version'); end if;
  if p_conn is not null and not exists (select 1 from platform.provider_connections where id = p_conn and status = 'enabled') then
    perform private.fail('connection_not_enabled');
  end if;
  update platform.settings set default_connection_id = p_conn, version = version + 1, updated_at = now();
  perform private.platform_audit(v_uid, 'settings.default_changed', p_conn, jsonb_build_object('default', v_s.default_connection_id),
    jsonb_build_object('default', p_conn));
  return v_s.version + 1;
end $$;

-- Refused while any subscription or pending checkout is pinned to the connection.
create function private.platform_delete_credential(p_conn uuid, p_expected_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.platform_actor(true);
  c platform.provider_connections := private.platform_lock_connection(p_conn, p_expected_version);
begin
  if exists (select 1 from billing.subscriptions where connection_id = p_conn and binding <> 'ended')
     or exists (select 1 from billing.checkout_intents where connection_id = p_conn
                and status in ('created', 'requesting', 'open', 'uncertain', 'completed_unpaid', 'review')) then
    perform private.fail('connection_in_use');
  end if;
  delete from vault.secrets where id in (c.credential_secret_id, c.pending_secret_id, c.previous_secret_id);
  update platform.provider_connections set credential_secret_id = null, pending_secret_id = null, pending_version = null,
    pending_fingerprint = null, previous_secret_id = null, previous_retire_after = null, credential_fingerprint = null,
    status = 'disabled', accepting_new = false, version = version + 1, updated_at = now() where id = p_conn;
  perform private.platform_audit(v_uid, 'secret.deleted', p_conn, null, jsonb_build_object('kind', 'api_key'));
  return c.version + 1;
end $$;

-- Retires replaced keys after their overlap, never while a run of that connection is in flight.
create function platform.retire_secrets() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c record;
  v_n integer := 0;
begin
  for c in select * from platform.provider_connections
           where previous_secret_id is not null and previous_retire_after < now() for no key update skip locked loop
    continue when exists (select 1 from billing.worker_runs r where r.connection_id = c.id and r.finished_at is null
                          and r.started_at > now() - interval '30 minutes');
    delete from vault.secrets where id = c.previous_secret_id;
    update platform.provider_connections set previous_secret_id = null, previous_retire_after = null where id = c.id;
    v_n := v_n + 1;
  end loop;
  for c in select * from platform.provider_connections
           where previous_webhook_secret_id is not null and previous_webhook_valid_until < now() for no key update skip locked loop
    delete from vault.secrets where id = c.previous_webhook_secret_id;
    update platform.provider_connections set previous_webhook_secret_id = null, previous_webhook_valid_until = null where id = c.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create function public.platform_overview() returns jsonb language sql stable security invoker set search_path = '' as
$$ select private.platform_overview() $$;
create function public.platform_create_connection(p_provider text, p_label text) returns uuid
language sql security invoker set search_path = '' as $$ select private.platform_create_connection(p_provider, p_label) $$;
create function public.platform_store_secret(p_conn uuid, p_kind text, p_secret text, p_expected_version integer) returns jsonb
language sql security invoker set search_path = '' as $$ select private.platform_store_secret(p_conn, p_kind, p_secret, p_expected_version) $$;
create function public.platform_set_expected_org(p_conn uuid, p_org text, p_expected_version integer) returns integer
language sql security invoker set search_path = '' as $$ select private.platform_set_expected_org(p_conn, p_org, p_expected_version) $$;
create function public.platform_propose_price(p_conn uuid, p_currency text, p_amount text, p_product_id text) returns uuid
language sql security invoker set search_path = '' as $$ select private.platform_propose_price(p_conn, p_currency, p_amount, p_product_id) $$;
create function public.platform_begin_test(p_conn uuid) returns uuid
language sql security invoker set search_path = '' as $$ select private.platform_begin_test(p_conn) $$;
create function public.platform_enable(p_conn uuid, p_expected_version integer) returns integer
language sql security invoker set search_path = '' as $$ select private.platform_enable(p_conn, p_expected_version) $$;
create function public.platform_disable(p_conn uuid, p_expected_version integer) returns integer
language sql security invoker set search_path = '' as $$ select private.platform_disable(p_conn, p_expected_version) $$;
create function public.platform_set_default(p_conn uuid, p_expected_version integer) returns integer
language sql security invoker set search_path = '' as $$ select private.platform_set_default(p_conn, p_expected_version) $$;
create function public.platform_delete_credential(p_conn uuid, p_expected_version integer) returns integer
language sql security invoker set search_path = '' as $$ select private.platform_delete_credential(p_conn, p_expected_version) $$;

-- ---------------------------------------------------------------------------
-- Operator-only (database owner; no grants to any role)
-- ---------------------------------------------------------------------------
-- Disposable fixtures and operator recovery only: configures a price on a connection without the
-- product read-back a connection test performs. Audited; never reachable from any role or RPC.
create function billing.operator_configure_price(p_conn uuid, p_currency text, p_amount text, p_product_id text, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_minor bigint := billing.to_minor(p_amount, p_currency);
  v_next integer;
  v_id uuid;
  v_ngn boolean;
begin
  if length(btrim(coalesce(p_note, ''))) = 0 then perform private.fail('reason_required'); end if;
  if p_product_id !~ '^[A-Za-z0-9_]{1,128}$' then perform private.fail('invalid_product'); end if;
  select ngn_recurring_verified_at is not null into v_ngn from platform.provider_connections where id = p_conn for no key update;  -- C2 before C4
  if not found then perform private.fail('not_found', 'connection'); end if;
  update billing.plan_prices set status = 'retired', retired_at = now() where connection_id = p_conn and currency = p_currency and status = 'configured';
  select coalesce(max(version), 0) + 1 into v_next from billing.plan_prices where connection_id = p_conn and currency = p_currency;
  insert into billing.plan_prices (connection_id, plan_code, currency, version, status, amount_minor, provider_product_id, recurring_capability,
    recurring_note, configured_at)
  values (p_conn, 'business', p_currency, v_next, 'configured', v_minor, p_product_id,
    case when p_currency = 'USD' then 'documented_standard' when v_ngn then 'account_verified' else 'unverified' end, p_note, now())
  returning id into v_id;
  insert into billing.operator_log (action, detail) values ('price_configured', jsonb_build_object('connection_id', p_conn,
    'currency', p_currency, 'amount_minor', v_minor, 'product', p_product_id, 'note', p_note));
  return v_id;
end $$;

-- NGN card subscriptions need account-specific enablement. Recorded only by the database owner from
-- real external evidence (a methods toggle is not evidence).
create function platform.operator_verify_ngn_recurring(p_conn uuid, p_evidence text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if length(btrim(coalesce(p_evidence, ''))) < 10 then perform private.fail('reason_required'); end if;
  update platform.provider_connections set ngn_recurring_verified_at = now(), ngn_recurring_evidence = btrim(p_evidence),
    version = version + 1, updated_at = now() where id = p_conn;
  if not found then perform private.fail('not_found', 'connection'); end if;
  update billing.plan_prices set recurring_capability = 'account_verified', recurring_note = btrim(p_evidence)
  where connection_id = p_conn and currency = 'NGN' and status in ('configured', 'proposed');
  insert into billing.operator_log (action, detail) values ('ngn_recurring_verified', jsonb_build_object('connection_id', p_conn,
    'evidence', p_evidence));
end $$;

create function billing.operator_set_suspension(p_ws uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update billing.workspace_billing set suspended_at = case when p_reason is null then null else now() end,
    suspended_reason = p_reason, version = version + 1, updated_at = now() where workspace_id = p_ws;
  if not found then perform private.fail('not_found', 'workspace'); end if;
  insert into public.audit_events (workspace_id, actor_id, action, entity_id, detail)
  values (p_ws, null, case when p_reason is null then 'billing.unsuspended' else 'billing.suspended' end, p_ws,
    jsonb_build_object('reason', p_reason, 'by', current_user));
end $$;

create function billing.operator_resolve_review(p_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if length(btrim(coalesce(p_note, ''))) = 0 then perform private.fail('reason_required'); end if;
  update billing.review_queue set resolved_at = now(), resolution_note = btrim(p_note) where id = p_id and resolved_at is null;
  insert into billing.operator_log (action, detail) values ('review_resolved', jsonb_build_object('id', p_id, 'note', p_note));
end $$;

-- After manual verification at Bachs that no checkout with this reference was paid.
create function billing.operator_release_intent(p_intent uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if length(btrim(coalesce(p_note, ''))) = 0 then perform private.fail('reason_required'); end if;
  update billing.checkout_intents set status = 'abandoned', resolved_at = now(), last_error_code = 'operator_released',
    version = version + 1, updated_at = now()
  where id = p_intent and status in ('uncertain', 'review', 'completed_unpaid', 'requesting');
  if not found then perform private.fail('invalid_state'); end if;
  insert into billing.operator_log (action, detail) values ('intent_released', jsonb_build_object('id', p_intent, 'note', p_note));
end $$;

-- DISPOSABLE FIXTURES ONLY. Older transactional SQL scripts that intentionally exercise more than the
-- trial limits call this as the database owner, inside their rolled-back transaction, after setting
-- savour.fixture_mode. No role has execute, no runtime path or RPC calls it, and the change is audited.
create function billing.fixture_uncap_trial(p_ws uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('savour.fixture_mode', true), '') <> 'disposable' then perform private.fail('fixture_mode_required'); end if;
  update billing.workspace_billing set trial_limits = '{"locations": 100000, "subjects": 100000, "staff": 100000, "assessments": 100000000}',
    limits_source = 'fixture_uncapped', updated_at = now() where workspace_id = p_ws;
  if not found then perform private.fail('not_found', 'workspace'); end if;
  insert into public.audit_events (workspace_id, actor_id, action, entity_id, detail)
  values (p_ws, null, 'billing.fixture_uncapped_trial', p_ws, jsonb_build_object('by', current_user));
end $$;

-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- Row level security (no policies: no direct client or role access to any billing/platform table)
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select schemaname, tablename from pg_catalog.pg_tables where schemaname in ('billing', 'platform') loop
    execute format('alter table %I.%I enable row level security', r.schemaname, r.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants (explicit; PostgreSQL's global default would otherwise give PUBLIC execute). Vault grants are
-- not changed: no role here receives any Vault privilege; only the definer wrappers read it.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema billing, platform from public, anon, authenticated, billing_intake, billing_gateway, billing_worker;
revoke all on all sequences in schema billing, platform from public, anon, authenticated, billing_intake, billing_gateway, billing_worker;
revoke all on all functions in schema billing, platform from public, anon, authenticated, billing_intake, billing_gateway, billing_worker;
alter default privileges in schema billing revoke all on tables from public, anon, authenticated;
alter default privileges in schema billing revoke all on functions from public, anon, authenticated;
alter default privileges in schema platform revoke all on tables from public, anon, authenticated;
alter default privileges in schema platform revoke all on functions from public, anon, authenticated;
revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon;

grant execute on function billing.ingest_event(uuid, text, text, timestamptz, text, bytea, text, bigint, text),
  platform.get_webhook_secrets(uuid) to billing_intake;

grant execute on function
  billing.start_run(uuid, text, text, text), billing.finish_run(uuid, integer, integer, integer, text),
  billing.claim_events(uuid, text, integer, integer), billing.complete_event(uuid, text, uuid, text), billing.fail_event(uuid, text, uuid, text),
  billing.absorb_checkout(uuid, text, uuid, jsonb, timestamptz), billing.absorb_payment(uuid, text, uuid, jsonb, timestamptz),
  billing.absorb_subscription(uuid, text, uuid, jsonb, timestamptz), billing.absorb_refund(uuid, text, uuid, jsonb, timestamptz),
  billing.absorb_dispute(uuid, text, uuid, jsonb, timestamptz), billing.reconcile_candidates(uuid, integer),
  billing.checkout_retry_context(uuid), billing.record_checkout_result(uuid, text, text, text, timestamptz, text, text),
  billing.housekeeping(), billing.worker_connections(), platform.get_credential(uuid), billing.release_event(uuid, text, uuid),
  billing.discovery_begin(uuid), billing.discovery_record_page(uuid, uuid, integer, jsonb, integer, boolean),
  billing.discovery_claim(uuid, text, integer, integer), billing.discovery_classify(uuid, text, text, text),
  billing.discovery_finish(uuid, text, uuid, text, text, text)
to billing_worker;

grant execute on function
  billing.gateway_checkout_context(uuid, uuid), billing.gateway_bind_customer(uuid, uuid, uuid, text, text, text),
  billing.gateway_customer_review(uuid, uuid, uuid, text, text), billing.gateway_mark_requesting(uuid, uuid, text),
  billing.gateway_record_checkout(uuid, uuid, text, text, text, timestamptz, text, text),
  billing.gateway_portal_context(uuid, uuid), billing.gateway_portal_refused(uuid, uuid, uuid, text[]),
  billing.gateway_cancel_context(uuid, uuid), billing.gateway_apply_subscription(uuid, uuid, jsonb, timestamptz),
  platform.get_credential(uuid), platform.gateway_test_context(uuid, uuid),
  platform.gateway_record_test(uuid, uuid, boolean, boolean, jsonb, jsonb)
to billing_gateway;

-- Internal helpers: only called from SECURITY DEFINER functions.
revoke all on function private.valid_period(billing.paid_periods), private.billing_core(uuid),
  private.billing_usage(uuid, timestamptz, timestamptz), private.effective_access(uuid),
  private.access_summary(uuid, public.member_role), private.lock_billing(uuid), private.require_writable(uuid),
  private.require_capacity(uuid, text, integer), private.reserve_session_work(uuid, uuid, uuid),
  private.release_session_work(uuid, uuid, uuid), private.consume_assessment(uuid, uuid, uuid, uuid, boolean),
  private.require_owner(uuid), private.currency_offer(uuid, text), private.platform_actor(boolean),
  private.platform_audit(uuid, text, uuid, jsonb, jsonb), private.platform_connection_json(platform.provider_connections),
  private.platform_lock_connection(uuid, integer)
from authenticated;
grant execute on function private.get_billing(uuid), private.set_billing_contact(uuid, text, boolean, integer),
  private.begin_checkout(uuid, text, uuid, text), private.request_cancellation(uuid, integer), private.authorize_portal(uuid),
  private.platform_overview(), private.platform_create_connection(text, text), private.platform_store_secret(uuid, text, text, integer),
  private.platform_set_expected_org(uuid, text, integer), private.platform_propose_price(uuid, text, text, text),
  private.platform_begin_test(uuid), private.platform_enable(uuid, integer), private.platform_disable(uuid, integer),
  private.platform_set_default(uuid, integer), private.platform_delete_credential(uuid, integer)
to authenticated;
grant execute on function public.get_billing(uuid), public.set_billing_contact(uuid, text, boolean, integer),
  public.begin_checkout(uuid, text, uuid, text), public.request_cancellation(uuid, integer), public.authorize_portal(uuid),
  public.platform_overview(), public.platform_create_connection(text, text), public.platform_store_secret(uuid, text, text, integer),
  public.platform_set_expected_org(uuid, text, integer), public.platform_propose_price(uuid, text, text, text),
  public.platform_begin_test(uuid), public.platform_enable(uuid, integer), public.platform_disable(uuid, integer),
  public.platform_set_default(uuid, integer), public.platform_delete_credential(uuid, integer)
to authenticated;
