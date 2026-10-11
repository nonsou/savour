-- SAVOUR Milestone 3: template triggers, findings, corrective actions, inbox, frozen action snapshots
-- and the dated appendix (migrations 20261011144333 and 20261011144335).
--
-- One transaction, ROLLED BACK. Runs as the database owner and switches to `authenticated` with JWT
-- claims, as PostgREST does:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m3_actions.sql
-- Fixture user IDs use the disposable prefix eeeeeeee-0000-4000-8000-0000000006xx.
-- Any failed expectation raises 'FAIL: ...'. The final SELECT prints the pass count.
-- Sequential only: version, idempotency and lock-order contracts are checked here; real overlapping
-- transactions need two independent connections (see docs/milestone-3/developer-report.md).
-- Two fixture steps run as the database owner to simulate the passage of time (an action whose due
-- date has passed); they are marked "fixture time travel".

begin;

create schema t;
grant usage on schema t to authenticated, anon;
create table t.vars (k text primary key, v text);
create table t.passes (n integer generated always as identity, msg text);
create table t.pins (id uuid primary key, h text, body text);
grant all on t.vars, t.passes to authenticated, anon;

create function t.u(n integer) returns uuid language sql immutable as
$$ select ('eeeeeeee-0000-4000-8000-' || lpad((600 + n)::text, 12, '0'))::uuid $$;
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
create function t.n(p_sql text) returns bigint language plpgsql as $$
declare v bigint;
begin execute 'select count(*) from (' || p_sql || ') q' into v; return v; end $$;
-- Owner-side helpers (SECURITY DEFINER as the database owner, so they ignore RLS).
create function t.dv(p_session uuid) returns integer language sql security definer as
$$ select data_version from public.sessions where id = p_session $$;
create function t.rv(p_session uuid, p_subject uuid) returns integer language sql security definer as
$$ select version from public.session_subjects where session_id = p_session and subject_id = p_subject $$;
create function t.av(p uuid) returns integer language sql security definer as $$ select version from public.actions where id = p $$;
create function t.ast(p uuid) returns text language sql security definer as $$ select status from public.actions where id = p $$;
create function t.fv(p uuid) returns integer language sql security definer as $$ select version from public.findings where id = p $$;
create function t.events(p uuid) returns bigint language sql security definer as
$$ select count(*) from public.action_events where action_id = p $$;
create function t.audits(p_action text) returns bigint language sql security definer as
-- Scope assertions to this disposable fixture, so existing QA/demo audit rows cannot affect them.
$$ select count(*) from public.audit_events where action = p_action and workspace_id in (t.id('ws'), t.id('wsB')) $$;
create function t.inbox(p_user integer, p_kind text) returns bigint language sql security definer as
$$ select count(*) from public.notifications where recipient_id = t.u(p_user) and (p_kind is null or kind = p_kind) $$;
create function t.nid(p_user integer, p_kind text) returns uuid language sql security definer as
$$ select id from public.notifications where recipient_id = t.u(p_user) and kind = p_kind order by created_at limit 1 $$;
create function t.today() returns date language sql security definer as
$$ select private.workspace_today((select v::uuid from t.vars where k = 'ws')) $$;
create function t.wtoday(p_ws uuid) returns date language sql security definer as $$ select private.workspace_today(p_ws) $$;
create function t.finding(p_session uuid, p_subject uuid, p_key text, p_revision integer) returns uuid language sql security definer as
$$ select id from public.findings where session_id = p_session and subject_id = p_subject and criterion_key = p_key
   and kind = 'generated' and revision = p_revision $$;
create function t.generated(p_session uuid) returns bigint language sql security definer as
$$ select count(*) from public.findings where session_id = p_session and kind = 'generated' $$;
create function t.rr(p_session uuid, p_revision integer) returns public.report_revisions language sql security definer as
$$ select * from public.report_revisions where session_id = p_session and revision = p_revision $$;
create function t.pin() returns void language sql security definer as $$
  insert into t.pins select id, inputs_hash, encode(sha256(convert_to(inputs::text, 'UTF8')), 'hex') from public.report_revisions
  on conflict (id) do nothing
$$;
create function t.pins_ok() returns boolean language sql security definer as $$
  select (select count(*) from t.pins) > 0 and not exists (
    select 1 from t.pins p left join public.report_revisions r on r.id = p.id
    where r.id is null or r.inputs_hash <> p.h or encode(sha256(convert_to(r.inputs::text, 'UTF8')), 'hex') <> p.body
      or r.inputs_hash <> p.body)
$$;
-- One state transition with the action's current version and a fresh idempotency key.
create function t.tr(p_action uuid, p_cmd text, p_evidence text, p_reason text) returns jsonb language sql as
$$ select public.transition_action(p_action, p_cmd, t.av(p_action), p_evidence, p_reason, gen_random_uuid()) $$;
-- Complete-response helper for an assigned assessor (caller must be that assessor).
create function t.score(p_session uuid, p_subject uuid, p_assessor integer, p_observed public.subject_outcome, p_answers jsonb)
returns jsonb language sql as
$$ select public.submit_assessment(p_session, p_subject, t.u(p_assessor), p_observed, p_answers, null,
     coalesce((select version from public.assessments where session_id = p_session and subject_id = p_subject
               and assessor_id = t.u(p_assessor)), 0), gen_random_uuid(), null) $$;
grant execute on all functions in schema t to authenticated;

-- Users: 1 owner A, 2 admin A, 3 reviewer A (L1, on sessions), 4 reviewer A (L1, not on sessions),
-- 5 and 6 assessors A (L1), 7 viewer A (L1), 8 assessor A (L2 only), 9 guest A, 10 owner B,
-- 12 assessor A (L1, never on a roster: holds an action only).
insert into auth.users (id, email, email_confirmed_at)
select t.u(n), 'm3-act-fixture-' || n || '@savour.test', now()
from unnest(array[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]) n;

-- ---------------------------------------------------------------- setup (two businesses, same labels)
select t.as(1);
select t.put('ws', public.create_workspace('Same Labels QA', 'Nigeria', 'Africa/Lagos', 'Owner')::text);
select t.put('L1', public.upsert_location(t.id('ws'), null, 'Main', false)::text);
select t.put('L2', public.upsert_location(t.id('ws'), null, 'Annex', false)::text);
select t.put('S1', public.upsert_subject(t.id('ws'), null, 'Alpha Stall', 'vendor', false)::text);
select t.put('S2', public.upsert_subject(t.id('ws'), null, 'Beta Stall', 'vendor', false)::text);
select t.put('S3', public.upsert_subject(t.id('ws'), null, 'Gamma Kitchen', 'operation', false)::text);
select t.put('S4', public.upsert_subject(t.id('ws'), null, 'Delta Supplies', 'supplier', false)::text);
select t.put('CAT', public.save_category(t.id('ws'), null, 'Grills', false, null) ->> 'id');
select public.save_subject(t.id('ws'), t.id('S1'), 'Alpha Stall', 'vendor', t.id('CAT'), null, '{}', false, 1);
do $$
declare r record;
begin
  for r in select * from (values (2, 'admin', true, null::text), (3, 'reviewer', false, 'L1'), (4, 'reviewer', false, 'L1'),
      (5, 'assessor', false, 'L1'), (6, 'assessor', false, 'L1'), (7, 'viewer', false, 'L1'), (8, 'assessor', false, 'L2'),
      (12, 'assessor', false, 'L1')) v (n, role, alll, loc)
  loop
    perform t.put('inv' || r.n, public.create_invitation(t.id('ws'), 'm3-act-fixture-' || r.n || '@savour.test',
      r.role::public.member_role, r.alll, case when r.loc is null then '{}'::uuid[] else array[t.id(r.loc)] end, null, null) ->> 'token');
  end loop;
end $$;
select t.as(2); select public.accept_invitation(t.get('inv2'), 'Ade Admin');
select t.as(3); select public.accept_invitation(t.get('inv3'), 'Rita Reviewer');
select t.as(4); select public.accept_invitation(t.get('inv4'), 'Remi Reviewer');
select t.as(5); select public.accept_invitation(t.get('inv5'), 'Ayo Assessor');
select t.as(6); select public.accept_invitation(t.get('inv6'), 'Bimpe Assessor');
select t.as(7); select public.accept_invitation(t.get('inv7'), 'Vic Viewer');
select t.as(8); select public.accept_invitation(t.get('inv8'), 'Kemi Annex');
select t.as(12); select public.accept_invitation(t.get('inv12'), 'Tunde Fixer');

