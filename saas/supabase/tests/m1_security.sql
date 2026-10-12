-- SAVOUR Milestone 1 transactional security/integrity test.
--
-- Runs entirely inside one transaction and ROLLS BACK: fixture users, tenants and helper
-- schema "t" disappear afterwards. Uses SET ROLE authenticated + request.jwt.claims, exactly
-- as PostgREST does. Run as the database owner (postgres), e.g.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m1_security.sql
-- Any failed expectation raises 'FAIL: ...' and aborts. The final SELECT prints the pass count.
-- Fixture user IDs use the disposable prefix eeeeeeee-0000-4000-8000-.

begin;

create schema t;
grant usage on schema t to authenticated, anon;
create table t.vars (k text primary key, v text);
create table t.passes (n integer generated always as identity, msg text);
grant all on t.vars, t.passes to authenticated, anon;

create function t.u(n integer) returns uuid language sql immutable as
$$ select ('eeeeeeee-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid $$;
create function t.as(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', t.u(n), 'role', 'authenticated',
    'aal', 'aal1', 'user_metadata', json_build_object('role', 'owner'))::text, true);
  perform set_config('role', 'authenticated', true);
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

-- Users: 1 A owner, 2 A admin, 3 A reviewer (L1), 4 A reviewer (L2), 5 A assessor 1, 6 A assessor 2,
-- 7 A viewer (L1), 8 A viewer (L2), 9 A guest, 10 B owner, 11 outsider, 12 unverified, 13 B assessor.
insert into auth.users (id, email, email_confirmed_at)
select t.u(n), 'm1-fixture-' || n || '@savour.test', case when n = 12 then null else now() end
from generate_series(1, 13) n;

-- ---------------------------------------------------------------- workspaces
select t.as(12);
select t.err($$select public.create_workspace('X', 'Nigeria', 'Africa/Lagos', 'U')$$, 'email_not_verified', 'unverified email cannot create workspace');
select t.as(1);
select t.err($$select public.create_workspace('X', 'Nigeria', 'Mars/Base', 'U')$$, 'invalid_timezone', 'invalid timezone rejected');
select t.put('wsA', public.create_workspace('Same Name Foods', 'Nigeria', 'Africa/Lagos', 'Ada Owner')::text);
select t.as(10);
select t.put('wsB', public.create_workspace('Same Name Foods', 'Nigeria', 'Africa/Lagos', 'Bola Owner')::text);
select t.ok(t.n('select 1 from public.workspaces') = 1, 'B sees only its own workspace');
select t.ok(public.workspace_context(t.id('wsA')) is null, 'B has no context in A');

reset role;
set local role anon;
select t.err($$select count(*) from public.workspaces$$, 'permission denied%', 'anon cannot read workspaces');
select t.err($$select public.get_dashboard(gen_random_uuid())$$, 'permission denied%', 'anon cannot call RPCs');
reset role;

-- M4 fixture: uncapped trial. This pre-M4 script intentionally exercises more than the SAVOUR trial
-- limits, so the database owner lifts them for its own disposable workspace inside this rolled-back
-- transaction (billing.fixture_uncap_trial: owner-only, audited, no runtime path). Assertion count unchanged.
set local savour.fixture_mode = 'disposable'; select billing.fixture_uncap_trial(t.id('wsA'));

-- ---------------------------------------------------------------- setup (A and B use identical labels)
select t.as(1);
select t.put('L1', public.upsert_location(t.id('wsA'), null, 'Main Site', false)::text);
select t.put('L2', public.upsert_location(t.id('wsA'), null, 'Annex', false)::text);
select t.put('S1', public.upsert_subject(t.id('wsA'), null, 'Vendor One', 'vendor', false)::text);
select t.put('S2', public.upsert_subject(t.id('wsA'), null, 'Vendor Two', 'vendor', false)::text);
select t.err($$select public.publish_template(t.id('wsA'), null, 'Empty', 'custom', 'presence', '[]')$$,
  'template_needs_criteria', 'template needs quality criteria or scored attendance');
select t.err($$select public.publish_template(t.id('wsA'), null, 'Bad', 'custom', 'off', '[{"key":"Bad Key","label":"x"}]')$$,
  'invalid_criteria', 'criterion keys validated');
select t.put('TV', public.publish_template(t.id('wsA'), null, 'Food panel', 'food_vendors', 'scored',
  '[{"key":"taste","label":"Taste"},{"key":"hygiene","label":"Hygiene","allow_na":true}]')::text);
select t.put('TVoff', public.publish_template(t.id('wsA'), null, 'Kitchen check', 'restaurant_ops', 'off',
  '[{"key":"storage","label":"Storage"}]')::text);
