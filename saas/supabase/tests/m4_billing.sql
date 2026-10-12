-- SAVOUR Milestone 4 transactional billing test (trial, limits, reservations, read-only, prices,
-- checkout intents, scoped roles, webhook inbox, worker claims/fencing, reconciliation).
--
-- Runs entirely inside one transaction and ROLLS BACK. Run as the database owner, e.g.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m4_billing.sql
-- Uses SET ROLE authenticated + request.jwt.claims (as PostgREST does) and SET ROLE to each scoped
-- billing role. Provider objects below are hand-written contract fixtures shaped like the official
-- Bachs OpenAPI v1.0.0 DTOs after src parsing; they are NOT sandbox evidence. "fixture time travel"
-- marks owner-side edits of timestamps that cannot elapse inside one transaction.
-- Fixture user IDs use the disposable prefix eeeeeeee-0000-4000-8000-.
-- Single connection: real overlapping transactions (checkout races, claims, reservations) are not
-- exercised here and need a two-connection check on real Postgres.

begin;

create schema t;
grant usage on schema t to authenticated, anon, billing_intake, billing_gateway, billing_worker;
create table t.vars (k text primary key, v text);
create table t.passes (n integer generated always as identity, msg text);
grant all on t.vars, t.passes to authenticated, anon, billing_intake, billing_gateway, billing_worker;

create function t.u(n integer) returns uuid language sql immutable as
$$ select ('eeeeeeee-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function t.as(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', t.u(n), 'role', 'authenticated', 'aal', 'aal1')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function t.admin(n integer, p_aal text default 'aal2') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', t.u(n), 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function t.role(r text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', r, true);
end $$;
create function t.put(k text, v text) returns void language sql as
$$ insert into t.vars values (k, v) on conflict (k) do update set v = excluded.v $$;
create function t.id(k text) returns uuid language sql stable as $$ select v::uuid from t.vars where t.vars.k = id.k $$;
create function t.get(k text) returns text language sql stable as $$ select v from t.vars where t.vars.k = get.k $$;
create function t.ok(p boolean, msg text) returns void language plpgsql as $$
begin
  if p is not true then raise exception 'FAIL: %', msg; end if;
  insert into t.passes (msg) values (msg);
end $$;
create function t.err(p_sql text, p_expect text, msg text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm like p_expect then insert into t.passes (msg) values (msg); return; end if;
    raise exception 'FAIL: % (expected %, got %: %)', msg, p_expect, sqlerrm, sqlstate;
  end;
  raise exception 'FAIL: % (expected error %, statement succeeded)', msg, p_expect;
end $$;
create function t.n(p_sql text) returns bigint language plpgsql as $$
declare v bigint;
begin execute 'select count(*) from (' || p_sql || ') q' into v; return v; end $$;
grant execute on all functions in schema t to authenticated, anon, billing_intake, billing_gateway, billing_worker;

-- Normalized provider facts (shape produced by supabase/functions/_shared/bachs-dto.ts).
create function t.sub(p_id text, p_customer text, p_status text, p_amount text, p_currency text, p_product text,
  p_start timestamptz, p_end timestamptz, p_cancel boolean default false, p_interval text default 'month',
  p_frequency integer default 1, p_quantity integer default 1) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_id, 'customer_id', p_customer, 'status', p_status, 'currency', p_currency, 'amount', p_amount,
    'interval', p_interval, 'frequency', p_frequency, 'quantity', p_quantity, 'product_id', p_product,
    'item_product_ids', jsonb_build_array(p_product), 'current_period_start', p_start, 'current_period_end', p_end,
    'cancel_at_period_end', p_cancel, 'canceled_at', null)
$$;
create function t.pay(p_id text, p_sub text, p_status text, p_amount text, p_currency text, p_reason text, p_checkout text,
  p_reference text, p_invoice text, p_start timestamptz, p_end timestamptz, p_product text, p_quantity integer default 1)
returns jsonb language sql immutable as $$
  select jsonb_build_object('payment_id', p_id, 'status', p_status, 'billing_reason', p_reason, 'checkout_id', p_checkout,
    'reference', p_reference, 'amount', p_amount, 'amount_paid', p_amount, 'currency', p_currency, 'subscription_id', p_sub,
    'invoice', jsonb_build_object('invoice_id', p_invoice, 'subscription_id', p_sub, 'period_start', p_start, 'period_end', p_end,
      'kind', 'cycle'),
    'line_items', jsonb_build_array(jsonb_build_object('product_id', p_product, 'quantity', p_quantity, 'unit_amount', p_amount,
      'currency', p_currency)))
$$;
create function t.facts(p jsonb, s jsonb) returns jsonb language sql immutable as
$$ select jsonb_build_object('payment', p, 'subscription', s) $$;
grant execute on all functions in schema t to authenticated, anon, billing_intake, billing_gateway, billing_worker;

-- Users: 1 owner of A and B (same person), 2 A admin, 3 A reviewer, 4 A assessor, 5 A viewer,
-- 6 A guest, 7 owner of C/D/E/F, 8 outsider, 9-12 extra invitees, 20-22 guests.
insert into auth.users (id, email, email_confirmed_at)
select t.u(n), 'm4-billing-fixture-' || n || '@savour.test', now()
from (select generate_series(1, 12) union all select generate_series(20, 22)) g (n);

-- ======================================================================== schema and privileges
select t.ok(t.n($$select 1 from pg_tables where schemaname in ('billing', 'platform') and not rowsecurity$$) = 0, 'RLS enabled on every billing and platform table');
select t.ok(t.n($$select 1 from pg_policies where schemaname in ('billing', 'platform')$$) = 0, 'billing and platform tables have no policies');
select t.ok(t.n($$select 1 from pg_tables tb cross join unnest(array['anon','authenticated','billing_intake','billing_gateway','billing_worker']) r
  where tb.schemaname in ('billing', 'platform', 'vault') and (has_table_privilege(r, tb.schemaname || '.' || tb.tablename, 'select')
    or has_table_privilege(r, tb.schemaname || '.' || tb.tablename, 'insert') or has_table_privilege(r, tb.schemaname || '.' || tb.tablename, 'update')
    or has_table_privilege(r, tb.schemaname || '.' || tb.tablename, 'delete'))$$) = 0,
  'no client or scoped role has any privilege on any billing, platform or vault table');
select t.ok(not has_schema_privilege('authenticated', 'billing', 'usage') and not has_schema_privilege('anon', 'billing', 'usage')
  and not has_schema_privilege('authenticated', 'platform', 'usage') and not has_schema_privilege('anon', 'platform', 'usage'),
  'clients cannot use the billing or platform schemas');
select t.ok(t.n($$select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('billing', 'platform') and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))$$) = 0,
  'clients cannot execute any billing or platform function');
select t.ok(t.n($$select 1 from pg_roles where rolname in ('billing_intake','billing_gateway','billing_worker')
  and not rolcanlogin and not rolsuper and not rolbypassrls and not rolcreaterole and not rolcreatedb and not rolinherit$$) = 3,
  'three scoped roles: NOLOGIN, no superuser/bypassrls/createrole/createdb, no inherit');
select t.ok((select array_agg(n.nspname || '.' || p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('billing', 'platform') and has_function_privilege('billing_intake', p.oid, 'execute'))
  = array['platform.get_webhook_secrets', 'billing.ingest_event'], 'billing_intake executes ingest_event and its webhook secrets only');
select t.ok(not has_function_privilege('billing_worker', 'billing.ingest_event(uuid,text,text,timestamptz,text,bytea,text,bigint,text)', 'execute')
  and not has_function_privilege('billing_worker', 'billing.gateway_bind_customer(uuid,uuid,uuid,text,text,text)', 'execute')
  and not has_function_privilege('billing_worker', 'platform.get_webhook_secrets(uuid)', 'execute')
  and not has_function_privilege('billing_gateway', 'billing.absorb_payment(uuid,text,uuid,jsonb,timestamptz)', 'execute')
  and not has_function_privilege('billing_gateway', 'billing.claim_events(uuid,text,integer,integer)', 'execute')
  and not has_function_privilege('billing_intake', 'billing.absorb_payment(uuid,text,uuid,jsonb,timestamptz)', 'execute')
  and not has_function_privilege('billing_intake', 'platform.get_credential(uuid)', 'execute'),
  'each scoped role is confined to its own entry points');
select t.ok(t.n($$select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('billing', 'platform') and (p.proname like 'operator%' or p.proname in ('fixture_uncap_trial', 'retire_secrets'))$$) = 7
  and t.n($$select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join unnest(array['anon','authenticated','billing_intake','billing_gateway','billing_worker']) r
  where n.nspname in ('billing', 'platform') and (p.proname like 'operator%' or p.proname in ('fixture_uncap_trial', 'retire_secrets', 'vault_value', 'fingerprint'))
    and has_function_privilege(r, p.oid, 'execute')$$) = 0,
  'operator and fixture functions are executable by the database owner only');
select t.ok(t.n($$select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('billing', 'private', 'platform') and p.prosecdef and not coalesce('search_path=""' = any (p.proconfig), false)$$) = 0,
  'every billing/private SECURITY DEFINER function pins search_path');
select t.ok(t.n($$select 1 from billing.plan_prices$$) = 0 and t.n($$select 1 from platform.provider_connections$$) = 0
  and (select default_connection_id from platform.settings) is null, 'no price, connection or default exists initially (no default amount)');
select t.ok((select adapter_status from platform.providers where code = 'bachs') = 'available'
  and (select sandbox_base_url from platform.providers where code = 'bachs') = 'https://sandbox-api.bachs.io'
  and t.n($$select 1 from platform.providers where code in ('paystack', 'stripe') and adapter_status = 'adapter_pending' and sandbox_base_url is null$$) = 2,
  'registry: Bachs sandbox adapter available; Paystack and Stripe truthfully pending');
select t.err($$update platform.providers set sandbox_base_url = 'https://api.bachs.io' where code = 'bachs'$$, 'immutable_record',
  'the registry is not editable');

-- ======================================================================== money
select t.ok(billing.to_minor('29.00', 'USD') = 2900 and billing.to_minor('29', 'USD') = 2900 and billing.to_minor('29.5', 'USD') = 2950
  and billing.to_minor('25000.00', 'NGN') = 2500000 and billing.to_minor('0', 'USD') = 0, 'decimal strings convert exactly to minor units');
select t.err($$select billing.to_minor('29.001', 'USD')$$, 'invalid_amount', 'out-of-scale amount refused');
select t.err($$select billing.to_minor('-1.00', 'USD')$$, 'invalid_amount', 'negative amount refused');
select t.err($$select billing.to_minor('1e3', 'USD')$$, 'invalid_amount', 'exponent notation refused');
select t.err($$select billing.to_minor('01.00', 'USD')$$, 'invalid_amount', 'leading zero refused');
select t.err($$select billing.to_minor('9999999999999999', 'USD')$$, 'invalid_amount', 'overflow refused');
select t.err($$select billing.to_minor('1.00', 'EUR')$$, 'invalid_currency', 'unsupported currency refused');
select t.ok(billing.from_minor(2900, 'USD') = '29.00' and billing.from_minor(2500000, 'NGN') = '25000.00' and billing.from_minor(5, 'USD') = '0.05',
  'minor units format back at currency precision');

-- ======================================================================== trial on creation (same owner, two businesses)
select t.as(1);
select t.put('A', public.create_workspace('Same Owner Foods', 'Nigeria', 'Africa/Lagos', 'Ada Owner')::text);
select t.put('B', public.create_workspace('Same Owner Foods', 'Nigeria', 'Africa/Lagos', 'Ada Owner')::text);
reset role;
select t.ok((select trial_ends_at - trial_started_at from billing.workspace_billing where workspace_id = t.id('A')) = interval '14 days'
  and (select trial_limits from billing.workspace_billing where workspace_id = t.id('A')) = billing.trial_defaults()
  and (select trial_started_at from billing.workspace_billing where workspace_id = t.id('A')) = (select created_at from public.workspaces where id = t.id('A')),
  'workspace creation starts a 14-day cardless trial with default limits');
select t.ok(exists (select 1 from public.audit_events where workspace_id = t.id('A') and action = 'billing.trial_started'), 'trial start audited');
select t.as(1);
select t.ok(public.workspace_context(t.id('A')) -> 'access' ->> 'state' = 'trialing'
  and (public.workspace_context(t.id('A')) -> 'access' -> 'limits' ->> 'locations')::int = 1
  and (public.workspace_context(t.id('A')) -> 'access' ->> 'billing')::boolean, 'owner context carries the trial access summary');
select t.ok(public.get_billing(t.id('A')) ->> 'view' = 'owner'
  and jsonb_array_length(public.get_billing(t.id('A')) -> 'prices') = 2
  and (select bool_and(x ->> 'unavailable_reason' = 'provider_not_connected') from jsonb_array_elements(public.get_billing(t.id('A')) -> 'prices') x),
  'owner billing read lists both currencies as unavailable (no provider connected), never payable');

-- Staff for A.
select t.put('i2', public.create_invitation(t.id('A'), 'm4-billing-fixture-2@savour.test', 'admin', true, '{}', null, null) ->> 'token');
select t.put('L1', public.upsert_location(t.id('A'), null, 'Main', false)::text);
select t.put('i3', public.create_invitation(t.id('A'), 'm4-billing-fixture-3@savour.test', 'reviewer', true, '{}', null, null) ->> 'token');
select t.put('i4', public.create_invitation(t.id('A'), 'm4-billing-fixture-4@savour.test', 'assessor', true, '{}', null, null) ->> 'token');
select t.put('i5', public.create_invitation(t.id('A'), 'm4-billing-fixture-5@savour.test', 'viewer', true, '{}', null, null) ->> 'token');
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'usage' ->> 'staff')::int = 5, 'owner plus four pending staff invitations use five seats');
select t.err($$select public.create_invitation(t.id('A'), 'm4-billing-fixture-9@savour.test', 'viewer', true, '{}', null, null)$$,
  'quota_exceeded', 'a sixth staff seat (pending invitations count) is refused');