-- ---------------------------------------------------------------- versioned template triggers
select t.as(1);
select t.put('TVf', public.publish_template(t.id('ws'), null, 'Food panel', 'food_vendors', 'scored',
  '[{"key":"taste","label":"Taste","critical":true},{"key":"hygiene","label":"Hygiene","allow_na":true,"trigger_at_or_below":3}]',
  '{"repeat_window":2}')::text);
select t.put('TVr', public.publish_template(t.id('ws'), null, 'Kitchen ops', 'restaurant_ops', 'off',
  '[{"key":"hygiene","label":"Hygiene","critical":true},{"key":"service_quality","label":"Service quality","allow_na":true}]', null)::text);
select t.put('TVp', public.publish_template(t.id('ws'), null, 'Supplier review', 'supplier_service', 'off',
  '[{"key":"quality","label":"Quality","trigger_at_or_below":2},{"key":"timeliness","label":"Timeliness"}]', '{}')::text);
select t.put('TVold', public.publish_template(t.id('ws'), null, 'Legacy panel', 'food_vendors', 'scored',
  '[{"key":"taste","label":"Taste"},{"key":"hygiene","label":"Hygiene"}]')::text);
reset role;
select t.ok((select criteria -> 0 = '{"key":"taste","label":"Taste","guidance":null,"allow_na":false,"critical":true}'::jsonb
    and criteria -> 1 ->> 'trigger_at_or_below' = '3' and settings = '{"repeat_window":2}'::jsonb
  from public.template_versions where id = t.id('TVf')), 'critical flag, trigger and repeat window are frozen with the version');
select t.ok((select criteria = '[{"key":"taste","label":"Taste","guidance":null,"allow_na":false},{"key":"hygiene","label":"Hygiene","guidance":null,"allow_na":false}]'::jsonb
    and settings = '{"repeat_window":3}'::jsonb from public.template_versions where id = t.id('TVold')),
  'the M1 6-argument publish still works and criteria without triggers keep the exact M1 shape');
select t.ok((select settings = '{"repeat_window":3}'::jsonb from public.template_versions where id = t.id('TVp')), 'empty settings default the repeat window to 3');
select t.err($$update public.template_versions set settings = '{}' where id = t.id('TVf')$$, 'immutable_record', 'published trigger settings are immutable');
select t.as(1);
select t.err($$select public.publish_template(t.id('ws'), null, 'X', 'custom', 'off', '[{"key":"a","label":"A","trigger_at_or_below":5}]', null)$$,
  'invalid_criteria', 'trigger above 4 refused');
select t.err($$select public.publish_template(t.id('ws'), null, 'X', 'custom', 'off', '[{"key":"a","label":"A","trigger_at_or_below":2.5}]', null)$$,
  'invalid_criteria', 'fractional trigger refused');
select t.err($$select public.publish_template(t.id('ws'), null, 'X', 'custom', 'off', '[{"key":"a","label":"A","critical":"yes"}]', null)$$,
  'invalid_criteria', 'non-boolean critical refused');
select t.err($$select public.publish_template(t.id('ws'), null, 'X', 'custom', 'off', '[{"key":"a","label":"A"}]', '{"repeat_window":7}')$$,
  'invalid_settings', 'repeat window above 6 refused');
select t.err($$select public.publish_template(t.id('ws'), null, 'X', 'custom', 'off', '[{"key":"a","label":"A"}]', '{"threshold":1}')$$,
  'invalid_settings', 'unknown setting refused');
select t.as(3);
select t.err($$select public.publish_template(t.id('ws'), null, 'X', 'custom', 'off', '[{"key":"a","label":"A"}]', null)$$,
  'forbidden', 'reviewer cannot publish templates');

-- ---------------------------------------------------------------- business B (same labels)
select t.as(10);
select t.put('wsB', public.create_workspace('Same Labels QA', 'Nigeria', 'Africa/Lagos', 'Owner B')::text);
select t.put('LB', public.upsert_location(t.id('wsB'), null, 'Main', false)::text);
select t.put('SB', public.upsert_subject(t.id('wsB'), null, 'Alpha Stall', 'vendor', false)::text);
select t.put('TVb', public.publish_template(t.id('wsB'), null, 'Food panel', 'food_vendors', 'off',
  '[{"key":"taste","label":"Taste","critical":true}]', null)::text);
select t.put('FB', public.create_session(t.id('wsB'), t.id('LB'), t.id('TVb'), 'Panel', current_date, array[t.id('SB')],
  array[t.u(10)], array[t.u(10)], 48, null)::text);
select t.score(t.id('FB'), t.id('SB'), 10, null, '{"taste":1}');
select public.resolve_outcome(t.id('FB'), t.id('SB'), 'assessed', null, t.rv(t.id('FB'), t.id('SB')));
select public.approve_session(t.id('FB'), t.dv(t.id('FB')));
select t.put('GB', t.finding(t.id('FB'), t.id('SB'), 'taste', 1)::text);
select t.put('XB', public.create_action(t.id('GB'), 'Undercooked', 'Retrain', 'critical', t.u(10),
  t.wtoday(t.id('wsB')) + 2, gen_random_uuid()) ->> 'action_id');
select t.ok(t.id('GB') is not null and t.id('XB') is not null, 'business B has its own finding and action');

-- ---------------------------------------------------------------- food session F (scored attendance)
select t.as(1);
select t.put('F', public.create_session(t.id('ws'), t.id('L1'), t.id('TVf'), 'Market panel', current_date - 1,
  array[t.id('S1'), t.id('S2')], array[t.u(5), t.u(6)], array[t.u(3)], 48, '09:00')::text);
select t.as(5);
select t.score(t.id('F'), t.id('S1'), 5, 'early', '{"taste":2,"hygiene":4}');
select t.score(t.id('F'), t.id('S2'), 5, 'middle', '{"taste":5,"hygiene":5}');
select t.as(6);
select t.score(t.id('F'), t.id('S1'), 6, 'early', '{"taste":4,"hygiene":3}');
select t.score(t.id('F'), t.id('S2'), 6, 'middle', '{"taste":5,"hygiene":{"na":"Closed"}}');
select t.as(3);
select public.resolve_outcome(t.id('F'), t.id('S1'), 'early', null, t.rv(t.id('F'), t.id('S1')));
select public.resolve_outcome(t.id('F'), t.id('S2'), 'middle', null, t.rv(t.id('F'), t.id('S2')));
select public.confirm_na(t.id('F'), t.id('S2'), t.u(6), 1);

-- ---------------------------------------------------------------- manual findings
select t.put('kF1', gen_random_uuid()::text);
select t.put('MF', public.create_finding(t.id('F'), t.id('S2'), 'medium', 'Bins overflowing', 'Seen at 10:00', null, t.id('kF1')) ->> 'finding_id');
select t.ok((public.create_finding(t.id('F'), t.id('S2'), 'medium', 'Bins overflowing', 'Seen at 10:00', null, t.id('kF1'))
  ->> 'finding_id')::uuid = t.id('MF'), 'manual finding retry with the same key and payload replays the receipt');
select t.err($$select public.create_finding(t.id('F'), t.id('S2'), 'high', 'Bins overflowing', 'Seen at 10:00', null, t.id('kF1'))$$,
  'idempotency_conflict', 'same finding key with a different payload conflicts');
