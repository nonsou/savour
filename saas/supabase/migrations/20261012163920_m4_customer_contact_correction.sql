-- Billing contact correction before a provider customer exists (additive; earlier migrations stay sealed,
-- including billing.guard_row, which keeps customer_idempotency_key immutable and forbids deletes).
--
-- set_billing_contact refuses once any provider_customers row exists, and that row is written on the first
-- checkout attempt. The page reported "locked" only once a customer was bound, so it offered an edit the
-- server always refused. This migration:
--   * derives one contact state (billing.contact_state) used by both get_billing and the correction RPC;
--   * records definitive refusal proof only for the CURRENT customer claim, atomically with its release,
--     and only for the observed validation rejection (http_400 or http_422 with VALIDATION_ERROR);
--     every new claim clears it;
--   * lets the Owner correct the email only when no request with the current identity can have created
--     a customer: nothing sent, or the last request definitively refused. Live or expired leases,
--     uncertain creations, unresolved customer reviews and rows with unknown history always block;
--   * rotates the request identity through a new effective key (customer_request_key, generation) while
--     the original customer_idempotency_key stays unchanged; the new identity fields are immutable once a
--     customer is bound;
--   * abandons any created intent before the contact changes, so an in-flight gateway run for the old
--     email cannot claim, request or resume afterwards.
-- No provider_customers row is deleted, no bound customer is replaced, and metadata adoption is unchanged.

alter table billing.provider_customers
  -- Proof that the current identity's last creation request was definitively refused (see below).
  add column create_refused_at timestamptz,
  add column create_refused_detail text check (create_refused_detail in ('http_400:VALIDATION_ERROR', 'http_422:VALIDATION_ERROR')),
  -- The effective request identity after a correction; null means customer_idempotency_key (generation 0).
  add column customer_request_key text unique check (customer_request_key ~ '^savour-customer-[0-9a-f-]{73}-g[1-9][0-9]{0,5}-[0-9a-f]{16}$'),
  add column customer_key_generation integer not null default 0 check (customer_key_generation >= 0),
  -- create_attempts when the current identity started: claims beyond it were made with the current key.
  add column customer_key_attempts_base integer not null default 0 check (customer_key_attempts_base >= 0),
  -- Rows written before outcomes were recorded per claim: whether a request reached Bachs is unknown.
  add column history_unknown boolean not null default false,
  add check ((create_refused_at is null) = (create_refused_detail is null)),
  add check ((customer_key_generation = 0) = (customer_request_key is null)),
  add check (customer_key_attempts_base <= create_attempts);

-- Every unbound row existing now predates per-claim outcome records, so an earlier POST /v1/customers may
-- have succeeded even if a later lookup by email finds nothing. These rows stay locked for manual review;
-- checkout itself is unaffected (same key, same adoption rules).
update billing.provider_customers set history_unknown = true where provider_customer_id is null;

-- Request identity rules, in addition to billing.guard_row (which is not replaced).
create function billing.guard_customer_request() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.provider_customer_id is not null and (new.customer_request_key, new.customer_key_generation, new.customer_key_attempts_base,
      new.history_unknown) is distinct from (old.customer_request_key, old.customer_key_generation, old.customer_key_attempts_base,
      old.history_unknown) then
    raise exception 'immutable_record' using detail = 'provider_customers';
  end if;
  if new.customer_key_generation < old.customer_key_generation
     or (new.customer_key_generation = old.customer_key_generation) <> (new.customer_request_key is not distinct from old.customer_request_key)
     or new.customer_key_attempts_base < old.customer_key_attempts_base
     or (old.history_unknown and not new.history_unknown) then
    raise exception 'immutable_record' using detail = 'provider_customers';
  end if;
  return new;
end $$;
create trigger provider_customers_request_guard before update on billing.provider_customers
  for each row execute function billing.guard_customer_request();

