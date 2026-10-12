-- Observed non-final payment status 'open' (additive; earlier migrations stay sealed).
--
-- Provenance: Bachs sandbox, 2026-10-12. After a declined test card, GET /v1/payments/{id} returned
-- status 'open' for the checkout charge while a signed collection.failed event was recorded. 'open' is
-- absent from the saved OpenAPI PaymentResponse enum, so the parser refused it (dto_invalid at
-- payment.status) and the event retried. The adapter now accepts exactly lowercase 'open' as an explicit
-- observed extension and keeps it unchanged in the facts.
--
-- This replaces billing.absorb_payment with its sealed body unchanged except for one line: 'open' joins
-- the existing 'created'/'processing' pending branch and returns 'payment_pending'. Consequences:
--   * First payment: an open charge grants no period, binds no subscription, starts no grace and leaves
--     trial limits as they are; the checkout may still be retried. A later succeeded GET grants normally;
--     a later failed, expired or cancelled GET takes the existing payment_failed_no_access path.
--   * Renewal: an open subscription_cycle payment records no payment_failures row, so no failure
--     observation and no grace comes from it. A later failed GET records the failure exactly as before.
--     The pending branch still does not call apply_subscription_facts (unchanged).
-- The full GET remains the only authority; a collection.failed envelope alone establishes nothing.

-- GET /v1/payments/{id} plus GET /v1/subscriptions/{id}: the only path that writes a paid period.
create or replace function billing.absorb_payment(p_conn uuid, p_event text, p_token uuid, p_facts jsonb, p_observed_at timestamptz)
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
  -- 'open' is the observed, undocumented non-final status (see the header): pending, never failure.
  if p ->> 'status' in ('created', 'processing', 'open') then
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