select t.ok(t.n($$select 1 from public.findings where session_id = t.id('F')$$) = 1, 'one manual finding exists after the retries');
select t.err($$select public.create_finding(t.id('F'), t.id('S2'), 'urgent', 'X', null, null, gen_random_uuid())$$, 'invalid_severity', 'unknown severity refused');
select t.err($$select public.create_finding(t.id('F'), t.id('S2'), 'low', 'X', null, 'smell', gen_random_uuid())$$, 'unknown_criterion', 'unknown criterion refused');
select t.err($$select public.create_finding(t.id('F'), t.id('S3'), 'low', 'X', null, null, gen_random_uuid())$$, 'not_found', 'subject not on the roster refused');
select t.err($$select public.create_finding(t.id('F'), t.id('SB'), 'low', 'X', null, null, gen_random_uuid())$$, 'not_found', 'other business subject refused');
select t.err($$select public.create_finding(t.id('F'), t.id('S2'), 'low', ' ', null, null, gen_random_uuid())$$, 'invalid_title', 'blank title refused');
select t.err($$select public.create_finding(t.id('F'), t.id('S2'), 'low', 'X', null, null, null)$$, 'idempotency_key_required', 'finding needs a key');
select t.as(5);
select t.err($$select public.create_finding(t.id('F'), t.id('S2'), 'low', 'X', null, null, gen_random_uuid())$$, 'forbidden', 'assessor cannot raise findings');
select t.as(4);
select t.err($$select public.create_finding(t.id('F'), t.id('S2'), 'low', 'X', null, null, gen_random_uuid())$$, 'forbidden', 'reviewer not on the session cannot raise findings');
select t.as(7);
select t.err($$select public.create_finding(t.id('F'), t.id('S2'), 'low', 'X', null, null, gen_random_uuid())$$, 'forbidden', 'viewer cannot raise findings');
select t.as(10);
select t.err($$select public.create_finding(t.id('F'), t.id('S2'), 'low', 'X', null, null, gen_random_uuid())$$, 'not_found', 'other business cannot raise findings or learn the session exists');

-- ---------------------------------------------------------------- action creation (before approval)
select t.as(3);
select t.put('kA1', gen_random_uuid()::text);
select t.put('X1', public.create_action(t.id('MF'), 'Overflowing bins', 'Empty and replace the bins', 'medium', t.u(5),
  t.today() + 3, t.id('kA1')) ->> 'action_id');
select t.ok((public.create_action(t.id('MF'), 'Overflowing bins', 'Empty and replace the bins', 'medium', t.u(5), t.today() + 3, t.id('kA1'))
  ->> 'replayed')::boolean, 'action create retry with the same key and payload replays');
select t.err($$select public.create_action(t.id('MF'), 'Overflowing bins', 'Empty and replace the bins', 'high', t.u(5), t.today() + 3, t.id('kA1'))$$,
  'idempotency_conflict', 'same action key with a different payload conflicts');
select t.ok(t.n($$select 1 from public.actions where finding_id = t.id('MF')$$) = 1 and t.events(t.id('X1')) = 1,
  'retries create exactly one action and one event');
select t.ok(t.inbox(5, 'action_assigned') = 1 and t.inbox(3, null) = 0, 'assignee notified once; the actor is never notified');
select t.err($$select public.create_action(t.id('MF'), 'I', 'A', 'low', t.u(7), t.today() + 1, gen_random_uuid())$$, 'invalid_assignee', 'viewer cannot be an assignee');
select t.err($$select public.create_action(t.id('MF'), 'I', 'A', 'low', t.u(8), t.today() + 1, gen_random_uuid())$$, 'invalid_assignee', 'assessor without the session location cannot be an assignee');
select t.err($$select public.create_action(t.id('MF'), 'I', 'A', 'low', t.u(10), t.today() + 1, gen_random_uuid())$$, 'invalid_assignee', 'other business user cannot be an assignee');
select t.err($$select public.create_action(t.id('MF'), 'I', 'A', 'low', t.u(5), t.today() - 1, gen_random_uuid())$$, 'invalid_due_date%', 'due date in the past refused');
select t.err($$select public.create_action(t.id('MF'), 'I', 'A', 'low', t.u(5), null, gen_random_uuid())$$, 'invalid_due_date%', 'due date required');
select t.err($$select public.create_action(t.id('MF'), ' ', 'A', 'low', t.u(5), t.today(), gen_random_uuid())$$, 'invalid_issue', 'issue required');
select t.err($$select public.create_action(t.id('MF'), 'I', ' ', 'low', t.u(5), t.today(), gen_random_uuid())$$, 'invalid_action_required', 'action required text needed');
select t.err($$select public.create_action(t.id('MF'), 'I', 'A', 'severe', t.u(5), t.today(), gen_random_uuid())$$, 'invalid_severity', 'severity validated');
select t.err($$select public.create_action(t.id('GB'), 'I', 'A', 'low', t.u(5), t.today(), gen_random_uuid())$$, 'not_found', 'cannot attach an action to another business finding');
select t.as(5);
select t.err($$select public.create_action(t.id('MF'), 'I', 'A', 'low', t.u(5), t.today(), gen_random_uuid())$$, 'forbidden', 'assessor cannot create actions');
select t.as(10);
select t.err($$select public.create_action(t.id('MF'), 'I', 'A', 'low', t.u(10), t.today(), gen_random_uuid())$$, 'not_found', 'other business cannot create actions');
reset role;
select t.ok(not exists (select 1 from public.actions a join public.sessions s on s.id = a.session_id
  where a.location_id <> s.location_id or a.workspace_id <> s.workspace_id), 'every action location equals its session location');
select t.err($$insert into public.actions (workspace_id, finding_id, session_id, subject_id, location_id, issue, action_required, severity,
    assignee_id, due_date, created_by, created_at, updated_at)
  select workspace_id, finding_id, session_id, subject_id, (select v::uuid from t.vars where k = 'L2'), issue, action_required, severity,
    assignee_id, due_date, created_by, now(), now() from public.actions where id = (select v::uuid from t.vars where k = 'X1')$$,
  '%foreign key%', 'database refuses an action whose location differs from its session');

-- ---------------------------------------------------------------- approval freezes actions and generates findings
select t.as(3);
select t.put('RF1', public.approve_session(t.id('F'), t.dv(t.id('F')))::text);
select t.pin();
select t.ok(t.generated(t.id('F')) = 2, 'approval generates exactly two findings from the frozen evidence');
select t.put('GF', t.finding(t.id('F'), t.id('S1'), 'taste', 1)::text);
select t.put('GH', t.finding(t.id('F'), t.id('S1'), 'hygiene', 1)::text);
reset role;
select t.ok((select severity = 'critical' and title = 'Taste scored 2 (at or below 2)' and detail ->> 'min_score' = '2'
    and detail ->> 'assessors_below' = '1' and detail ->> 'assessors_scored' = '2' and detail -> 'repeat' ->> 'status' = 'insufficient_data'
    and detail ->> 'rule' like '%critical criterion default%not a certification or penalty.'
  from public.findings where id = t.id('GF')), 'critical criterion with no explicit trigger generates a critical finding at score 2 with its rule');
select t.ok((select severity = 'high' and detail ->> 'trigger_at_or_below' = '3' and detail ->> 'min_score' = '3'
  from public.findings where id = t.id('GH')), 'non-critical trigger 3 generates a high finding');
select t.ok(t.finding(t.id('F'), t.id('S2'), 'taste', 1) is null and t.finding(t.id('F'), t.id('S2'), 'hygiene', 1) is null,
  'scores above the trigger and N/A answers generate nothing');
select t.ok((select inputs ->> 'formula_version' = 'savour-m3.1' and jsonb_array_length(inputs -> 'actions') = 1
    and inputs -> 'actions' -> 0 ->> 'action_id' = t.get('X1') and inputs -> 'actions' -> 0 ->> 'status' = 'open'
    and inputs -> 'actions' -> 0 ->> 'assignee_label' = 'Ayo Assessor'
    and jsonb_array_length(inputs -> 'findings') = 3
    and inputs -> 'session' ->> 'location_id' = t.get('L1') and inputs -> 'template' ->> 'pack' = 'food_vendors'
    and inputs -> 'subjects' -> 0 ->> 'category_id' = t.get('CAT') and inputs -> 'subjects' -> 0 ->> 'category_name' = 'Grills'
    and inputs -> 'subjects' -> 1 ? 'category_id' and inputs -> 'subjects' -> 1 -> 'category_id' = 'null'::jsonb
    and inputs -> 'subjects' -> 0 ->> 'subject_type' = 'vendor'
    and approved_at >= (select created_at from public.actions where id = t.id('X1'))
  from public.report_revisions where id = t.id('RF1')), 'new approval stamps m3.1 and freezes actions, findings, category, type, location and pack');
select t.ok(t.inbox(1, 'session_approved') = 1 and t.inbox(3, 'session_approved') = 0, 'approval notifies the session creator, never the approver');