select t.as(2); select public.accept_invitation(t.get('i2'), 'Ade Admin');
select t.as(3); select public.accept_invitation(t.get('i3'), 'Rita Reviewer');
select t.as(4); select public.accept_invitation(t.get('i4'), 'Ayo Assessor');
select t.as(5); select public.accept_invitation(t.get('i5'), 'Vic Viewer');
select t.as(1);
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'usage' ->> 'staff')::int = 5, 'accepting reserved invitations does not count again');

-- Role-aware summaries.
select t.as(2);
select t.ok(public.workspace_context(t.id('A')) -> 'access' ? 'usage' and not (public.workspace_context(t.id('A')) -> 'access' ? 'paid_through')
  and public.get_billing(t.id('A')) ->> 'view' = 'member' and not (public.get_billing(t.id('A')) ? 'billing_contact'),
  'admin gets usage for capacity but no payer or billing details');
select t.as(3);
select t.ok(public.workspace_context(t.id('A')) -> 'access' = jsonb_build_object('state', 'trialing', 'writable', true),
  'reviewer gets only state and write access');
select t.as(8);
select t.err($$select public.get_billing(t.id('A'))$$, 'not_found%', 'outsider cannot read billing');

-- ======================================================================== isolation and direct attacks
select t.as(1);
select t.put('vA', public.set_billing_contact(t.id('A'), 'billing-a@m4.savour.test', true, (public.get_billing(t.id('A')) ->> 'version')::int)::text);
select t.err($$select public.set_billing_contact(t.id('B'), 'Billing-A@m4.savour.test', true, (public.get_billing(t.id('B')) ->> 'version')::int)$$,
  'billing_email_in_use', 'same owner cannot reuse one billing email for a second business');
select t.err($$select public.set_billing_contact(t.id('B'), 'billing-b@m4.savour.test', false, (public.get_billing(t.id('B')) ->> 'version')::int)$$,
  'consent_required', 'billing contact requires explicit consent');
select public.set_billing_contact(t.id('B'), 'billing-b@m4.savour.test', true, (public.get_billing(t.id('B')) ->> 'version')::int);
select t.ok(public.get_billing(t.id('A')) -> 'billing_contact' ->> 'email' = 'billing-a@m4.savour.test'
  and public.get_billing(t.id('B')) -> 'billing_contact' ->> 'email' = 'billing-b@m4.savour.test',
  'each business shows only its own billing contact');
select t.as(2);
select t.err($$select public.set_billing_contact(t.id('A'), 'x@m4.savour.test', true, 1)$$, 'forbidden', 'admin cannot set the billing contact');
select t.err($$select public.begin_checkout(t.id('A'), 'USD', gen_random_uuid(), billing.terms_version())$$, 'permission denied%',
  'admin cannot even reach billing internals');
select t.err($$select public.begin_checkout(t.id('A'), 'USD', gen_random_uuid(), 'savour-m4-sandbox-terms-1')$$, 'forbidden', 'admin cannot start checkout');
select t.err($$select public.request_cancellation(t.id('A'), 1)$$, 'forbidden', 'admin cannot cancel');
select t.err($$select public.authorize_portal(t.id('A'))$$, 'forbidden', 'admin cannot open the billing portal');
select t.err($$select count(*) from billing.workspace_billing$$, 'permission denied%', 'members cannot read billing tables directly');
select t.err($$select billing.absorb_payment(gen_random_uuid(), null, null, '{}'::jsonb, now())$$, 'permission denied%', 'members cannot call worker functions');
select t.err($$select billing.fixture_uncap_trial(t.id('A'))$$, 'permission denied%', 'members cannot call the fixture override');
select t.err($$select private.require_capacity(t.id('A'), 'locations', 0)$$, 'permission denied%', 'internal gates are not callable');
select t.err($$select private.effective_access(t.id('A'))$$, 'permission denied%', 'internal access derivation is not callable');
select t.as(8);
select t.err($$select public.begin_checkout(t.id('A'), 'USD', gen_random_uuid(), 'savour-m4-sandbox-terms-1')$$, 'not_found%', 'outsider cannot start checkout');
reset role;
set local role anon;
select t.err($$select public.get_billing(gen_random_uuid())$$, 'permission denied%', 'anon cannot call billing RPCs');
select t.err($$select billing.ingest_event(gen_random_uuid(), 'evt_x', 'x', now(), 'acct', '\x7b7d'::bytea, 'x', 1, null)$$, 'permission denied%', 'anon cannot ingest events');
reset role;

-- ======================================================================== capacity: locations, subjects, import
select t.as(1);
select t.err($$select public.upsert_location(t.id('A'), null, 'Second', false)$$, 'quota_exceeded', 'second active location exceeds the trial limit');
select public.upsert_location(t.id('A'), t.id('L1'), 'Main', true);
select t.put('L2', public.upsert_location(t.id('A'), null, 'Replacement', false)::text);
select t.err($$select public.upsert_location(t.id('A'), t.id('L1'), 'Main', false)$$, 'quota_exceeded', 'reactivating an archived location counts');
select t.ok(public.upsert_location(t.id('A'), t.id('L2'), 'Replacement renamed', false) = t.id('L2'), 'renaming an active location is not new capacity');
do $$ begin
  for i in 1..15 loop perform public.upsert_subject(t.id('A'), null, 'Subject ' || i, 'vendor', false); end loop;
end $$;
select t.ok(not (public.get_billing(t.id('A')) -> 'access' -> 'warnings') ? 'subjects', 'no warning below 80 percent');
select public.upsert_subject(t.id('A'), null, 'Subject 16', 'vendor', false);
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'warnings') ? 'subjects'
  and (public.get_billing(t.id('A')) -> 'access' -> 'percent' ->> 'subjects')::int = 80, 'warning at 80 percent of the subject limit');
select t.put('rows', '[{"line":2,"cells":{"name":"Imp 1","type":"vendor"}},{"line":3,"cells":{"name":"Imp 2","type":"vendor"}},{"line":4,"cells":{"name":"Imp 3","type":"vendor"}},{"line":5,"cells":{"name":"Imp 4","type":"vendor"}},{"line":6,"cells":{"name":"Imp 5","type":"vendor"}}]');
select t.put('plan', public.preview_subject_import(t.id('A'), t.get('rows')::jsonb) ->> 'plan_hash');
select t.err($$select public.commit_subject_import(t.id('A'), gen_random_uuid(), t.get('rows')::jsonb, t.get('plan'))$$, 'quota_exceeded',
  'an import whose creates exceed the subject limit commits nothing');
select t.ok(t.n($$select 1 from public.subjects where workspace_id = t.id('A') and name like 'Imp %'$$) = 0, 'refused import wrote no subject');
do $$ begin
  for i in 17..20 loop perform public.upsert_subject(t.id('A'), null, 'Subject ' || i, 'vendor', false); end loop;
end $$;
select t.err($$select public.upsert_subject(t.id('A'), null, 'Subject 21', 'vendor', false)$$, 'quota_exceeded', 'twenty-first subject refused');
select t.err($$select public.save_subject(t.id('A'), null, 'Subject 21', 'vendor', null, null, '{}', false, null)$$, 'quota_exceeded',
  'directory editor create refused at the limit');
select t.ok((public.save_subject(t.id('A'), null, 'Archived extra', 'vendor', null, null, '{}', true, null) ->> 'id') is not null,
  'creating an archived subject uses no active-subject capacity');
select t.put('S20', (select id::text from public.subjects where workspace_id = t.id('A') and name = 'Subject 20'));
select public.upsert_subject(t.id('A'), t.id('S20'), 'Subject 20', 'vendor', true);
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'usage' ->> 'subjects')::int = 19, 'archiving releases an active-subject slot');
select public.upsert_subject(t.id('A'), (select id from public.subjects where name = 'Archived extra'), 'Archived extra', 'vendor', false);
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'usage' ->> 'subjects')::int = 20, 'reactivation within the limit is allowed and counted');

