-- SAVOUR Milestone 3: analytics source RPC (migration 20261011144337).
--
-- One transaction, ROLLED BACK. Runs as the database owner and switches to `authenticated` with JWT
-- claims, as PostgREST does:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m3_analytics.sql
-- Fixture user IDs use the disposable prefix eeeeeeee-0000-4000-8000-0000000007xx.
-- The arithmetic over this dataset is tested in tests/unit/analytics.test.ts and end to end in
-- tests/sql/analytics.test.ts (same RPC, same aggregator as the page, CSV and PDF).

begin;

create schema t;
grant usage on schema t to authenticated, anon;
create table t.vars (k text primary key, v text);
create table t.passes (n integer generated always as identity, msg text);
grant all on t.vars, t.passes to authenticated, anon;

create function t.u(n integer) returns uuid language sql immutable as
$$ select ('eeeeeeee-0000-4000-8000-' || lpad((700 + n)::text, 12, '0'))::uuid $$;
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
create function t.dv(p_session uuid) returns integer language sql security definer as
$$ select data_version from public.sessions where id = p_session $$;
create function t.rv(p_session uuid, p_subject uuid) returns integer language sql security definer as
$$ select version from public.session_subjects where session_id = p_session and subject_id = p_subject $$;
create function t.audits(p_action text) returns bigint language sql security definer as
-- Scope assertions to this disposable fixture, so existing QA/demo audit rows cannot affect them.
$$ select count(*) from public.audit_events where action = p_action and workspace_id = t.id('ws') $$;
create function t.today() returns date language sql security definer as
$$ select private.workspace_today((select v::uuid from t.vars where k = 'ws')) $$;
create function t.score(p_session uuid, p_subject uuid, p_assessor integer, p_answers jsonb) returns jsonb language sql as
$$ select public.submit_assessment(p_session, p_subject, t.u(p_assessor), null, p_answers, null,
     coalesce((select version from public.assessments where session_id = p_session and subject_id = p_subject
               and assessor_id = t.u(p_assessor)), 0), gen_random_uuid(), null) $$;
-- Analytics as the current caller.
create function t.an(p_mode text, p_filters jsonb) returns jsonb language sql as
$$ select public.get_analytics((select v::uuid from t.vars where k = 'ws'), p_mode, p_filters, 'view') $$;
create function t.sessions(p jsonb) returns text[] language sql immutable as
$$ select coalesce(array_agg(r ->> 'session_id' order by r ->> 'session_id'), '{}') from jsonb_array_elements(p -> 'records') r $$;
grant execute on all functions in schema t to authenticated;

-- 1 owner, 3 reviewer (L1, on sessions), 5 assessor (L1), 7 viewer (L1 only), 9 guest, 10 owner B.
insert into auth.users (id, email, email_confirmed_at)
select t.u(n), 'm3-ana-fixture-' || n || '@savour.test', now() from unnest(array[1, 3, 5, 7, 9, 10]) n;

select t.as(1);
select t.put('ws', public.create_workspace('Analytics QA', 'Nigeria', 'Africa/Lagos', 'Owner')::text);
-- M4 fixture: uncapped trial. This pre-M4 script intentionally exercises more than the SAVOUR trial
-- limits, so the database owner lifts them for its own disposable workspace inside this rolled-back
-- transaction (billing.fixture_uncap_trial: owner-only, audited, no runtime path). Assertion count unchanged.
reset role; set local savour.fixture_mode = 'disposable'; select billing.fixture_uncap_trial(t.id('ws')); select t.as(1);
select t.put('L1', public.upsert_location(t.id('ws'), null, 'Main', false)::text);
select t.put('L2', public.upsert_location(t.id('ws'), null, 'Annex', false)::text);
select t.put('S1', public.upsert_subject(t.id('ws'), null, 'Alpha Stall', 'vendor', false)::text);
select t.put('S2', public.upsert_subject(t.id('ws'), null, 'Beta Stall', 'vendor', false)::text);
select t.put('CAT', public.save_category(t.id('ws'), null, 'Grills', false, null) ->> 'id');
select public.save_subject(t.id('ws'), t.id('S1'), 'Alpha Stall', 'vendor', t.id('CAT'), null, '{}', false, 1);
select t.put('TV', public.publish_template(t.id('ws'), null, 'Food panel', 'food_vendors', 'off',
  '[{"key":"taste","label":"Taste","critical":true},{"key":"hygiene","label":"Hygiene","allow_na":true}]', null)::text);