-- Action after approval: never in the frozen snapshot, shown only in the dated appendix.
select t.as(3);
select t.put('X2', public.create_action(t.id('GF'), 'Undercooked meat', 'Retrain on cooking temperatures', 'critical', t.u(12),
  t.today() + 7, gen_random_uuid()) ->> 'action_id');
reset role;
select t.ok((select created_at > (select approved_at from public.report_revisions where id = t.id('RF1')) from public.actions where id = t.id('X2')),
  'an action created after approval is timestamped after the approval (clock_timestamp after the lock)');
select t.as(3);
select t.put('rep1', public.get_session_report(t.id('F'), null, false, 'view')::text);
select t.ok(t.j('rep1') -> 'meta' ->> 'actions_snapshot' = 'frozen' and t.j('rep1') -> 'actions_appendix' ->> 'snapshot' = 'frozen'
  and jsonb_array_length(t.j('rep1') -> 'inputs' -> 'actions') = 1
  and jsonb_array_length(t.j('rep1') -> 'actions_appendix' -> 'actions') = 2
  and t.j('rep1') -> 'actions_appendix' ->> 'as_of' is not null, 'report keeps the frozen action list and adds a dated appendix');
select t.ok(t.j('rep1') -> 'meta' ->> 'workspace_id' = t.get('ws'), 'report envelope names its business for route checks');
select t.ok((select (a ->> 'in_snapshot')::boolean and not (a ->> 'changed_since_snapshot')::boolean
  from jsonb_array_elements(t.j('rep1') -> 'actions_appendix' -> 'actions') a where a ->> 'action_id' = t.get('X1')),
  'appendix marks the frozen action as in the snapshot and unchanged');
select t.ok((select not (a ->> 'in_snapshot')::boolean and (a ->> 'created_after_snapshot')::boolean
  from jsonb_array_elements(t.j('rep1') -> 'actions_appendix' -> 'actions') a where a ->> 'action_id' = t.get('X2')),
  'appendix marks the later action as created after the snapshot');

-- ---------------------------------------------------------------- assignee-only access never opens the session
select t.as(12);
select t.ok(t.n('select 1 from public.actions') = 1 and t.n('select 1 from public.findings') = 1 and t.n('select 1 from public.action_events') = 1,
  'assignee reads only their action, its finding and its history');
select t.ok(t.n($$select 1 from public.sessions where id = t.id('F')$$) = 0
  and t.n($$select 1 from public.session_subjects where session_id = t.id('F')$$) = 0
  and t.n($$select 1 from public.assessments where session_id = t.id('F')$$) = 0, 'an action grants no session, roster or assessment read');
select t.err($$select public.get_session_report(t.id('F'), null, false, 'view')$$, 'forbidden', 'an action grants no report access');
select t.err($$select public.get_findings(t.id('F'))$$, 'forbidden', 'assignee cannot list the session findings');
select t.err($$select public.get_action_assignees(t.id('F'))$$, 'forbidden', 'assignee cannot list assignable staff');
select t.ok((public.get_action(t.id('X2')) -> 'finding' ->> 'title') = 'Taste scored 2 (at or below 2)'
  and not (public.get_action(t.id('X2')) -> 'permissions' ->> 'review')::boolean, 'assignee sees the action detail and its finding');
select t.err($$select public.get_action(t.id('X1'))$$, 'not_found', 'assignee cannot read someone else''s action');
select t.err($$select detail from public.findings$$, 'permission denied%', 'finding detail is read only through scrubbing RPCs');
select t.ok(jsonb_array_length(public.get_actions(t.id('ws'), null) -> 'actions') = 1, 'assignee list contains only their own action');

-- ---------------------------------------------------------------- workflow on X1 (assignee 5)
select t.as(6);
select t.err($$select t.tr(t.id('X1'), 'start', null, null)$$, 'not_assigned', 'another assessor cannot progress the action');
select t.as(7);
select t.err($$select t.tr(t.id('X1'), 'start', null, null)$$, 'forbidden', 'viewer cannot progress actions');
select t.as(4);
select t.err($$select t.tr(t.id('X1'), 'start', null, null)$$, 'not_assigned', 'reviewer outside the session cannot progress');
select t.err($$select t.tr(t.id('X1'), 'verify', null, null)$$, 'forbidden', 'reviewer outside the session cannot verify');
select t.as(10);
select t.err($$select t.tr(t.id('X1'), 'start', null, null)$$, 'not_found', 'other business cannot progress or detect the action');
select t.as(5);
select t.err($$select public.transition_action(t.id('X1'), 'start', null, null, null, gen_random_uuid())$$, 'stale_version', 'null expected version refused');
select t.err($$select public.transition_action(t.id('X1'), 'start', 9, null, null, gen_random_uuid())$$, 'stale_version', 'wrong expected version refused');
select t.err($$select t.tr(t.id('X1'), 'submit', 'Done', null)$$, 'invalid_transition%', 'cannot skip from open to ready');
select t.err($$select t.tr(t.id('X1'), 'jump', null, null)$$, 'invalid_command', 'unknown command refused');
select t.err($$select public.transition_action(t.id('X1'), 'start', 1, null, null, null)$$, 'idempotency_key_required', 'transition needs a key');
select t.put('kS1', gen_random_uuid()::text);
select t.ok((public.transition_action(t.id('X1'), 'start', 1, null, null, t.id('kS1')) ->> 'version')::int = 2, 'assignee starts work');
select t.ok((public.transition_action(t.id('X1'), 'start', 1, null, null, t.id('kS1')) ->> 'replayed')::boolean, 'start retry replays the receipt');
select t.err($$select public.transition_action(t.id('X1'), 'start', 1, null, 'other', t.id('kS1'))$$, 'idempotency_conflict', 'same key with a changed payload conflicts');
select t.ok(t.events(t.id('X1')) = 2 and t.ast(t.id('X1')) = 'in_progress', 'retries wrote no extra events');
select t.err($$select t.tr(t.id('X1'), 'verify', null, null)$$, 'forbidden', 'assessor cannot verify');
select t.err($$select t.tr(t.id('X1'), 'cancel', null, 'x')$$, 'forbidden', 'assessor cannot cancel');
select t.err($$select t.tr(t.id('X1'), 'submit', '  ', null)$$, 'evidence_required', 'resolution evidence required');
select t.ok(t.tr(t.id('X1'), 'submit', 'Bins emptied; photo on file', null) ->> 'status' = 'ready_for_verification', 'assignee submits evidence');
select t.as(3);
select t.err($$select public.update_action(t.id('X1'), t.av(t.id('X1')), null, 'Repair the fridge instead', null, null, null, 'Different work', gen_random_uuid())$$,
  'return_required%', 'work awaiting verification cannot be changed without a return');
select t.err($$select public.update_action(t.id('X1'), t.av(t.id('X1')), null, null, null, t.u(6), null, 'Hand over', gen_random_uuid())$$,
  'return_required%', 'work awaiting verification cannot be reassigned without a return');
select t.ok((select status = 'ready_for_verification' and action_required = 'Empty and replace the bins' and resolution_evidence is not null
  from public.actions where id = t.id('X1')), 'refused edit leaves the submitted work and evidence untouched');
select t.ok(public.update_action(t.id('X1'), t.av(t.id('X1')), null, null, null, null, t.today() + 5, 'Inspector visit moved', gen_random_uuid())
  ->> 'status' = 'ready_for_verification', 'a due-date-only change keeps the action ready');