-- ======================================================================== assessment reservations
select t.put('TV', public.publish_template(t.id('A'), null, 'Panel', 'food_vendors', 'off', '[{"key":"taste","label":"Taste"}]')::text);
select t.put('S1', (select id::text from public.subjects where workspace_id = t.id('A') and name = 'Subject 1'));
select t.put('S2', (select id::text from public.subjects where workspace_id = t.id('A') and name = 'Subject 2'));
select t.put('S3', (select id::text from public.subjects where workspace_id = t.id('A') and name = 'Subject 3'));
select t.put('S4', (select id::text from public.subjects where workspace_id = t.id('A') and name = 'Subject 4'));
select t.put('S5', (select id::text from public.subjects where workspace_id = t.id('A') and name = 'Subject 5'));
reset role;
-- fixture: lower assessment limit (owner-side edit of this disposable workspace) to exercise the cap cheaply
update billing.workspace_billing set trial_limits = jsonb_set(trial_limits, '{assessments}', '8') where workspace_id = t.id('A');
select t.as(1);
select t.put('D', public.create_session_draft(t.id('A'), t.id('L2'), t.id('TV'), 'Reserved panel', current_date,
  array[t.id('S1'), t.id('S2'), t.id('S3')], array[t.u(1), t.u(4)], array[t.u(3)], 24, null)::text);
reset role;
select t.ok(t.n($$select 1 from billing.assessment_reservations where session_id = t.id('D')$$) = 0, 'a draft reserves nothing');
select t.as(1);
select public.open_session(t.id('D'), (select data_version from public.sessions where id = t.id('D')));
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'usage' ->> 'assessments')::int = 6, 'opening reserves every accepted assignment (3 subjects x 2)');
select t.put('D2', public.create_session_draft(t.id('A'), t.id('L2'), t.id('TV'), 'Too big', current_date,
  array[t.id('S4'), t.id('S5')], array[t.u(1), t.u(4)], array[t.u(3)], 24, null)::text);
select t.err($$select public.open_session(t.id('D2'), (select data_version from public.sessions where id = t.id('D2')))$$, 'quota_exceeded',
  'opening beyond the assessment limit is refused');
select t.ok((select status from public.sessions where id = t.id('D2')) = 'draft', 'refused opening leaves the draft unchanged');
select public.set_assignment(t.id('D'), t.id('S1'), t.u(1), true, (select data_version from public.sessions where id = t.id('D')), null);
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'usage' ->> 'assessments')::int = 6, 'duplicate assignment retry reserves nothing more');
select t.as(4);
select t.put('k1', gen_random_uuid()::text);
select public.submit_assessment(t.id('D'), t.id('S1'), t.u(4), null, '{"taste":4}'::jsonb, null, 0, t.id('k1'), null);
select t.ok((public.submit_assessment(t.id('D'), t.id('S1'), t.u(4), null, '{"taste":4}'::jsonb, null, 0, t.id('k1'), null) ->> 'replayed')::boolean,
  'idempotent replay returns the receipt');
select public.submit_assessment(t.id('D'), t.id('S1'), t.u(4), null, '{"taste":5}'::jsonb, null, 1, gen_random_uuid(), null);
reset role;
select t.ok((select state from billing.assessment_reservations where session_id = t.id('D') and subject_id = t.id('S1') and user_id = t.u(4)) = 'consumed'
  and t.n($$select 1 from billing.assessment_reservations where session_id = t.id('D') and state = 'consumed'$$) = 1,
  'first submission consumes once; replay and edit never count again');
select t.as(1);
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'usage' ->> 'assessments')::int = 6, 'consumption keeps the total (reserved became consumed)');
select public.set_assignment(t.id('D'), t.id('S3'), t.u(1), false, (select data_version from public.sessions where id = t.id('D')), 'not needed');
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'usage' ->> 'assessments')::int = 5, 'removing unused work releases its reservation');
select public.set_assignment(t.id('D'), t.id('S1'), t.u(4), false, (select data_version from public.sessions where id = t.id('D')), 'reassign');
reset role;
select t.ok((select state from billing.assessment_reservations where session_id = t.id('D') and subject_id = t.id('S1') and user_id = t.u(4)) = 'consumed',
  'removing an assignment with a submission never destroys consumed accounting');
select t.as(1);
select public.set_assignment(t.id('D'), t.id('S3'), t.u(1), true, (select data_version from public.sessions where id = t.id('D')), 'needed again');
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'usage' ->> 'assessments')::int = 6, 're-adding re-reserves');
select t.put('g20', public.create_invitation(t.id('A'), 'm4-billing-fixture-20@savour.test', 'guest', false, '{}', t.id('D'), array[t.id('S2')]) ->> 'token');
select t.put('g21', public.create_invitation(t.id('A'), 'm4-billing-fixture-21@savour.test', 'guest', false, '{}', t.id('D'), array[t.id('S2'), t.id('S3')]) ->> 'token');
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'usage' ->> 'staff')::int = 5, 'guest invitations use no staff seat');
select t.as(20); select public.accept_invitation(t.get('g20'), 'Guest Twenty');
select t.as(1);
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'usage' ->> 'assessments')::int = 7
  and (public.get_billing(t.id('A')) -> 'access' -> 'warnings') ? 'assessments', 'guest acceptance reserves its work; warning at 80 percent');
select t.as(21);
select t.err($$select public.accept_invitation(t.get('g21'), 'Guest Twenty-one')$$, 'quota_exceeded', 'guest acceptance beyond the limit is refused');
reset role;
select t.ok(not exists (select 1 from public.memberships where user_id = t.u(21)), 'refused acceptance created no membership');
-- Carry-over semantics of the usage window, checked directly: consumed work outside the window is not
-- counted, outstanding reservations always are.
select t.ok((private.billing_usage(t.id('A'), now() + interval '1 hour', null) ->> 'assessments')::int = 6
  and (private.billing_usage(t.id('A'), now() - interval '1 hour', null) ->> 'assessments')::int = 7,
  'outstanding reservations carry across windows; consumed work counts only inside its window');
-- consume rule: no accepted reservation means no initial submission (except reported-evidence correction)
select t.err($$select private.consume_assessment(t.id('A'), t.id('D'), t.id('S4'), t.u(4), false)$$, 'assessment_not_reserved',
  'a submission without an accepted reservation is refused');
select t.as(1);
select t.put('SM', public.create_sample_session(t.id('A'), t.id('L2'), t.id('TV'))::text);
select public.submit_assessment(t.id('SM'), (select subject_id from public.session_subjects where session_id = t.id('SM') order by subject_name limit 1),
  t.u(1), null, '{"taste":3}'::jsonb, null, 0, gen_random_uuid(), null);
reset role;
select t.ok(t.n($$select 1 from billing.assessment_reservations where session_id = t.id('SM')$$) = 0, 'samples never reserve or consume');

-- ======================================================================== read-only after trial expiry
-- fixture time travel: the trial ends now
update billing.workspace_billing set trial_ends_at = trial_started_at where workspace_id = t.id('A');
select t.put('S1v', (select version::text from public.subjects where id = t.id('S1')));
select t.as(1);
select t.ok(public.workspace_context(t.id('A')) -> 'access' ->> 'state' = 'read_only'
  and not (public.workspace_context(t.id('A')) -> 'access' ->> 'writable')::boolean, 'expired trial is read-only');
select t.err($$select public.create_session_draft(t.id('A'), t.id('L2'), t.id('TV'), 'New', current_date, array[t.id('S4')], array[t.u(1)], array[t.u(3)], 24, null)$$,
  'read_only%', 'read-only blocks new drafts');
select t.err($$select public.open_session(t.id('D2'), (select data_version from public.sessions where id = t.id('D2')))$$, 'read_only%', 'read-only blocks opening');
select t.err($$select public.update_session_draft(t.id('D2'), 'Edited', current_date, t.id('L2'), t.id('TV'), 24, null, (select data_version from public.sessions where id = t.id('D2')))$$,
  'read_only%', 'read-only blocks draft edits');
select t.err($$select public.publish_template(t.id('A'), null, 'New', 'food_vendors', 'off', '[{"key":"a","label":"A"}]')$$, 'read_only%', 'read-only blocks templates');
select t.err($$select public.upsert_location(t.id('A'), null, 'New site', false)$$, 'read_only%', 'read-only blocks new locations');
select t.err($$select public.upsert_location(t.id('A'), t.id('L2'), 'Renamed', false)$$, 'read_only%', 'read-only blocks location renames');
select t.err($$select public.upsert_subject(t.id('A'), t.id('S1'), 'Renamed', 'vendor', false)$$, 'read_only%', 'read-only blocks subject renames');
select t.err($$select public.upsert_subject(t.id('A'), t.id('S5'), 'Renamed and archived', 'vendor', true)$$, 'read_only%',
  'an archive request bundling a rename is refused');
select t.err($$select public.save_subject(t.id('A'), t.id('S1'), 'Subject 1', 'outlet', null, null, '{}', false, t.get('S1v')::int)$$,
  'read_only%', 'read-only blocks directory edits');
select t.err($$select public.save_category(t.id('A'), null, 'Grills', false, null)$$, 'read_only%', 'read-only blocks new categories');
select t.err($$select public.save_subject_contact(t.id('A'), t.id('S1'), 'Contact', null, null, 0)$$, 'read_only%', 'read-only blocks new contacts');
select t.err($$select public.create_invitation(t.id('A'), 'late@savour.test', 'viewer', true, '{}', null, null)$$, 'read_only%', 'read-only blocks staff invitations');
select t.err($$select public.create_invitation(t.id('A'), 'late@savour.test', 'guest', false, '{}', t.id('D'), array[t.id('S2')])$$, 'read_only%', 'read-only blocks guest invitations');
select t.err($$select public.set_assignment(t.id('D'), t.id('S2'), t.u(1), true, (select data_version from public.sessions where id = t.id('D')), null)$$,
  'read_only%', 'read-only blocks new assignments');
select t.err($$select public.set_session_reviewer(t.id('D'), t.u(1), true, 'more', (select data_version from public.sessions where id = t.id('D')))$$,
  'read_only%', 'read-only blocks adding reviewers');
select t.err($$select public.update_session_window(t.id('D'), 72, 'longer', (select data_version from public.sessions where id = t.id('D')))$$,
  'read_only%', 'read-only blocks window changes');
select t.err($$select public.create_finding(t.id('D'), t.id('S2'), 'high', 'Issue', null, null, gen_random_uuid())$$, 'read_only%', 'read-only blocks new findings');
select t.err($$select public.create_sample_session(t.id('A'), t.id('L2'), t.id('TV'))$$, 'read_only%', 'read-only blocks new samples');
select t.err($$select public.commit_subject_import(t.id('A'), gen_random_uuid(), t.get('rows')::jsonb, public.preview_subject_import(t.id('A'), t.get('rows')::jsonb) ->> 'plan_hash')$$,
  'read_only%', 'read-only blocks import commits');
-- Allowed: accepted work, review, approval, reductions, security, reads and exports.
select t.as(20);
select t.ok((public.submit_assessment(t.id('D'), t.id('S2'), t.u(20), null, '{"taste":4}'::jsonb, null, 0, gen_random_uuid(), null) ->> 'replayed') = 'false',
  'accepted reserved work can still be completed after expiry');
select t.as(1);
select t.ok((public.get_billing(t.id('A')) -> 'access' -> 'usage' ->> 'assessments')::int = 7,
  'completion after expiry stays counted against the last allocation');
select t.ok(public.upsert_location(t.id('A'), t.id('L2'), 'Replacement renamed', true) = t.id('L2'), 'a pure archive is an allowed reduction');
select public.upsert_location(t.id('A'), t.id('L2'), 'Replacement renamed', true);
select t.ok(public.save_subject_contact(t.id('A'), t.id('S1'), null, null, null, 0) = 0, 'removing a contact is an allowed reduction');
select public.revoke_member(t.id('A'), t.u(5));
select t.ok(not exists (select 1 from public.memberships where workspace_id = t.id('A') and user_id = t.u(5) and status = 'active'),
  'revocation (security) still works read-only');
