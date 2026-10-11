-- SAVOUR Milestone 2: subject directory, contacts and CSV import (migration 20261010230959).
--
-- One transaction, ROLLED BACK. Runs as the database owner and switches to `authenticated`
-- with JWT claims, as PostgREST does:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m2_directory.sql
-- Fixture user IDs use the disposable prefix eeeeeeee-0000-4000-8000-0000000002xx.
-- Any failed expectation raises 'FAIL: ...'. The final SELECT prints the pass count.
-- Sequential only: concurrency here is the lock/version/plan-hash contract, not a parallel race.

begin;

create schema t;
grant usage on schema t to authenticated, anon;
create table t.vars (k text primary key, v text);
create table t.passes (n integer generated always as identity, msg text);
grant all on t.vars, t.passes to authenticated, anon;

create function t.u(n integer) returns uuid language sql immutable as
$$ select ('eeeeeeee-0000-4000-8000-' || lpad((200 + n)::text, 12, '0'))::uuid $$;
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
-- One CSV row as the server action sends it.
create function t.row(p_line integer, p_cells jsonb) returns jsonb language sql immutable as
$$ select jsonb_build_object('line', p_line, 'cells', p_cells) $$;
-- Row verdict from a plan, by line.
create function t.verdict(p_plan jsonb, p_line integer) returns jsonb language sql immutable as
$$ select x from jsonb_array_elements(p_plan -> 'rows') x where (x ->> 'line')::int = p_line $$;
-- Owner-side counts that bypass RLS (test helper runs as the database owner when reset).
create function t.subjects_named(p_ws uuid, p_name text) returns bigint language sql stable security definer as
$$ select count(*) from public.subjects where workspace_id = p_ws and name = p_name $$;
grant execute on function t.subjects_named(uuid, text) to authenticated;

-- Users: 1 owner A, 2 admin A, 3 reviewer A, 4 assessor A, 5 guest A, 6 viewer A, 10 owner B.
insert into auth.users (id, email, email_confirmed_at)
select t.u(n), 'm2-dir-fixture-' || n || '@savour.test', now() from unnest(array[1, 2, 3, 4, 5, 6, 10]) n;

-- ---------------------------------------------------------------- tenants with identical labels
select t.as(1);
select t.put('wsA', public.create_workspace('Same Label Foods', 'Nigeria', 'Africa/Lagos', 'Owner A')::text);
select t.put('L1', public.upsert_location(t.id('wsA'), null, 'Main Site', false)::text);
select t.put('L2', public.upsert_location(t.id('wsA'), null, 'Annex', false)::text);
select t.put('LX', public.upsert_location(t.id('wsA'), null, 'Old Yard', false)::text);
select public.upsert_location(t.id('wsA'), t.id('LX'), 'Old Yard', true);
select t.put('catA', public.save_category(t.id('wsA'), null, 'Grills', false, null) ->> 'id');
select t.put('catOld', public.save_category(t.id('wsA'), null, 'Retired', true, null) ->> 'id');
select t.err($$select public.save_category(t.id('wsA'), null, '  grills ', false, null)$$, 'duplicate_name', 'category names unique per workspace (case/space-insensitive)');
select t.err($$select public.save_category(t.id('wsA'), t.id('catA'), 'Grill', false, null)$$, 'stale_version', 'category edit needs an expected version');
select t.ok((public.save_category(t.id('wsA'), t.id('catA'), 'Grills', false, 1) ->> 'version')::int = 2, 'category edit with version');
select t.put('S1', public.save_subject(t.id('wsA'), null, 'Vendor One', 'vendor', t.id('catA'), 'V-001',
  array[t.id('L1')], false, null) ->> 'id');
select t.ok(public.save_subject_contact(t.id('wsA'), t.id('S1'), 'Ada Contact', '+234 800 000 0001', 'Ada@Example.test', 0) = 1,
  'owner saves a private contact');