select t.as(5);
select t.ok(t.inbox(3, 'action_ready') = 1, 'reviewer (also the creator) notified once that the action is ready');
select t.as(3);
select t.err($$select t.tr(t.id('X1'), 'return', null, null)$$, 'reason_required', 'return needs a reason');
select t.ok(t.tr(t.id('X1'), 'return', null, 'Photo missing') ->> 'status' = 'in_progress', 'reviewer returns the work');
select t.ok((select resolution_evidence is null and resolved_by is null from public.actions where id = t.id('X1')), 'returned work has no current resolution');
select t.ok(t.inbox(5, 'action_returned') = 1, 'assignee notified of the return');
select t.as(5);
select t.ok(t.tr(t.id('X1'), 'submit', 'Bins emptied; photo attached', null) ->> 'status' = 'ready_for_verification', 'assignee resubmits');
select t.as(3);
select t.ok(t.tr(t.id('X1'), 'verify', null, null) ->> 'status' = 'closed', 'a different reviewer verifies and closes');
select t.ok(t.inbox(5, 'action_verified') = 1, 'assignee notified of verification');
select t.ok((public.get_action(t.id('X1')) -> 'finding' ->> 'state') = 'resolved', 'finding resolved once its only action is closed');
select t.err($$select t.tr(t.id('X1'), 'reopen', null, ' ')$$, 'reason_required', 'reopen needs a reason');
select t.ok(t.tr(t.id('X1'), 'reopen', null, 'Bins overflowing again') ->> 'status' = 'open', 'reviewer reopens a closed action');
select t.ok((select reopen_count = 1 and verified_at is null and resolution_evidence is null from public.actions where id = t.id('X1')),
  'reopen counts the reopen and clears the old resolution and verification');
select t.ok((public.get_action(t.id('X1')) -> 'finding' ->> 'state') = 'open', 'finding open again while its action is active');
select t.err($$select t.tr(t.id('X1'), 'cancel', null, null)$$, 'reason_required', 'cancel needs a reason');
select t.ok(t.tr(t.id('X1'), 'cancel', null, 'Duplicate of supervisor task') ->> 'status' = 'cancelled', 'reviewer cancels with a reason');
select t.as(5);
select t.err($$select t.tr(t.id('X1'), 'start', null, null)$$, 'invalid_transition%', 'cancelled action cannot be started');
select t.as(3);
select t.ok(t.tr(t.id('X1'), 'reopen', null, 'Not a duplicate after all') ->> 'status' = 'open', 'cancelled action can be reopened with a reason');
select t.put('evX1', t.events(t.id('X1'))::text);
select t.err($$select public.update_action(t.id('X1'), t.av(t.id('X1')) - 1, 'New issue', null, null, null, null, null, gen_random_uuid())$$,
  'stale_version', 'stale edit refused');
select t.err($$select public.update_action(t.id('X1'), t.av(t.id('X1')), null, null, null, null, null, null, gen_random_uuid())$$,
  'no_change', 'empty edit refused');
select t.ok(t.events(t.id('X1')) = t.get('evX1')::bigint, 'refused saves write no events');
select t.ok(t.pins_ok(), 'every snapshot hash and body unchanged after the action transitions');

-- ---------------------------------------------------------------- self-verification
select t.as(1);
select t.put('X3', public.create_action(t.id('MF'), 'Sort waste', 'Add a recycling bin', 'low', t.u(3), t.today() + 5, gen_random_uuid()) ->> 'action_id');
select t.as(3);
select t.tr(t.id('X3'), 'start', null, null);
select t.tr(t.id('X3'), 'submit', 'Recycling bin installed', null);
select t.err($$select t.tr(t.id('X3'), 'verify', null, 'I am sure')$$, 'own_verification_forbidden%', 'reviewer cannot verify own resolution, even with a reason');
select t.as(2);
select t.ok(t.tr(t.id('X3'), 'verify', null, null) ->> 'status' = 'closed', 'admin verifies the reviewer''s resolution');
select t.as(1);
select t.put('X4', public.create_action(t.id('MF'), 'Owner task', 'Owner fixes signage', 'low', t.u(1), t.today() + 5, gen_random_uuid()) ->> 'action_id');
select t.tr(t.id('X4'), 'start', null, null);
select t.tr(t.id('X4'), 'submit', 'Signage replaced', null);
select t.err($$select t.tr(t.id('X4'), 'verify', null, null)$$, 'own_verification_forbidden%', 'owner cannot self-verify without an override reason');
select t.ok(t.tr(t.id('X4'), 'verify', null, 'Owner-only business; checked in person') ->> 'status' = 'closed', 'owner self-verifies with a recorded override reason');
reset role;
select t.ok((select override and reason = 'Owner-only business; checked in person' from public.action_events
  where action_id = t.id('X4') and kind = 'verify') and t.audits('action.self_verified') = 1, 'override reason is recorded in the event and the audit log');
select t.as(1);
select t.put('X5', public.create_action(t.id('MF'), 'Clean drains', 'Clear the drains', 'medium', t.u(5), t.today() + 5, gen_random_uuid()) ->> 'action_id');
select t.as(3);
select t.err($$select t.tr(t.id('X5'), 'start', null, null)$$, 'override_reason_required', 'reviewer progressing someone else''s action needs a reason');
select t.ok(t.tr(t.id('X5'), 'start', null, 'Assessor away; started on their behalf') ->> 'status' = 'in_progress', 'reviewer override start');
select t.tr(t.id('X5'), 'submit', 'Drains cleared by contractor', 'Recorded on behalf of assignee');
select t.err($$select t.tr(t.id('X5'), 'verify', null, null)$$, 'own_verification_forbidden%', 'the reviewer who resolved cannot verify');
select t.as(1);
select t.ok(t.tr(t.id('X5'), 'verify', null, null) ->> 'status' = 'closed', 'owner verifies a resolution recorded by another reviewer');
reset role;
select t.ok(t.audits('action.progress_override') = 2 and (select count(*) from public.action_events where action_id = t.id('X5') and override) = 2,
  'progress overrides are audited and flagged');

-- ---------------------------------------------------------------- finding withdrawal
select t.as(3);
select t.err($$select public.withdraw_finding(t.id('MF'), 'Wrong stall', t.fv(t.id('MF')))$$, 'finding_has_actions', 'finding with live or closed actions cannot be withdrawn');
select t.put('kFW', gen_random_uuid()::text);
select t.put('FW', public.create_finding(t.id('F'), t.id('S1'), 'low', 'Pest sighting', null, null, t.id('kFW')) ->> 'finding_id');
select t.put('XW', public.create_action(t.id('FW'), 'Pest check', 'Call pest control', 'low', t.u(5), t.today() + 2, gen_random_uuid()) ->> 'action_id');
select t.tr(t.id('XW'), 'cancel', null, 'Not a pest after all');
select t.err($$select public.withdraw_finding(t.id('FW'), ' ', 1)$$, 'reason_required', 'withdrawal needs a reason');
select t.err($$select public.withdraw_finding(t.id('FW'), 'x', 9)$$, 'stale_version', 'withdrawal is version-checked');
select t.ok(public.withdraw_finding(t.id('FW'), 'Misidentified', 1) = 2, 'finding with only cancelled actions is withdrawn');
select t.ok(public.create_finding(t.id('F'), t.id('S1'), 'low', 'Pest sighting', null, null, t.id('kFW'))
  = jsonb_build_object('finding_id', t.id('FW'), 'version', 1, 'replayed', true), 'create retry after withdrawal returns the original receipt');
select t.err($$select public.create_action(t.id('FW'), 'I', 'A', 'low', t.u(5), t.today(), gen_random_uuid())$$, 'finding_withdrawn', 'no actions on a withdrawn finding');
select t.err($$select public.withdraw_finding(t.id('FW'), 'again', 2)$$, 'invalid_state', 'withdrawal happens once');
select t.as(5);
select t.err($$select public.withdraw_finding(t.id('MF'), 'x', 1)$$, 'forbidden', 'assessor cannot withdraw findings');

-- ---------------------------------------------------------------- reassignment
select t.as(3);
select public.update_action(t.id('X1'), t.av(t.id('X1')), null, null, null, t.u(6), null, 'Ayo on leave', gen_random_uuid());
select t.ok(t.inbox(6, 'action_assigned') = 1, 'new assignee notified');
select t.as(5);
select t.err($$select t.tr(t.id('X1'), 'start', null, null)$$, 'not_assigned', 'old assignee cannot progress reassigned work');
select t.ok((select count(*) from jsonb_array_elements(public.get_inbox(t.id('ws')) -> 'items') i
  where i ->> 'kind' = 'action_assigned' and (i ->> 'stale')::boolean and i ->> 'title' is null and i ->> 'link' is null) = 1,
  'old assignment notice is stale with no payload or link');