select t.ok((public.get_session_report(t.id('D'), null, false, 'csv') -> 'meta' ->> 'status') = 'provisional', 'reports and exports remain available');
select public.close_collection(t.id('D'));
select t.ok((select status from public.sessions where id = t.id('D')) = 'in_review', 'closing collection (review) is allowed');
select t.err($$select public.reopen_collection(t.id('D'), 24, 'more time', (select data_version from public.sessions where id = t.id('D')))$$, 'read_only%',
  'reopening collection needs write access even with no new reservation');
select public.cancel_session(t.id('D2'), 'not needed');
select t.ok(public.get_billing(t.id('A')) ->> 'view' = 'owner', 'the owner can still manage billing while read-only');
select t.err($$select public.begin_checkout(t.id('A'), 'USD', gen_random_uuid(), 'savour-m4-sandbox-terms-1')$$,
  'provider_not_connected', 'no payable checkout while no provider connection exists');

-- ======================================================================== prices, pinning and checkout intents
reset role;
-- Disposable founder QA identity: enrolled by the database owner only (no RPC can do this).
insert into auth.users (id, email, email_confirmed_at) values (t.u(30), 'm4-billing-fixture-30@savour.test', now());
insert into platform.admins (user_id, note) values (t.u(30), 'disposable founder QA fixture');
select t.admin(30);
select t.put('CONN', public.platform_create_connection('bachs', 'Bachs sandbox A')::text);
select public.platform_store_secret(t.id('CONN'), 'api_key', 'sk_sandbox_TESTONLYfixturekey0000000001', 1);
select public.platform_store_secret(t.id('CONN'), 'webhook_secret', 'whsec_TESTONLYfixture000000000001', 2);
select public.platform_set_expected_org(t.id('CONN'), 'acct_test', 3);
select public.platform_propose_price(t.id('CONN'), 'USD', '29.00', 'prod_testusd');
select public.platform_propose_price(t.id('CONN'), 'NGN', '25000.00', 'prod_testngn');
select t.put('test1', public.platform_begin_test(t.id('CONN'))::text);
reset role;
select t.role('billing_gateway');
select t.ok((platform.gateway_test_context(t.id('test1'), t.u(30)) ->> 'api_key') = 'sk_sandbox_TESTONLYfixturekey0000000001',
  'the test runner reads the pending key for its own running test');
select t.ok(platform.gateway_record_test(t.id('test1'), t.u(30), true, true, '{"account":"ok"}'::jsonb,
  (select jsonb_agg(jsonb_build_object('price_id', x ->> 'price_id', 'matched', true)) from jsonb_array_elements(platform.gateway_test_context(t.id('test1'), t.u(30)) -> 'prices') x))
  = 'passed', 'read-only connection test recorded');
select t.admin(30);
select public.platform_enable(t.id('CONN'), (select (c ->> 'version')::int from jsonb_array_elements(public.platform_overview() -> 'connections') c where c ->> 'id' = t.get('CONN')));
select public.platform_set_default(t.id('CONN'), (public.platform_overview() ->> 'settings_version')::int);
reset role;
select t.put('pUSD1', (select id::text from billing.plan_prices where connection_id = t.id('CONN') and currency = 'USD' and status = 'configured'));
select t.ok((select recurring_capability from billing.plan_prices where connection_id = t.id('CONN') and currency = 'NGN' and status = 'configured') = 'unverified',
  'a configured NGN price stays recurring-unverified');
select t.err($$update billing.plan_prices set recurring_capability = 'documented_standard' where currency = 'NGN'$$, '%check%',
  'a methods toggle can never mark NGN recurring as documented');
select t.err($$update billing.plan_prices set amount_minor = 1 where id = t.id('pUSD1')$$, 'immutable_record', 'a configured price is immutable');
select t.as(1);
select t.ok((select x ->> 'unavailable_reason' from jsonb_array_elements(public.get_billing(t.id('A')) -> 'prices') x where x ->> 'currency' = 'USD') is null
  and (select x ->> 'unavailable_reason' from jsonb_array_elements(public.get_billing(t.id('A')) -> 'prices') x where x ->> 'currency' = 'NGN') = 'recurring_not_verified',
  'USD becomes payable; NGN stays unavailable until recurring is verified');
select t.err($$select public.begin_checkout(t.id('A'), 'NGN', (select id from billing.plan_prices where false), 'savour-m4-sandbox-terms-1')$$, 'permission denied%',
  'owner cannot read price rows directly');
select t.err(format($$select public.begin_checkout(%L, 'NGN', %L, 'savour-m4-sandbox-terms-1')$$, t.id('A'),
  (select (x ->> 'price_id') from jsonb_array_elements(public.get_billing(t.id('A')) -> 'prices') x where x ->> 'currency' = 'NGN')), 'recurring_not_verified%', 'NGN checkout refused');
select t.err(format($$select public.begin_checkout(%L, 'USD', gen_random_uuid(), 'savour-m4-sandbox-terms-1')$$, t.id('A')), 'price_changed', 'consent to another price refused');
select t.err(format($$select public.begin_checkout(%L, 'USD', %L, 'old-terms')$$, t.id('A'), t.id('pUSD1')), 'terms_changed', 'consent to other terms refused');
select t.put('iA', public.begin_checkout(t.id('A'), 'USD', t.id('pUSD1'), 'savour-m4-sandbox-terms-1') ->> 'intent_id');
select t.put('iB', public.begin_checkout(t.id('B'), 'USD', t.id('pUSD1'), 'savour-m4-sandbox-terms-1') ->> 'intent_id');
reset role;
select t.ok((select reference ~ '^savour_ck_[0-9a-f]{32}$' and amount_minor = 2900 and currency = 'USD' and provider_product_id = 'prod_testusd'
  and status = 'created' and idempotency_key = 'savour-checkout-' || id from billing.checkout_intents where id = t.id('iA')),
  'intent persisted before any provider call with pinned price, unique reference and idempotency key');
select t.err($$update billing.checkout_intents set amount_minor = 1 where id = t.id('iA')$$, 'immutable_record', 'pinned intent terms are immutable');
select t.put('refA', (select reference from billing.checkout_intents where id = t.id('iA')));
select t.put('refB', (select reference from billing.checkout_intents where id = t.id('iB')));

-- ======================================================================== gateway role
select t.role('billing_gateway');
select t.ok((billing.gateway_checkout_context(t.id('iA'), t.u(1)) ->> 'amount') = '29.00'
  and (billing.gateway_checkout_context(t.id('iA'), t.u(1)) ->> 'card_corridor') = 'USD_CARD', 'gateway context carries the pinned price and corridor');
select t.err($$select billing.gateway_checkout_context(t.id('iA'), t.u(2))$$, 'not_found%', 'gateway refuses a non-owner caller');
select t.err($$select count(*) from billing.checkout_intents$$, 'permission denied%', 'gateway cannot read tables');
select t.err($$select billing.absorb_payment(t.id('CONN'), null, null, '{}'::jsonb, now())$$, 'permission denied%', 'gateway cannot absorb payments');
select billing.gateway_checkout_context(t.id('iB'), t.u(1));
select t.ok(billing.gateway_bind_customer(t.id('A'), t.id('CONN'), t.u(1), 'cust_A1', 'billing-a@m4.savour.test', 'created') = 'bound', 'customer bound to A');
select t.err($$select billing.gateway_bind_customer(t.id('B'), t.id('CONN'), t.u(1), 'cust_A1', 'billing-b@m4.savour.test', 'created')$$, 'billing_customer_review',
  'a customer bound to A can never bind to B (same owner)');
select t.err($$select billing.gateway_bind_customer(t.id('A'), t.id('CONN'), t.u(1), 'cust_A2', 'billing-a@m4.savour.test', 'created')$$, 'billing_customer_review',
  'a bound customer is never replaced');
select t.err($$select billing.gateway_bind_customer(t.id('B'), t.id('CONN'), t.u(1), 'cust_B1', 'someone@else.test', 'adopted')$$, 'billing_customer_review',
  'a customer whose email differs from the nominated contact is refused');
select billing.gateway_bind_customer(t.id('B'), t.id('CONN'), t.u(1), 'cust_B1', 'billing-b@m4.savour.test', 'created');
select t.err(format($$select billing.gateway_mark_requesting(%L, %L, '{"key":"sk_sandbox_abc","reference":"%s"}')$$, t.id('iA'), t.u(1), t.get('refA')),
  'invalid_request_body', 'a request body containing key material is refused');
select billing.gateway_mark_requesting(t.id('iA'), t.u(1), '{"reference":"' || t.get('refA') || '"}');
select t.as(1);
select t.err(format($$select public.begin_checkout(%L, 'USD', %L, 'savour-m4-sandbox-terms-1')$$, t.id('A'), t.id('pUSD1')), 'checkout_in_progress',
  'one pending checkout per business once a provider request has started');
select t.role('billing_gateway');
select t.ok(billing.gateway_record_checkout(t.id('iA'), t.u(1), 'created', 'chk_A1', 'https://checkout.sandbox.bachs.io/c/a1', now() + interval '1 hour', t.get('refA'), null) = 'open',
  'created checkout attached to its intent');
select billing.gateway_mark_requesting(t.id('iB'), t.u(1), '{"reference":"' || t.get('refB') || '"}');
select t.ok(billing.gateway_record_checkout(t.id('iB'), t.u(1), 'created', 'chk_B1', 'https://checkout.sandbox.bachs.io/c/b1', now() + interval '1 hour', 'savour_ck_00000000000000000000000000000000', null) = 'review',
  'a response echoing another reference is quarantined for review');
reset role;
select t.ok((select status from billing.checkout_intents where id = t.id('iB')) = 'review'
  and exists (select 1 from billing.review_queue where kind = 'checkout_response_mismatch' and workspace_id = t.id('B')),
  'mismatched checkout response stays exclusive and is queued for review');

reset role;
select t.put('pUSD2', billing.operator_configure_price(t.id('CONN'), 'USD', '35.00', 'prod_testusd2', 'price change test')::text);
select t.ok((select status from billing.plan_prices where id = t.id('pUSD1')) = 'retired'
  and (select amount_minor from billing.checkout_intents where id = t.id('iA')) = 2900, 'a price change retires the old row; existing intents keep their price');
select t.role('billing_gateway');
select t.err($$select billing.gateway_checkout_context(t.id('iB'), t.u(1))$$, 'checkout_intent_stale', 'B (already reviewed) cannot restart');
reset role;
-- Uncertain outcome on C (owner 7).
select t.as(7);
select t.put('C', public.create_workspace('Other Owner Co', 'Nigeria', 'Africa/Lagos', 'Owner Seven')::text);
select t.err(format($$select public.begin_checkout(%L, 'USD', %L, 'savour-m4-sandbox-terms-1')$$, t.id('C'), t.id('pUSD2')), 'billing_contact_required',
  'checkout requires a nominated billing contact');