do $$
declare r record;
begin
  for r in select * from (values (3, 'reviewer'), (5, 'assessor'), (7, 'viewer')) v (n, role) loop
    perform t.put('inv' || r.n, public.create_invitation(t.id('ws'), 'm3-ana-fixture-' || r.n || '@savour.test',
      r.role::public.member_role, false, array[t.id('L1')], null, null) ->> 'token');
  end loop;
end $$;
select t.as(3); select public.accept_invitation(t.get('inv3'), 'Rita Reviewer');
select t.as(5); select public.accept_invitation(t.get('inv5'), 'Ayo Assessor');
select t.as(7); select public.accept_invitation(t.get('inv7'), 'Vic Viewer');

-- A1: approved at L1 (reviewer 3). A2: approved at L2 (owner only). Sample: approved. P1: open at L1.
select t.as(1);
select t.put('A1', public.create_session(t.id('ws'), t.id('L1'), t.id('TV'), 'Main panel', current_date - 3,
  array[t.id('S1'), t.id('S2')], array[t.u(5)], array[t.u(3)], 48, null)::text);
select t.put('A2', public.create_session(t.id('ws'), t.id('L2'), t.id('TV'), 'Annex panel', current_date - 2,
  array[t.id('S1')], array[t.u(1)], array[t.u(1)], 48, null)::text);
select t.put('P1', public.create_session(t.id('ws'), t.id('L1'), t.id('TV'), 'Open panel', current_date,
  array[t.id('S1')], array[t.u(5)], array[t.u(3)], 48, null)::text);
select t.put('SM', public.create_sample_session(t.id('ws'), t.id('L1'), t.id('TV'))::text);
select t.put('D', public.create_session_draft(t.id('ws'), t.id('L1'), t.id('TV'), 'Draft', current_date, array[t.id('S1')],
  array[t.u(5)], array[t.u(3)], 24, null)::text);
select t.score(t.id('A2'), t.id('S1'), 1, '{"taste":4,"hygiene":4}');
select public.resolve_outcome(t.id('A2'), t.id('S1'), 'assessed', null, t.rv(t.id('A2'), t.id('S1')));
select public.approve_session(t.id('A2'), t.dv(t.id('A2')));
do $$
declare r record;
begin
  for r in select subject_id from public.session_subjects where session_id = t.id('SM') loop
    perform t.score(t.id('SM'), r.subject_id, 1, '{"taste":1,"hygiene":1}');
    perform public.resolve_outcome(t.id('SM'), r.subject_id, 'assessed', null, t.rv(t.id('SM'), r.subject_id));
  end loop;
end $$;
select public.approve_session(t.id('SM'), t.dv(t.id('SM')));
select t.as(5);
select t.score(t.id('A1'), t.id('S1'), 5, '{"taste":2,"hygiene":4}');
select t.score(t.id('A1'), t.id('S2'), 5, '{"taste":5,"hygiene":{"na":"Closed"}}');
select t.score(t.id('P1'), t.id('S1'), 5, '{"taste":3,"hygiene":3}');
select t.as(3);
select public.confirm_na(t.id('A1'), t.id('S2'), t.u(5), 1);
select public.resolve_outcome(t.id('A1'), t.id('S1'), 'assessed', null, t.rv(t.id('A1'), t.id('S1')));
select public.resolve_outcome(t.id('A1'), t.id('S2'), 'assessed', null, t.rv(t.id('A1'), t.id('S2')));
select public.approve_session(t.id('A1'), t.dv(t.id('A1')));
select public.create_action((select id from public.findings where session_id = t.id('A1') and kind = 'generated'),
  'Undercooked', 'Retrain', 'critical', t.u(5), t.today() + 3, gen_random_uuid());

-- ---------------------------------------------------------------- scope and samples
select t.as(1);
select t.put('own', t.an('approved', '{}')::text);
select t.ok(t.sessions(t.j('own')) = (select array_agg(x order by x) from unnest(array[t.get('A1'), t.get('A2')]) x),
  'owner sees both approved real sessions and never the sample');