select t.as(6);
select t.ok(t.tr(t.id('X1'), 'start', null, null) ->> 'status' = 'in_progress', 'new assignee can progress');
reset role;
select t.ok((select before ->> 'assignee_id' = t.u(5)::text and after ->> 'assignee_id' = t.u(6)::text and reason = 'Ayo on leave'
  from public.action_events where action_id = t.id('X1') and kind = 'update' order by created_at desc limit 1),
  'reassignment event records before, after and reason');

-- ---------------------------------------------------------------- due dates and lazy reminders
select t.as(3);
select t.put('X6', public.create_action(t.id('MF'), 'Fix lid', 'Replace bin lid', 'low', t.u(5), t.today(), gen_random_uuid()) ->> 'action_id');
select t.as(5);
select t.ok((public.get_inbox(t.id('ws')) ->> 'reminders_created')::int = 1 and t.inbox(5, 'action_due_today') = 1, 'opening the inbox creates one due-today reminder');
select t.ok((public.get_inbox(t.id('ws')) ->> 'reminders_created')::int = 0 and t.inbox(5, 'action_due_today') = 1, 'reopening the inbox creates no duplicate');
select t.as(3);
select public.get_inbox(t.id('ws'));
select t.ok(t.inbox(3, 'action_due_today') = 1, 'the creator who reviews the session also gets the reminder');
select public.update_action(t.id('X6'), t.av(t.id('X6')), null, null, null, null, t.today() + 1, 'More time', gen_random_uuid());
select t.as(5);
select t.ok((select count(*) from jsonb_array_elements(public.get_inbox(t.id('ws')) -> 'items') i
    where i ->> 'kind' = 'action_due_today' and (i ->> 'stale')::boolean) = 1 and t.inbox(5, 'action_due_today') = 1,
  'a due-date change makes the old reminder stale and creates none for a future date');
reset role;
-- fixture time travel: the due date has passed
update public.actions set due_date = t.today() - 2 where id = t.id('X6');
select t.as(5);
select t.ok((public.get_inbox(t.id('ws')) ->> 'reminders_created')::int = 1 and t.inbox(5, 'action_overdue') = 1, 'one overdue reminder after the local due date ends');
select t.ok((public.get_inbox(t.id('ws')) ->> 'reminders_created')::int = 0, 'overdue reminder is not repeated');
reset role;
-- fixture: a due-today notice stored for the due date that has now passed
insert into public.notifications (workspace_id, recipient_id, kind, action_id, dedupe_key, meta, created_at)
select workspace_id, assignee_id, 'action_due_today', id, 'fixture-old-due-today', jsonb_build_object('due_date', due_date), now() - interval '2 days'
from public.actions where id = t.id('X6');
select t.as(5);
-- Both due-today notices are stale: the first because the due date changed, the fixture (same due
-- date as the action) only because that day has ended.
select t.ok((select count(*) = 2 and bool_and((i ->> 'stale')::boolean and i ->> 'body' is null)
  from jsonb_array_elements(public.get_inbox(t.id('ws')) -> 'items') i where i ->> 'kind' = 'action_due_today'),
  'a due-today notice is stale once its day has ended');
select t.tr(t.id('X6'), 'start', null, null);
select t.tr(t.id('X6'), 'submit', 'Lid replaced', null);
select t.ok((select a ->> 'due_state' from jsonb_array_elements(public.get_actions(t.id('ws'), null) -> 'actions') a
  where a ->> 'id' = t.get('X6')) = 'overdue', 'ready-for-verification work is still overdue');
select t.ok((select count(*) from jsonb_array_elements(public.get_inbox(t.id('ws')) -> 'items') i
  where i ->> 'kind' = 'action_overdue' and not (i ->> 'stale')::boolean) = 1, 'overdue reminder stays live until closed');
select t.as(3);
select t.tr(t.id('X6'), 'verify', null, null);
select t.as(5);
select t.ok((select a ->> 'due_state' from jsonb_array_elements(public.get_actions(t.id('ws'), null) -> 'actions') a
  where a ->> 'id' = t.get('X6')) = 'done'
  and (select count(*) from jsonb_array_elements(public.get_inbox(t.id('ws')) -> 'items') i
       where i ->> 'kind' = 'action_overdue' and (i ->> 'stale')::boolean) = 1, 'closed actions are never overdue and their reminders go stale');

-- ---------------------------------------------------------------- mark read and inbox scope
select t.as(6);
select t.err($$select public.mark_notification_read(t.id('ws'), t.nid(5, 'action_returned'))$$, 'not_found', 'another member cannot mark someone''s notification read');
select t.as(10);
select t.err($$select public.mark_notification_read(t.id('wsB'), t.nid(5, 'action_returned'))$$, 'not_found', 'another business cannot mark it read');
select t.err($$select public.get_inbox(t.id('ws'))$$, 'not_found', 'another business cannot open this inbox');
select t.as(5);
select t.err($$select public.mark_notification_read(t.id('wsB'), t.nid(5, 'action_returned'))$$, 'not_found', 'recipient cannot mark it read under another business');
select public.mark_notification_read(t.id('ws'), t.nid(5, 'action_returned'));
reset role;
select t.ok((select read_at is not null from public.notifications where id = t.nid(5, 'action_returned')), 'recipient marks read');
select t.err($$update public.notifications set kind = 'action_verified' where id = (select id from public.notifications limit 1)$$,
  'immutable_record', 'notification content cannot change');
select t.as(5);
select t.ok(public.mark_all_notifications_read(t.id('ws')) > 0 and (public.get_inbox(t.id('ws')) ->> 'unread')::int = 0, 'mark all read');
select t.err($$select * from public.notifications$$, 'permission denied%', 'notifications are not directly readable');
select t.as(7);
select t.err($$select public.get_inbox(t.id('ws'))$$, 'forbidden', 'viewer has no inbox');
select t.err($$select public.get_actions(t.id('ws'), null)$$, 'forbidden', 'viewer cannot list actions');
select t.err($$select public.get_action(t.id('X1'))$$, 'not_found', 'viewer cannot read an action');
select t.err($$select public.get_findings(t.id('F'))$$, 'forbidden', 'viewer cannot list findings');
select t.ok(t.n('select 1 from public.actions') = 0 and t.n('select 1 from public.findings') = 0 and t.n('select 1 from public.action_events') = 0,
  'viewer reads no action, finding or event rows');

-- ---------------------------------------------------------------- correction requests reach the inbox
select t.as(1);
select t.put('C', public.create_session(t.id('ws'), t.id('L1'), t.id('TVf'), 'Correction panel', current_date,
  array[t.id('S1'), t.id('S2')], array[t.u(5), t.u(6)], array[t.u(3)], 48, '09:00')::text);
select t.as(5);
select t.score(t.id('C'), t.id('S1'), 5, 'early', '{"taste":4,"hygiene":4}');
select t.as(3);
select public.request_correction(t.id('C'), t.id('S1'), t.u(5), 'Check hygiene score', t.dv(t.id('C')));
select t.ok(t.inbox(5, 'correction_requested') = 1, 'correction request notifies the named assessor');
select t.as(5);
select t.ok((select i ->> 'link' like '%/sessions/' || t.get('C') || '/assess/' || t.get('S1')
  from jsonb_array_elements(public.get_inbox(t.id('ws')) -> 'items') i where i ->> 'kind' = 'correction_requested'),
  'live correction notice links to the assessment');
select t.score(t.id('C'), t.id('S1'), 5, 'early', '{"taste":4,"hygiene":3}');
select t.ok((select (i ->> 'stale')::boolean and i ->> 'link' is null
  from jsonb_array_elements(public.get_inbox(t.id('ws')) -> 'items') i where i ->> 'kind' = 'correction_requested'),
  'resolved correction notice is stale and exposes nothing');

-- ---------------------------------------------------------------- guest is denied every new surface
select t.as(1);
select t.put('ginv', public.create_invitation(t.id('ws'), 'm3-act-fixture-9@savour.test', 'guest', false, '{}', t.id('C'), array[t.id('S2')]) ->> 'token');
select t.as(9); select public.accept_invitation(t.get('ginv'), 'Guest Taster');
select t.err($$select public.get_actions(t.id('ws'), null)$$, 'forbidden', 'guest cannot list actions');
select t.err($$select public.get_inbox(t.id('ws'))$$, 'forbidden', 'guest has no inbox');
select t.err($$select t.tr(t.id('X1'), 'start', null, null)$$, 'forbidden', 'guest cannot progress actions');
select t.err($$select public.create_finding(t.id('C'), t.id('S2'), 'low', 'X', null, null, gen_random_uuid())$$, 'forbidden', 'guest cannot raise findings');
select t.err($$select public.get_analytics(t.id('ws'), 'approved', '{}', 'view')$$, 'forbidden', 'guest cannot read analytics');
select t.ok(t.n('select 1 from public.actions') = 0 and t.n('select 1 from public.findings') = 0 and t.n('select 1 from public.action_events') = 0,
  'guest reads no rows from the new tables');