select t.err($$select public.save_subject_contact(t.id('wsA'), t.id('S1'), 'X', null, null, 0)$$, 'stale_version', 'contact edit needs current version');
select t.err($$select public.save_subject(t.id('wsA'), null, 'vendor  ONE', 'vendor', null, null, '{}', false, null)$$,
  'duplicate_name', 'manual create refuses an existing name (never a silent duplicate)');
select t.err($$select public.save_subject(t.id('wsA'), null, 'Vendor Nine', 'vendor', null, 'v-001', '{}', false, null)$$,
  'duplicate_external_id', 'external IDs unique per workspace, case-insensitive');
select t.err($$select public.save_subject(t.id('wsA'), null, 'Vendor Nine', 'vendor', t.id('catOld'), null, '{}', false, null)$$,
  'not_found%', 'archived category cannot be newly assigned');
select t.err($$select public.save_subject(t.id('wsA'), null, 'Vendor Nine', 'vendor', null, null, array[t.id('LX')], false, null)$$,
  'not_found%', 'archived location cannot be newly linked');
select t.put('S2', public.save_subject(t.id('wsA'), null, 'Vendor Two', 'vendor', null, null, '{}', false, null) ->> 'id');
select t.put('TV', public.publish_template(t.id('wsA'), null, 'Panel', 'food_vendors', 'off', '[{"key":"taste","label":"Taste"}]')::text);

select t.as(10);
select t.put('wsB', public.create_workspace('Same Label Foods', 'Nigeria', 'Africa/Lagos', 'Owner B')::text);
select t.put('BL1', public.upsert_location(t.id('wsB'), null, 'Main Site', false)::text);
select t.put('BcatA', public.save_category(t.id('wsB'), null, 'Grills', false, null) ->> 'id');
select t.put('BS1', public.save_subject(t.id('wsB'), null, 'Vendor One', 'vendor', t.id('BcatA'), 'V-001', array[t.id('BL1')], false, null) ->> 'id');
select t.ok(t.id('BS1') <> t.id('S1'), 'identical name and external ID coexist across workspaces');
select t.err($$select public.save_subject(t.id('wsB'), null, 'X', 'vendor', t.id('catA'), null, '{}', false, null)$$,
  'not_found%', 'B cannot attach A category');
select t.err($$select public.save_subject(t.id('wsB'), null, 'X', 'vendor', null, null, array[t.id('L1')], false, null)$$,
  'not_found%', 'B cannot link A location');
select t.err($$select public.save_subject(t.id('wsB'), t.id('S1'), 'Hijack', 'vendor', null, null, '{}', false, 1)$$,
  'not_found%', 'B cannot edit A subject');
select t.err($$select public.save_subject_contact(t.id('wsB'), t.id('S1'), 'X', null, null, 1)$$, 'not_found%', 'B cannot edit A contact');
select t.err($$select public.get_subject_directory(t.id('wsA'))$$, 'forbidden', 'B cannot read A directory');
select t.err($$select public.preview_subject_import(t.id('wsA'), jsonb_build_array(t.row(2, '{"name":"X","type":"vendor"}')))$$,
  'forbidden', 'B cannot preview into A');
select t.ok(t.n('select 1 from public.subject_contacts') = 0 and t.n('select 1 from public.categories') = 1
  and t.n('select 1 from public.subject_locations') = 1, 'B reads only its own categories, contacts and links');
select t.ok(jsonb_array_length(public.get_subject_directory(t.id('wsB')) -> 'subjects') = 1, 'B directory has only its subject');
select t.err($$insert into public.categories (workspace_id, name) values (t.id('wsA'), 'Sneaky')$$, 'permission denied%', 'no direct category writes');
select t.err($$insert into public.subject_contacts (workspace_id, subject_id, name, updated_by) values (t.id('wsB'), t.id('BS1'), 'x', t.u(10))$$,
  'permission denied%', 'no direct contact writes');
select t.err($$select external_id from public.subjects$$, 'permission denied%', 'external_id is not client-readable');
select t.err($$select category_id from public.subjects$$, 'permission denied%', 'category_id is not client-readable');