select t.ok(t.j('own') ->> 'mode' = 'approved' and (select bool_and(r ->> 'mode' = 'approved') from jsonb_array_elements(t.j('own') -> 'records') r),
  'every record is labelled approved');
select t.ok((t.j('own') ->> 'total')::int = 2 and not (t.j('own') ->> 'truncated')::boolean, 'totals exclude samples, drafts and open sessions');
select t.ok(t.j('own')::text not like '%' || t.u(5) || '%' and t.j('own')::text not like '%Ayo Assessor%'
  and (select bool_and((r -> 'inputs' ->> 'redacted')::boolean) from jsonb_array_elements(t.j('own') -> 'records') r),
  'analytics inputs are redacted even for the owner');
select t.ok(jsonb_array_length(t.j('own') -> 'findings') = 1 and t.j('own') -> 'findings' -> 0 ->> 'severity' = 'critical'
  and (t.j('own') -> 'findings' -> 0 ->> 'current')::boolean and (t.j('own') ->> 'live_flags_visible')::boolean,
  'owner receives the open critical finding with its current flag');
select t.ok(jsonb_array_length(t.j('own') -> 'actions') = 1 and not (t.j('own') -> 'actions' -> 0) ? 'assignee_id'
  and not (t.j('own') -> 'actions' -> 0) ? 'assignee_label' and t.j('own') -> 'actions' -> 0 ->> 'due_state' = 'upcoming',
  'unfinished actions carry due state but no assignee identity');
select t.ok(jsonb_array_length(t.j('own') -> 'options' -> 'locations') = 2 and jsonb_array_length(t.j('own') -> 'options' -> 'template_versions') = 1
  and t.j('own') -> 'options' -> 'packs' = '["food_vendors"]'::jsonb, 'filter options come from the authorized dataset');
select t.ok(t.sessions(t.an('approved', jsonb_build_object('location_id', t.get('L2')))) = array[t.get('A2')], 'location filter');
select t.ok(t.sessions(t.an('approved', jsonb_build_object('from', (current_date - 2)::text))) = array[t.get('A2')], 'from filter');
select t.ok(t.sessions(t.an('approved', jsonb_build_object('to', (current_date - 3)::text))) = array[t.get('A1')], 'to filter');
select t.ok(t.sessions(t.an('approved', '{"pack":"restaurant_ops"}')) = '{}', 'pack filter');
select t.ok(t.sessions(t.an('approved', jsonb_build_object('template_version_id', t.get('TV')))) = t.sessions(t.j('own')), 'template version filter');
select t.ok(t.sessions(t.an('approved', jsonb_build_object('location_id', (select location_id::text from public.sessions where id = t.id('SM'))))) <> array[t.get('SM')],
  'no filter can select the sample');
select t.err($$select t.an('approved', '{"is_sample":"true"}')$$, 'invalid_filter%', 'unknown filter keys are refused (no sample switch exists)');
select t.err($$select t.an('approved', '{"from":"not a date"}')$$, 'invalid_filter%', 'invalid date refused');
select t.err($$select t.an('approved', '{"from":"2026-10-10","to":"2026-10-01"}')$$, 'invalid_filter%', 'from after to refused');
select t.err($$select t.an('approved', '{"subject_type":"robot"}')$$, 'invalid_filter%', 'invalid subject type refused');
select t.err($$select t.an('approved', '{"location_id":5}')$$, 'invalid_filter%', 'non-text filter refused');
select t.err($$select t.an('everything', '{}')$$, 'invalid_mode', 'unknown mode refused');
select t.err($$select public.get_analytics(t.id('ws'), 'approved', '{}', 'print')$$, 'invalid_purpose', 'unknown purpose refused');

-- ---------------------------------------------------------------- provisional mode is separate
select t.put('prov', t.an('provisional', '{}')::text);
select t.ok(t.sessions(t.j('prov')) = array[t.get('P1')] and (select bool_and(r ->> 'mode' = 'provisional' and r ->> 'approved_at' is null)
  from jsonb_array_elements(t.j('prov') -> 'records') r), 'provisional mode returns only live open sessions, labelled provisional');