-- ---------------------------------------------------------------- revocation and scope changes
select t.as(3);
select t.put('XR', public.create_action(t.id('MF'), 'Label shelves', 'Label all shelves', 'low', t.u(5), t.today() + 4, gen_random_uuid()) ->> 'action_id');
select t.as(1);
select public.update_member(t.id('ws'), t.u(5), 'assessor', false, array[t.id('L2')]);
select t.as(5);
select t.err($$select t.tr(t.id('XR'), 'start', null, null)$$, 'not_assigned', 'assignee who lost the location cannot progress');
select t.ok(t.n('select 1 from public.actions') = 0 and jsonb_array_length(public.get_actions(t.id('ws'), null) -> 'actions') = 0,
  'assignee who lost the location reads no actions');
select t.ok((select bool_and((i ->> 'stale')::boolean) from jsonb_array_elements(public.get_inbox(t.id('ws')) -> 'items') i
  where i ->> 'kind' like 'action_%'), 'every action notice goes stale when scope is lost');
select t.as(1);
select public.update_member(t.id('ws'), t.u(5), 'assessor', false, array[t.id('L1')]);
select t.as(5);
select t.ok(t.tr(t.id('XR'), 'start', null, null) ->> 'status' = 'in_progress', 'restored location restores the assignment');
select t.as(1);
select public.update_member(t.id('ws'), t.u(3), 'reviewer', false, array[t.id('L2')]);
select t.as(3);
select t.err($$select t.tr(t.id('XR'), 'return', null, 'x')$$, 'forbidden', 'reviewer who lost the location cannot act');
select t.err($$select public.get_findings(t.id('F'))$$, 'forbidden', 'reviewer who lost the location cannot list findings');
select t.ok((select bool_and((i ->> 'stale')::boolean) from jsonb_array_elements(public.get_inbox(t.id('ws')) -> 'items') i
  where i ->> 'kind' in ('action_ready', 'session_approved')), 'reviewer notices go stale with the scope');
select t.as(1);
select public.update_member(t.id('ws'), t.u(3), 'reviewer', false, array[t.id('L1')]);
select public.revoke_member(t.id('ws'), t.u(6));
select t.ok((select not (a ->> 'assignee_in_scope')::boolean from jsonb_array_elements(public.get_actions(t.id('ws'), null) -> 'actions') a
  where a ->> 'id' = t.get('X1')), 'owner sees the revoked assignee flagged out of scope');
select t.as(6);
select t.err($$select t.tr(t.id('X1'), 'submit', 'x', null)$$, 'not_found', 'revoked assignee fails on the next save');
select t.err($$select public.get_inbox(t.id('ws'))$$, 'not_found', 'revoked assignee has no inbox');
select t.ok(t.n('select 1 from public.actions') = 0, 'revoked assignee reads no actions');

-- ---------------------------------------------------------------- reopen and reapprove: earlier snapshot untouched
reset role;
select t.put('GFdetail', (select detail::text from public.findings where id = t.id('GF')));
select t.as(1);
select public.reopen_session(t.id('F'), 'Recheck hygiene');
select t.as(3);
select t.put('RF2', public.approve_session(t.id('F'), t.dv(t.id('F')))::text);
select t.pin();
select t.ok(t.generated(t.id('F')) = 4 and t.finding(t.id('F'), t.id('S1'), 'taste', 2) is not null,
  'reapproval appends generated findings for revision 2');
reset role;
select t.ok((select detail::text = t.get('GFdetail') and revision = 1 from public.findings where id = t.id('GF'))
  and (select detail ->> 'previous_revision_finding_id' = t.get('GF') from public.findings where id = t.finding(t.id('F'), t.id('S1'), 'taste', 2)),
  'revision 1 findings are untouched and revision 2 links back to them');
select t.ok((select jsonb_array_length(inputs -> 'actions') = (select count(*) from public.actions where session_id = t.id('F'))
  from public.report_revisions where id = t.id('RF2')) and (select jsonb_array_length(inputs -> 'actions') = 1
  from public.report_revisions where id = t.id('RF1')), 'revision 2 freezes current actions; revision 1 still freezes one');
select t.ok(t.pins_ok(), 'every snapshot hash and body unchanged after reopen and reapproval');
select t.as(3);
select t.ok((select (a ->> 'created_after_snapshot')::boolean from jsonb_array_elements(
    public.get_session_report(t.id('F'), 1, false, 'view') -> 'actions_appendix' -> 'actions') a where a ->> 'action_id' = t.get('X2'))
  and (select (a ->> 'in_snapshot')::boolean from jsonb_array_elements(
    public.get_session_report(t.id('F'), 2, false, 'view') -> 'actions_appendix' -> 'actions') a where a ->> 'action_id' = t.get('X2'))
  and (public.get_session_report(t.id('F'), 1, false, 'view') -> 'actions_appendix' ->> 'snapshot_revision') = '1',
  'appendix compares live actions with the revision being viewed');
select t.ok((select (f ->> 'current')::boolean = (f ->> 'revision' = '2') from jsonb_array_elements(public.get_findings(t.id('F'))) f
  where f ->> 'id' = t.get('GF')) and (select bool_and((f ->> 'current')::boolean) from jsonb_array_elements(public.get_findings(t.id('F'))) f
  where f ->> 'kind' = 'generated' and f ->> 'revision' = '2'), 'only the current revision''s generated findings are current evidence');

-- ---------------------------------------------------------------- viewer report: redacted actions and appendix
select t.as(7);
select t.put('vrep', public.get_session_report(t.id('F'), null, false, 'view')::text);
select t.ok((t.j('vrep') -> 'meta' ->> 'redacted')::boolean
  and (select bool_and(a ->> 'assignee_label' like 'Assignee %' and not a ? 'assignee_id') from jsonb_array_elements(t.j('vrep') -> 'inputs' -> 'actions') a)
  and (select bool_and(a ->> 'assignee_label' = 'Assigned staff member') from jsonb_array_elements(t.j('vrep') -> 'actions_appendix' -> 'actions') a),
  'viewer report pseudonymises assignees in the snapshot and appendix');
select t.ok(t.get('vrep') not like '%' || t.u(5) || '%' and t.get('vrep') not like '%' || t.u(12) || '%'
  and t.get('vrep') not like '%' || t.u(3) || '%' and t.get('vrep') not like '%Ayo Assessor%' and t.get('vrep') not like '%Tunde Fixer%',
  'viewer report contains no assignee or assessor IDs or names');
reset role;
select t.ok((select (private.redact_inputs(inputs) - 'actions') = private.redact_inputs(inputs - 'actions')
  from public.report_revisions where id = t.id('RF2')), 'action redaction leaves the rest of the redaction unchanged');

-- ---------------------------------------------------------------- samples: no findings, no actions
select t.as(1);
select t.put('SM', public.create_sample_session(t.id('ws'), t.id('L1'), t.id('TVf'))::text);
select t.err($$select public.create_finding(t.id('SM'), (select subject_id from public.session_subjects where session_id = t.id('SM') limit 1),
  'low', 'X', null, null, gen_random_uuid())$$, 'sample_not_allowed', 'sample sessions refuse findings');
do $$
declare r record;
begin
  for r in select subject_id from public.session_subjects where session_id = t.id('SM') loop
    perform t.score(t.id('SM'), r.subject_id, 1, 'early', '{"taste":1,"hygiene":1}');
    perform public.resolve_outcome(t.id('SM'), r.subject_id, 'early', null, t.rv(t.id('SM'), r.subject_id));
  end loop;
end $$;
select public.approve_session(t.id('SM'), t.dv(t.id('SM')));
reset role;
select t.ok(t.generated(t.id('SM')) = 0 and (select jsonb_array_length(inputs -> 'findings') = 0 and jsonb_array_length(inputs -> 'actions') = 0
  from public.report_revisions where session_id = t.id('SM')), 'sample approval generates no findings even with low scores');