-- ---------------------------------------------------------------- staff, guest and contact visibility
select t.as(1);
select t.put('inv_admin', public.create_invitation(t.id('wsA'), 'm2-dir-fixture-2@savour.test', 'admin', true, '{}', null, null) ->> 'token');
select t.put('inv_rev', public.create_invitation(t.id('wsA'), 'm2-dir-fixture-3@savour.test', 'reviewer', false, array[t.id('L1')], null, null) ->> 'token');
select t.put('inv_as', public.create_invitation(t.id('wsA'), 'm2-dir-fixture-4@savour.test', 'assessor', false, array[t.id('L1')], null, null) ->> 'token');
select t.put('inv_view', public.create_invitation(t.id('wsA'), 'm2-dir-fixture-6@savour.test', 'viewer', true, '{}', null, null) ->> 'token');
select t.as(2); select public.accept_invitation(t.get('inv_admin'), 'Admin A');
select t.as(3); select public.accept_invitation(t.get('inv_rev'), 'Reviewer A');
select t.as(4); select public.accept_invitation(t.get('inv_as'), 'Assessor A');
select t.as(6); select public.accept_invitation(t.get('inv_view'), 'Viewer A');
select t.as(1);
select t.put('SES', public.create_session(t.id('wsA'), t.id('L1'), t.id('TV'), 'Directory session', current_date,
  array[t.id('S1')], array[t.u(4)], array[t.u(3)], 48, null)::text);
select t.put('inv_guest', public.create_invitation(t.id('wsA'), 'm2-dir-fixture-5@savour.test', 'guest', false, '{}', t.id('SES'), array[t.id('S1')]) ->> 'token');
select t.as(5); select public.accept_invitation(t.get('inv_guest'), 'Guest A');

select t.as(5);
select t.ok(t.n('select 1 from public.subjects') = 1, 'guest reads its one roster subject');
select t.ok(t.n('select 1 from public.subject_contacts') = 0, 'guest reads no contacts (direct SELECT)');
select t.ok(t.n('select 1 from public.categories') = 0 and t.n('select 1 from public.subject_locations') = 0, 'guest reads no categories or links');
select t.ok(t.n('select id, name, subject_type, is_sample from public.subjects') = 1, 'guest subject row carries only M1 columns and the sample label');
select t.err($$select external_id from public.subjects$$, 'permission denied%', 'guest cannot read external IDs');
select t.err($$select public.get_subject_directory(t.id('wsA'))$$, 'forbidden', 'guest has no directory RPC');
select t.as(4);
select t.ok(t.n('select 1 from public.subject_contacts') = 0, 'assessor reads no contacts');
select t.err($$select public.get_subject_directory(t.id('wsA'))$$, 'forbidden', 'assessor has no directory RPC');
select t.as(3);
select t.ok(t.n('select 1 from public.subject_contacts') = 0, 'reviewer reads no contacts (private owner/admin metadata)');
select t.err($$select public.save_subject(t.id('wsA'), null, 'R', 'vendor', null, null, '{}', false, null)$$, 'forbidden', 'reviewer cannot edit directory');
select t.err($$select public.preview_subject_import(t.id('wsA'), jsonb_build_array(t.row(2, '{"name":"X","type":"vendor"}')))$$,
  'forbidden', 'reviewer cannot preview imports');
select t.as(6);
select t.ok(t.n('select 1 from public.subject_contacts') = 0 and t.n('select 1 from public.subjects') = 0, 'viewer reads no subjects or contacts');
select t.as(2);
select t.ok(t.n('select 1 from public.subject_contacts') = 1, 'admin reads contacts');
select t.ok((public.get_subject_directory(t.id('wsA')) -> 'subjects')::text like '%ada@example.test%', 'directory RPC returns contact (email lower-cased)');
select t.ok(not ((public.get_session_report(t.id('SES'), null, false, 'view'))::text like '%Ada Contact%'), 'contacts never enter report inputs');

