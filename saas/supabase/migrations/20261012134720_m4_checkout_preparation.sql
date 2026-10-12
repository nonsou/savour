-- Checkout preparation recovery (additive; earlier migrations stay sealed).
-- Before the checkout request an intent stays 'created' while SAVOUR finds or creates the workspace's
-- Bachs customer. This migration:
--   * records a sanitized reason on the intent when preparation stops (code plus HTTP status and the
--     provider's error_code only; never a response body);
--   * serializes customer creation with a short lease, and treats an attempt whose result was never
--     recorded as uncertain;
--   * fences late results: each customer claim carries a token and each Owner retry a preparation
--     attempt token, so an outcome from an expired claim or a superseded attempt can neither release a
--     newer claim nor overwrite a newer reason;
--   * after an uncertain creation, allows identical retries (same customer idempotency key) only inside
--     the provider's 24-hour idempotency window and at most three more times, then queues a review;
--   * lets the consenting Owner retry the same pending intent (fresh role check, pinned connection,
--     price and currency unchanged).

alter table billing.checkout_intents
  add column prepare_error_detail text
    check (prepare_error_detail ~ '^(http_[0-9]{3}(:[A-Z_]{2,60})?|timeout|network|response_invalid)$'),
  -- Null for the first attempt (begin_checkout); a new token for every Owner retry.
  add column prepare_attempt uuid;

alter table billing.provider_customers
  add column create_attempts integer not null default 0 check (create_attempts >= 0),
  add column create_last_attempt_at timestamptz,
  add column create_lease_until timestamptz,
  add column create_uncertain_since timestamptz,
  add column create_uncertain_retries integer not null default 0 check (create_uncertain_retries >= 0),
  -- The current creation claim; only an outcome carrying this token may release its lease.
  add column create_claim_token uuid;

-- Preparation outcomes the consenting Owner may retry on the same intent. Anything else needs a fresh
-- checkout (price or terms changed, connection unavailable) or SAVOUR support (review).
create function billing.preparation_retryable(p_code text) returns boolean
language sql immutable set search_path = '' as $$
  select p_code is null or p_code in ('customer_lookup_refused', 'customer_lookup_unavailable', 'customer_create_refused',
    'customer_create_uncertain', 'customer_create_in_progress', 'provider_response_invalid', 'provider_config_invalid',
    'preparation_failed')
$$;

-- Claims the right to send POST /v1/customers for this intent's workspace and connection.
-- Returns {decision: proceed (with claim token) | bound | in_progress | review}.
create function billing.gateway_customer_claim(p_intent uuid, p_user uuid) returns jsonb
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
    update billing.provider_customers set create_lease_until = null, create_claim_token = null, create_uncertain_since = v_uncertain
    where workspace_id = v.workspace_id and connection_id = v.connection_id;
    perform billing.review(v.connection_id, v.workspace_id, 'customer_creation_unresolved', v.workspace_id::text, '{}'::jsonb,
      jsonb_build_object('attempts', v_c.create_attempts), null);
    return jsonb_build_object('decision', 'review');
  end if;
  update billing.provider_customers set create_attempts = create_attempts + 1, create_last_attempt_at = clock_timestamp(),
    create_lease_until = clock_timestamp() + interval '60 seconds', create_uncertain_since = v_uncertain,
    create_uncertain_retries = create_uncertain_retries + case when v_uncertain is not null then 1 else 0 end,
    create_claim_token = v_token
  where workspace_id = v.workspace_id and connection_id = v.connection_id;
  return jsonb_build_object('decision', 'proceed', 'claim', v_token);
end $$;

-- Records why preparation stopped. The intent keeps status 'created'.
-- p_attempt: the preparation attempt that produced this outcome (null for the first). An outcome from a
--   superseded attempt does not overwrite the reason a newer attempt will record.
-- p_customer_outcome (refused | uncertain) with p_claim closes that customer creation claim. Only the
--   current claim releases the lease; a late outcome from an expired claim leaves the newer claim alone
--   (an uncertain one can only make the customer state stricter). Uncertainty is sticky until bound.
create function billing.gateway_record_preparation(p_intent uuid, p_user uuid, p_attempt uuid, p_code text, p_detail text,
  p_customer_outcome text, p_claim uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v billing.checkout_intents;
  v_code text := case when billing.preparation_retryable(p_code) and p_code is not null then p_code
    when p_code in ('customer_create_unresolved', 'billing_customer_review', 'price_changed', 'price_not_configured', 'provider_unavailable',
      'billing_contact_required', 'checkout_intent_stale', 'forbidden') then p_code
    else 'preparation_failed' end;
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
        else create_uncertain_since end
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

-- The consenting Owner retries the same pending intent: same reference, idempotency keys, pinned
-- connection, price and currency. Live Owner membership is re-checked here and again by the gateway.
create function private.resume_checkout(p_ws uuid, p_intent uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_b billing.workspace_billing;
  v billing.checkout_intents;
  v_new billing.checkout_intents;
begin
  perform private.require_owner(p_ws);
  v_b := private.lock_billing(p_ws);
  if v_b.suspended_at is not null then perform private.fail('workspace_suspended'); end if;
  select * into v from billing.checkout_intents where id = p_intent and workspace_id = p_ws for no key update;
  if not found then perform private.fail('not_found', 'checkout'); end if;
  if v.owner_id <> v_uid then perform private.fail('forbidden'); end if;
  if v.status in ('requesting', 'open', 'uncertain', 'completed_unpaid', 'review') then perform private.fail('checkout_in_progress'); end if;
  if v.status <> 'created' or v.created_at < now() - interval '15 minutes' then perform private.fail('checkout_intent_stale'); end if;
  if v.terms_version is distinct from billing.terms_version() then perform private.fail('terms_changed'); end if;
  if not billing.preparation_retryable(v.last_error_code) then perform private.fail('checkout_not_retryable'); end if;
  update billing.checkout_intents set last_error_code = null, prepare_error_detail = null, prepare_attempt = gen_random_uuid(),
    version = version + 1, updated_at = now()
  where id = p_intent returning * into v_new;
  perform private.audit(p_ws, 'billing.checkout_intent_resumed', v.id, jsonb_build_object('previous_error', v.last_error_code));
  return jsonb_build_object('intent_id', v.id, 'attempt', v_new.prepare_attempt);
end $$;
create function public.resume_checkout(p_ws uuid, p_intent uuid) returns jsonb
language sql security invoker set search_path = '' as $$ select private.resume_checkout(p_ws, p_intent) $$;

-- get_billing as before, plus the preparation state of a created intent.
create or replace function private.get_billing(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role public.member_role;
  v_b billing.workspace_billing;
  v_sub billing.subscriptions;
  v_intent billing.checkout_intents;
  v_c billing.provider_customers;
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

revoke all on function billing.preparation_retryable(text), billing.gateway_customer_claim(uuid, uuid),
  billing.gateway_record_preparation(uuid, uuid, uuid, text, text, text, uuid), private.resume_checkout(uuid, uuid), public.resume_checkout(uuid, uuid)
from public, anon, authenticated, billing_intake, billing_gateway, billing_worker;
grant execute on function billing.gateway_customer_claim(uuid, uuid), billing.gateway_record_preparation(uuid, uuid, uuid, text, text, text, uuid)
to billing_gateway;
grant execute on function private.resume_checkout(uuid, uuid), public.resume_checkout(uuid, uuid) to authenticated;
