-- LOCAL_NATIVE_LOGICAL_REHEARSAL_ONLY synthetic fixture, applied after tests/sql/supabase-stub.sql (labelled
-- Auth/Vault doubles) and every real migration. Two businesses through the real public RPCs (same calls as
-- tests/sql/m4-billing.test.ts): each gets a trial billing.workspace_billing row from create_workspace and one
-- approved, immutable report revision. No provider connection, Vault secret, checkout or paid period.
insert into auth.users (id, email, email_confirmed_at) values
  ('eeeeeeee-0000-4000-8000-000000009501', 'rehearsal-owner-a@savour.test', now()),
  ('eeeeeeee-0000-4000-8000-000000009502', 'rehearsal-owner-b@savour.test', now());

do $$
declare
  k text; o uuid; ws uuid; loc uuid; s uuid; tv uuid; sid uuid;
begin
  foreach k in array array['A', 'B'] loop
    o := case k when 'A' then 'eeeeeeee-0000-4000-8000-000000009501'::uuid else 'eeeeeeee-0000-4000-8000-000000009502'::uuid end;
    perform set_config('request.jwt.claims', json_build_object('sub', o, 'role', 'authenticated', 'aal', 'aal1')::text, true);
    perform set_config('role', 'authenticated', true);
    ws := public.create_workspace('Rehearsal Business ' || k, 'Nigeria', 'Africa/Lagos', 'Rehearsal Owner ' || k);
    loc := public.upsert_location(ws, null, 'Main', false);
    s := public.upsert_subject(ws, null, 'Rehearsal Stall ' || k, 'vendor', false);
    tv := public.publish_template(ws, null, 'Rehearsal panel', 'food_vendors', 'off', '[{"key":"taste","label":"Taste"}]'::jsonb, null::jsonb);
    sid := public.create_session(ws, loc, tv, 'Approved panel ' || k, date '2026-10-01', array[s], array[o], array[o], 24, null);
    perform public.submit_assessment(sid, s, o, null, '{"taste":4}'::jsonb, null, 0, gen_random_uuid(), null);
    perform public.resolve_outcome(sid, s, 'assessed', null, 1);
    perform public.approve_session(sid, (select data_version from public.sessions where id = sid));
    perform set_config('role', 'none', true);
  end loop;
end $$;
