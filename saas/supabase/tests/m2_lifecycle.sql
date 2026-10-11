-- SAVOUR Milestone 2: drafts, opening, scope edits, roster removal, collection reopen and guest
-- expiry, waivers, correction requests, samples and snapshot immutability (migration 20261010231001).
--
-- One transaction, ROLLED BACK. Runs as the database owner and switches to `authenticated`
-- with JWT claims, as PostgREST does:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m2_lifecycle.sql
-- Fixture user IDs use the disposable prefix eeeeeeee-0000-4000-8000-0000000003xx.
-- Any failed expectation raises 'FAIL: ...'. The final SELECT prints the pass count.
-- Sequential only: stale-version and lock contracts are checked, not a parallel race.

begin;

create schema t;
grant usage on schema t to authenticated, anon;
create table t.vars (k text primary key, v text);
create table t.passes (n integer generated always as identity, msg text);
grant all on t.vars, t.passes to authenticated, anon;

create function t.u(n integer) returns uuid language sql immutable as
$$ select ('eeeeeeee-0000-4000-8000-' || lpad((300 + n)::text, 12, '0'))::uuid $$;
create function t.as(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', t.u(n), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function t.put(k text, v text) returns void language sql as
$$ insert into t.vars values (k, v) on conflict (k) do update set v = excluded.v $$;
create function t.id(k text) returns uuid language sql stable as $$ select v::uuid from t.vars where t.vars.k = id.k $$;
create function t.get(k text) returns text language sql stable as $$ select v from t.vars where t.vars.k = get.k $$;
create function t.j(k text) returns jsonb language sql stable as $$ select v::jsonb from t.vars where t.vars.k = j.k $$;
create function t.ok(p boolean, msg text) returns void language plpgsql as $$
begin
  if p is not true then raise exception 'FAIL: %', msg; end if;
  insert into t.passes (msg) values (msg);
end $$;
-- Matches the error code (message) or "code: detail" (problem lists are in the detail).
create function t.err(p_sql text, p_expect text, msg text) returns void language plpgsql as $$
declare v_detail text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm like p_expect or (sqlerrm || ': ' || coalesce(v_detail, '')) like p_expect then
      insert into t.passes (msg) values (msg); return;
    end if;
    raise exception 'FAIL: % (expected %, got %: % / %)', msg, p_expect, sqlerrm, v_detail, sqlstate;
  end;
  raise exception 'FAIL: % (expected error %, statement succeeded)', msg, p_expect;
end $$;
create function t.n(p_sql text) returns bigint language plpgsql as $$
declare v bigint;
begin execute 'select count(*) from (' || p_sql || ') q' into v; return v; end $$;
-- Owner-side helpers (SECURITY DEFINER as the database owner, so they ignore RLS).
create function t.dv(p_session uuid) returns integer language sql stable security definer as
$$ select data_version from public.sessions where id = p_session $$;
create function t.rv(p_session uuid, p_subject uuid) returns integer language sql stable security definer as
$$ select version from public.session_subjects where session_id = p_session and subject_id = p_subject $$;
create function t.audits(p_action text) returns bigint language sql stable security definer as
$$ select count(*) from public.audit_events where action = p_action $$;
grant execute on function t.dv(uuid), t.rv(uuid, uuid), t.audits(text) to authenticated;
-- Every read surface a guest/assessor could use for one session.
create function t.surfaces(p_session uuid) returns integer[] language sql as $$
  select array[
    (select count(*) from public.sessions where id = p_session)::integer,
    (select count(*) from public.session_subjects where session_id = p_session)::integer,
    (select count(*) from public.session_assignments where session_id = p_session)::integer,
    (select count(*) from public.assessments where session_id = p_session)::integer]
$$;

-- Users: 1 owner A, 2 admin A, 3 reviewer A (L1), 4 reviewer A (L1, never on sessions),
-- 5 and 6 assessors A (L1), 7 viewer A, 8 assessor A (L2 only), 10 owner B, 21..25 guests.
insert into auth.users (id, email, email_confirmed_at)
select t.u(n), 'm2-life-fixture-' || n || '@savour.test', now()
from unnest(array[1, 2, 3, 4, 5, 6, 7, 8, 10, 21, 22, 23, 24, 25, 26]) n;

-- ---------------------------------------------------------------- setup
select t.as(1);
select t.put('ws', public.create_workspace('Lifecycle QA', 'Nigeria', 'Africa/Lagos', 'Owner')::text);
select t.put('L1', public.upsert_location(t.id('ws'), null, 'Main', false)::text);
select t.put('L2', public.upsert_location(t.id('ws'), null, 'Annex', false)::text);
select t.put('S1', public.upsert_subject(t.id('ws'), null, 'Alpha Stall', 'vendor', false)::text);
select t.put('S2', public.upsert_subject(t.id('ws'), null, 'Beta Stall', 'vendor', false)::text);
select t.put('S3', public.upsert_subject(t.id('ws'), null, 'Gamma Stall', 'vendor', false)::text);
select t.put('TVs', public.publish_template(t.id('ws'), null, 'Panel', 'food_vendors', 'scored', '[{"key":"taste","label":"Taste"}]')::text);
select t.put('TVo', public.publish_template(t.id('ws'), null, 'Kitchen', 'restaurant_ops', 'off',
  '[{"key":"storage","label":"Storage"},{"key":"safety","label":"Safety","allow_na":true}]')::text);
select t.put('TVa', public.publish_template(t.id('ws'), null, 'Roll call', 'custom', 'scored', '[]')::text);
do $$
declare r record;
begin
  for r in select * from (values (2, 'admin', true, null::text), (3, 'reviewer', false, 'L1'), (4, 'reviewer', false, 'L1'),
      (5, 'assessor', false, 'L1'), (6, 'assessor', false, 'L1'), (7, 'viewer', true, null), (8, 'assessor', false, 'L2')) v (n, role, alll, loc)
  loop
    perform t.put('inv' || r.n, public.create_invitation(t.id('ws'), 'm2-life-fixture-' || r.n || '@savour.test', r.role::public.member_role,
      r.alll, case when r.loc is null then '{}'::uuid[] else array[t.id(r.loc)] end, null, null) ->> 'token');
  end loop;
end $$;
select t.as(2); select public.accept_invitation(t.get('inv2'), 'Ade Admin');
select t.as(3); select public.accept_invitation(t.get('inv3'), 'Rita Reviewer');
select t.as(4); select public.accept_invitation(t.get('inv4'), 'Remi Reviewer');
select t.as(5); select public.accept_invitation(t.get('inv5'), 'Ayo Assessor');
select t.as(6); select public.accept_invitation(t.get('inv6'), 'Bimpe Assessor');
select t.as(7); select public.accept_invitation(t.get('inv7'), 'Vic Viewer');
select t.as(8); select public.accept_invitation(t.get('inv8'), 'Kemi Annex');
select t.as(10);
select t.put('wsB', public.create_workspace('Lifecycle QA', 'Nigeria', 'Africa/Lagos', 'Owner B')::text);

-- ---------------------------------------------------------------- drafts are not collecting
select t.as(1);
select t.put('D', public.create_session_draft(t.id('ws'), t.id('L1'), t.id('TVs'), 'Draft panel', current_date,
  array[t.id('S1'), t.id('S2')], array[t.u(5), t.u(6)], '{}', 24, null)::text);
select t.put('D2', public.create_session_draft(t.id('ws'), t.id('L1'), t.id('TVs'), 'Draft panel', current_date,
  array[t.id('S1')], array[t.u(5)], array[t.u(3)], 24, '09:00')::text);
select t.ok(t.id('D') <> t.id('D2') and t.n($$select 1 from public.sessions where local_date = current_date and name = 'Draft panel'$$) = 2,
  'two drafts on the same local date coexist');
select t.ok((select status::text from public.sessions where id = t.id('D')) = 'draft', 'new session is a draft');
select t.err($$select public.create_session_draft(t.id('ws'), t.id('L2'), t.id('TVs'), 'X', current_date, array[t.id('S1')], array[t.u(5)], '{}', 24, null)$$,
  'invalid_assessor', 'draft still validates assessor location');
select t.err($$select public.create_invitation(t.id('ws'), 'g@savour.test', 'guest', false, '{}', t.id('D'), array[t.id('S1')])$$,
  'not_found%', 'no guest invitation into a draft');
select t.as(5);
select t.ok(t.surfaces(t.id('D')) = array[0, 0, 0, 0], 'assigned assessor cannot see a draft');
select t.err($$select public.submit_assessment(t.id('D'), t.id('S1'), t.u(5), 'early', '{"taste":4}', null, 0, gen_random_uuid(), null)$$,
  'not_assigned', 'assessor cannot submit into a draft');
select t.err($$select public.open_session(t.id('D'), t.dv(t.id('D')))$$, 'forbidden', 'assessor cannot open');
select t.as(3);
select t.err($$select public.set_session_reviewer(t.id('D'), t.u(3), true, null, t.dv(t.id('D')))$$, 'forbidden', 'reviewer cannot manage session reviewers');
select t.ok(t.n($$select 1 from public.sessions where id = t.id('D')$$) = 0, 'reviewer not on a draft cannot see it');
select t.as(3);
select t.ok(t.n($$select 1 from public.sessions where id = t.id('D2')$$) = 1, 'reviewer assigned to a draft can prepare by reading it');
select t.err($$select public.submit_assessment(t.id('D2'), t.id('S1'), t.u(5), null, '{"taste":4}', null, 0, gen_random_uuid(), 'pre-fill')$$,
  'session_locked', 'reviewer cannot write evidence into a draft');
select t.err($$select public.open_session(t.id('D2'), t.dv(t.id('D2')))$$, 'forbidden', 'reviewer cannot open');
select t.as(10);
select t.err($$select public.open_session(t.id('D'), 1)$$, 'not_found%', 'other workspace cannot open');
select t.err($$select public.set_roster_subject(t.id('D'), t.id('S3'), true, null, 1)$$, 'not_found%', 'other workspace cannot edit roster');

select t.as(1);
select t.err($$select public.open_session(t.id('D'), null)$$, 'stale_version', 'open needs an expected version');
select t.err($$select public.open_session(t.id('D'), t.dv(t.id('D')))$$, 'open_blocked', 'open refuses missing reviewer and ready time');
select t.err($$select public.open_session(t.id('D'), t.dv(t.id('D')))$$, '%at least one reviewer%', 'open explains the missing reviewer');
select public.set_session_reviewer(t.id('D'), t.u(3), true, null, t.dv(t.id('D')));
select t.err($$select public.set_session_reviewer(t.id('D'), t.u(5), true, null, t.dv(t.id('D')))$$, 'invalid_reviewer', 'assessor cannot be a reviewer');
select t.err($$select public.open_session(t.id('D'), t.dv(t.id('D')))$$, '%ready time%', 'scored readiness still needs a ready time at opening');
select public.update_session_draft(t.id('D'), 'Draft panel', current_date, t.id('L1'), t.id('TVs'), 24, '09:00', t.dv(t.id('D')));
select public.set_roster_subject(t.id('D'), t.id('S2'), false, null, t.dv(t.id('D')));
reset role;
select t.ok(t.n($$select 1 from public.session_subjects where session_id = t.id('D')$$) = 1
  and t.n($$select 1 from public.session_assignments where session_id = t.id('D')$$) = 2, 'draft roster removal deletes (no evidence exists)');
select t.as(1);
select public.upsert_subject(t.id('ws'), t.id('S1'), 'Alpha Stall', 'vendor', true);
select t.err($$select public.open_session(t.id('D'), t.dv(t.id('D')))$$, '%archived subject%', 'archived roster subject blocks opening');
select public.upsert_subject(t.id('ws'), t.id('S1'), 'Alpha Stall', 'vendor', false);
select public.set_roster_subject(t.id('D'), t.id('S2'), true, null, t.dv(t.id('D')));
select public.set_assignment(t.id('D'), t.id('S2'), t.u(5), true, t.dv(t.id('D')), null);
select public.set_assignment(t.id('D'), t.id('S2'), t.u(6), true, t.dv(t.id('D')), 'second assessor');
select t.put('dvD', t.dv(t.id('D'))::text);
select public.open_session(t.id('D'), t.get('dvD')::int);
select t.ok((select status::text = 'open' and opened_at is not null and closes_at > now() + interval '23 hours'
  and closes_at <= now() + interval '24 hours' from public.sessions where id = t.id('D')), 'opening starts collection now with the planned window');
select t.err($$select public.open_session(t.id('D'), t.dv(t.id('D')))$$, 'invalid_state', 'cannot open twice');
select t.err($$select public.update_session_draft(t.id('D'), 'X', current_date, t.id('L1'), t.id('TVs'), 24, '09:00', t.dv(t.id('D')))$$,
  'invalid_state', 'draft details lock at opening');
select t.ok(t.audits('session.opened') = 1 and t.audits('session.draft_created') = 2, 'draft creation and opening audited');
select t.as(5);
select t.ok(t.surfaces(t.id('D')) = array[1, 2, 2, 0], 'assessor sees the opened session');
select t.ok((public.submit_assessment(t.id('D'), t.id('S2'), t.u(5), 'early', '{"taste":4}', 'good', 0, gen_random_uuid(), null) ->> 'version')::int = 1,
  'assessor submits once open');

-- ---------------------------------------------------------------- post-open scope edits
select t.as(5);
select t.err($$select public.set_roster_subject(t.id('D'), t.id('S2'), false, 'x', t.dv(t.id('D')))$$, 'forbidden', 'assessor cannot change roster');
select t.err($$select public.set_session_reviewer(t.id('D'), t.u(4), true, 'x', t.dv(t.id('D')))$$, 'forbidden', 'assessor cannot change reviewers');
select t.err($$select public.update_session_window(t.id('D'), 10, 'x', t.dv(t.id('D')))$$, 'forbidden', 'assessor cannot change the window');
select t.as(3);
select t.err($$select public.set_roster_subject(t.id('D'), t.id('S2'), false, 'x', t.dv(t.id('D')))$$, 'forbidden', 'reviewer cannot change roster');
select t.err($$select public.update_session_window(t.id('D'), 10, 'x', t.dv(t.id('D')))$$, 'forbidden', 'reviewer cannot change the window');
select t.as(2);
select t.err($$select public.set_roster_subject(t.id('D'), t.id('S2'), false, '  ', t.dv(t.id('D')))$$, 'reason_required', 'roster removal after opening needs a reason');
select t.err($$select public.set_roster_subject(t.id('D'), t.id('S2'), false, 'x', t.dv(t.id('D')) - 1)$$, 'stale_version', 'roster edit with stale version refused');
select t.err($$select public.set_session_reviewer(t.id('D'), t.u(3), false, 'x', t.dv(t.id('D')))$$, 'reviewer_required', 'last reviewer cannot be removed after opening');
select t.err($$select public.set_session_reviewer(t.id('D'), t.u(4), true, null, t.dv(t.id('D')))$$, 'reason_required', 'reviewer change after opening needs a reason');
select public.set_session_reviewer(t.id('D'), t.u(4), true, 'Second reviewer for volume', t.dv(t.id('D')));
select public.set_session_reviewer(t.id('D'), t.u(4), false, 'No longer needed', t.dv(t.id('D')));
select t.err($$select public.update_session_window(t.id('D'), 10, null, t.dv(t.id('D')))$$, 'reason_required', 'window change after opening needs a reason');
select t.err($$select public.update_session_window(t.id('D'), 200, 'x', t.dv(t.id('D')))$$, 'invalid_window', 'window bounded to 168 hours');
select public.update_session_window(t.id('D'), 30, 'Market hours extended', t.dv(t.id('D')));
select t.ok((select closes_at > now() + interval '29 hours' from public.sessions where id = t.id('D')), 'collection close moved');
select t.ok(t.audits('reviewer.added') = 2 and t.audits('reviewer.removed') = 1 and t.audits('session.window_changed') = 1,
  'scope changes audited');

-- Removal after submission keeps evidence and blocks every path.
select t.put('evBefore', (select count(*)::text from public.assessment_events where session_id = t.id('D')));
select public.set_roster_subject(t.id('D'), t.id('S2'), false, 'Vendor withdrew from the market', t.dv(t.id('D')));
reset role;
select t.ok(t.n($$select 1 from public.assessments where session_id = t.id('D') and subject_id = t.id('S2') and state = 'submitted'$$) = 1
  and (select count(*)::text from public.assessment_events where session_id = t.id('D')) = t.get('evBefore'),
  'roster removal keeps the assessment and its history');
select t.as(5);
select t.ok(t.surfaces(t.id('D')) = array[1, 1, 1, 0], 'assessor no longer reads the removed subject, assignment or assessment');
select t.ok(t.n($$select 1 from public.subjects where id = t.id('S2')$$) = 0, 'removed subject leaves the assessor subject directory');
select t.err($$select public.submit_assessment(t.id('D'), t.id('S2'), t.u(5), 'early', '{"taste":5}', null, 1, gen_random_uuid(), null)$$,
  'not_assigned', 'assessor cannot save to a removed subject');
select t.as(3);
select t.err($$select public.submit_assessment(t.id('D'), t.id('S2'), t.u(5), 'early', '{"taste":5}', null, 1, gen_random_uuid(), 'fix')$$,
  'subject_removed', 'reviewer cannot amend a removed subject');
select t.err($$select public.resolve_outcome(t.id('D'), t.id('S2'), 'early', null, t.rv(t.id('D'), t.id('S2')))$$,
  'subject_removed', 'reviewer cannot resolve a removed subject');
select t.as(1);
select t.err($$select public.create_invitation(t.id('ws'), 'g@savour.test', 'guest', false, '{}', t.id('D'), array[t.id('S2')])$$,
  'not_found%', 'no guest invitation for a removed subject');
select t.err($$select public.set_assignment(t.id('D'), t.id('S2'), t.u(6), true, t.dv(t.id('D')), 'x')$$, 'subject_removed', 'no new assignment to a removed subject');
select t.put('rep', public.get_session_report(t.id('D'), null, false, 'view')::text);
select t.ok(t.j('rep') -> 'inputs' ->> 'formula_version' = 'savour-m2.1'
  and jsonb_array_length(t.j('rep') -> 'inputs' -> 'subjects') = 1
  and t.j('rep') -> 'inputs' -> 'removed_subjects' -> 0 ->> 'reason' = 'Vendor withdrew from the market'
  and (t.j('rep') -> 'inputs' -> 'removed_subjects' -> 0 ->> 'retained_responses')::int = 1,
  'report inputs exclude the removed subject and disclose it with retained responses');
select public.set_roster_subject(t.id('D'), t.id('S2'), true, 'Vendor returned', t.dv(t.id('D')));
select t.ok((select detail ->> 'retained_responses' from public.audit_events where action = 'roster.restored') = '1',
  'restoration is audited with the number of retained responses');
select t.ok((public.get_session_report(t.id('D'), null, false, 'view') -> 'inputs' -> 'subjects' -> 1 -> 'restored' ->> 'reason') = 'Vendor returned',
  'restored subject is disclosed in report inputs');
select t.as(5);
select t.ok(t.surfaces(t.id('D')) = array[1, 2, 2, 1], 'restored subject and retained response visible again to its assessor');

-- ---------------------------------------------------------------- collection reopen and guests
select t.as(1);
select t.put('G', public.create_session(t.id('ws'), t.id('L1'), t.id('TVo'), 'Guest panel', current_date,
  array[t.id('S1'), t.id('S2')], array[t.u(5)], array[t.u(3)], 48, null)::text);
do $$
declare g integer;
begin
  foreach g in array array[21, 22, 24] loop
    perform t.put('ginv' || g, public.create_invitation(t.id('ws'), 'm2-life-fixture-' || g || '@savour.test', 'guest', false, '{}',
      t.id('G'), array[t.id('S1')]) ->> 'token');
  end loop;
end $$;
select t.as(21); select public.accept_invitation(t.get('ginv21'), 'Guest Live');
select t.as(22); select public.accept_invitation(t.get('ginv22'), 'Guest Revoked');
select t.as(24); select public.accept_invitation(t.get('ginv24'), 'Guest Unassigned');
select t.as(21);
select public.submit_assessment(t.id('G'), t.id('S1'), t.u(21), null, '{"storage":4,"safety":4}', null, 0, gen_random_uuid(), null);
select t.as(1);
select public.revoke_member(t.id('ws'), t.u(22));
select public.set_assignment(t.id('G'), t.id('S1'), t.u(24), false, t.dv(t.id('G')), 'Guest reassigned');
select t.put('oldClose', (select closes_at::text from public.sessions where id = t.id('G')));
select public.close_collection(t.id('G'));
select t.as(21);
select t.ok(t.surfaces(t.id('G')) = array[0, 0, 0, 0], 'manual close ends guest reads');
select t.as(3);
select t.err($$select public.reopen_collection(t.id('G'), 24, 'x', t.dv(t.id('G')))$$, 'forbidden', 'reviewer cannot reopen collection');
select t.as(21);
select t.err($$select public.reopen_collection(t.id('G'), 24, 'x', 1)$$, 'forbidden', 'guest cannot reopen collection');
select t.as(1);
select t.err($$select public.reopen_collection(t.id('G'), 24, '', t.dv(t.id('G')))$$, 'reason_required', 'collection reopen needs a reason');
select t.err($$select public.reopen_collection(t.id('G'), 24, 'x', null)$$, 'stale_version', 'collection reopen needs a version');
select public.reopen_collection(t.id('G'), 24, 'Late deliveries still arriving', t.dv(t.id('G')));
select t.ok((select status::text = 'open' and collection_reopens = 1 and revision = 1 from public.sessions where id = t.id('G')),
  'collection reopened explicitly (same revision)');
reset role;
select t.ok((select expires_at = (select closes_at from public.sessions where id = t.id('G')) from public.memberships where user_id = t.u(21)),
  'still-live guest grant moves with the new close');
select t.ok((select status::text = 'revoked' from public.memberships where user_id = t.u(22))
  and (select expires_at::text from public.memberships where user_id = t.u(24)) = t.get('oldClose'),
  'revoked and unassigned guests are not extended');
select t.as(21);
select t.ok(t.surfaces(t.id('G')) = array[1, 1, 1, 1], 'live guest regains access to its own scope');
select t.ok((public.submit_assessment(t.id('G'), t.id('S1'), t.u(21), null, '{"storage":5,"safety":4}', null, 1, gen_random_uuid(), null) ->> 'version')::int = 2,
  'live guest can save again after collection reopen');
select t.as(22);
select t.ok(t.surfaces(t.id('G')) = array[0, 0, 0, 0] and public.workspace_context(t.id('ws')) is null, 'revoked guest stays revoked');
select t.as(24);
select t.ok(t.surfaces(t.id('G')) = array[0, 0, 0, 0], 'guest with removed assignment gains nothing');

-- Approve, revision reopen (no guest access), collection reopen (snapshot untouched).
select t.as(1);
select public.close_collection(t.id('G'));
select public.resolve_outcome(t.id('G'), t.id('S1'), 'assessed', null, t.rv(t.id('G'), t.id('S1')));
select public.resolve_outcome(t.id('G'), t.id('S2'), 'not_assessed', 'Closed for refit', t.rv(t.id('G'), t.id('S2')));
select t.as(5);
select t.err($$select public.submit_assessment(t.id('G'), t.id('S1'), t.u(5), null, '{"storage":3,"safety":3}', null, 0, gen_random_uuid(), null)$$,
  'window_closed', 'closed collection refuses assessor saves');
select t.as(3);
select t.err($$select public.approve_session(t.id('G'), t.dv(t.id('G')))$$, 'approval_blocked', 'missing staff response blocks approval');
select public.submit_assessment(t.id('G'), t.id('S1'), t.u(5), null, '{"storage":3,"safety":3}', null, 0, gen_random_uuid(), 'Entered from paper sheet');
select t.err($$select public.approve_session(t.id('G'), t.dv(t.id('G')))$$, '%1 required response(s) missing%', 'revoked guest''s missing response still counts');
select public.set_waiver(t.id('G'), t.id('S1'), t.u(22), true, 'Guest access revoked before submitting', t.dv(t.id('G')));
select t.put('RG1', public.approve_session(t.id('G'), t.dv(t.id('G')))::text);
reset role;
select t.put('hashRG1', (select inputs_hash from public.report_revisions where id = t.id('RG1')));
select t.as(1);
select t.err($$select public.reopen_collection(t.id('G'), 24, 'x', t.dv(t.id('G')))$$, 'reopen_report_first', 'approved session cannot reopen collection directly');
select public.reopen_session(t.id('G'), 'Storage score disputed');
select t.as(21);
select t.ok(t.surfaces(t.id('G')) = array[0, 0, 0, 0], 'revision reopen alone grants guests no collection access');
select t.err($$select public.submit_assessment(t.id('G'), t.id('S1'), t.u(21), null, '{"storage":1,"safety":1}', null, 2, gen_random_uuid(), null)$$,
  'not_assigned', 'revision reopen alone refuses guest saves');
select t.as(1);
select public.reopen_collection(t.id('G'), 12, 'Re-inspect storage', t.dv(t.id('G')));
select t.ok((select status::text = 'open' and revision = 2 and current_report_id is null from public.sessions where id = t.id('G')),
  'collection reopened inside revision 2');
select t.ok((public.get_dashboard(t.id('ws')) -> 'under_revision')::text like '%' || t.get('G') || '%', 'reopened revision listed as under revision');
reset role;
select t.ok((select inputs_hash = t.get('hashRG1') and inputs_hash = encode(sha256(convert_to(inputs::text, 'UTF8')), 'hex')
  from public.report_revisions where id = t.id('RG1')), 'approved snapshot byte-identical after revision and collection reopen');
select t.as(21);
select t.ok((t.surfaces(t.id('G')))[1] = 1, 'still-live guest scope follows the reopened collection');

-- Scheduled expiry: expired grants are never revived.
select t.as(1);
select t.put('H', public.create_session(t.id('ws'), t.id('L1'), t.id('TVo'), 'Expiry panel', current_date,
  array[t.id('S1')], array[t.u(5)], array[t.u(3)], 48, null)::text);
select t.put('ginv25', public.create_invitation(t.id('ws'), 'm2-life-fixture-25@savour.test', 'guest', false, '{}', t.id('H'), array[t.id('S1')]) ->> 'token');
select t.as(25); select public.accept_invitation(t.get('ginv25'), 'Guest Expired');
reset role;
update public.sessions set opens_at = now() - interval '50 hours', closes_at = now() - interval '2 hours' where id = t.id('H');
update public.memberships set expires_at = now() - interval '2 hours' where user_id = t.u(25);
select t.as(1);
select t.err($$select public.update_session_window(t.id('H'), 24, 'x', t.dv(t.id('H')))$$, 'invalid_state', 'expired window is not silently extended');
select public.reopen_collection(t.id('H'), 24, 'Rain delay', t.dv(t.id('H')));
select t.as(25);
select t.ok(t.surfaces(t.id('H')) = array[0, 0, 0, 0] and public.workspace_context(t.id('ws')) is null,
  'schedule-expired guest is not revived by collection reopen');
select t.err($$select public.accept_invitation(t.get('ginv25'), 'Again')$$, 'invitation_used', 'consumed invitation is not renewed');
select t.as(5);
select t.ok((t.surfaces(t.id('H')))[1] = 1, 'staff assessor collects again after reopen');

-- ---------------------------------------------------------------- re-invitation after expiry (replaces scope)
select t.as(1);
select t.put('K', public.create_session(t.id('ws'), t.id('L1'), t.id('TVo'), 'Reinvite panel', current_date,
  array[t.id('S1'), t.id('S2'), t.id('S3')], array[t.u(5)], array[t.u(3)], 48, null)::text);
select t.put('again21', public.create_invitation(t.id('ws'), 'm2-life-fixture-21@savour.test', 'guest', false, '{}', t.id('G'), array[t.id('S1')]) ->> 'token');
select t.as(21);
select t.err($$select public.accept_invitation(t.get('again21'), 'Twice')$$, 'already_member', 'active unexpired guest still gets already_member');
select t.as(1);
select t.put('fresh25', public.create_invitation(t.id('ws'), 'm2-life-fixture-25@savour.test', 'guest', false, '{}', t.id('H'), array[t.id('S1')]) ->> 'token');
select t.as(25);
select t.err($$select public.accept_invitation(t.get('ginv25'), 'Old')$$, 'invitation_used', 'old consumed token still refused');
select t.ok(public.accept_invitation(t.get('fresh25'), 'Guest Renewed') = t.id('ws'), 'expired guest accepts a fresh email-bound invitation');
select t.ok(t.surfaces(t.id('H')) = array[1, 1, 1, 0], 'renewed guest reads exactly the newly granted scope');
reset role;
select t.ok((select expires_at = (select closes_at from public.sessions where id = t.id('H')) and status = 'active'
  from public.memberships where user_id = t.u(25)), 'renewed grant expires with the live session window');
update public.memberships set expires_at = now() - interval '1 minute' where user_id = t.u(25);
select t.as(1);
select t.put('move25', public.create_invitation(t.id('ws'), 'm2-life-fixture-25@savour.test', 'guest', false, '{}', t.id('K'), array[t.id('S2')]) ->> 'token');
select t.as(25);
select public.accept_invitation(t.get('move25'), 'Guest Moved');
select t.ok(t.surfaces(t.id('K')) = array[1, 1, 1, 0], 'new invitation binds the guest to the new session scope');
select t.ok(t.surfaces(t.id('H')) = array[0, 0, 0, 0] and t.surfaces(t.id('G')) = array[0, 0, 0, 0],
  'old session and unrelated sessions stay denied');
select t.err($$select public.submit_assessment(t.id('H'), t.id('S1'), t.u(25), null, '{"storage":3,"safety":3}', null, 0, gen_random_uuid(), null)$$,
  'not_assigned', 'old session assignment is inert after rebinding');
select t.err($$select public.accept_invitation(t.get('fresh21'), 'Steal')$$, 'invitation_invalid', 'unknown token refused');
select t.err($$select public.accept_invitation(t.get('again21'), 'Steal')$$, 'invitation_wrong_account', 'another guest''s invitation refused');
-- Same session, narrower scope: evidence is never silently revived or dropped.
select t.as(1);
select t.put('g26a', public.create_invitation(t.id('ws'), 'm2-life-fixture-26@savour.test', 'guest', false, '{}', t.id('K'), array[t.id('S1'), t.id('S2')]) ->> 'token');
select t.as(26);
select public.accept_invitation(t.get('g26a'), 'Guest Scoped');
select public.submit_assessment(t.id('K'), t.id('S1'), t.u(26), null, '{"storage":4,"safety":4}', null, 0, gen_random_uuid(), null);
reset role;
update public.memberships set expires_at = now() - interval '1 minute' where user_id = t.u(26);
select t.as(1);
select t.put('g26b', public.create_invitation(t.id('ws'), 'm2-life-fixture-26@savour.test', 'guest', false, '{}', t.id('K'), array[t.id('S2'), t.id('S3')]) ->> 'token');
select t.put('g26c', public.create_invitation(t.id('ws'), 'm2-life-fixture-26@savour.test', 'guest', false, '{}', t.id('K'), array[t.id('S1'), t.id('S3')]) ->> 'token');
select t.as(26);
select t.ok(t.surfaces(t.id('K')) = array[0, 0, 0, 0], 'expired guest reads nothing before re-invitation');
select t.err($$select public.accept_invitation(t.get('g26b'), 'Guest Scoped')$$, 'invitation_scope_conflict: Alpha Stall',
  'new scope that would drop a submitted response is refused, naming the subject');
select public.accept_invitation(t.get('g26c'), 'Guest Scoped');
select t.ok(t.surfaces(t.id('K')) = array[1, 2, 2, 1], 'accepted scope replaces the old one (S2 without evidence dropped, S1 response kept)');
select t.ok(t.n($$select 1 from public.session_subjects where subject_id = t.id('S2')$$) = 0, 'dropped subject no longer readable');

-- ---------------------------------------------------------------- waivers
select t.as(1);
select t.put('W', public.create_session(t.id('ws'), t.id('L1'), t.id('TVo'), 'Waiver panel', current_date,
  array[t.id('S1'), t.id('S2'), t.id('S3')], array[t.u(5), t.u(6)], array[t.u(3)], 48, null)::text);
select public.set_assignment(t.id('W'), t.id('S3'), t.u(3), true, t.dv(t.id('W')), 'Reviewer covers S3');
select public.set_assignment(t.id('W'), t.id('S3'), t.u(1), true, t.dv(t.id('W')), 'Owner covers S3');
select t.as(5);
select public.submit_assessment(t.id('W'), t.id('S1'), t.u(5), null, '{"storage":4,"safety":5}', null, 0, gen_random_uuid(), null);
select t.err($$select public.set_waiver(t.id('W'), t.id('S1'), t.u(6), true, 'x', t.dv(t.id('W')))$$, 'forbidden', 'assessor cannot waive');
select t.as(3);
select t.err($$select public.set_waiver(t.id('W'), t.id('S1'), t.u(6), true, 'Sick', t.dv(t.id('W')))$$, 'outcome_required', 'unknown outcome cannot be waived away');
select public.resolve_outcome(t.id('W'), t.id('S1'), 'assessed', null, t.rv(t.id('W'), t.id('S1')));
select t.err($$select public.set_waiver(t.id('W'), t.id('S1'), t.u(6), true, ' ', t.dv(t.id('W')))$$, 'reason_required', 'waiver needs a reason');
select t.err($$select public.set_waiver(t.id('W'), t.id('S1'), t.u(5), true, 'x', t.dv(t.id('W')))$$, 'response_present', 'submitted work cannot be waived');
select t.err($$select public.set_waiver(t.id('W'), t.id('S1'), t.u(6), true, 'x', null)$$, 'stale_version', 'waiver needs a version');
select t.err($$select public.set_waiver(t.id('W'), t.id('S1'), t.u(7), true, 'x', t.dv(t.id('W')))$$, 'not_assigned', 'only assigned work can be waived');
select public.set_waiver(t.id('W'), t.id('S1'), t.u(6), true, 'Assessor ill on the day', t.dv(t.id('W')));
select t.err($$select public.set_waiver(t.id('W'), t.id('S1'), t.u(6), true, 'again', t.dv(t.id('W')))$$, 'already_waived', 'waiver is not applied twice');
select public.resolve_outcome(t.id('W'), t.id('S3'), 'assessed', null, t.rv(t.id('W'), t.id('S3')));
select t.err($$select public.set_waiver(t.id('W'), t.id('S3'), t.u(3), true, 'mine', t.dv(t.id('W')))$$, 'own_waiver_forbidden', 'reviewer cannot waive own work');
select public.resolve_outcome(t.id('W'), t.id('S2'), 'not_assessed', 'Stall shut', t.rv(t.id('W'), t.id('S2')));
select t.err($$select public.set_waiver(t.id('W'), t.id('S2'), t.u(5), true, 'x', t.dv(t.id('W')))$$, 'waiver_not_needed', 'no waiver for a not-assessed subject');
select t.err($$select public.approve_session(t.id('W'), t.dv(t.id('W')))$$, '%Gamma Stall: 4 required response(s) missing%', 'unwaived missing responses still block approval');
select t.as(1);
select public.set_waiver(t.id('W'), t.id('S3'), t.u(1), true, 'Lead could not attend', t.dv(t.id('W')));
select public.set_waiver(t.id('W'), t.id('S3'), t.u(3), true, 'Reviewer reassigned to audit', t.dv(t.id('W')));
select public.set_waiver(t.id('W'), t.id('S3'), t.u(5), true, 'Ran out of time', t.dv(t.id('W')));
select public.set_waiver(t.id('W'), t.id('S3'), t.u(6), true, 'Ran out of time', t.dv(t.id('W')));
select t.ok(t.audits('assignment.waived') = 6, 'every waiver audited (including the owner''s own)');
select t.as(21);
select t.err($$select public.set_waiver(t.id('W'), t.id('S1'), t.u(6), false, null, 1)$$, 'forbidden', 'guest from another session cannot touch waivers');
select t.as(3);
select t.put('RW', public.approve_session(t.id('W'), t.dv(t.id('W')))::text);
reset role;
select t.put('snapW', (select inputs::text from public.report_revisions where id = t.id('RW')));
select t.ok((select (x ->> 'required_assessors')::int = 2 and (x ->> 'waived_assessors')::int = 1
    and jsonb_array_length(x -> 'assessments') = 1 and x -> 'waivers' -> 0 ->> 'reason' = 'Assessor ill on the day'
  from jsonb_array_elements(t.j('snapW') -> 'subjects') x where x ->> 'name' = 'Alpha Stall'),
  'snapshot keeps required 2, one waived, one response, and the reason');
select t.ok((select (x ->> 'required_assessors')::int = 4 and (x ->> 'waived_assessors')::int = 4 and jsonb_array_length(x -> 'assessments') = 0
  from jsonb_array_elements(t.j('snapW') -> 'subjects') x where x ->> 'name' = 'Gamma Stall'),
  'fully waived subject approves with required count intact and no responses');
select t.as(7);
select t.put('viewW', public.get_session_report(t.id('W'), null, false, 'view')::text);
select t.ok(t.get('viewW') not like '%Bimpe%' and t.get('viewW') not like '%' || t.u(6)::text || '%' and t.get('viewW') not like '%Owner%'
  and t.get('viewW') like '%Assessor ill on the day%', 'redacted report keeps waiver reasons without identities');

-- A later complete submission clears a waiver (audited).
select t.as(1);
select t.put('W2', public.create_session(t.id('ws'), t.id('L1'), t.id('TVo'), 'Waiver clear', current_date,
  array[t.id('S1')], array[t.u(5)], array[t.u(3)], 48, null)::text);
select public.resolve_outcome(t.id('W2'), t.id('S1'), 'assessed', null, t.rv(t.id('W2'), t.id('S1')));
select public.set_waiver(t.id('W2'), t.id('S1'), t.u(5), true, 'Expected absence', t.dv(t.id('W2')));
select t.as(5);
select t.ok(t.n($$select 1 from public.session_assignments where session_id = t.id('W2') and waiver_reason = 'Expected absence'$$) = 1,
  'assessor sees the waiver on their own assignment');
select public.submit_assessment(t.id('W2'), t.id('S1'), t.u(5), null, '{"storage":4,"safety":4}', null, 0, gen_random_uuid(), null);
reset role;
select t.ok(t.n($$select 1 from public.session_assignments where session_id = t.id('W2') and waived_at is not null$$) = 0
  and t.audits('assignment.waiver_cleared') = 1, 'submission clears the waiver and audits it');

-- ---------------------------------------------------------------- correction requests
select t.as(1);
select t.put('C', public.create_session(t.id('ws'), t.id('L1'), t.id('TVo'), 'Correction panel', current_date,
  array[t.id('S1'), t.id('S2')], array[t.u(5), t.u(6)], array[t.u(3)], 48, null)::text);
select t.put('ginvC', public.create_invitation(t.id('ws'), 'm2-life-fixture-23@savour.test', 'guest', false, '{}', t.id('C'), array[t.id('S1')]) ->> 'token');
select t.as(23); select public.accept_invitation(t.get('ginvC'), 'Guest C');
select t.as(5);
select public.submit_assessment(t.id('C'), t.id('S1'), t.u(5), null, '{"storage":1,"safety":1}', null, 0, gen_random_uuid(), null);
select t.as(23);
select public.submit_assessment(t.id('C'), t.id('S1'), t.u(23), null, '{"storage":3,"safety":3}', null, 0, gen_random_uuid(), null);
select t.as(5);
select t.err($$select public.request_correction(t.id('C'), t.id('S1'), t.u(23), 'x', t.dv(t.id('C')))$$, 'forbidden', 'assessor cannot request corrections');
select t.as(4);
select t.err($$select public.request_correction(t.id('C'), t.id('S1'), t.u(5), 'x', t.dv(t.id('C')))$$, 'forbidden', 'reviewer outside the session cannot request');
select t.as(10);
select t.err($$select public.request_correction(t.id('C'), t.id('S1'), t.u(5), 'x', 1)$$, 'not_found%', 'other workspace cannot request');
select t.as(3);
select t.err($$select public.request_correction(t.id('C'), t.id('S1'), t.u(6), 'x', t.dv(t.id('C')))$$, 'nothing_to_correct', 'nothing submitted, nothing to correct');
select t.err($$select public.request_correction(t.id('C'), t.id('S1'), t.u(3), 'x', t.dv(t.id('C')))$$, 'invalid_target', 'cannot request from yourself');
select t.err($$select public.request_correction(t.id('C'), t.id('S1'), t.u(5), '', t.dv(t.id('C')))$$, 'reason_required', 'correction needs a reason');
select t.err($$select public.request_correction(t.id('C'), t.id('S1'), t.u(5), 'x', null)$$, 'stale_version', 'correction needs a version');
select t.put('CR1', public.request_correction(t.id('C'), t.id('S1'), t.u(5), 'Storage 1 looks like a slip; please recheck', t.dv(t.id('C')))::text);
select t.put('CR2', public.request_correction(t.id('C'), t.id('S1'), t.u(23), 'Please add the safety N/A reason', t.dv(t.id('C')))::text);
select t.err($$select public.request_correction(t.id('C'), t.id('S1'), t.u(5), 'again', t.dv(t.id('C')))$$, 'correction_open', 'one open request per assignment');
select t.ok(t.n($$select 1 from public.correction_requests where session_id = t.id('C')$$) = 2, 'reviewer reads requests in scope');
select t.as(5);
select t.ok(t.n('select 1 from public.correction_requests') = 1, 'named assessor reads only their own request');
select t.as(6);
select t.ok(t.n('select 1 from public.correction_requests') = 0, 'other assessor reads no requests');
select public.submit_assessment(t.id('C'), t.id('S1'), t.u(6), null, '{"storage":4,"safety":4}', null, 0, gen_random_uuid(), null);
select t.as(23);
select t.ok(t.n('select 1 from public.correction_requests') = 1, 'guest reads its own request while collecting');
select t.as(7);
select t.ok(t.n('select 1 from public.correction_requests') = 0, 'viewer reads no requests');
select t.as(4);
select t.ok(t.n('select 1 from public.correction_requests') = 0, 'reviewer outside the session reads no requests');
select t.as(3);
select public.resolve_outcome(t.id('C'), t.id('S1'), 'assessed', null, t.rv(t.id('C'), t.id('S1')));
select public.resolve_outcome(t.id('C'), t.id('S2'), 'not_assessed', 'Closed', t.rv(t.id('C'), t.id('S2')));
select t.err($$select public.approve_session(t.id('C'), t.dv(t.id('C')))$$, '%correction requested%', 'open correction request blocks approval');
select t.as(5);
select public.submit_assessment(t.id('C'), t.id('S1'), t.u(5), null, '{"storage":4,"safety":4}', null, 1, gen_random_uuid(), null);
reset role;
select t.ok((select status = 'resolved' and resolution = 'resubmitted' from public.correction_requests where id = t.id('CR1')),
  'resubmission resolves the request');
select t.as(1);
select public.close_collection(t.id('C'));
select t.as(23);
select t.ok(t.n('select 1 from public.correction_requests') = 0, 'closed collection hides the guest''s request');
select t.err($$select public.submit_assessment(t.id('C'), t.id('S1'), t.u(23), null, '{"storage":3,"safety":3}', null, 1, gen_random_uuid(), null)$$,
  'not_assigned', 'closed guest collection still refuses a fresh save');
select t.as(3);
select t.err($$select public.request_correction(t.id('C'), t.id('S1'), t.u(5), 'x', t.dv(t.id('C')))$$, 'collection_closed', 'no new request after collection closes');
select t.err($$select public.withdraw_correction(t.id('CR2'), '', t.dv(t.id('C')))$$, 'reason_required', 'withdrawal needs a reason');
select t.err($$select public.withdraw_correction(t.id('CR2'), 'x', t.dv(t.id('C')) - 1)$$, 'stale_version', 'stale withdrawal refused');
select public.withdraw_correction(t.id('CR2'), 'Reviewer confirmed by phone', t.dv(t.id('C')));
select t.put('RC', public.approve_session(t.id('C'), t.dv(t.id('C')))::text);
select t.ok(t.id('RC') is not null and t.audits('correction.requested') = 2 and t.audits('correction.resolved') = 1
  and t.audits('correction.withdrawn') = 1, 'correction lifecycle audited and approval proceeds');

-- Revoked member: request refused and nothing readable.
select t.as(1);
select t.put('C2', public.create_session(t.id('ws'), t.id('L1'), t.id('TVo'), 'Revocation panel', current_date,
  array[t.id('S1')], array[t.u(6)], array[t.u(3)], 48, null)::text);
select t.as(6);
select public.submit_assessment(t.id('C2'), t.id('S1'), t.u(6), null, '{"storage":2,"safety":2}', null, 0, gen_random_uuid(), null);
select t.as(3);
select t.put('CR3', public.request_correction(t.id('C2'), t.id('S1'), t.u(6), 'Recheck', t.dv(t.id('C2')))::text);
select t.as(1);
select public.revoke_member(t.id('ws'), t.u(6));
select t.as(6);
select t.ok(t.n('select 1 from public.correction_requests') = 0, 'revoked assessor reads no requests');
select t.err($$select public.submit_assessment(t.id('C2'), t.id('S1'), t.u(6), null, '{"storage":3,"safety":3}', null, 1, gen_random_uuid(), null)$$,
  'not_found%', 'revoked assessor cannot save from an open page');
select t.as(3);
select t.err($$select public.request_correction(t.id('C2'), t.id('S1'), t.u(6), 'again', t.dv(t.id('C2')))$$, 'not_assigned', 'revoked assessor cannot receive a second request');

-- ---------------------------------------------------------------- attendance-only template
select t.as(1);
select t.put('A', public.create_session(t.id('ws'), t.id('L1'), t.id('TVa'), 'Roll call', current_date,
  array[t.id('S1'), t.id('S2')], '{}', array[t.u(3)], 48, '08:00')::text);
select public.resolve_outcome(t.id('A'), t.id('S1'), 'early', null, t.rv(t.id('A'), t.id('S1')));
select public.resolve_outcome(t.id('A'), t.id('S2'), 'absent', null, t.rv(t.id('A'), t.id('S2')));
select t.put('RA', public.approve_session(t.id('A'), t.dv(t.id('A')))::text);
reset role;
select t.ok((select jsonb_array_length(inputs -> 'template' -> 'criteria') = 0 and formula_version = 'savour-m2.1'
  from public.report_revisions where id = t.id('RA')), 'attendance-only session approves without a quality requirement');

-- ---------------------------------------------------------------- samples (all three starter packs)
select t.as(1);
select t.put('TVsup', public.publish_template(t.id('ws'), null, 'Supplier quality', 'supplier_service', 'off', '[{"key":"quality","label":"Quality"}]')::text);
select t.put('SMf', public.create_sample_session(t.id('ws'), t.id('L1'), t.id('TVs'))::text);
select t.put('SM', public.create_sample_session(t.id('ws'), t.id('L1'), t.id('TVo'))::text);
select t.put('SMs', public.create_sample_session(t.id('ws'), t.id('L1'), t.id('TVsup'))::text);
select t.put('SMs2', public.create_sample_session(t.id('ws'), t.id('L1'), t.id('TVsup'))::text);
reset role;
create function t.sample_roster(p_session uuid) returns text language sql stable as $$
  select string_agg(x.name || ':' || x.subject_type::text, ' | ' order by x.name)
  from public.session_subjects ss join public.subjects x on x.id = ss.subject_id where ss.session_id = p_session and x.is_sample $$;
select t.ok(t.sample_roster(t.id('SMf')) = 'SAMPLE - Practice vendor A:vendor | SAMPLE - Practice vendor B:vendor'
  and (select expected_ready_time = '09:00' from public.sessions where id = t.id('SMf')), 'food vendors sample: two labelled vendors, ready time set');
select t.ok(t.sample_roster(t.id('SM')) = 'SAMPLE - Practice kitchen operation:operation | SAMPLE - Practice outlet:outlet',
  'restaurant operations sample: an outlet and a kitchen operation');
select t.ok(t.sample_roster(t.id('SMs')) = 'SAMPLE - Practice service provider:service_provider | SAMPLE - Practice supplier:supplier',
  'supplier and service sample: a supplier and a service provider');
select t.ok(t.sample_roster(t.id('SMs2')) = t.sample_roster(t.id('SMs'))
  and t.n($$select 1 from public.subjects where is_sample and name like 'SAMPLE - Practice s%'$$) = 2, 'a second sample reuses the labelled sample subjects');
select t.ok((select bool_and(is_sample and status = 'open' and name like 'SAMPLE%') from public.sessions
  where id in (t.id('SMf'), t.id('SM'), t.id('SMs'), t.id('SMs2'))), 'every sample session is labelled and open');
select t.as(1);
select t.err($$select public.create_invitation(t.id('ws'), 'g@savour.test', 'guest', false, '{}', t.id('SM'),
  (select array_agg(subject_id) from public.session_subjects where session_id = t.id('SM')))$$, 'not_found%', 'samples take no guests');
select t.err($$select public.create_session(t.id('ws'), t.id('L1'), t.id('TVo'), 'Mix', current_date,
  (select array_agg(subject_id) from public.session_subjects where session_id = t.id('SM')), '{}', array[t.u(3)], 48, null)$$,
  'not_found%', 'legacy create cannot put sample subjects on a real session');
select t.err($$select public.set_roster_subject(t.id('D'), (select subject_id from public.session_subjects where session_id = t.id('SM') limit 1), true, 'mix', t.dv(t.id('D')))$$,
  'not_found%', 'roster add cannot mix sample into real');
select t.err($$select public.set_roster_subject(t.id('SM'), t.id('S3'), true, 'mix', t.dv(t.id('SM')))$$,
  'not_found%', 'roster add cannot mix real into sample');
select t.ok((public.get_setup_progress(t.id('ws')) -> 'samples' ->> 'sessions')::int = 4
  and (public.get_setup_progress(t.id('ws')) -> 'samples' ->> 'approved')::int = 0, 'setup progress reports samples separately');
select t.put('pre', public.get_setup_progress(t.id('ws'))::text);
do $$
declare s uuid;
begin
  for s in select subject_id from public.session_subjects where session_id = t.id('SM') loop
    perform public.submit_assessment(t.id('SM'), s, t.u(1), null, '{"storage":5,"safety":5}', null, 0, gen_random_uuid(), null);
    perform public.resolve_outcome(t.id('SM'), s, 'assessed', null, t.rv(t.id('SM'), s));
  end loop;
end $$;
select t.put('RSM', public.approve_session(t.id('SM'), t.dv(t.id('SM')))::text);
select t.ok((public.get_session_report(t.id('SM'), null, false, 'view') -> 'inputs' -> 'session' ->> 'is_sample')::boolean,
  'sample report inputs carry the sample label');
select t.ok((public.get_dashboard(t.id('ws')) -> 'approved')::text not like '%' || t.get('SM') || '%', 'owner dashboard excludes the approved sample');
select t.ok((public.get_setup_progress(t.id('ws')) ->> 'approved') = (t.j('pre') ->> 'approved')
  and (public.get_setup_progress(t.id('ws')) -> 'samples' ->> 'approved')::int = 1, 'activation counts exclude the sample');
select t.as(7);
select t.ok((public.get_dashboard(t.id('ws')) -> 'approved')::text not like '%' || t.get('SM') || '%', 'viewer dashboard excludes the sample');
select t.as(3);
select t.err($$select public.create_sample_session(t.id('ws'), t.id('L1'), t.id('TVo'))$$, 'forbidden', 'reviewer cannot create samples');
select t.err($$select public.get_setup_progress(t.id('ws'))$$, 'forbidden', 'reviewer has no setup progress');
reset role;
select t.err($$update public.sessions set is_sample = false where id = t.id('SM')$$, 'immutable_record', 'sample session flag immutable');
select t.err($$update public.sessions set is_sample = true where id = t.id('D')$$, 'immutable_record', 'real session cannot become a sample');

-- ---------------------------------------------------------------- drafts and cancellation
select t.as(1);
select public.cancel_session(t.id('D2'), 'Not needed');
select t.ok((select status::text from public.sessions where id = t.id('D2')) = 'cancelled', 'draft can be cancelled');
select t.err($$select public.set_roster_subject(t.id('D2'), t.id('S2'), true, null, t.dv(t.id('D2')))$$, 'session_locked', 'cancelled draft is locked');

-- ---------------------------------------------------------------- every approved snapshot untouched
reset role;
select t.ok((select bool_and(inputs_hash = encode(sha256(convert_to(inputs::text, 'UTF8')), 'hex')) from public.report_revisions),
  'every snapshot still matches its recorded hash');
select t.ok((select inputs_hash from public.report_revisions where id = t.id('RG1')) = t.get('hashRG1'), 'revision 1 of the guest panel unchanged at the end');
select t.err($$update public.report_revisions set inputs = '{}' where id = t.id('RW')$$, 'immutable_record', 'snapshots stay insert-only');

reset role;
select count(*) as passed from t.passes;
rollback;