select t.ok(t.j('prov') -> 'records' -> 0 -> 'inputs' ->> 'formula_version' = 'savour-m3.1'
  and jsonb_array_length(t.j('prov') -> 'findings') = 0 and not (t.j('prov') ->> 'live_flags_visible')::boolean,
  'provisional records are live inputs and carry no attention flags');

-- ---------------------------------------------------------------- roles
select t.as(3);
select t.ok(t.sessions(t.an('approved', '{}')) = array[t.get('A1')], 'reviewer sees only sessions they review');
select t.ok(t.sessions(t.an('provisional', '{}')) = array[t.get('P1')], 'reviewer may use provisional mode');
select t.as(7);
select t.put('view', t.an('approved', '{}')::text);
select t.ok(t.sessions(t.j('view')) = array[t.get('A1')], 'viewer sees approved sessions in their locations only');
select t.ok(jsonb_array_length(t.j('view') -> 'findings') = 0 and jsonb_array_length(t.j('view') -> 'actions') = 0
  and not (t.j('view') ->> 'live_flags_visible')::boolean, 'viewer gets no live findings or actions');
select t.ok(t.get('view') not like '%' || t.u(5) || '%' and t.get('view') not like '%Ayo Assessor%', 'viewer analytics carry no identities');
select t.err($$select t.an('provisional', '{}')$$, 'forbidden', 'viewer cannot use provisional mode');
select t.as(5);
select t.err($$select t.an('approved', '{}')$$, 'forbidden', 'assessor cannot read analytics');
select t.as(10);
select public.create_workspace('Analytics QA', 'Nigeria', 'Africa/Lagos', 'Owner B');
select t.err($$select t.an('approved', '{}')$$, 'not_found%', 'another business cannot read analytics');

-- ---------------------------------------------------------------- historical labels and annotations
select t.as(1);
select public.save_category(t.id('ws'), t.id('CAT'), 'Barbecue', true, 1);
select public.save_subject(t.id('ws'), t.id('S2'), 'Beta Kitchen', 'vendor', null, null, '{}', false,
  (select (s ->> 'version')::int from jsonb_array_elements(public.get_subject_directory(t.id('ws')) -> 'subjects') s where s ->> 'id' = t.get('S2')));
select t.put('own2', t.an('approved', jsonb_build_object('location_id', t.get('L1')))::text);
select t.ok((select s ->> 'category_name' = 'Grills' and s ->> 'category_id' = t.get('CAT')
  from jsonb_array_elements(t.j('own2') -> 'records' -> 0 -> 'inputs' -> 'subjects') s where s ->> 'subject_id' = t.get('S1')),
  'renamed and archived category keeps its approval-time name in the snapshot');
select t.ok((select c ->> 'name' = 'Barbecue' and (c ->> 'archived')::boolean from jsonb_array_elements(t.j('own2') -> 'categories_now') c),
  'current category name and archive state are returned for annotation only');
select t.ok((select s ->> 'name' = 'Beta Stall' from jsonb_array_elements(t.j('own2') -> 'records' -> 0 -> 'inputs' -> 'subjects') s
    where s ->> 'subject_id' = t.get('S2'))
  and (select s ->> 'name' = 'Beta Kitchen' from jsonb_array_elements(t.j('own2') -> 'subjects_now') s where s ->> 'id' = t.get('S2')),
  'renamed subject keeps its approval-time name; the current name is annotation');

-- ---------------------------------------------------------------- exports are audited with their filters
select t.ok((public.get_analytics(t.id('ws'), 'approved', jsonb_build_object('location_id', t.get('L1')), 'csv') ->> 'total')::int = 1,
  'csv purpose returns the same dataset');
reset role;
select t.ok(t.audits('analytics.exported') = 1 and (select detail -> 'filters' ->> 'location_id' = t.get('L1') and detail ->> 'format' = 'csv'
  from public.audit_events where action = 'analytics.exported' and workspace_id = t.id('ws')), 'analytics export is audited with format and filters');
select t.ok(t.audits('analytics.exported') = 1, 'viewing analytics is not audited as an export');

select count(*) as passed from t.passes;
rollback;