select public.set_billing_contact(t.id('C'), 'billing-c@m4.savour.test', true, 1);
select t.put('iC', public.begin_checkout(t.id('C'), 'USD', t.id('pUSD2'), 'savour-m4-sandbox-terms-1') ->> 'intent_id');
reset role;
select t.put('refC', (select reference from billing.checkout_intents where id = t.id('iC')));
select t.role('billing_gateway');
select billing.gateway_checkout_context(t.id('iC'), t.u(7));
select billing.gateway_bind_customer(t.id('C'), t.id('CONN'), t.u(7), 'cust_C1', 'billing-c@m4.savour.test', 'created');
select billing.gateway_mark_requesting(t.id('iC'), t.u(7), '{"reference":"' || t.get('refC') || '"}');
select t.ok(billing.gateway_record_checkout(t.id('iC'), t.u(7), 'uncertain', null, null, null, null, 'timeout') = 'uncertain', 'timeout leaves the outcome uncertain');
select t.as(7);
select t.err(format($$select public.begin_checkout(%L, 'USD', %L, 'savour-m4-sandbox-terms-1')$$, t.id('C'), t.id('pUSD2')), 'checkout_in_progress',
  'an uncertain checkout stays exclusive');
select t.role('billing_worker');
select t.ok((billing.checkout_retry_context(t.id('iC')) ->> 'idempotency_key') = 'savour-checkout-' || t.get('iC'),
  'inside the provider window the worker may retry the identical request with the same key');
reset role;
-- fixture time travel: the first request is 24 hours old
update billing.checkout_intents set request_started_at = now() - interval '24 hours' where id = t.id('iC');
select t.role('billing_worker');
select t.ok(billing.checkout_retry_context(t.id('iC')) is null, 'after the idempotency window no retry is allowed');
reset role;
select t.ok((select status from billing.checkout_intents where id = t.id('iC')) = 'review'
  and exists (select 1 from billing.review_queue where kind = 'checkout_uncertain'), 'expired uncertainty escalates to manual review');
select billing.operator_release_intent(t.id('iC'), 'verified at Bachs: no checkout with this reference was paid (fixture)');
select t.as(7);
select t.put('iC2', public.begin_checkout(t.id('C'), 'USD', t.id('pUSD2'), 'savour-m4-sandbox-terms-1') ->> 'intent_id');
select t.ok(t.id('iC2') is not null, 'after operator release a new checkout may start');
reset role;
select t.put('refC2', (select reference from billing.checkout_intents where id = t.id('iC2')));
select t.role('billing_gateway');
select billing.gateway_mark_requesting(t.id('iC2'), t.u(7), '{"reference":"' || t.get('refC2') || '"}');
select t.ok(billing.gateway_record_checkout(t.id('iC2'), t.u(7), 'refused', null, null, null, null, 'VALIDATION_ERROR') = 'failed',
  'a definite provider refusal closes the intent');
select t.as(7);
select t.put('iC3', public.begin_checkout(t.id('C'), 'USD', t.id('pUSD2'), 'savour-m4-sandbox-terms-1') ->> 'intent_id');
reset role;
select t.put('refC3', (select reference from billing.checkout_intents where id = t.id('iC3')));
select t.role('billing_gateway');
select billing.gateway_mark_requesting(t.id('iC3'), t.u(7), '{"reference":"' || t.get('refC3') || '"}');
select billing.gateway_record_checkout(t.id('iC3'), t.u(7), 'created', 'chk_C3', 'https://checkout.sandbox.bachs.io/c/c3', now() + interval '1 hour', t.get('refC3'), null);

-- ======================================================================== intake role (durable inbox)
reset role;
select t.put('body1', '{"id":"evt_t1","type":"collection.succeeded","created_at":"2026-10-11T00:00:00Z","organization_id":"acct_test","data":{"charge_id":"ch_A1"}}');
select t.role('billing_intake');
select t.ok(billing.ingest_event(t.id('CONN'), 'evt_t1', 'collection.succeeded', now(), 'acct_test', convert_to(t.get('body1'), 'UTF8'),
  encode(sha256(convert_to(t.get('body1'), 'UTF8')), 'hex'), 1, null) = 'inserted', 'verified event stored durably');
select t.ok(billing.ingest_event(t.id('CONN'), 'evt_t1', 'collection.succeeded', now(), 'acct_test', convert_to(t.get('body1'), 'UTF8'),
  encode(sha256(convert_to(t.get('body1'), 'UTF8')), 'hex'), 1, null) = 'duplicate', 'identical redelivery is a duplicate');
select t.ok(billing.ingest_event(t.id('CONN'), 'evt_t1', 'collection.succeeded', now(), 'acct_test', convert_to(t.get('body1') || ' ', 'UTF8'),
  encode(sha256(convert_to(t.get('body1') || ' ', 'UTF8')), 'hex'), 1, null) = 'collision', 'same event ID with different bytes is a collision');
select t.err($$select billing.ingest_event(t.id('CONN'), 'evt_t2', 'x', now(), 'acct_test', '\x7b7d'::bytea, repeat('0', 64), 1, null)$$, 'body_hash_mismatch',
  'body hash must match the stored bytes');
select t.ok(billing.ingest_event(t.id('CONN'), 'evt_q1', 'collection.succeeded', now(), 'acct_wrong', '\x7b7d'::bytea, encode(sha256('\x7b7d'::bytea), 'hex'), 1,
  'organization_mismatch') = 'quarantined', 'an event from another account is quarantined');
select t.err($$select count(*) from billing.webhook_inbox$$, 'permission denied%', 'intake cannot read the inbox');
select t.err($$select * from billing.claim_events(gen_random_uuid(), 'x', 1, 60)$$, 'permission denied%', 'intake cannot claim events');
reset role;
select t.ok((select convert_from(raw_body, 'UTF8') from billing.webhook_inbox where event_id = 'evt_t1') = t.get('body1')
  and t.n($$select 1 from billing.inbox_collisions where event_id = 'evt_t1'$$) = 1
  and exists (select 1 from billing.review_queue where kind = 'webhook_id_collision'), 'a collision never replaces the original bytes and is reviewed');
select t.ok(t.n($$select 1 from billing.paid_periods$$) = 0, 'storing events grants nothing');

-- ======================================================================== worker role: claims, leases, fencing, backoff
select t.role('billing_worker');
select t.put('run', billing.start_run(t.id('CONN'), 'process', 'cron', 'w1')::text);
select t.put('tok1', (select claim_token::text from billing.claim_events(t.id('CONN'), 'w1', 10, 60) where event_id = 'evt_t1'));
select t.ok(t.id('tok1') is not null and t.n($$select 1 from billing.claim_events(t.id('CONN'), 'w2', 10, 60)$$) = 0,
  'a claimed event is not claimed twice; quarantined events are never claimed');
reset role;
-- fixture time travel: the worker crashed and its lease expired
update billing.webhook_inbox set lease_until = now() - interval '1 second' where event_id = 'evt_t1';
select t.role('billing_worker');
select t.put('tok2', (select claim_token::text from billing.claim_events(t.id('CONN'), 'w2', 10, 60) where event_id = 'evt_t1'));
select t.ok(t.id('tok2') is not null and t.id('tok2') <> t.id('tok1'), 'an expired lease is reclaimed with a new claim token');
select t.err($$select billing.complete_event(t.id('CONN'), 'evt_t1', t.id('tok1'), 'done')$$, 'stale_claim', 'the crashed worker''s token is fenced out');
select billing.fail_event(t.id('CONN'), 'evt_t1', t.id('tok2'), 'provider_timeout');
reset role;
select t.ok((select status = 'failed' and next_attempt_at > clock_timestamp() and attempts = 2 from billing.webhook_inbox where event_id = 'evt_t1'),
  'a provider timeout is retryable with backoff');
-- fixture time travel: backoff elapsed; attempts at the dead-letter threshold
update billing.webhook_inbox set next_attempt_at = now() - interval '1 second', attempts = 7 where event_id = 'evt_t1';
select t.role('billing_worker');
select t.put('tok3', (select claim_token::text from billing.claim_events(t.id('CONN'), 'w1', 10, 60) where event_id = 'evt_t1'));
select billing.fail_event(t.id('CONN'), 'evt_t1', t.id('tok3'), 'provider_timeout');
select billing.finish_run(t.id('run'), 3, 0, 2, null);
reset role;
select t.ok((select status from billing.webhook_inbox where event_id = 'evt_t1') = 'dead' and exists (select 1 from billing.review_queue where kind = 'webhook_dead')
  and (select trigger from billing.worker_runs where id = t.id('run')) = 'cron', 'eight failures dead-letter with review; the run records its trigger');

-- ======================================================================== payment binding (contract fixtures)
select t.put('T', now()::text);
create function t.ckA(p_status text default 'completed') returns jsonb language sql stable as $$
  select jsonb_build_object('checkout_id', 'chk_A1', 'status', p_status, 'reference', t.get('refA'), 'customer_id', 'cust_A1', 'currency', 'USD',
    'amount', '29.00', 'product_ids', jsonb_build_array('prod_testusd'), 'recurring', jsonb_build_object('interval', 'month', 'interval_count', 1))
$$;
create function t.pA(p_amount text default '29.00', p_currency text default 'USD', p_reason text default 'subscription_create',
  p_ref text default null, p_start timestamptz default null, p_end timestamptz default null, p_product text default 'prod_testusd',
  p_status text default 'succeeded', p_qty integer default 1) returns jsonb language sql stable as $$
  select t.pay('ch_A1', 'sub_A1', p_status, p_amount, p_currency, p_reason, 'chk_A1', coalesce(p_ref, t.get('refA')), 'inv_A1',
    coalesce(p_start, t.get('T')::timestamptz - interval '1 day'), coalesce(p_end, t.get('T')::timestamptz - interval '1 day' + interval '1 month'), p_product, p_qty)
$$;
create function t.sA(p_customer text default 'cust_A1', p_product text default 'prod_testusd', p_interval text default 'month',
  p_amount text default '29.00', p_qty integer default 1) returns jsonb language sql stable as $$
  select t.sub('sub_A1', p_customer, 'active', p_amount, 'USD', p_product, t.get('T')::timestamptz - interval '1 day',
    t.get('T')::timestamptz - interval '1 day' + interval '1 month', false, p_interval, 1, p_qty)
$$;
create function t.fA(p jsonb, s jsonb, c jsonb default null) returns jsonb language sql stable as
$$ select jsonb_build_object('payment', p, 'subscription', s, 'checkout', coalesce(c, t.ckA())) $$;
grant execute on all functions in schema t to billing_worker, billing_gateway, billing_intake, authenticated;