-- ---------------------------------------------------------------- import validation (preview writes nothing)
select t.as(1);
select t.put('L1dup', public.upsert_location(t.id('wsA'), null, 'Twin Site', false)::text);
select public.upsert_location(t.id('wsA'), null, 'Twin Site', false);
select t.put('S3', public.save_subject(t.id('wsA'), null, 'Archived Stall', 'vendor', null, 'V-ARCH', '{}', true, null) ->> 'id');
select t.put('plan', public.preview_subject_import(t.id('wsA'), jsonb_build_array(
  t.row(2, '{"name":"Ọ̀ṣun Grill","type":"Vendor","category":"grills","locations":"Main Site; annex","external_id":"V-100"}'),
  t.row(3, '{"name":"Vendor One","type":"vendor"}'),
  t.row(4, '{"name":"Dup Ext A","type":"vendor","external_id":"X-1"}'),
  t.row(5, '{"name":"Dup Ext B","type":"vendor","external_id":"x-1"}'),
  t.row(6, '{"name":"Same Name","type":"vendor"}'),
  t.row(7, '{"name":"same  name","type":"outlet"}'),
  t.row(8, '{"name":"Bad Type","type":"spaceship"}'),
  t.row(9, '{"name":"Unknown Cat","type":"vendor","category":"Nope"}'),
  t.row(10, '{"name":"Old Cat","type":"vendor","category":"Retired"}'),
  t.row(11, '{"name":"Old Loc","type":"vendor","locations":"Old Yard"}'),
  t.row(12, '{"name":"Twin Loc","type":"vendor","locations":"Twin Site"}'),
  t.row(13, '{"name":"","type":"vendor"}'),
  t.row(14, '{"name":"Restore Me","type":"vendor","external_id":"V-ARCH"}'),
  t.row(15, '{"name":"Bad Mail","type":"vendor","contact_email":"not-an-email"}'),
  t.row(16, '{"name":"Vendor Uno","type":"vendor","external_id":"V-001"}')))::text);
select t.ok((t.j('plan') ->> 'valid')::boolean = false and (t.j('plan') -> 'counts' ->> 'create')::int = 1
  and (t.j('plan') -> 'counts' ->> 'update')::int = 1, 'mixed file: one create, one update, the rest errors');
select t.ok(t.verdict(t.j('plan'), 2) ->> 'action' = 'create' and t.verdict(t.j('plan'), 2) ->> 'type' = 'vendor'
  and jsonb_array_length(t.verdict(t.j('plan'), 2) -> 'location_ids') = 2 and t.verdict(t.j('plan'), 2) ->> 'category' = 'Grills',
  'Unicode name, case-insensitive type/category/location labels resolve');
select t.ok(t.verdict(t.j('plan'), 3) ->> 'action' = 'error' and (t.verdict(t.j('plan'), 3) -> 'errors')::text like '%already exists%V-001%',
  'name match without external ID is an error naming the ID to use (never merged)');
select t.ok(t.verdict(t.j('plan'), 4) ->> 'action' = 'error' and t.verdict(t.j('plan'), 5) ->> 'action' = 'error'
  and (t.verdict(t.j('plan'), 4) -> 'errors')::text like '%lines 4, 5%', 'every repeated external ID occurrence is an error');
select t.ok(t.verdict(t.j('plan'), 6) ->> 'action' = 'error' and t.verdict(t.j('plan'), 7) ->> 'action' = 'error',
  'in-file duplicate names (case/space-insensitive) are errors');