select t.as(10);
select t.put('BL1', public.upsert_location(t.id('wsB'), null, 'Main Site', false)::text);
select t.put('BS1', public.upsert_subject(t.id('wsB'), null, 'Vendor One', 'vendor', false)::text);
select t.put('BTV', public.publish_template(t.id('wsB'), null, 'Food panel', 'food_vendors', 'scored',
  '[{"key":"taste","label":"Taste"}]')::text);
select t.err($$select public.upsert_subject(t.id('wsA'), null, 'Intruder', 'vendor', false)$$, 'forbidden', 'B cannot write into A');
select t.err($$select public.upsert_subject(t.id('wsB'), t.id('S1'), 'Hijack', 'vendor', false)$$, 'not_found%', 'B cannot update A subject via own workspace id');

reset role;
select t.err($$update public.template_versions set criteria = '[]' where id = t.id('TV')$$, 'immutable_record', 'published template version immutable');

-- ---------------------------------------------------------------- invitations
select t.as(1);
select t.put('inv_admin', public.create_invitation(t.id('wsA'), 'M1-FIXTURE-2@savour.test', 'admin', true, '{}', null, null) ->> 'token');
select t.err($$select public.create_invitation(t.id('wsA'), 'x@savour.test', 'owner', true, '{}', null, null)$$, 'role_not_invitable', 'owner role cannot be invited');
select t.as(2);
select t.err($$select public.accept_invitation('not-a-token', 'Admin')$$, 'invitation_invalid', 'unknown token rejected');
select t.ok(public.accept_invitation(t.get('inv_admin'), 'Ade Admin') = t.id('wsA'), 'admin accepts with matching email (case-insensitive)');
select t.err($$select public.accept_invitation(t.get('inv_admin'), 'Again')$$, 'invitation_used', 'invitation is single-use');
select t.err($$select public.create_invitation(t.id('wsA'), 'x@savour.test', 'admin', true, '{}', null, null)$$, 'role_not_invitable', 'admin cannot invite admin');
select t.err($$select public.create_invitation(t.id('wsA'), 'x@savour.test', 'viewer', false, '{}', null, null)$$, 'locations_required', 'scoped role needs locations');
select t.err($$select public.create_invitation(t.id('wsA'), 'x@savour.test', 'viewer', false, array[t.id('BL1')], null, null)$$, 'not_found%', 'foreign location rejected in invitation');
select t.put('inv_rev', public.create_invitation(t.id('wsA'), 'm1-fixture-3@savour.test', 'reviewer', false, array[t.id('L1')], null, null) ->> 'token');
select t.put('inv_rev2', public.create_invitation(t.id('wsA'), 'm1-fixture-4@savour.test', 'reviewer', false, array[t.id('L2')], null, null) ->> 'token');
select t.put('inv_as1', public.create_invitation(t.id('wsA'), 'm1-fixture-5@savour.test', 'assessor', false, array[t.id('L1')], null, null) ->> 'token');
select t.put('inv_as2', public.create_invitation(t.id('wsA'), 'm1-fixture-6@savour.test', 'assessor', true, '{}', null, null) ->> 'token');
select t.put('inv_view', public.create_invitation(t.id('wsA'), 'm1-fixture-7@savour.test', 'viewer', false, array[t.id('L1')], null, null) ->> 'token');
select t.put('inv_view2', public.create_invitation(t.id('wsA'), 'm1-fixture-8@savour.test', 'viewer', false, array[t.id('L2')], null, null) ->> 'token');
select t.put('inv_exp', public.create_invitation(t.id('wsA'), 'm1-fixture-11@savour.test', 'viewer', true, '{}', null, null) ->> 'token');
select t.put('inv_rvk_json', public.create_invitation(t.id('wsA'), 'm1-fixture-11@savour.test', 'viewer', true, '{}', null, null)::text);

select t.as(11);
select t.err($$select public.accept_invitation(t.get('inv_as1'), 'Thief')$$, 'invitation_wrong_account', 'wrong signed-in user cannot accept');
select t.ok(public.peek_invitation(t.get('inv_as1')) ->> 'status' = 'invitation_wrong_account', 'peek reports wrong account');
reset role;
update public.invitations set expires_at = now() - interval '1 second'
  where token_hash = encode(sha256(convert_to(t.get('inv_exp'), 'UTF8')), 'hex');
select t.as(2);
select public.revoke_invitation((t.get('inv_rvk_json')::jsonb ->> 'id')::uuid);
select t.as(11);
select t.err($$select public.accept_invitation(t.get('inv_exp'), 'Late')$$, 'invitation_expired', 'expired invitation rejected');
select t.err($$select public.accept_invitation(t.get('inv_rvk_json')::jsonb ->> 'token', 'Rev')$$, 'invitation_revoked', 'revoked invitation rejected');
select t.ok(t.n('select 1 from public.memberships') = 0, 'failed acceptances create no membership');

