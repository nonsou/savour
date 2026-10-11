-- LOCAL ONLY: builds three approved Milestone 1 snapshots (one per starter pack) on a database
-- that has ONLY the two applied M1 migrations, then COMMITS them so the test can apply the
-- Milestone 2 migrations on top and prove the snapshots, hashes and redaction are unchanged.
-- Disposable fixture users use the prefix eeeeeeee-0000-4000-8000-0000000004xx.
create function pg_temp.as_user(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', ('eeeeeeee-0000-4000-8000-' || lpad((400 + n)::text, 12, '0')),
    'role', 'authenticated')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create function pg_temp.u(n integer) returns uuid language sql immutable as
$$ select ('eeeeeeee-0000-4000-8000-' || lpad((400 + n)::text, 12, '0'))::uuid $$;
create table public.legacy_ids (k text primary key, v uuid);
grant all on public.legacy_ids to authenticated;

insert into auth.users (id, email, email_confirmed_at)
select pg_temp.u(n), 'legacy-fixture-' || n || '@savour.test', now() from unnest(array[1, 3, 5]) n;

select pg_temp.as_user(1);
insert into public.legacy_ids values ('ws', public.create_workspace('Legacy QA', 'Nigeria', 'Africa/Lagos', 'Legacy Owner'));
insert into public.legacy_ids values ('L', public.upsert_location((select v from public.legacy_ids where k = 'ws'), null, 'Main', false));
insert into public.legacy_ids
select 'S' || i, public.upsert_subject((select v from public.legacy_ids where k = 'ws'), null, 'Legacy subject ' || i, 'vendor', false)
from generate_series(1, 3) i;
insert into public.legacy_ids values ('TVfood', public.publish_template((select v from public.legacy_ids where k = 'ws'), null, 'Food vendors',
  'food_vendors', 'scored', '[{"key":"taste","label":"Taste"},{"key":"hygiene","label":"Hygiene","allow_na":true}]'));
insert into public.legacy_ids values ('TVrest', public.publish_template((select v from public.legacy_ids where k = 'ws'), null, 'Restaurant operations',
  'restaurant_ops', 'off', '[{"key":"hygiene","label":"Hygiene"},{"key":"service_quality","label":"Service quality","allow_na":true}]'));
insert into public.legacy_ids values ('TVsup', public.publish_template((select v from public.legacy_ids where k = 'ws'), null, 'Supplier and service quality',
  'supplier_service', 'off', '[{"key":"quality","label":"Quality"},{"key":"timeliness","label":"Timeliness"}]'));
create temp table tokens (k text, token text);
grant all on tokens to authenticated;
insert into tokens values ('R', public.create_invitation((select v from public.legacy_ids where k = 'ws'), 'legacy-fixture-3@savour.test',
  'reviewer', true, '{}', null, null) ->> 'token');
insert into tokens values ('A', public.create_invitation((select v from public.legacy_ids where k = 'ws'), 'legacy-fixture-5@savour.test',
  'assessor', true, '{}', null, null) ->> 'token');
select pg_temp.as_user(3); select public.accept_invitation((select token from tokens where k = 'R'), 'Legacy Reviewer');
select pg_temp.as_user(5); select public.accept_invitation((select token from tokens where k = 'A'), 'Legacy Assessor');

select pg_temp.as_user(1);
do $$
declare
  ws uuid := (select v from public.legacy_ids where k = 'ws');
  l uuid := (select v from public.legacy_ids where k = 'L');
  s1 uuid := (select v from public.legacy_ids where k = 'S1');
  s2 uuid := (select v from public.legacy_ids where k = 'S2');
  s3 uuid := (select v from public.legacy_ids where k = 'S3');
  owner uuid := pg_temp.u(1);
  asr uuid := pg_temp.u(5);
  rev uuid := pg_temp.u(3);
  f uuid; r uuid; p uuid;
begin
  f := public.create_session(ws, l, (select v from public.legacy_ids where k = 'TVfood'), 'Legacy food panel', date '2026-10-03',
    array[s1, s2, s3], array[owner], array[rev], 48, '09:00');
  r := public.create_session(ws, l, (select v from public.legacy_ids where k = 'TVrest'), 'Legacy kitchen check', date '2026-10-04',
    array[s1, s2], array[owner], array[rev], 48, null);
  p := public.create_session(ws, l, (select v from public.legacy_ids where k = 'TVsup'), 'Legacy supplier review', date '2026-10-05',
    array[s1], array[owner], array[rev], 48, null);
  insert into public.legacy_ids values ('F', f), ('R', r), ('P', p);
  -- Food: S1 early 4/5 (90%, combined 93.3), S2 late with Hygiene N/A (80%, combined 50 = (4+1)/(5+5)), S3 absent.
  perform public.submit_assessment(f, s1, owner, 'early', '{"taste":4,"hygiene":5}', 'Well seasoned', 0, gen_random_uuid(), null);
  perform public.submit_assessment(f, s2, owner, 'late', '{"taste":4,"hygiene":{"na":"No kitchen on site"}}', null, 0, gen_random_uuid(), null);
  perform public.resolve_outcome(f, s1, 'early', null, 1);
  perform public.resolve_outcome(f, s2, 'late', null, 1);
  perform public.resolve_outcome(f, s3, 'absent', 'Did not arrive', 1);
  perform public.confirm_na(f, s2, owner, 1);
  perform public.approve_session(f, (select data_version from public.sessions where id = f));
  -- Restaurant: S1 assessed 3/5 + N/A (60%), S2 not assessed.
  perform public.submit_assessment(r, s1, owner, null, '{"hygiene":3,"service_quality":{"na":"Closed"}}', null, 0, gen_random_uuid(), null);
  perform public.resolve_outcome(r, s1, 'assessed', null, 1);
  perform public.resolve_outcome(r, s2, 'not_assessed', 'Closed for refit', 1);
  perform public.confirm_na(r, s1, owner, 1);
  perform public.approve_session(r, (select data_version from public.sessions where id = r));
  -- Supplier: S1 assessed 5/4 (90%), then reopened and reapproved at 4/4 (80%).
  perform public.submit_assessment(p, s1, owner, null, '{"quality":5,"timeliness":4}', null, 0, gen_random_uuid(), null);
  perform public.resolve_outcome(p, s1, 'assessed', null, 1);
  perform public.approve_session(p, (select data_version from public.sessions where id = p));
  perform public.reopen_session(p, 'Quality recount');
  perform public.submit_assessment(p, s1, owner, null, '{"quality":4,"timeliness":4}', null, 1, gen_random_uuid(), 'Recount');
  perform public.approve_session(p, (select data_version from public.sessions where id = p));
end $$;
reset role;