select t.role('billing_worker');
select t.ok(billing.absorb_checkout(t.id('CONN'), null, null, jsonb_build_object('checkout', t.ckA('completed')), now()) = 'checkout_completed',
  'a completed checkout without a verified payment stays pending (completed_unpaid)');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA('28.99'), t.sA()), now()) = 'review:payment_mismatch', 'wrong amount: no grant');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA('29.00', 'NGN'), t.sA()), now()) = 'review:payment_mismatch', 'wrong currency: no grant');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(p_product => 'prod_other'), t.sA(p_product => 'prod_other')), now()) = 'review:payment_mismatch', 'wrong product: no grant');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(p_ref => 'savour_ck_ffffffffffffffffffffffffffffffff'), t.sA()), now()) like 'review:%', 'wrong reference: no grant');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(p_end => t.get('T')::timestamptz + interval '14 days'), t.sA()), now()) = 'review:payment_mismatch', 'wrong period length: no grant');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(p_start => t.get('T')::timestamptz + interval '3 days', p_end => t.get('T')::timestamptz + interval '3 days' + interval '1 month'), t.sA()), now()) = 'review:payment_mismatch',
  'invoice period not matching the subscription period: no grant');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(p_reason => 'subscription_update'), t.sA()), now()) = 'review:payment_mismatch', 'proration payment: no grant');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(p_qty => 2), t.sA(p_qty => 2)), now()) = 'review:payment_mismatch', 'quantity 2: no grant');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(), t.sA(p_interval => 'year')), now()) = 'review:payment_mismatch', 'non-monthly cadence: no grant');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(), t.sA(p_customer => 'cust_B1')), now()) = 'review:customer_mismatch', 'another business''s customer: no grant');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA() - 'amount_paid', t.sA()), now()) = 'review:payment_mismatch', 'missing amount_paid is never read as fully paid');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA() - 'line_items', t.sA() || '{"item_product_ids": []}'), now()) = 'review:payment_mismatch',
  'missing line items need product evidence from exactly one subscription item');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA() || '{"customer_email":"intruder@else.test"}', t.sA()), now()) = 'review:payment_mismatch',
  'a payment email other than the nominated billing contact is refused');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, jsonb_build_object('payment', t.pA(), 'subscription', t.sA()), now()) = 'review:payment_mismatch',
  'a first payment needs the server-read checkout');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(), t.sA(), t.ckA() || '{"customer_id":"cust_B1"}'), now()) = 'review:payment_mismatch',
  'a checkout bound to another customer is refused');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(p_status => 'accepted'), t.sA()), now()) = 'review:payment_not_exact', 'accepted status is never sufficient');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(p_status => 'processing'), t.sA()), now()) = 'payment_pending', 'processing payment grants nothing yet');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(p_status => 'failed'), t.sA()), now()) = 'payment_failed_no_access', 'failed first payment: no access, no grace');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(p_ref => t.get('refB')), t.sA()), now()) = 'review:payment_pointer_conflict',
  'checkout and reference pointing at different intents are refused');
reset role;
select t.ok(t.n($$select 1 from billing.paid_periods$$) = 0 and private.billing_core(t.id('A')) ->> 'state' = 'read_only', 'no mismatch granted anything');
select t.role('billing_worker');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(), t.sA()), now()) = 'granted', 'exactly bound verified payment grants one paid period');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA(), t.sA()), now()) = 'duplicate', 'replayed verified payment is a no-op');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.fA(t.pA('30.00'), t.sA()), now()) = 'review:payment_facts_changed', 'changed immutable facts for a known payment are reviewed');
reset role;
select t.ok(t.n($$select 1 from billing.paid_periods where workspace_id = t.id('A')$$) = 1
  and (select status from billing.checkout_intents where id = t.id('iA')) = 'paid'
  and (select billing_currency from billing.workspace_billing where workspace_id = t.id('A')) = 'USD'
  and (select amount_minor from billing.paid_periods where workspace_id = t.id('A')) = 2900, 'one period at the pinned price; currency pinned to USD');
select t.as(1);
select t.ok(public.workspace_context(t.id('A')) -> 'access' ->> 'state' = 'active'
  and (public.workspace_context(t.id('A')) -> 'access' -> 'limits' ->> 'locations')::int = 3, 'verified payment makes the business active with plan limits');
select t.err(format($$select public.begin_checkout(%L, 'USD', %L, 'savour-m4-sandbox-terms-1')$$, t.id('A'), t.id('pUSD2')), 'subscription_exists',
  'no second subscription checkout while one is current');
select t.ok(public.get_billing(t.id('B')) -> 'ledger' = '[]'::jsonb, 'the same owner''s other business sees none of A''s payments');
reset role;
-- Duplicate subscription: a second pending intent (fixture insert) whose payment creates another subscription.
insert into billing.checkout_intents (id, workspace_id, connection_id, owner_id, plan_code, price_id, price_version, currency, amount_minor, provider_product_id,
  terms_version, consented_at, reference, idempotency_key, status, provider_checkout_id)
values (gen_random_uuid(), t.id('A'), t.id('CONN'), t.u(1), 'business', t.id('pUSD1'), 1, 'USD', 2900, 'prod_testusd', 'savour-m4-sandbox-terms-1', now(),
  'savour_ck_dddddddddddddddddddddddddddddddd', 'savour-checkout-dup', 'open', 'chk_A9');
select t.role('billing_worker');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, jsonb_build_object(
  'payment', t.pay('ch_A9', 'sub_A9', 'succeeded', '29.00', 'USD', 'subscription_create', 'chk_A9', 'savour_ck_dddddddddddddddddddddddddddddddd', 'inv_A9',
    t.get('T')::timestamptz, t.get('T')::timestamptz + interval '1 month', 'prod_testusd'),
  'subscription', t.sub('sub_A9', 'cust_A1', 'active', '29.00', 'USD', 'prod_testusd', t.get('T')::timestamptz, t.get('T')::timestamptz + interval '1 month'),
  'checkout', t.ckA() || '{"checkout_id":"chk_A9","reference":"savour_ck_dddddddddddddddddddddddddddddddd"}'), now()) = 'review:duplicate_subscription',
  'a second subscription for a business is recorded for review and grants nothing');
-- Renewals: pinned price, explicit older-period rule.
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, jsonb_build_object(
  'payment', t.pay('ch_A2', 'sub_A1', 'succeeded', '35.00', 'USD', 'subscription_cycle', null, null, 'inv_A2',
    t.get('T')::timestamptz - interval '1 day' + interval '1 month', t.get('T')::timestamptz - interval '1 day' + interval '2 months', 'prod_testusd'),
  'subscription', t.sub('sub_A1', 'cust_A1', 'active', '29.00', 'USD', 'prod_testusd', t.get('T')::timestamptz - interval '1 day' + interval '1 month',
    t.get('T')::timestamptz - interval '1 day' + interval '2 months')), now()) = 'review:payment_mismatch',
  'a renewal at today''s catalog price instead of the pinned price is refused');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, jsonb_build_object(
  'payment', t.pay('ch_A2', 'sub_A1', 'succeeded', '29.00', 'USD', 'subscription_cycle', null, null, 'inv_A2',
    t.get('T')::timestamptz - interval '1 day' + interval '1 month', t.get('T')::timestamptz - interval '1 day' + interval '2 months', 'prod_testusd'),
  'subscription', t.sub('sub_A1', 'cust_A1', 'active', '29.00', 'USD', 'prod_testusd', t.get('T')::timestamptz - interval '1 day' + interval '1 month',
    t.get('T')::timestamptz - interval '1 day' + interval '2 months')), clock_timestamp()) = 'granted', 'renewal at the pinned price for the current subscription period');
select t.ok(billing.absorb_subscription(t.id('CONN'), null, null, jsonb_build_object('subscription', t.sA()), now() - interval '1 day') = 'stale_read',
  'an older subscription read never overwrites a newer one');
reset role;

-- ======================================================================== cancellation: pending vs provider-confirmed
select t.as(1);
select t.put('cxl', public.request_cancellation(t.id('A'), (public.get_billing(t.id('A')) ->> 'version')::int) ->> 'cancellation');
select t.ok(t.get('cxl') = 'pending'
  and public.get_billing(t.id('A')) -> 'subscription' ->> 'cancellation' = 'pending'
  and public.workspace_context(t.id('A')) -> 'access' ->> 'state' = 'active', 'a cancellation request is pending until the provider confirms');
select t.as(2);
select t.err(format($$select public.request_cancellation(%L, 99)$$, t.id('A')), 'forbidden', 'only the owner can cancel');
select t.role('billing_gateway');
select t.err(format($$select billing.gateway_cancel_context(%L, %L)$$, t.id('A'), t.u(2)), 'forbidden', 'gateway refuses a non-owner cancel');
select t.ok(billing.gateway_cancel_context(t.id('A'), t.u(1)) ->> 'provider_subscription_id' = 'sub_A1', 'gateway resolves the bound subscription');
select t.err(format($$select billing.gateway_apply_subscription(%L, %L, %L::jsonb, clock_timestamp())$$, t.id('A'), t.u(1),
  jsonb_build_object('subscription', t.sub('sub_B9', 'cust_A1', 'active', '29.00', 'USD', 'prod_testusd', now(), now() + interval '1 month', true))),
  'subscription_mismatch', 'a cancel response for another subscription is refused');
select t.ok(billing.gateway_apply_subscription(t.id('A'), t.u(1), jsonb_build_object('subscription', t.sub('sub_A1', 'cust_A1', 'active', '29.00', 'USD',
  'prod_testusd', t.get('T')::timestamptz - interval '1 day' + interval '1 month', t.get('T')::timestamptz - interval '1 day' + interval '2 months', true)),
  clock_timestamp()) = 'applied', 'provider-confirmed cancellation applied');
select t.as(1);
select t.ok(public.workspace_context(t.id('A')) -> 'access' ->> 'state' = 'cancel_scheduled'
  and public.get_billing(t.id('A')) -> 'subscription' ->> 'cancellation' = 'confirmed', 'access continues until the paid-through date, shown as confirmed');
reset role;

-- ======================================================================== refunds and disputes: only the associated period
select t.role('billing_worker');
select t.ok(billing.absorb_refund(t.id('CONN'), null, null, jsonb_build_object('payment', t.pA(p_status => 'partially_refunded')), now()) = 'period_flagged',
  'a partial refund flags the period for review');
select t.ok(billing.absorb_refund(t.id('CONN'), null, null, jsonb_build_object('payment', t.pA(p_status => 'refunded')), now()) = 'period_revoked',
  'a full refund revokes only its own period');
reset role;
select t.ok((select revoked_at is not null from billing.paid_periods where provider_payment_id = 'ch_A1')
  and (select revoked_at is null from billing.paid_periods where provider_payment_id = 'ch_A2'), 'the later paid period is untouched');
-- Refund before the payment was verified: tombstone; a delayed succeeded read cannot resurrect it.
select t.role('billing_worker');
select t.ok(billing.absorb_refund(t.id('CONN'), null, null, jsonb_build_object('payment', t.pay('ch_A3', 'sub_A1', 'refunded', '29.00', 'USD', 'subscription_cycle', null, null,
  'inv_A3', now() + interval '2 months', now() + interval '3 months', 'prod_testusd')), now()) = 'tombstoned', 'refund of an unverified payment tombstones it');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, jsonb_build_object('payment', t.pay('ch_A3', 'sub_A1', 'succeeded', '29.00', 'USD', 'subscription_cycle',
  null, null, 'inv_A3', now() + interval '2 months', now() + interval '3 months', 'prod_testusd'), 'subscription', t.sA()), now()) = 'review:payment_tombstoned',
  'paid-after-refund ordering grants nothing');
-- A re-read refunded status for an already verified payment must still apply the refund (not "duplicate").
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, jsonb_build_object('payment', t.pay('ch_A2', 'sub_A1', 'partially_refunded', '29.00', 'USD', 'subscription_cycle',
  null, null, 'inv_A2', t.get('T')::timestamptz - interval '1 day' + interval '1 month', t.get('T')::timestamptz - interval '1 day' + interval '2 months', 'prod_testusd'),
  'subscription', t.sA()), now()) = 'period_flagged', 'reconciliation re-read of a refunded payment applies the refund');