select t.as(3); select public.accept_invitation(t.get('inv_rev'), 'Rita Reviewer');
select t.as(4); select public.accept_invitation(t.get('inv_rev2'), 'Remi Reviewer');
select t.as(5); select public.accept_invitation(t.get('inv_as1'), 'Ayo Assessor');
select t.ok((select role::text from public.memberships where user_id = t.u(5)) = 'assessor', 'role comes from the invitation row only');
select t.as(6); select public.accept_invitation(t.get('inv_as2'), 'Bimpe Assessor');
select t.as(7); select public.accept_invitation(t.get('inv_view'), 'Vic Viewer');
select t.as(8); select public.accept_invitation(t.get('inv_view2'), 'Val Viewer');
select t.as(5);
select t.ok(t.n('select 1 from public.memberships') = 1, 'non-admin sees only own membership');
select t.ok(t.n('select 1 from public.invitations') = 0, 'assessor cannot read invitations');
select t.err($$select public.create_invitation(t.id('wsA'), 'x@savour.test', 'viewer', true, '{}', null, null)$$, 'forbidden', 'assessor cannot invite');
select t.ok(public.workspace_context(t.id('wsA')) ->> 'role' = 'assessor', 'user_metadata role claim is ignored');

-- ---------------------------------------------------------------- escalation and last owner
select t.as(2);
select t.err($$select public.update_member(t.id('wsA'), t.u(5), 'admin', true, '{}')$$, 'forbidden', 'admin cannot grant admin');
select t.err($$select public.update_member(t.id('wsA'), t.u(5), 'owner', true, '{}')$$, 'role_not_grantable', 'admin cannot grant owner');
select t.err($$select public.update_member(t.id('wsA'), t.u(2), 'reviewer', true, '{}')$$, 'cannot_change_own_role', 'cannot change own role');
select t.err($$select public.revoke_member(t.id('wsA'), t.u(1))$$, 'forbidden', 'admin cannot remove owner');
select t.err($$update public.memberships set role = 'owner' where user_id = t.u(2)$$, 'permission denied%', 'no direct membership writes');
select t.as(1);
select t.err($$select public.update_member(t.id('wsA'), t.u(5), 'owner', true, '{}')$$, 'role_not_grantable', 'owner cannot be granted in M1');
select t.err($$select public.update_member(t.id('wsA'), t.u(1), 'admin', true, '{}')$$, 'cannot_change_own_role', 'owner cannot demote self');
select t.err($$select public.revoke_member(t.id('wsA'), t.u(1))$$, 'last_owner', 'last owner cannot leave');

-- ---------------------------------------------------------------- session creation
select t.as(2);
select t.err($$select public.create_session(t.id('wsA'), t.id('L1'), t.id('TV'), 'S', current_date,
  array[t.id('S1'), t.id('BS1')], array[t.u(5)], array[t.u(3)], 48, '09:00')$$, 'not_found%', 'foreign subject rejected');
select t.err($$select public.create_session(t.id('wsA'), t.id('L1'), t.id('BTV'), 'S', current_date,
  array[t.id('S1')], array[t.u(5)], array[t.u(3)], 48, '09:00')$$, 'not_found%', 'foreign template version rejected');
select t.err($$select public.create_session(t.id('wsA'), t.id('L1'), t.id('TV'), 'S', current_date,
  array[t.id('S1')], array[t.u(5)], array[t.u(4)], 48, '09:00')$$, 'invalid_reviewer', 'reviewer must hold the session location');
select t.err($$select public.create_session(t.id('wsA'), t.id('L1'), t.id('TV'), 'S', current_date,
  array[t.id('S1')], array[t.u(7)], array[t.u(3)], 48, '09:00')$$, 'invalid_assessor', 'viewer cannot be assigned');
select t.put('SES', public.create_session(t.id('wsA'), t.id('L1'), t.id('TV'), 'Same Session', current_date,
  array[t.id('S1'), t.id('S2')], array[t.u(5), t.u(6)], array[t.u(3)], 48, '09:00')::text);
select t.err($$select public.create_session(t.id('wsA'), t.id('L1'), t.id('TV'), 'S', current_date,
  array[t.id('S1')], array[t.u(5)], array[t.u(3)], 48, null)$$, 'ready_time_required', 'scored attendance requires a readiness time');
select t.err($$select public.create_session(t.id('wsA'), t.id('L2'), t.id('TV'), 'S', current_date,
  array[t.id('S1')], array[t.u(5)], array[]::uuid[], 48, '09:00')$$, 'invalid_assessor', 'assessor outside session location cannot be assigned');