-- The billing contact of a workspace: 'editable' (no customer request yet; set_billing_contact),
-- 'correctable' (correct_billing_contact), or why it is locked. Callers that act on it hold the billing
-- row, intent and customer row locks first.
create function billing.contact_state(p_ws uuid) returns text
language sql stable set search_path = '' as $$
  select case
    when not exists (select 1 from billing.provider_customers c where c.workspace_id = p_ws) then 'editable'
    when exists (select 1 from billing.provider_customers c where c.workspace_id = p_ws and c.provider_customer_id is not null) then 'bound'
    when exists (select 1 from billing.provider_customers c where c.workspace_id = p_ws and c.create_lease_until > clock_timestamp())
      or exists (select 1 from billing.checkout_intents i where i.workspace_id = p_ws
                 and i.status in ('requesting', 'open', 'uncertain', 'completed_unpaid', 'review')) then 'in_progress'
    -- An expired lease was never closed by its own outcome: that request may have reached Bachs.
    when exists (select 1 from billing.provider_customers c where c.workspace_id = p_ws
                 and (c.create_uncertain_since is not null or c.create_lease_until is not null or c.create_claim_token is not null)) then 'uncertain'
    when exists (select 1 from billing.review_queue r where r.workspace_id = p_ws and r.resolved_at is null and r.kind like 'customer\_%') then 'review'
    when exists (select 1 from billing.provider_customers c where c.workspace_id = p_ws and c.history_unknown) then 'unverified'
    when exists (select 1 from billing.provider_customers c where c.workspace_id = p_ws
                 and c.create_attempts > c.customer_key_attempts_base and c.create_refused_at is null) then 'request_sent'
    else 'correctable' end
$$;