-- ---------------------------------------------------------------- all three packs and old versions
select t.as(1);
select t.put('R', public.create_session(t.id('ws'), t.id('L1'), t.id('TVr'), 'Kitchen check', current_date, array[t.id('S3')],
  array[t.u(5)], array[t.u(3)], 48, null)::text);
select t.put('P', public.create_session(t.id('ws'), t.id('L1'), t.id('TVp'), 'Supplier check', current_date, array[t.id('S4'), t.id('S2')],
  array[t.u(5)], array[t.u(3)], 48, null)::text);
select t.put('O', public.create_session(t.id('ws'), t.id('L1'), t.id('TVold'), 'Old panel', current_date, array[t.id('S1')],
  array[t.u(5)], array[t.u(3)], 48, '09:00')::text);
select t.as(5);
select t.score(t.id('R'), t.id('S3'), 5, null, '{"hygiene":2,"service_quality":{"na":"Not served"}}');
select t.score(t.id('P'), t.id('S4'), 5, null, '{"quality":2,"timeliness":1}');
select t.score(t.id('P'), t.id('S2'), 5, null, '{"quality":3,"timeliness":1}');
select t.score(t.id('O'), t.id('S1'), 5, 'early', '{"taste":1,"hygiene":1}');
select t.as(3);
select public.confirm_na(t.id('R'), t.id('S3'), t.u(5), 1);
select public.resolve_outcome(t.id('R'), t.id('S3'), 'assessed', null, t.rv(t.id('R'), t.id('S3')));
select public.resolve_outcome(t.id('P'), t.id('S4'), 'assessed', null, t.rv(t.id('P'), t.id('S4')));
select public.resolve_outcome(t.id('P'), t.id('S2'), 'assessed', null, t.rv(t.id('P'), t.id('S2')));
select public.resolve_outcome(t.id('O'), t.id('S1'), 'early', null, t.rv(t.id('O'), t.id('S1')));
select public.approve_session(t.id('R'), t.dv(t.id('R')));
select public.approve_session(t.id('P'), t.dv(t.id('P')));
select public.approve_session(t.id('O'), t.dv(t.id('O')));
reset role;
select t.ok(t.generated(t.id('R')) = 1 and (select severity from public.findings where id = t.finding(t.id('R'), t.id('S3'), 'hygiene', 1)) = 'critical',
  'restaurant pack: critical criterion at 2 raises a critical finding; N/A raises nothing');
select t.ok(t.generated(t.id('P')) = 1 and (select severity from public.findings where id = t.finding(t.id('P'), t.id('S4'), 'quality', 1)) = 'high'
  and t.finding(t.id('P'), t.id('S2'), 'quality', 1) is null, 'supplier pack: trigger 2 raises high at 2, nothing at 3; untriggered criterion ignored');
select t.ok(t.generated(t.id('O')) = 0, 'a template version without triggers never generates findings, even at score 1');

-- ---------------------------------------------------------------- repeat tag uses compatible prior evidence
select t.as(1);
select t.put('F2', public.create_session(t.id('ws'), t.id('L1'), t.id('TVf'), 'Market panel', current_date,
  array[t.id('S1'), t.id('S2')], array[t.u(5)], array[t.u(3)], 48, '09:00')::text);
select t.as(5);
select t.score(t.id('F2'), t.id('S1'), 5, 'early', '{"taste":1,"hygiene":5}');
select t.score(t.id('F2'), t.id('S2'), 5, 'early', '{"taste":2,"hygiene":5}');
select t.as(3);
select public.resolve_outcome(t.id('F2'), t.id('S1'), 'early', null, t.rv(t.id('F2'), t.id('S1')));
select public.resolve_outcome(t.id('F2'), t.id('S2'), 'early', null, t.rv(t.id('F2'), t.id('S2')));
select public.approve_session(t.id('F2'), t.dv(t.id('F2')));
reset role;
select t.ok((select detail -> 'repeat' ->> 'status' = 'repeat' and detail -> 'repeat' -> 'sessions_with_finding' ->> 0 = t.get('F')
  from public.findings where id = t.finding(t.id('F2'), t.id('S1'), 'taste', 1)), 'same subject and criterion in a compatible prior session is tagged repeat');
select t.ok((select detail -> 'repeat' ->> 'status' = 'insufficient_data' and (detail -> 'repeat' ->> 'prior_sessions_checked')::int = 1
  from public.findings where id = t.finding(t.id('F2'), t.id('S2'), 'taste', 1)), 'fewer compatible prior sessions than the window is insufficient data');

-- ---------------------------------------------------------------- cross-business isolation
select t.as(1);
select t.err($$select public.get_action(t.id('XB'))$$, 'not_found', 'A cannot read B''s action');
select t.err($$select public.transition_action(t.id('XB'), 'start', 1, null, null, gen_random_uuid())$$, 'not_found', 'A cannot progress B''s action');
select t.err($$select public.update_action(t.id('XB'), 1, 'x', null, null, null, null, null, gen_random_uuid())$$, 'not_found', 'A cannot edit B''s action');
select t.err($$select public.withdraw_finding(t.id('GB'), 'x', 1)$$, 'not_found', 'A cannot withdraw B''s finding');
select t.err($$select public.get_findings(t.id('FB'))$$, 'not_found', 'A cannot list B''s findings');
select t.err($$select public.get_action_assignees(t.id('FB'))$$, 'not_found', 'A cannot list B''s staff');
select t.err($$select public.get_actions(t.id('wsB'), null)$$, 'not_found', 'A cannot list B''s actions');
select t.err($$select public.get_inbox(t.id('wsB'))$$, 'not_found', 'A cannot open B''s inbox');
select t.err($$select public.get_analytics(t.id('wsB'), 'approved', '{}', 'view')$$, 'not_found', 'A cannot read B''s analytics');
select t.ok(t.n($$select 1 from public.actions where id = t.id('XB')$$) = 0 and t.n($$select 1 from public.findings where id = t.id('GB')$$) = 0,
  'A reads none of B''s rows');
select t.as(10);
select t.ok(t.n('select 1 from public.actions') = 1 and t.n('select 1 from public.findings') = 1, 'B reads only its own rows');
select t.err($$select public.get_action(t.id('X2'))$$, 'not_found', 'B cannot read A''s action');
select t.err($$select public.get_session_report(t.id('F'), null, false, 'view')$$, 'not_found', 'B cannot read A''s report');

-- ---------------------------------------------------------------- one person in both businesses
select t.as(10);
select t.put('invB5', public.create_invitation(t.id('wsB'), 'm3-act-fixture-5@savour.test', 'assessor', true, '{}', null, null) ->> 'token');
select t.as(5);
select public.accept_invitation(t.get('invB5'), 'Ayo in B');
select t.err($$select public.mark_notification_read(t.id('wsB'), t.nid(5, 'action_verified'))$$, 'not_found', 'a member of both businesses cannot mark A''s notice under B');
select t.ok((select count(*) from jsonb_array_elements(public.get_actions(t.id('wsB'), null) -> 'actions')) = 0
  and (select bool_and(a ->> 'workspace_id' = t.get('ws')) from jsonb_array_elements(public.get_actions(t.id('ws'), null) -> 'actions') a),
  'each business lists only its own actions, labelled with their business');
select t.ok((public.get_action(t.id('XR')) -> 'action' ->> 'workspace_id') = t.get('ws'), 'action detail names its business for route checks');

-- ---------------------------------------------------------------- audit trail
reset role;
select t.ok(t.audits('action.created') >= 9 and t.audits('action.verify') >= 5 and t.audits('action.cancel') = 2
  and t.audits('finding.created') = 2 and t.audits('finding.withdrawn') = 1 and t.audits('action.reassigned') = 1,
  'every write is audited once (replays write no audit row)');
select t.ok(not exists (select 1 from public.action_events e join public.actions a on a.id = e.action_id
  where (e.after ->> 'version')::int > a.version), 'event versions never run ahead of the action');
select t.ok(t.pins_ok(), 'all snapshots unchanged at the end');

select count(*) as passed from t.passes;
rollback;