select t.put('SES_same_day', public.create_session(t.id('wsA'), t.id('L1'), t.id('TV'), 'Same Session', current_date,
  array[t.id('S1')], array[t.u(5)], array[t.u(3)], 48, '09:00')::text);
select t.ok(t.id('SES') <> t.id('SES_same_day'), 'two same-date sessions coexist');

select t.as(10);
select t.ok(t.n('select 1 from public.sessions') = 0, 'B cannot list A sessions');
select t.ok(t.n($$select 1 from public.subjects where name = 'Vendor One'$$) = 1, 'B sees only its own identically named subject');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(10), null, '{"taste":5,"hygiene":5}', null, 0, gen_random_uuid(), null)$$,
  'not_found%', 'B cannot submit into A session');
select t.err($$select public.get_session_report(t.id('SES'), null, false, 'csv')$$, 'not_found%', 'B cannot export A report');
select t.err($$select public.approve_session(t.id('SES'), 1)$$, 'not_found%', 'B cannot approve A session');

-- ---------------------------------------------------------------- guest
select t.as(2);
select t.put('inv_guest', public.create_invitation(t.id('wsA'), 'm1-fixture-9@savour.test', 'guest', false, '{}', t.id('SES'), array[t.id('S1')]) ->> 'token');
select t.err($$select public.create_invitation(t.id('wsA'), 'g2@savour.test', 'guest', false, '{}', t.id('SES'), '{}')$$, 'subjects_required', 'guest invitation needs explicit subjects');
select t.err($$select public.create_invitation(t.id('wsA'), 'g2@savour.test', 'guest', false, '{}', t.id('SES'), array[t.id('BS1')])$$, 'not_found%', 'guest subjects must be on the session roster');
select t.err($$select public.create_invitation(t.id('wsA'), 'g2@savour.test', 'viewer', true, '{}', null, array[t.id('S1')])$$, 'invalid_scope', 'only guests carry subject scope');
select t.as(9);
select public.accept_invitation(t.get('inv_guest'), 'Gina Guest');
select t.ok(t.n('select 1 from public.sessions') = 1, 'guest sees only the invited session');
select t.ok(t.n('select 1 from public.locations') = 0, 'guest cannot browse locations');
select t.ok(t.n('select 1 from public.subjects') = 1, 'guest sees only the permitted roster subject');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(9), null, '{"taste":3,"hygiene":3}', null, 0, gen_random_uuid(), null)$$,
  'not_assigned', 'guest cannot submit outside permitted subjects');
select t.err($$select public.get_session_report(t.id('SES'), null, false, 'view')$$, 'forbidden', 'guest cannot read reports');
select t.err($$select public.get_dashboard(t.id('wsA'))$$, 'forbidden', 'guest has no dashboard');
select t.ok((public.submit_assessment(t.id('SES'), t.id('S1'), t.u(9), 'early', '{"taste":3,"hygiene":3}', null, 0, gen_random_uuid(), null) ->> 'version')::int = 1,
  'guest submits own assigned work');
select t.as(2);
select public.set_assignment(t.id('SES'), t.id('S1'), t.u(9), false,
  (select data_version from public.sessions where id = t.id('SES')));
select public.set_assignment(t.id('SES'), t.id('S2'), t.u(9), false,
  (select data_version from public.sessions where id = t.id('SES')));
select t.as(9);
select t.ok(t.n('select 1 from public.sessions') = 0, 'removed assignment hides the session on the next request');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(9), null, '{"taste":4,"hygiene":4}', null, 1, gen_random_uuid(), null)$$,
  'not_assigned', 'removed assignment blocks saving');

-- ---------------------------------------------------------------- submissions and validation
select t.as(5);
select t.put('k1', gen_random_uuid()::text);
select t.ok((public.submit_assessment(t.id('SES'), t.id('S1'), t.u(5), 'early', '{"taste":4,"hygiene":5}', 'Good', 0, t.id('k1'), null) ->> 'version')::int = 1,
  'assessor submits complete scores');
select t.ok((public.submit_assessment(t.id('SES'), t.id('S1'), t.u(5), 'early', '{"taste":4,"hygiene":5}', 'Good', 0, t.id('k1'), null) ->> 'replayed')::boolean,
  'identical retry is idempotent');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(5), 'early', '{"taste":3,"hygiene":5}', 'Good', 0, t.id('k1'), null)$$,
  'idempotency_conflict', 'same key with altered payload conflicts');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(5), 'early', '{"taste":3,"hygiene":5}', null, 0, gen_random_uuid(), null)$$,
  'stale_version', 'stale version cannot overwrite');
reset role;
select t.ok((select count(*) from public.assessment_events e join public.assessments a on a.id = e.assessment_id
  where a.assessor_id = t.u(5)) = 1, 'retry created exactly one revision');