select t.ok(billing.absorb_dispute(t.id('CONN'), null, null, jsonb_build_object('dispute', jsonb_build_object('dispute_id', 'dp_1', 'charge_id', 'ch_A2', 'status', 'needs_response')), now())
  = 'dispute_open', 'a dispute flags its period without revoking');
select t.ok(billing.absorb_dispute(t.id('CONN'), null, null, jsonb_build_object('dispute', jsonb_build_object('dispute_id', 'dp_1', 'charge_id', 'ch_A2', 'status', 'lost')), now())
  = 'dispute_lost', 'a lost dispute revokes its period');
select t.ok(billing.absorb_dispute(t.id('CONN'), null, null, jsonb_build_object('dispute', jsonb_build_object('dispute_id', 'dp_2', 'charge_id', 'ch_A4', 'status', 'lost')), now())
  = 'review:dispute_unverified_payment', 'a lost dispute on an unverified payment tombstones it');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, jsonb_build_object('payment', t.pay('ch_A4', 'sub_A1', 'succeeded', '29.00', 'USD', 'subscription_cycle',
  null, null, 'inv_A4', now() + interval '3 months', now() + interval '4 months', 'prod_testusd'), 'subscription', t.sA()), now()) = 'review:payment_tombstoned',
  'dispute-before-payment grants nothing');
select t.ok((billing.reconcile_candidates(t.id('CONN'), 50) -> 'payments') @> '[{"payment_id": "ch_A1"}]'::jsonb is false
  and jsonb_typeof(billing.reconcile_candidates(t.id('CONN'), 50) -> 'payments') = 'array', 'reconciliation lists recent unrevoked verified payments');
reset role;
select t.ok(private.billing_core(t.id('A')) ->> 'state' not in ('active', 'cancel_scheduled'), 'with every period revoked the business is not active');
select t.ok((select array_agg(distinct currency) from billing.paid_periods where workspace_id = t.id('A')) = array['USD'], 'ledger rows carry their currency');

-- ======================================================================== renewal failure grace (E, owner 7)
create function t.paid_ws(p_ws uuid, p_owner integer, p_email text, p_cust text, p_chk text, p_pay text, p_sub text, p_start timestamptz,
  p_end timestamptz, p_currency text default 'USD') returns text language plpgsql as $$
declare v_i uuid; v_ref text; v_price uuid; v_amount text; v_product text; v_r text;
begin
  perform t.as(p_owner);
  perform public.set_billing_contact(p_ws, p_email, true, (public.get_billing(p_ws) ->> 'version')::int);
  select (x ->> 'price_id')::uuid, x ->> 'amount' into v_price, v_amount from jsonb_array_elements(public.get_billing(p_ws) -> 'prices') x
  where x ->> 'currency' = p_currency;
  v_i := (public.begin_checkout(p_ws, p_currency, v_price, 'savour-m4-sandbox-terms-1') ->> 'intent_id')::uuid;
  reset role;
  select reference, provider_product_id into v_ref, v_product from billing.checkout_intents where id = v_i;
  perform t.role('billing_gateway');
  perform billing.gateway_checkout_context(v_i, t.u(p_owner));
  perform billing.gateway_bind_customer(p_ws, t.id('CONN'), t.u(p_owner), p_cust, p_email, 'created');
  perform billing.gateway_mark_requesting(v_i, t.u(p_owner), '{"reference":"' || v_ref || '"}');
  perform billing.gateway_record_checkout(v_i, t.u(p_owner), 'created', p_chk, 'https://checkout.sandbox.bachs.io/c/x', now() + interval '1 hour', v_ref, null);
  perform t.role('billing_worker');
  v_r := billing.absorb_payment(t.id('CONN'), null, null, jsonb_build_object(
    'payment', t.pay(p_pay, p_sub, 'succeeded', v_amount, p_currency, 'subscription_create', p_chk, v_ref, 'inv_' || p_pay, p_start, p_end, v_product),
    'subscription', t.sub(p_sub, p_cust, 'active', v_amount, p_currency, v_product, p_start, p_end),
    'checkout', jsonb_build_object('checkout_id', p_chk, 'status', 'completed', 'reference', v_ref, 'customer_id', p_cust, 'currency', p_currency,
      'amount', v_amount, 'product_ids', jsonb_build_array(v_product), 'recurring', jsonb_build_object('interval', 'month', 'interval_count', 1))), now());
  reset role;
  return v_r;
end $$;

select t.as(7);
select t.put('E', public.create_workspace('Grace Co', 'Nigeria', 'Africa/Lagos', 'Owner Seven')::text);
select t.put('F', public.create_workspace('Lapsed Co', 'Nigeria', 'Africa/Lagos', 'Owner Seven')::text);
reset role;
select t.ok(t.paid_ws(t.id('E'), 7, 'billing-e@m4.savour.test', 'cust_E1', 'chk_E1', 'ch_E1', 'sub_E1',
  now() - interval '35 days', now() - interval '35 days' + interval '1 month') = 'granted', 'E paid an earlier month (contract fixture)');
-- fixture time travel: E's own trial is over, so only billing state decides
update billing.workspace_billing set trial_ends_at = trial_started_at where workspace_id in (t.id('E'), t.id('F'));
create function t.eFail(p_pay text) returns jsonb language sql stable as $$
  select jsonb_build_object('payment', t.pay(p_pay, 'sub_E1', 'failed', '35.00', 'USD', 'subscription_cycle', null, null, 'inv_E2',
      now() - interval '35 days' + interval '1 month', now() - interval '35 days' + interval '2 months', 'prod_testusd2'),
    'subscription', t.sub('sub_E1', 'cust_E1', 'past_due', '35.00', 'USD', 'prod_testusd2', now() - interval '35 days' + interval '1 month',
      now() - interval '35 days' + interval '2 months'))
$$;
grant execute on function t.eFail(text) to billing_worker;
select t.ok(private.billing_core(t.id('E')) ->> 'state' = 'read_only', 'after the paid month without a renewal or failure: read-only');
select t.role('billing_worker');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.eFail('ch_E2f'), now()) = 'renewal_failed', 'a failed renewal is recorded');
reset role;
select t.put('anchor', (private.billing_core(t.id('E')) ->> 'grace_anchor'));
select t.ok(private.billing_core(t.id('E')) ->> 'state' = 'past_due' and (private.billing_core(t.id('E')) ->> 'writable')::boolean
  and (private.billing_core(t.id('E')) ->> 'grace_ends_at')::timestamptz = (now() - interval '35 days' + interval '1 month') + interval '7 days',
  'a previously paid business keeps access for 7 days from the failed renewal period start');
select t.role('billing_worker');
select billing.absorb_payment(t.id('CONN'), null, null, t.eFail('ch_E2g'), clock_timestamp());
reset role;
select t.ok(private.billing_core(t.id('E')) ->> 'grace_anchor' = t.get('anchor')
  and (select observations from billing.payment_failures where provider_subscription_id = 'sub_E1') = 2, 'provider retries never reset the grace anchor');
select t.role('billing_worker');
select t.ok((billing.housekeeping() ->> 'notices')::int = 1, 'housekeeping emits one owner notice for the current grace milestone');
select t.ok((billing.housekeeping() ->> 'notices')::int = 0, 'notices are deduplicated');
select t.as(7);
select t.ok(exists (select 1 from jsonb_array_elements(public.get_inbox(t.id('E')) -> 'items') x
  where x ->> 'kind' = 'billing_past_due' and not (x ->> 'stale')::boolean and x ->> 'link' like '%/billing'), 'the owner sees a live in-app past-due notice');
select t.role('billing_worker');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, jsonb_build_object('payment', t.pay('ch_E2', 'sub_E1', 'succeeded', '35.00', 'USD', 'subscription_cycle', null, null,
    'inv_E2', now() - interval '35 days' + interval '1 month', now() - interval '35 days' + interval '2 months', 'prod_testusd2'),
  'subscription', t.sub('sub_E1', 'cust_E1', 'active', '35.00', 'USD', 'prod_testusd2', now() - interval '35 days' + interval '1 month',
    now() - interval '35 days' + interval '2 months')), clock_timestamp()) = 'granted', 'the recovered renewal is verified');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, t.eFail('ch_E2h'), clock_timestamp()) like '%', 'an older failure arrives after the later payment');
reset role;
select t.ok(private.billing_core(t.id('E')) ->> 'state' = 'active', 'an out-of-order old failure never overrides a later verified payment');
select t.as(7);
select t.ok(exists (select 1 from jsonb_array_elements(public.get_inbox(t.id('E')) -> 'items') x where x ->> 'kind' = 'billing_past_due' and (x ->> 'stale')::boolean),
  'the past-due notice goes stale once paid');
reset role;
select t.ok(t.paid_ws(t.id('F'), 7, 'billing-f@m4.savour.test', 'cust_F1', 'chk_F1', 'ch_F1', 'sub_F1',
  now() - interval '40 days', now() - interval '40 days' + interval '1 month') = 'granted', 'F paid an earlier month');
select t.role('billing_worker');
select billing.absorb_subscription(t.id('CONN'), null, null, jsonb_build_object('subscription', t.sub('sub_F1', 'cust_F1', 'past_due', '35.00', 'USD', 'prod_testusd2',
  now() - interval '40 days' + interval '1 month', now() - interval '40 days' + interval '2 months')), clock_timestamp());
reset role;
select t.ok(private.billing_core(t.id('F')) ->> 'state' = 'read_only' and private.billing_core(t.id('F')) ->> 'last_allocation' = 'grace'
  and not (private.billing_core(t.id('F')) ->> 'writable')::boolean, 'after 7 days of grace the business is read-only, keeping its last allocation');
select t.as(7);
select t.err(format($$select public.create_session_draft(%L, gen_random_uuid(), gen_random_uuid(), 'x', current_date, '{}', '{}', '{}', 24, null)$$, t.id('F')),
  'read_only%', 'expired grace blocks new work');

-- ======================================================================== NGN pinning and capability (G, owner 7)
reset role;
select platform.operator_verify_ngn_recurring(t.id('CONN'), 'disposable fixture: stands in for external sandbox recurring evidence');
select t.as(7);
select t.put('G', public.create_workspace('Naira Co', 'Nigeria', 'Africa/Lagos', 'Owner Seven')::text);
reset role;
select t.ok(t.paid_ws(t.id('G'), 7, 'billing-g@m4.savour.test', 'cust_G1', 'chk_G1', 'ch_G1', 'sub_G1', now() - interval '1 day',
  now() - interval '1 day' + interval '1 month', 'NGN') = 'granted', 'a verified NGN subscription grants in NGN');
select t.ok((select billing_currency from billing.workspace_billing where workspace_id = t.id('G')) = 'NGN'
  and (select amount_minor from billing.paid_periods where workspace_id = t.id('G')) = 2500000, 'NGN amount kept exactly in kobo; currency pinned');
select t.as(7);
select t.err(format($$select public.begin_checkout(%L, 'USD', %L, 'savour-m4-sandbox-terms-1')$$, t.id('G'), t.id('pUSD2')), 'currency_pinned%',
  'a pinned NGN business cannot switch to USD');
select t.ok((select jsonb_agg(x ->> 'currency') from jsonb_array_elements(public.get_billing(t.id('G')) -> 'totals_by_currency') x) = '["NGN"]'::jsonb,
  'totals are grouped by currency, never summed across currencies');