select t.ok((t.verdict(t.j('plan'), 8) -> 'errors')::text like '%Type must be%', 'invalid type explained');
select t.ok((t.verdict(t.j('plan'), 9) -> 'errors')::text like '%Unknown category%', 'unknown category explained');
select t.ok((t.verdict(t.j('plan'), 10) -> 'errors')::text like '%archived%', 'archived category explained');
select t.ok((t.verdict(t.j('plan'), 11) -> 'errors')::text like '%archived%', 'archived location explained');
select t.ok((t.verdict(t.j('plan'), 12) -> 'errors')::text like '%matches 2 active locations%', 'ambiguous duplicate location names are an explicit error');
select t.ok((t.verdict(t.j('plan'), 13) -> 'errors')::text like '%Name is required%', 'blank name explained');
select t.ok((t.verdict(t.j('plan'), 14) -> 'errors')::text like '%Restore it first%', 'archived subject never auto-restored');
select t.ok((t.verdict(t.j('plan'), 15) -> 'errors')::text like '%Contact email%', 'invalid contact email explained');
select t.ok(t.verdict(t.j('plan'), 16) ->> 'action' = 'update' and t.verdict(t.j('plan'), 16) -> 'changes' = '["name"]'
  and t.verdict(t.j('plan'), 16) -> 'before' ->> 'name' = 'Vendor One', 'external ID update labels changed fields with before values');
select t.ok(t.subjects_named(t.id('wsA'), 'Ọ̀ṣun Grill') = 0, 'preview writes nothing');
select t.err($$select public.preview_subject_import(t.id('wsA'), '[]')$$, 'import_empty', 'empty import rejected');
select t.err($$select public.preview_subject_import(t.id('wsA'), (select jsonb_agg(t.row(g, jsonb_build_object('name', 'N' || g, 'type', 'vendor'))) from generate_series(1, 501) g))$$,
  'import_too_large', 'more than 500 rows rejected');
select t.err($$select public.preview_subject_import(t.id('wsA'), jsonb_build_array(t.row(2, '{"name":"X","type":"vendor","secret":"y"}')))$$,
  'invalid_import', 'unknown column rejected server-side');
select t.err($$select public.preview_subject_import(t.id('wsA'), jsonb_build_array(t.row(2, '{"name":5,"type":"vendor"}')))$$,
  'invalid_import', 'non-text cell rejected server-side');
select t.err($$select public.preview_subject_import(t.id('wsA'), jsonb_build_array(t.row(2, '{"name":"A","type":"vendor"}'), t.row(2, '{"name":"B","type":"vendor"}')))$$,
  'invalid_import', 'duplicate line numbers rejected');

-- ---------------------------------------------------------------- atomic commit: any error, no rows
select t.err(format($$select public.commit_subject_import(t.id('wsA'), gen_random_uuid(), %L::jsonb, %L)$$,
  jsonb_build_array(t.row(2, '{"name":"Good Row","type":"vendor"}'), t.row(3, '{"name":"Bad Row","type":"spaceship"}')),
  (public.preview_subject_import(t.id('wsA'), jsonb_build_array(t.row(2, '{"name":"Good Row","type":"vendor"}'), t.row(3, '{"name":"Bad Row","type":"spaceship"}'))) ->> 'plan_hash')),
  'import_invalid', 'one bad row fails the whole import');
select t.ok(t.subjects_named(t.id('wsA'), 'Good Row') = 0, 'failed import created no partial rows');
select t.ok(t.n('select 1 from public.subject_imports') = 0, 'failed import records no receipt');

-- ---------------------------------------------------------------- confirm, replay, conflict
select t.put('rows', jsonb_build_array(
  t.row(2, '{"name":"Fresh Stall","type":"vendor","external_id":"V-200","category":"Grills","locations":"Main Site","contact_name":"Bola","contact_phone":"0800"}'),
  t.row(3, '{"name":"Vendor One","type":"vendor","external_id":"V-001","contact_email":"new@example.test"}'))::text);
select t.put('plan2', public.preview_subject_import(t.id('wsA'), t.j('rows'))::text);
select t.ok(t.verdict(t.j('plan2'), 3) ->> 'action' = 'update' and t.verdict(t.j('plan2'), 3) -> 'changes' = '["contact"]'
  and t.verdict(t.j('plan2'), 3) -> 'contact' ->> 'name' = 'Ada Contact'
  and t.verdict(t.j('plan2'), 3) -> 'before' -> 'contact' ->> 'email' = 'ada@example.test',
  'email-only contact update previews merged contact with before values');