select t.as(5);
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), null, '{"taste":6,"hygiene":5}', null, 0, gen_random_uuid(), null)$$, 'invalid_score', 'score above 5 rejected');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), null, '{"taste":0,"hygiene":5}', null, 0, gen_random_uuid(), null)$$, 'invalid_score', 'score below 1 rejected');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), null, '{"taste":3.5,"hygiene":5}', null, 0, gen_random_uuid(), null)$$, 'invalid_score', 'fractional score rejected');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), null, '{"taste":"4","hygiene":5}', null, 0, gen_random_uuid(), null)$$, 'invalid_score', 'string score rejected');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), null, '{"taste":4}', null, 0, gen_random_uuid(), null)$$, 'missing_criterion', 'missing criterion rejected');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), null, '{"taste":4,"hygiene":5,"aroma":3}', null, 0, gen_random_uuid(), null)$$, 'unknown_criterion', 'extra criterion rejected');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), null, '{"taste":{"na":"n/a"},"hygiene":5}', null, 0, gen_random_uuid(), null)$$, 'na_not_allowed', 'N/A where not permitted rejected');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), null, '{"taste":4,"hygiene":{"na":"  "}}', null, 0, gen_random_uuid(), null)$$, 'na_reason_required', 'N/A without reason rejected');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), 'present', '{"taste":4,"hygiene":5}', null, 0, gen_random_uuid(), null)$$, 'invalid_attendance', 'presence value invalid in scored mode');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), 'bogus', '{"taste":4,"hygiene":5}', null, 0, gen_random_uuid(), null)$$, 'invalid input value%', 'invalid enum rejected');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), 'absent', '{"taste":4,"hygiene":5}', null, 0, gen_random_uuid(), null)$$, 'absent_clears_scores', 'absent observation cannot carry scores');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('BS1'), t.u(5), null, '{"taste":4,"hygiene":5}', null, 0, gen_random_uuid(), null)$$, 'not_assigned', 'foreign subject id rejected');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(5), null, '{"taste":4,"hygiene":5}', null, 0, null, null)$$, 'idempotency_key_required', 'idempotency key required');
select t.err($$insert into public.assessments (workspace_id, session_id, subject_id, assessor_id, assessor_name, state, updated_by)
  values (t.id('wsA'), t.id('SES'), t.id('S2'), t.u(5), 'x', 'submitted', t.u(5))$$, 'permission denied%', 'no direct assessment inserts');
select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), 'late', '{"taste":3,"hygiene":3}', 'Tasty stew', 0, gen_random_uuid(), null);

select t.as(6);
select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(6), 'early', '{"taste":4,"hygiene":{"na":"Kitchen closed"}}', null, 0, gen_random_uuid(), null);
select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(6), 'late', '{"taste":2,"hygiene":2}', null, 0, gen_random_uuid(), null);
select t.ok(t.n('select 1 from public.assessments') = 2, 'assessor sees only own assessments (no peer drafts)');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(5), null, '{"taste":1,"hygiene":1}', null, 1, gen_random_uuid(), 'tamper')$$, 'forbidden', 'assessor cannot edit another response');
select t.err($$select public.approve_session(t.id('SES'), 1)$$, 'forbidden', 'assessor cannot approve');
select t.err($$select public.reopen_session(t.id('SES'), 'x')$$, 'forbidden', 'assessor cannot reopen');
select t.err($$select public.set_assignment(t.id('SES'), t.id('S1'), t.u(6), true, 1)$$, 'forbidden', 'assessor cannot assign');
select t.err($$select public.resolve_outcome(t.id('SES'), t.id('S1'), 'early', null, 1)$$, 'forbidden', 'assessor cannot set canonical outcome');
select t.err($$select public.get_session_report(t.id('SES'), null, false, 'view')$$, 'forbidden', 'assessor cannot read reports');

select t.as(7);
select t.ok(t.n('select 1 from public.sessions') = 0, 'viewer cannot see unapproved sessions');
select t.ok(t.n('select 1 from public.subjects') = 0, 'viewer has no workspace subject directory');
select t.err($$select public.get_session_report(t.id('SES'), null, false, 'view')$$, 'not_found%', 'viewer has no provisional report');

-- ---------------------------------------------------------------- review, attendance, approval
select t.as(4);
select t.err($$select public.approve_session(t.id('SES'), 1)$$, 'forbidden', 'reviewer outside location/assignment cannot approve');
select t.ok(t.n('select 1 from public.assessments') = 0, 'unassigned reviewer cannot read assessments');