-- A price retired after consent: the provider checkout cannot start until the owner consents again.
select t.put('H', public.create_workspace('Repriced Co', 'Nigeria', 'Africa/Lagos', 'Owner Seven')::text);
select public.set_billing_contact(t.id('H'), 'billing-h@m4.savour.test', true, 1);
select t.put('iH', public.begin_checkout(t.id('H'), 'USD', t.id('pUSD2'), 'savour-m4-sandbox-terms-1') ->> 'intent_id');
reset role;
select billing.operator_configure_price(t.id('CONN'), 'USD', '36.00', 'prod_testusd3', 'second price change test');
select t.role('billing_gateway');
select t.err(format($$select billing.gateway_checkout_context(%L, %L)$$, t.id('iH'), t.u(7)), 'price_changed', 'a retired price requires fresh consent');
reset role;
select t.as(7);
select t.put('iH2', public.begin_checkout(t.id('H'), 'USD', (select (x ->> 'price_id')::uuid from jsonb_array_elements(public.get_billing(t.id('H')) -> 'prices') x
  where x ->> 'currency' = 'USD'), 'savour-m4-sandbox-terms-1') ->> 'intent_id');
reset role;
select t.ok((select status from billing.checkout_intents where id = t.id('iH')) = 'abandoned'
  and (select amount_minor from billing.checkout_intents where id = t.id('iH2')) = 3600, 'fresh consent to the new price supersedes the never-requested intent');

-- ======================================================================== platform admin and provider connections
select t.as(1);
select t.err($$select public.platform_overview()$$, 'forbidden', 'a workspace Owner is not a platform admin');
select t.as(2);
select t.err($$select public.platform_overview()$$, 'forbidden', 'a workspace Admin is not a platform admin');
select t.admin(30, 'aal1');
select t.ok(public.platform_overview() ->> 'environment' = 'sandbox', 'an enrolled platform admin reads non-secret state at aal1');
select t.err($$select public.platform_create_connection('bachs', 'No MFA')$$, 'mfa_required', 'every platform write needs aal2');
select t.err(format($$select public.platform_store_secret(%L, 'api_key', 'sk_sandbox_TESTONLYfixturekey0000000009', 99)$$, t.id('CONN')), 'mfa_required',
  'credential writes need aal2');
select t.ok(public.workspace_context(t.id('A')) is null, 'platform admin gains no workspace membership');
select t.admin(30);
select t.err($$select public.platform_create_connection('paystack', 'Paystack')$$, 'provider_adapter_pending%', 'a provider without an adapter cannot be connected');
select t.err($$select public.platform_create_connection('acme', 'Arbitrary')$$, 'provider_not_supported', 'a provider outside the registry cannot be connected');
select t.put('CONN2', public.platform_create_connection('bachs', 'Bachs sandbox B')::text);
select t.err(format($$select public.platform_store_secret(%L, 'api_key', 'sk_live_NOT_REAL', 1)$$, t.id('CONN2')),
  'invalid_credential_format', 'a live key is refused in SQL');
select t.err(format($$select public.platform_store_secret(%L, 'api_key', 'pk_sandbox_TESTONLY000000000000000002', 1)$$, t.id('CONN2')),
  'invalid_credential_format', 'a key with the wrong prefix is refused');
select t.ok((public.platform_store_secret(t.id('CONN2'), 'api_key', 'sk_sandbox_TESTONLYfixturekey0000000002', 1) ->> 'fingerprint') ~ '^[0-9a-f]{12}$',
  'storing a key returns only a fingerprint');
select public.platform_store_secret(t.id('CONN2'), 'webhook_secret', 'whsec_TESTONLYfixture000000000002', 2);
select public.platform_set_expected_org(t.id('CONN2'), 'acct_test_b', 3);
select t.err(format($$select public.platform_enable(%L, 4)$$, t.id('CONN2')), 'connection_incomplete', 'enable needs an active (tested) key');
select t.ok(public.platform_overview()::text !~ 'sk_sandbox_' and public.platform_overview()::text !~ 'whsec_', 'the overview never returns secret values');
select t.put('test2', public.platform_begin_test(t.id('CONN2'))::text);
reset role;
select t.role('billing_gateway');
select t.err(format($$select platform.gateway_test_context(%L, %L)$$, t.id('test2'), t.u(1)), 'test_not_running', 'only the starting admin''s running test exposes the key');
select platform.gateway_record_test(t.id('test2'), t.u(30), true, true, '{"account":"ok"}'::jsonb, '[]'::jsonb);
select t.admin(30);
select public.platform_enable(t.id('CONN2'), (select (c ->> 'version')::int from jsonb_array_elements(public.platform_overview() -> 'connections') c where c ->> 'id' = t.get('CONN2')));
reset role;
select billing.operator_configure_price(t.id('CONN2'), 'USD', '40.00', 'prod_conn2usd', 'disposable fixture on connection B');
-- Default change affects new checkouts only.
select t.admin(30);
select public.platform_set_default(t.id('CONN2'), (public.platform_overview() ->> 'settings_version')::int);
select t.as(7);
select t.put('J', public.create_workspace('New Default Co', 'Nigeria', 'Africa/Lagos', 'Owner Seven')::text);
select public.set_billing_contact(t.id('J'), 'billing-j@m4.savour.test', true, 1);
select t.put('iJ', public.begin_checkout(t.id('J'), 'USD', (select (x ->> 'price_id')::uuid from jsonb_array_elements(public.get_billing(t.id('J')) -> 'prices') x where x ->> 'currency' = 'USD'),
  'savour-m4-sandbox-terms-1') ->> 'intent_id');
reset role;
select t.ok((select connection_id from billing.checkout_intents where id = t.id('iJ')) = t.id('CONN2')
  and (select amount_minor from billing.checkout_intents where id = t.id('iJ')) = 4000, 'a new checkout pins the new default connection and its price');
select t.ok((select connection_id from billing.subscriptions where provider_subscription_id = 'sub_E1') = t.id('CONN'),
  'existing subscriptions stay on their pinned connection');
-- Disable stops new business on that connection; verification continues for pinned subscriptions.
select t.admin(30);
select public.platform_disable(t.id('CONN'), (select (c ->> 'version')::int from jsonb_array_elements(public.platform_overview() -> 'connections') c where c ->> 'id' = t.get('CONN')));
select t.err(format($$select public.platform_set_default(%L, %s)$$, t.id('CONN'), (public.platform_overview() ->> 'settings_version')::int), 'connection_not_enabled',
  'a disabled connection cannot become the default');
reset role;
select t.role('billing_worker');
select t.ok(billing.absorb_payment(t.id('CONN'), null, null, jsonb_build_object('payment', t.pay('ch_E3', 'sub_E1', 'succeeded', '35.00', 'USD', 'subscription_cycle', null, null,
    'inv_E3', now() - interval '35 days' + interval '2 months', now() - interval '35 days' + interval '3 months', 'prod_testusd2'),
  'subscription', t.sub('sub_E1', 'cust_E1', 'active', '35.00', 'USD', 'prod_testusd2', now() - interval '35 days' + interval '2 months',
    now() - interval '35 days' + interval '3 months')), clock_timestamp()) = 'granted', 'a disabled connection still verifies renewals of pinned subscriptions');
select t.ok((platform.get_credential(t.id('CONN')) ->> 'api_key') = 'sk_sandbox_TESTONLYfixturekey0000000001', 'the worker can still read the pinned connection''s key');
-- Same provider IDs on another connection never collide or cross-bind.
select t.role('billing_intake');
select t.ok(billing.ingest_event(t.id('CONN2'), 'evt_t1', 'collection.succeeded', now(), 'acct_test_b', convert_to(t.get('body1') || '  ', 'UTF8'),
  encode(sha256(convert_to(t.get('body1') || '  ', 'UTF8')), 'hex'), 1, null) = 'inserted', 'the same event ID on another connection is a different event');
select t.ok((platform.get_webhook_secrets(t.id('CONN2')) -> 'secrets' ->> 0) = 'whsec_TESTONLYfixture000000000002'
  and platform.get_webhook_secrets(t.id('CONN2')) ->> 'expected_organization_id' = 'acct_test_b', 'intake reads only the named connection''s signing secret');
select t.role('billing_worker');
select t.ok(billing.absorb_subscription(t.id('CONN2'), null, null, jsonb_build_object('subscription', t.sA()), now()) = 'review:unknown_subscription',
  'a subscription ID known on connection A binds nothing on connection B');
reset role;
-- Deletion is refused while anything is pinned; rotation keeps the old key until a test passes.
select t.admin(30);
select t.err(format($$select public.platform_delete_credential(%L, %s)$$, t.id('CONN'),
  (select (c ->> 'version')::int from jsonb_array_elements(public.platform_overview() -> 'connections') c where c ->> 'id' = t.get('CONN'))),
  'connection_in_use', 'a credential with pinned subscriptions cannot be deleted');
select public.platform_store_secret(t.id('CONN2'), 'api_key', 'sk_sandbox_TESTONLYfixturekey0000000003',
  (select (c ->> 'version')::int from jsonb_array_elements(public.platform_overview() -> 'connections') c where c ->> 'id' = t.get('CONN2')));
reset role;
select t.role('billing_worker');
select t.ok((platform.get_credential(t.id('CONN2')) ->> 'api_key') = 'sk_sandbox_TESTONLYfixturekey0000000002', 'a rotated key stays pending; the old key keeps working');
select t.admin(30);
select t.put('test3', public.platform_begin_test(t.id('CONN2'))::text);
reset role;
select t.role('billing_gateway');
select platform.gateway_record_test(t.id('test3'), t.u(30), true, true, '{"account":"ok"}'::jsonb, '[]'::jsonb);
select t.role('billing_worker');
select t.ok((platform.get_credential(t.id('CONN2')) ->> 'api_key') = 'sk_sandbox_TESTONLYfixturekey0000000003'
  and (platform.get_credential(t.id('CONN2')) ->> 'credential_version')::int = 2, 'a passing test promotes the new key version');
select billing.housekeeping();
reset role;
select t.ok((select previous_secret_id is not null and previous_retire_after > now() + interval '24 hours' from platform.provider_connections where id = t.id('CONN2')),
  'the previous key is retained for in-flight work and the idempotency window');
do $$
declare r record; v integer; v_total integer := 0;
begin
  for r in select c.table_schema, c.table_name, c.column_name from information_schema.columns c
           where c.table_schema in ('public', 'private', 'billing', 'platform') and c.data_type in ('text', 'jsonb', 'json', 'character varying', 'bytea')
  loop
    execute format('select count(*) from %I.%I where %I::text ~ %L', r.table_schema, r.table_name, r.column_name, '(sk_sandbox_|whsec_)TESTONLY') into v;
    v_total := v_total + v;
  end loop;
  perform t.ok(v_total = 0, 'no table outside Vault holds a key-shaped value (including audit and request bodies)');
end $$;
select t.ok(t.n($$select 1 from platform.admin_audit where action in ('secret.stored', 'connection.enabled', 'settings.default_changed', 'connection.disabled')$$) >= 6
  and t.n($$select 1 from platform.admin_audit where aal = 'aal2' and action = 'secret.stored'$$) >= 5, 'every admin change is audited with its assurance level');

select count(*) as passed from t.passes;
rollback;
