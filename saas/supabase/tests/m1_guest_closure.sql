-- SAVOUR Milestone 1: guest read access ends with collection (migration 20261010224854).
--
-- One transaction, ROLLED BACK. Runs as the database owner and switches to `authenticated`
-- with JWT claims, as PostgREST does:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m1_guest_closure.sql
-- Fixture user IDs use the disposable prefix eeeeeeee-0000-4000-8000-0000000001xx.
-- Any failed expectation raises 'FAIL: ...'. The final SELECT prints the pass count.

begin;

create schema t;
grant usage on schema t to authenticated, anon;
create table t.vars (k text primary key, v text);
create table t.passes (n integer generated always as identity, msg text);
grant all on t.vars, t.passes to authenticated, anon;

create function t.u(n integer) returns uuid language sql immutable as
$$ select ('eeeeeeee-0000-4000-8000-' || lpad((100 + n)::text, 12, '0'))::uuid $$;
create function t.as(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', t.u(n), 'role', 'authenticated')::text, true);
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

-- Counts every guest read surface for one session in a single row of six numbers.
create function t.surfaces(p_session uuid) returns integer[] language plpgsql as $$
declare
  v_subjects integer;
begin
  select count(*) into v_subjects from public.subjects s
  where s.id in (select subject_id from t.roster where session_id = p_session);
  return array[
    (select count(*) from public.sessions where id = p_session)::integer,
    (select count(*) from public.session_subjects where session_id = p_session)::integer,
    v_subjects,
    (select count(*) from public.template_versions where id = t.id('TV'))::integer,
    (select count(*) from public.session_assignments where session_id = p_session)::integer,
    (select count(*) from public.assessments where session_id = p_session)::integer];
end $$;
-- Roster copy readable by the test helper regardless of the caller's RLS.
create table t.roster (session_id uuid, subject_id uuid);
grant select, insert on t.roster to authenticated;

-- Users: 1 owner, 3 reviewer (L1), 5 staff assessor (L1), 21..24 guests (one per session).
insert into auth.users (id, email, email_confirmed_at)
select t.u(n), 'm1-guest-fixture-' || n || '@savour.test', now()
from unnest(array[1, 3, 5, 21, 22, 23, 24]) n;

-- ---------------------------------------------------------------- tenant setup
select t.as(1);
select t.put('ws', public.create_workspace('Guest Closure QA', 'Nigeria', 'Africa/Lagos', 'Owner')::text);
select t.put('L1', public.upsert_location(t.id('ws'), null, 'Main', false)::text);
select t.put('S1', public.upsert_subject(t.id('ws'), null, 'Early Vendor', 'vendor', false)::text);
select t.put('S2', public.upsert_subject(t.id('ws'), null, 'Other Vendor', 'vendor', false)::text);
select t.put('TV', public.publish_template(t.id('ws'), null, 'Panel', 'food_vendors', 'scored',
  '[{"key":"taste","label":"Taste"}]')::text);
select t.put('inv_rev', public.create_invitation(t.id('ws'), 'm1-guest-fixture-3@savour.test', 'reviewer', false, array[t.id('L1')], null, null) ->> 'token');
select t.put('inv_as', public.create_invitation(t.id('ws'), 'm1-guest-fixture-5@savour.test', 'assessor', false, array[t.id('L1')], null, null) ->> 'token');
select t.as(3); select public.accept_invitation(t.get('inv_rev'), 'Rita Reviewer');
select t.as(5); select public.accept_invitation(t.get('inv_as'), 'Sam Staff');

-- Four sessions, each with roster S1+S2, staff assessor 5, reviewer 3; one guest each (S1 only).
select t.as(1);
do $$
declare k text; g integer; i integer := 0;
begin
  foreach k in array array['A', 'B', 'C', 'D'] loop
    i := i + 1;
    perform t.put(k, public.create_session(t.id('ws'), t.id('L1'), t.id('TV'), 'Session ' || k, current_date,
      array[t.id('S1'), t.id('S2')], array[t.u(5)], array[t.u(3)], 48, '09:00')::text);
    g := 20 + i;
    perform t.put('inv_' || k, public.create_invitation(t.id('ws'), 'm1-guest-fixture-' || g || '@savour.test',
      'guest', false, '{}', t.id(k), array[t.id('S1')]) ->> 'token');
    insert into t.roster values (t.id(k), t.id('S1')), (t.id(k), t.id('S2'));
  end loop;
end $$;
select t.as(21); select public.accept_invitation(t.get('inv_A'), 'Guest A');
select t.as(22); select public.accept_invitation(t.get('inv_B'), 'Guest B');
select t.as(23); select public.accept_invitation(t.get('inv_C'), 'Guest C');
select t.as(24); select public.accept_invitation(t.get('inv_D'), 'Guest D');

-- ---------------------------------------------------------------- baseline while collecting
-- surfaces = [sessions, roster rows, subjects, template versions, assignments, assessments]
select t.as(21);
select public.submit_assessment(t.id('A'), t.id('S1'), t.u(21), 'early', '{"taste":4}', 'guest note', 0, gen_random_uuid(), null);
select t.ok(t.surfaces(t.id('A')) = array[1, 1, 1, 1, 1, 1], 'open session: guest reads its one subject, template, assignment and own assessment');
select t.ok(t.surfaces(t.id('B')) = array[0, 0, 1, 1, 0, 0],
  'guest cannot read another session; shared subject S1 and template stay visible only through its own open session A');
select t.as(23);
select public.submit_assessment(t.id('C'), t.id('S1'), t.u(23), 'early', '{"taste":3}', null, 0, gen_random_uuid(), null);
select t.ok(t.surfaces(t.id('C')) = array[1, 1, 1, 1, 1, 1], 'open session C: guest has full read scope');
select t.as(24);
select t.ok(t.surfaces(t.id('D')) = array[1, 1, 1, 1, 1, 0], 'open session D: guest reads scope before submitting');
select t.as(5);
select public.submit_assessment(t.id('A'), t.id('S1'), t.u(5), 'early', '{"taste":5}', null, 0, gen_random_uuid(), null);
select public.submit_assessment(t.id('A'), t.id('S2'), t.u(5), 'late', '{"taste":2}', null, 0, gen_random_uuid(), null);

-- ---------------------------------------------------------------- path 1: manual close
select t.as(1);
select public.close_collection(t.id('A'));
select t.as(21);
select t.ok(t.surfaces(t.id('A')) = array[0, 0, 0, 0, 0, 0], 'manual close: guest loses every read surface, including own assessment');
select t.err($$select public.submit_assessment(t.id('A'), t.id('S1'), t.u(21), 'early', '{"taste":5}', null, 1, gen_random_uuid(), null)$$,
  'not_assigned', 'manual close: guest save refused');
select t.err($$select public.get_session_report(t.id('A'), null, false, 'view')$$, 'forbidden', 'manual close: guest still has no report');
select t.as(5);
select t.ok(t.n($$select 1 from public.sessions where id = t.id('A')$$) = 1
  and t.n($$select 1 from public.assessments where session_id = t.id('A')$$) = 2
  and t.n($$select 1 from public.subjects$$) = 2,
  'manual close: staff assessor read access unchanged (session, own assessments, subjects)');
select t.as(3);
select t.ok(t.n($$select 1 from public.assessments where session_id = t.id('A') and assessor_id = t.u(21) and notes = 'guest note'$$) = 1,
  'manual close: reviewer still reads the guest assessment');
select t.ok(t.n($$select 1 from public.session_assignments where session_id = t.id('A') and user_id = t.u(21)$$) = 1,
  'manual close: reviewer still sees the guest assignment');
select t.ok((public.get_session_report(t.id('A'), null, false, 'view') -> 'inputs' -> 'subjects')::text like '%Guest A%',
  'manual close: provisional report includes the guest response');
select t.ok((select (x ->> 'required_assessors')::int from jsonb_array_elements(
    public.get_session_report(t.id('A'), null, false, 'view') -> 'inputs' -> 'subjects') x
  where x ->> 'subject_id' = t.get('S1')) = 2, 'manual close: guest still counts as a required assessor');
select public.resolve_outcome(t.id('A'), t.id('S1'), 'early', null, 1);
select public.resolve_outcome(t.id('A'), t.id('S2'), 'late', null, 1);
select t.put('RA', public.approve_session(t.id('A'), (select data_version from public.sessions where id = t.id('A')))::text);
reset role;
select t.ok((select jsonb_array_length(x -> 'assessments') from public.report_revisions r,
    jsonb_array_elements(r.inputs -> 'subjects') x
  where r.id = t.id('RA') and x ->> 'subject_id' = t.get('S1')) = 2,
  'approved snapshot keeps both the staff and the guest response');
select t.as(21);
select t.ok(t.surfaces(t.id('A')) = array[0, 0, 0, 0, 0, 0], 'after approval: guest still denied');
select t.as(1);
select public.reopen_session(t.id('A'), 'QA reopen');
select t.as(21);
select t.ok(t.surfaces(t.id('A')) = array[0, 0, 0, 0, 0, 0], 'after reopen (in review, collection not reopened): guest still denied');
select t.as(3);
select t.ok(public.get_session_report(t.id('A'), 1, false, 'view') -> 'meta' ->> 'status' = 'approved'
  and (public.get_session_report(t.id('A'), 1, false, 'view') -> 'inputs')::text like '%Guest A%',
  'reviewer can still read the approved revision containing the guest response');

-- ---------------------------------------------------------------- path 2: approval while open
select t.as(3);
select public.resolve_outcome(t.id('B'), t.id('S1'), 'early', null, 1);
select public.resolve_outcome(t.id('B'), t.id('S2'), 'absent', null, 1);
select t.as(5);
select public.submit_assessment(t.id('B'), t.id('S1'), t.u(5), 'early', '{"taste":4}', null, 0, gen_random_uuid(), null);
select t.as(3);
select t.err($$select public.approve_session(t.id('B'), (select data_version from public.sessions where id = t.id('B')))$$,
  'approval_blocked', 'missing guest response still blocks approval (coverage not dropped)');
select public.submit_assessment(t.id('B'), t.id('S1'), t.u(22), null, '{"taste":3}', null, 0, gen_random_uuid(), 'Recorded from guest paper form');
select public.approve_session(t.id('B'), (select data_version from public.sessions where id = t.id('B')));
select t.as(22);
select t.ok(t.surfaces(t.id('B')) = array[0, 0, 0, 0, 0, 0], 'approval while open: guest loses every read surface');

-- ---------------------------------------------------------------- path 3: cancellation
select t.as(1);
select public.cancel_session(t.id('C'), 'QA cancel');
select t.as(23);
select t.ok(t.surfaces(t.id('C')) = array[0, 0, 0, 0, 0, 0], 'cancellation: guest loses every read surface');
select t.as(3);
select t.ok(t.n($$select 1 from public.assessments where session_id = t.id('C') and assessor_id = t.u(23)$$) = 1,
  'cancellation: reviewer keeps the guest evidence');

-- ---------------------------------------------------------------- path 4: scheduled expiry
-- Move only the session window into the past; keep the guest membership unexpired so the new
-- session check alone is what denies access.
reset role;
update public.sessions set opens_at = now() - interval '50 hours', closes_at = now() - interval '2 hours'
where id = t.id('D');
update public.memberships set expires_at = now() + interval '1 day' where user_id = t.u(24);
select t.as(24);
select t.ok(t.surfaces(t.id('D')) = array[0, 0, 0, 0, 0, 0], 'scheduled expiry (status still open): guest loses every read surface');
select t.as(5);
select t.ok(t.n($$select 1 from public.sessions where id = t.id('D')$$) = 1, 'scheduled expiry: staff assessor still sees the session');
select t.as(3);
select t.ok(t.n($$select 1 from public.session_assignments where session_id = t.id('D') and user_id = t.u(24)$$) = 1,
  'scheduled expiry: reviewer still sees the guest assignment');

reset role;
select count(*) as passed from t.passes;
rollback;