select t.ok(t.n('select 1 from public.subjects') = 0, 'reviewer without permitted sessions sees no subjects');
select t.as(3);
select t.ok(t.n('select 1 from public.subjects') = 2, 'reviewer sees only subjects on sessions they review');
select t.err($$select public.resolve_outcome(t.id('SES'), t.id('S1'), 'early', null, null)$$, 'stale_version', 'null outcome version rejected');
select t.err($$select public.approve_session(t.id('SES'), null)$$, 'stale_version', 'null approval version rejected');
select t.err($$select public.confirm_na(t.id('SES'), t.id('S1'), t.u(6), null)$$, 'stale_version', 'null N/A confirmation version rejected');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(6), 'early', '{"taste":4,"hygiene":4}', null, null, gen_random_uuid(), 'fix')$$, 'stale_version', 'null assessment version rejected');
select t.as(2);
select t.err($$select public.set_assignment(t.id('SES'), t.id('S1'), t.u(6), true, null)$$, 'stale_version', 'null assignment version rejected');
select t.as(3);
select t.ok(t.n('select 1 from public.assessments where session_id = t.id(''SES'')') = 5, 'assigned reviewer reads all session responses (2 assessors x 2 subjects + guest)');
select t.err($$select public.approve_session(t.id('SES'), (select data_version from public.sessions where id = t.id('SES')))$$,
  'approval_blocked', 'unknown outcomes block approval');
select t.err($$select public.resolve_outcome(t.id('SES'), t.id('S1'), 'present', null, 1)$$, 'invalid_outcome', 'presence outcome invalid in scored mode');
select public.resolve_outcome(t.id('SES'), t.id('S1'), 'early', null, 1);
select t.err($$select public.resolve_outcome(t.id('SES'), t.id('S1'), 'late', null, 1)$$, 'stale_version', 'stale outcome version rejected');
select public.resolve_outcome(t.id('SES'), t.id('S2'), 'absent', 'Did not arrive', 1);
select t.ok(t.n($$select 1 from public.assessments where session_id = t.id('SES') and subject_id = t.id('S2') and state = 'cleared' and answers is null$$) = 2,
  'absent clears every current quality response for the subject');
select t.ok(t.n($$select 1 from public.assessments where subject_id = t.id('S2') and notes is not null$$) = 0, 'absent clears quality feedback notes');
reset role;
select t.ok((select payload ->> 'notes' from public.assessment_events e join public.assessments a on a.id = e.assessment_id
  where a.assessor_id = t.u(5) and a.subject_id = t.id('S2') and e.kind = 'submit') = 'Tasty stew', 'cleared feedback preserved in immutable history');
select t.as(3);
select public.resolve_outcome(t.id('SES'), t.id('S2'), 'middle', 'Arrived after all', 2);
select t.as(6);
select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(6), 'absent', null, 'Stall closed at 9', 2, gen_random_uuid(), null);
select t.as(3);
select t.ok((select notes is null and absence_reason = 'Stall closed at 9' and answers is null from public.assessments
  where subject_id = t.id('S2') and assessor_id = t.u(6)), 'absent observation stores a reason, not quality feedback');
select t.ok(t.n($$select 1 from public.assessments where subject_id = t.id('S2') and answers is not null$$) = 0, 'restoring presence does not resurrect scores');
select t.as(3);
select t.err($$select public.approve_session(t.id('SES'), (select data_version from public.sessions where id = t.id('SES')))$$,
  'approval_blocked', 'missing required responses block approval');
select public.resolve_outcome(t.id('SES'), t.id('S2'), 'absent', null, 3);
select t.as(5);
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S2'), t.u(5), null, '{"taste":4,"hygiene":5}', null, 3, gen_random_uuid(), null)$$,
  'subject_not_assessable', 'absent subject blocks new quality scores');
select t.as(3);
select t.err($$select public.approve_session(t.id('SES'), (select data_version from public.sessions where id = t.id('SES')))$$,
  'approval_blocked', 'unconfirmed N/A blocks approval');
select public.confirm_na(t.id('SES'), t.id('S1'), t.u(6), 1);
select t.put('dv', (select data_version from public.sessions where id = t.id('SES'))::text);
select t.as(5);
select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(5), 'early', '{"taste":4,"hygiene":5}', 'Good again', 1, gen_random_uuid(), null);
select t.as(3);
select t.err($$select public.approve_session(t.id('SES'), t.get('dv')::int)$$, 'stale_version', 'approval of a stale view is rejected after a concurrent save');
select t.put('R1', public.approve_session(t.id('SES'), (select data_version from public.sessions where id = t.id('SES')))::text);
select t.ok((select status::text from public.sessions where id = t.id('SES')) = 'approved', 'session approved');

-- ---------------------------------------------------------------- locked after approval
select t.as(5);
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(5), 'early', '{"taste":1,"hygiene":1}', null, 2, gen_random_uuid(), null)$$,
  'session_locked', 'approved revision rejects assessor writes');