-- As before, plus: every new claim clears the refusal proof of the previous one.
create or replace function billing.gateway_customer_claim(p_intent uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v billing.checkout_intents;
  v_c billing.provider_customers;
  v_uncertain timestamptz;
  v_token uuid := gen_random_uuid();
begin
  select * into v from billing.checkout_intents where id = p_intent;
  if not found or v.owner_id <> p_user then perform private.fail('not_found', 'intent'); end if;
  perform private.lock_billing(v.workspace_id);
  select * into v from billing.checkout_intents where id = p_intent for no key update;
  perform billing.require_live_owner(v.workspace_id, p_user);
  if v.status <> 'created' or v.created_at < now() - interval '15 minutes' then perform private.fail('checkout_intent_stale'); end if;
  select * into v_c from billing.provider_customers where workspace_id = v.workspace_id and connection_id = v.connection_id for no key update;
  if not found then perform private.fail('not_found', 'customer request'); end if;
  if v_c.provider_customer_id is not null then
    return jsonb_build_object('decision', 'bound', 'provider_customer_id', v_c.provider_customer_id);
  end if;
  if v_c.create_lease_until > clock_timestamp() then return jsonb_build_object('decision', 'in_progress'); end if;
  -- An earlier claim whose result was never recorded may have reached Bachs.
  v_uncertain := case when v_c.create_lease_until is not null then coalesce(v_c.create_uncertain_since, v_c.create_last_attempt_at)
    else v_c.create_uncertain_since end;
  if v_uncertain is not null and (v_uncertain < now() - interval '23 hours' or v_c.create_uncertain_retries >= 3) then
    update billing.provider_customers set create_lease_until = null, create_claim_token = null, create_uncertain_since = v_uncertain,
      create_refused_at = null, create_refused_detail = null
    where workspace_id = v.workspace_id and connection_id = v.connection_id;
    perform billing.review(v.connection_id, v.workspace_id, 'customer_creation_unresolved', v.workspace_id::text, '{}'::jsonb,
      jsonb_build_object('attempts', v_c.create_attempts), null);
    return jsonb_build_object('decision', 'review');
  end if;
  update billing.provider_customers set create_attempts = create_attempts + 1, create_last_attempt_at = clock_timestamp(),
    create_lease_until = clock_timestamp() + interval '60 seconds', create_uncertain_since = v_uncertain,
    create_uncertain_retries = create_uncertain_retries + case when v_uncertain is not null then 1 else 0 end,
    create_claim_token = v_token, create_refused_at = null, create_refused_detail = null
  where workspace_id = v.workspace_id and connection_id = v.connection_id;
  return jsonb_build_object('decision', 'proceed', 'claim', v_token);
end $$;

-- As before, plus: the outcome of the CURRENT claim also decides the refusal proof, in the same update
-- that releases its lease. Proof only for a refusal whose sanitized detail is exactly one of the observed
-- validation rejections, only while the claim's lease is still live (an outcome arriving after expiry
-- certifies nothing), and only while nothing is uncertain. Other 4xx (including 409 and 429, other
-- 400/422 codes, or a status without a code), uncertain outcomes and late outcomes of superseded claims
-- certify nothing.
create or replace function billing.gateway_record_preparation(p_intent uuid, p_user uuid, p_attempt uuid, p_code text, p_detail text,
  p_customer_outcome text, p_claim uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v billing.checkout_intents;
  v_code text := case when billing.preparation_retryable(p_code) and p_code is not null then p_code
    when p_code in ('customer_create_unresolved', 'billing_customer_review', 'price_changed', 'price_not_configured', 'provider_unavailable',
      'billing_contact_required', 'checkout_intent_stale', 'forbidden') then p_code
    else 'preparation_failed' end;
  v_proof boolean := p_customer_outcome = 'refused' and p_code = 'customer_create_refused'
    and p_detail in ('http_400:VALIDATION_ERROR', 'http_422:VALIDATION_ERROR');
begin
  if p_customer_outcome is not null and (p_customer_outcome not in ('refused', 'uncertain') or p_claim is null) then
    perform private.fail('invalid_outcome');
  end if;
  select * into v from billing.checkout_intents where id = p_intent;
  if not found or v.owner_id <> p_user then perform private.fail('not_found', 'intent'); end if;
  perform private.lock_billing(v.workspace_id);
  select * into v from billing.checkout_intents where id = p_intent for no key update;
  if p_customer_outcome is not null then
    update billing.provider_customers set
      create_lease_until = case when create_claim_token = p_claim then null else create_lease_until end,
      create_claim_token = case when create_claim_token = p_claim then null else create_claim_token end,
      create_uncertain_since = case when p_customer_outcome = 'uncertain' then coalesce(create_uncertain_since, create_last_attempt_at, now())
        else create_uncertain_since end,
      create_refused_at = case when create_claim_token is distinct from p_claim then create_refused_at
        when coalesce(v_proof, false) and create_uncertain_since is null and create_lease_until > clock_timestamp() then clock_timestamp() end,
      create_refused_detail = case when create_claim_token is distinct from p_claim then create_refused_detail
        when coalesce(v_proof, false) and create_uncertain_since is null and create_lease_until > clock_timestamp() then p_detail end
    where workspace_id = v.workspace_id and connection_id = v.connection_id and provider_customer_id is null;
  end if;
  if v.status <> 'created' then return v.status; end if;
  if v.prepare_attempt is distinct from p_attempt then return 'superseded'; end if;
  update billing.checkout_intents set last_error_code = v_code,
    prepare_error_detail = case when p_detail ~ '^(http_[0-9]{3}(:[A-Z_]{2,60})?|timeout|network|response_invalid)$' then p_detail end,
    version = version + 1, updated_at = now()
  where id = p_intent;
  return v_code;
end $$;

-- As before, but returns the effective request key (the corrected identity when there is one) and refuses
-- a customer request whose email differs from the workspace's billing contact.
create or replace function billing.gateway_checkout_context(p_intent uuid, p_user uuid) returns jsonb
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
  if v_c.billing_email is distinct from v_b.billing_email then perform private.fail('billing_contact_mismatch'); end if;
  return jsonb_build_object('intent_id', v.id, 'workspace_id', v.workspace_id, 'connection_id', v.connection_id,
    'billing_email', v_c.billing_email, 'provider_customer_id', v_c.provider_customer_id,
    'customer_idempotency_key', coalesce(v_c.customer_request_key, v_c.customer_idempotency_key),
    'customer_key_generation', v_c.customer_key_generation,
    'provider_product_id', v.provider_product_id, 'currency', v.currency, 'amount', billing.from_minor(v.amount_minor, v.currency),
    'card_corridor', (select card_corridor from billing.currencies where code = v.currency),
    'reference', v.reference, 'idempotency_key', v.idempotency_key);
end $$;

-- The Owner corrects the billing email while no provider customer can exist for it. Same rules as
-- set_billing_contact (live Owner, expected version, email format, consent, distinct across workspaces),
-- plus the contact state re-read under the billing, intent and customer locks (the checkout lock order).
-- A created intent is abandoned before the contact changes; the original customer key is kept and a new
-- effective key is issued per connection. The audit carries no email values.
create function private.correct_billing_contact(p_ws uuid, p_email text, p_consent boolean, p_expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_b billing.workspace_billing;
  v_state text;
  v_refusal text;
  v_generation integer;
  v_abandoned integer;
begin
  perform private.require_owner(p_ws);
  v_b := private.lock_billing(p_ws);
  if p_expected_version is null or v_b.version <> p_expected_version then perform private.fail('stale_version'); end if;
  perform 1 from billing.checkout_intents where workspace_id = p_ws
    and status in ('created', 'requesting', 'open', 'uncertain', 'completed_unpaid', 'review') for no key update;
  perform 1 from billing.provider_customers where workspace_id = p_ws order by connection_id for no key update;
  v_state := billing.contact_state(p_ws);
  if v_state <> 'correctable' then
    perform private.fail(case v_state when 'editable' then 'billing_contact_not_requested' when 'bound' then 'billing_contact_locked'
      when 'in_progress' then 'customer_request_in_progress' when 'uncertain' then 'customer_request_uncertain'
      when 'review' then 'customer_request_review' when 'unverified' then 'customer_request_unverified'
      else 'customer_request_sent' end);
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 or v_email ~ '[[:cntrl:]]' then
    perform private.fail('invalid_email');
  end if;
  if not coalesce(p_consent, false) then perform private.fail('consent_required'); end if;
  if v_email = v_b.billing_email then perform private.fail('billing_contact_unchanged'); end if;
  select max(create_refused_detail), max(customer_key_generation) + 1 into v_refusal, v_generation
  from billing.provider_customers where workspace_id = p_ws;

  update billing.checkout_intents set status = 'abandoned', resolved_at = now(), last_error_code = 'contact_corrected',
    version = version + 1, updated_at = now()
  where workspace_id = p_ws and status = 'created';
  get diagnostics v_abandoned = row_count;

  begin
    update billing.workspace_billing set billing_email = v_email, billing_email_consent_at = now(),
      billing_email_consent_by = (select auth.uid()), version = version + 1, updated_at = now()
    where workspace_id = p_ws;
  exception when unique_violation then
    perform private.fail('billing_email_in_use');
  end;
  update billing.provider_customers set billing_email = v_email, customer_key_generation = customer_key_generation + 1,
    customer_request_key = 'savour-customer-' || connection_id || '-' || workspace_id || '-g' || (customer_key_generation + 1) || '-'
      || left(private.sha256_hex(v_email), 16),
    customer_key_attempts_base = create_attempts, create_refused_at = null, create_refused_detail = null
  where workspace_id = p_ws;
  perform private.audit(p_ws, 'billing.contact_corrected', p_ws, jsonb_build_object('version', v_b.version + 1,
    'generation', v_generation, 'previous_refusal', v_refusal, 'abandoned_intents', v_abandoned));
  return v_b.version + 1;
end $$;
create function public.correct_billing_contact(p_ws uuid, p_email text, p_consent boolean, p_expected_version integer) returns integer
language sql security invoker set search_path = '' as $$ select private.correct_billing_contact(p_ws, p_email, p_consent, p_expected_version) $$;

-- get_billing as before; billing_contact also carries its state, so the page offers only the action the
-- server accepts.
create or replace function private.get_billing(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role public.member_role;
  v_b billing.workspace_billing;
  v_sub billing.subscriptions;
  v_intent billing.checkout_intents;
  v_c billing.provider_customers;
  v_contact text;
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
  if v_intent.status = 'created' then
    select * into v_c from billing.provider_customers where workspace_id = p_ws and connection_id = v_intent.connection_id;
  end if;
  v_contact := billing.contact_state(p_ws);
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
      'consent_at', v_b.billing_email_consent_at, 'state', v_contact,
      'locked', v_contact not in ('editable', 'correctable'), 'correctable', v_contact = 'correctable') end,
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
      'checkout_expires_at', v_intent.checkout_expires_at,
      'preparation', case when v_intent.status = 'created' then jsonb_build_object(
        'error_code', v_intent.last_error_code, 'detail', v_intent.prepare_error_detail,
        'retry_allowed', v_intent.created_at > now() - interval '15 minutes' and billing.preparation_retryable(v_intent.last_error_code),
        'customer_uncertain', v_c.provider_customer_id is null and (v_c.create_uncertain_since is not null
          or v_c.create_lease_until is not null)) end) end,
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

-- Owner entry point only. The gateway, intake and worker roles get nothing new; replaced gateway functions
-- keep their existing grants (billing_gateway only).
revoke all on function billing.guard_customer_request(), billing.contact_state(uuid),
  private.correct_billing_contact(uuid, text, boolean, integer), public.correct_billing_contact(uuid, text, boolean, integer)
from public, anon, authenticated, billing_intake, billing_gateway, billing_worker;
grant execute on function private.correct_billing_contact(uuid, text, boolean, integer), public.correct_billing_contact(uuid, text, boolean, integer)
to authenticated;