select t.err(format($$select public.commit_subject_import(t.id('wsA'), gen_random_uuid(), %L::jsonb, null)$$, t.get('rows')),
  'stale_preview', 'commit requires the previewed plan hash');
select t.err(format($$select public.commit_subject_import(t.id('wsA'), null, %L::jsonb, %L)$$, t.get('rows'), t.j('plan2') ->> 'plan_hash'),
  'idempotency_key_required', 'commit requires an idempotency key');
select t.put('key', gen_random_uuid()::text);
select t.put('receipt', public.commit_subject_import(t.id('wsA'), t.id('key'), t.j('rows'), t.j('plan2') ->> 'plan_hash')::text);
select t.ok((t.j('receipt') ->> 'created')::int = 1 and (t.j('receipt') ->> 'updated')::int = 1 and t.j('receipt') ->> 'import_id' is not null
  and not (t.j('receipt') ->> 'replayed')::boolean, 'confirmed import writes once and returns a receipt');
select t.ok(t.subjects_named(t.id('wsA'), 'Fresh Stall') = 1, 'created subject exists');
select t.ok((select c from jsonb_array_elements(public.get_subject_directory(t.id('wsA')) -> 'subjects') s, lateral (select s -> 'contact' as c) x
  where s ->> 'id' = t.get('S1')) = '{"name":"Ada Contact","phone":"+234 800 000 0001","email":"new@example.test","version":2}'::jsonb,
  'email-only import keeps stored contact name and phone');
select t.put('replay', public.commit_subject_import(t.id('wsA'), t.id('key'), t.j('rows'), t.j('plan2') ->> 'plan_hash')::text);
select t.ok((t.j('replay') ->> 'replayed')::boolean and (t.j('replay') - 'replayed') = (t.j('receipt') - 'replayed'),
  'identical retry returns the identical receipt (including import_id)');
select t.ok(t.subjects_named(t.id('wsA'), 'Fresh Stall') = 1, 'retry created nothing new');
select t.put('replay2', public.commit_subject_import(t.id('wsA'), t.id('key'), t.j('rows'), 'any-stale-hash')::text);
select t.ok((t.j('replay2') - 'replayed') = (t.j('receipt') - 'replayed'), 'replay after the directory changed still returns the stored receipt');
select t.err(format($$select public.commit_subject_import(t.id('wsA'), t.id('key'), %L::jsonb, %L)$$,
  jsonb_build_array(t.row(2, '{"name":"Other","type":"vendor"}')), 'x'), 'idempotency_conflict', 'same key with changed payload conflicts');
select t.as(2);
select t.err(format($$select public.commit_subject_import(t.id('wsA'), t.id('key'), %L::jsonb, %L)$$,
  jsonb_build_array(t.row(2, '{"name":"Other","type":"vendor"}')), 'x'), 'idempotency_conflict', 'key is per workspace, not per user');
select t.as(10);
select t.ok((public.commit_subject_import(t.id('wsB'), t.id('key'), jsonb_build_array(t.row(2, '{"name":"B Import","type":"vendor"}')),
  public.preview_subject_import(t.id('wsB'), jsonb_build_array(t.row(2, '{"name":"B Import","type":"vendor"}'))) ->> 'plan_hash') ->> 'created')::int = 1,
  'the same key in another workspace is independent');
select t.ok(t.n('select 1 from public.subject_imports') = 1, 'B sees only its own import receipts');

-- ---------------------------------------------------------------- stale preview from overlapping directory edits
select t.as(1);
select t.put('rows3', jsonb_build_array(t.row(2, '{"name":"Late Stall","type":"vendor","locations":"Annex"}'),
  t.row(3, '{"name":"Fresh Stall Renamed","type":"vendor","external_id":"V-200"}'))::text);