select t.as(3);
select t.err($$select public.resolve_outcome(t.id('SES'), t.id('S1'), 'late', null, 2)$$, 'session_locked', 'approved revision rejects outcome changes');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(5), 'early', '{"taste":1,"hygiene":1}', null, 2, gen_random_uuid(), 'fix')$$,
  'session_locked', 'approved revision rejects reviewer amendments');
select t.err($$select public.reopen_session(t.id('SES'), 'x')$$, 'forbidden', 'reviewer cannot reopen');
select t.err($$select * from public.report_revisions$$, 'permission denied%', 'snapshots not directly readable');
reset role;
select t.err($$update public.report_revisions set approver_name = 'x' where id = t.id('R1')$$, 'immutable_record', 'approved snapshot immutable even for owner role');
select t.err($$update public.sessions set workspace_id = t.id('wsB') where id = t.id('SES')$$, 'immutable_workspace', 'tenant key cannot change');
select t.ok((select (inputs -> 'subjects' -> 0 -> 'assessments') @> '[{"answers":{"taste":4,"hygiene":5}}]'
  and jsonb_array_length(inputs -> 'subjects' -> 0 -> 'assessments') = 2
  and inputs -> 'subjects' -> 1 ->> 'outcome' = 'absent'
  and approver_name = 'Rita Reviewer' and approved_by = t.u(3)
  from public.report_revisions where id = t.id('R1')), 'snapshot stores validated inputs, actor and name');

-- ---------------------------------------------------------------- report reads and redaction
select t.as(3);
select t.ok((public.get_session_report(t.id('SES'), null, false, 'view') -> 'inputs')::text like '%Ayo Assessor%', 'reviewer may see identities');
select t.ok((public.get_session_report(t.id('SES'), null, true, 'pdf') -> 'inputs')::text not like '%Ayo Assessor%', 'reviewer may request redacted export');
select t.as(7);
select t.put('viewer_report', public.get_session_report(t.id('SES'), null, false, 'csv')::text);
select t.ok(t.get('viewer_report') not like '%Ayo Assessor%' and t.get('viewer_report') not like '%Bimpe Assessor%'
  and t.get('viewer_report') not like '%' || t.u(5)::text || '%' and t.get('viewer_report') not like '%' || t.u(6)::text || '%'
  and t.get('viewer_report') like '%Assessor 1%' and (t.get('viewer_report')::jsonb -> 'meta' ->> 'redacted')::boolean,
  'viewer report is redacted at the RPC boundary (names and ids)');
select t.ok(jsonb_array_length(public.get_dashboard(t.id('wsA')) -> 'approved') = 1, 'viewer dashboard counts approved session');
select t.ok(public.get_dashboard(t.id('wsA'))::text not like '%Ayo Assessor%', 'dashboard inputs are redacted');
select t.as(8);
select t.err($$select public.get_session_report(t.id('SES'), null, false, 'view')$$, 'forbidden', 'viewer outside location denied');

-- ---------------------------------------------------------------- reopen and reapproval
select t.as(1);
select t.err($$select public.reopen_session(t.id('SES'), '  ')$$, 'reason_required', 'reopen requires reason');
select t.ok(public.reopen_session(t.id('SES'), 'Hygiene score disputed') = 2, 'owner reopens into revision 2');
select t.ok(jsonb_array_length(public.get_dashboard(t.id('wsA')) -> 'approved') = 0, 'session under revision excluded from analytics');
select t.ok(jsonb_array_length(public.get_dashboard(t.id('wsA')) -> 'under_revision') = 1, 'session labelled under revision');
select t.ok(public.get_session_report(t.id('SES'), 1, false, 'view') -> 'meta' ->> 'approver_name' = 'Rita Reviewer', 'prior approved revision preserved');
select t.ok(public.get_session_report(t.id('SES'), null, false, 'view') -> 'meta' ->> 'status' = 'provisional', 'current revision is provisional');
select t.as(7);
select t.err($$select public.get_session_report(t.id('SES'), null, false, 'view')$$, 'not_found%', 'viewer cannot see revision in progress');
select t.ok(public.get_session_report(t.id('SES'), 1, false, 'view') -> 'meta' ->> 'status' = 'approved', 'viewer can still export prior approved revision');
select t.as(3);
select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(6), 'early', '{"taste":5,"hygiene":5}', null, 2, gen_random_uuid(), 'Reviewer correction after reopen');
select t.put('R2', public.approve_session(t.id('SES'), (select data_version from public.sessions where id = t.id('SES')))::text);
select t.as(1);
select t.ok(jsonb_array_length(public.get_dashboard(t.id('wsA')) -> 'approved') = 1, 'reapproval counts once');
select t.ok((select count(*) from jsonb_array_elements(public.get_session_report(t.id('SES'), null, false, 'view') -> 'revisions')) = 2, 'both revisions retained');
select t.ok(public.get_session_report(t.id('SES'), 1, false, 'view') -> 'inputs' -> 'subjects' -> 0 -> 'assessments' @> '[{"answers":{"hygiene":{"na":"Kitchen closed"}}}]',
  'historic revision keeps original values');