select t.put('plan3', public.preview_subject_import(t.id('wsA'), t.j('rows3'))::text);
select public.upsert_location(t.id('wsA'), t.id('L2'), 'Annex East', false);
select t.err(format($$select public.commit_subject_import(t.id('wsA'), gen_random_uuid(), %L::jsonb, %L)$$, t.get('rows3'), t.j('plan3') ->> 'plan_hash'),
  'import_invalid', 'location renamed after preview: commit re-validates and refuses');
select public.upsert_location(t.id('wsA'), t.id('L2'), 'Annex', false);
select t.put('plan3', public.preview_subject_import(t.id('wsA'), t.j('rows3'))::text);
select public.upsert_location(t.id('wsA'), t.id('L2'), 'annex', false);
select t.err(format($$select public.commit_subject_import(t.id('wsA'), gen_random_uuid(), %L::jsonb, %L)$$, t.get('rows3'), t.j('plan3') ->> 'plan_hash'),
  'stale_preview', 'location label changed after preview: stale preview refused');
select t.put('plan3', public.preview_subject_import(t.id('wsA'), t.j('rows3'))::text);
select public.upsert_location(t.id('wsA'), t.id('L2'), 'annex', true);
select t.err(format($$select public.commit_subject_import(t.id('wsA'), gen_random_uuid(), %L::jsonb, %L)$$, t.get('rows3'), t.j('plan3') ->> 'plan_hash'),
  'import_invalid', 'location archived after preview: commit refuses');
select public.upsert_location(t.id('wsA'), t.id('L2'), 'Annex', false);
select t.put('plan3', public.preview_subject_import(t.id('wsA'), t.j('rows3'))::text);
select public.upsert_subject(t.id('wsA'), (select (x ->> 'subject_id')::uuid from jsonb_array_elements(t.j('plan3') -> 'rows') x where x ->> 'line' = '3'),
  'Fresh Stall', 'outlet', false);
select t.err(format($$select public.commit_subject_import(t.id('wsA'), gen_random_uuid(), %L::jsonb, %L)$$, t.get('rows3'), t.j('plan3') ->> 'plan_hash'),
  'stale_preview', 'subject edited (legacy RPC bumps version) after preview: stale preview refused');
select t.ok(t.subjects_named(t.id('wsA'), 'Late Stall') = 0, 'refused imports wrote nothing');

-- ---------------------------------------------------------------- archive/restore keeps identity
select t.put('dirS1', (select s::text from jsonb_array_elements(public.get_subject_directory(t.id('wsA')) -> 'subjects') s where s ->> 'id' = t.get('S1')));
select public.save_subject(t.id('wsA'), t.id('S1'), 'Vendor One', 'vendor', t.id('catA'), 'V-001', array[t.id('L1')], true, (t.j('dirS1') ->> 'version')::int);
select t.put('dirS1', (select s::text from jsonb_array_elements(public.get_subject_directory(t.id('wsA')) -> 'subjects') s where s ->> 'id' = t.get('S1')));
select t.ok(t.j('dirS1') ->> 'archived_at' is not null, 'subject archived');
select public.save_subject(t.id('wsA'), t.id('S1'), 'Vendor One', 'vendor', t.id('catA'), 'V-001', array[t.id('L1')], false, (t.j('dirS1') ->> 'version')::int);
select t.ok(t.n($$select 1 from public.subjects where id = t.id('S1') and archived_at is null$$) = 1, 'restored with the same ID');
select t.ok(t.n($$select 1 from public.session_subjects where subject_id = t.id('S1') and subject_name = 'Vendor One'$$) = 1, 'session roster label unchanged');

-- ---------------------------------------------------------------- sample flag is immutable
reset role;
select t.err($$update public.subjects set is_sample = true where id = t.id('S2')$$, 'immutable_record', 'sample flag cannot change even for the owner role');

reset role;
select count(*) as passed from t.passes;
rollback;