select t.ok(t.n($$select 1 from public.audit_events where action = 'report.exported'$$) >= 2, 'exports are audited');

-- ---------------------------------------------------------------- window, attendance-off, revocation
reset role;
update public.sessions set opens_at = now() - interval '50 hours', closes_at = now() - interval '2 hours'
where id = t.id('SES_same_day');
select t.as(5);
select t.err($$select public.submit_assessment(t.id('SES_same_day'), t.id('S1'), t.u(5), null, '{"taste":4,"hygiene":5}', null, 0, gen_random_uuid(), null)$$,
  'window_closed', 'out-of-window assessor submission rejected');

select t.as(1);
select t.put('SES_off', public.create_session(t.id('wsA'), t.id('L1'), t.id('TVoff'), 'Kitchen', current_date,
  array[t.id('S1')], array[t.u(5), t.u(1)], array[t.u(3)], 48, null)::text);
select t.as(5);
select t.err($$select public.submit_assessment(t.id('SES_off'), t.id('S1'), t.u(5), 'absent', null, null, 0, gen_random_uuid(), null)$$,
  'invalid_attendance', 'attendance-off has no arrival input');
select t.as(3);
select t.err($$select public.resolve_outcome(t.id('SES_off'), t.id('S1'), 'early', null, 1)$$, 'invalid_outcome', 'attendance-off rejects arrival outcomes');
select t.err($$select public.resolve_outcome(t.id('SES_off'), t.id('S1'), 'not_assessed', null, 1)$$, 'reason_required', 'not assessed requires reason');
select t.as(1);
select public.submit_assessment(t.id('SES_off'), t.id('S1'), t.u(1), null, '{"storage":4}', null, 0, gen_random_uuid(), null);
select public.close_collection(t.id('SES_off'));
select t.err($$select public.submit_assessment(t.id('SES_off'), t.id('S1'), t.u(1), null, '{"storage":2}', null, 1, gen_random_uuid(), null)$$,
  'window_closed', 'own submission after close without reason is rejected');
select t.ok((public.submit_assessment(t.id('SES_off'), t.id('S1'), t.u(1), null, '{"storage":2}', null, 1, gen_random_uuid(), 'Recount') ->> 'version')::int = 2,
  'reviewer-capable owner can amend own score with a reason');
reset role;
select t.ok((select kind from public.assessment_events where session_id = t.id('SES_off') and version = 2) = 'amend', 'own correction audited as amendment');

select t.as(2);
select public.update_member(t.id('wsA'), t.u(7), 'viewer', false, array[t.id('L2')]);
select t.as(7);
select t.err($$select public.get_session_report(t.id('SES'), null, false, 'view')$$, 'forbidden', 'location scope removal denies next report read');
select t.as(2);
select public.update_member(t.id('wsA'), t.u(6), 'assessor', false, array[t.id('L2')]);
select t.as(6);
select t.ok(t.n($$select 1 from public.sessions where id = t.id('SES_same_day') or id = t.id('SES')$$) = 0, 'assessor moved to another location loses old-location sessions');
select t.ok(t.n('select 1 from public.subjects') = 0, 'moved assessor loses old roster subjects');
select t.err($$select public.submit_assessment(t.id('SES'), t.id('S1'), t.u(6), 'early', '{"taste":5,"hygiene":5}', null, 3, gen_random_uuid(), null)$$,
  'not_assigned', 'moved assessor cannot save to old-location session');
select t.as(2);
select t.err($$select public.set_assignment(t.id('SES_same_day'), t.id('S1'), t.u(6), true, (select data_version from public.sessions where id = t.id('SES_same_day')))$$,
  'invalid_assessor', 'cannot assign assessor outside session location');
select public.revoke_member(t.id('wsA'), t.u(5));
select t.as(5);
select t.ok(t.n('select 1 from public.sessions') = 0, 'revoked member loses reads on next request');
select t.err($$select public.submit_assessment(t.id('SES_off'), t.id('S1'), t.u(5), null, '{"storage":4}', null, 0, gen_random_uuid(), null)$$,
  'not_found%', 'revoked member cannot save from an open page');
select t.ok(public.workspace_context(t.id('wsA')) is null, 'revoked member has no workspace context');

reset role;
select count(*) as passed from t.passes;
rollback;
