-- Sol independent read-only pin of all 15 pre-Milestone 3 disposable approvals.
-- Run before/after migrations and workflow/race/export checks on savour-dev only.
-- This script makes no changes. Historical hash, body and formula must all match.
begin;
set transaction read only;
do $$
declare missing integer;
begin
  if exists (select 1 from public.report_revisions
      where inputs_hash is distinct from encode(sha256(convert_to(inputs::text, 'UTF8')), 'hex')
         or formula_version is distinct from inputs->>'formula_version') then
    raise exception 'FAIL: approved snapshot body/hash/formula mismatch';
  end if;
  select count(*) into missing from (values
  ('03c655dd-8d3d-4d24-a8ed-69a93b4e1f66'::uuid, 1, '05f3dda35f1bec4cd7607c7d4495cee9bd051dcc29cf2f5e938c09cb25883b6b', 'savour-m2.1', '05f3dda35f1bec4cd7607c7d4495cee9bd051dcc29cf2f5e938c09cb25883b6b'),
  ('040f4861-24b2-4869-9da1-e75d68086880'::uuid, 1, '48561ca52a459edb004f942918f0c3cdeb8ac902bde4fbb55afe26ea7238585a', 'savour-m1.1', '48561ca52a459edb004f942918f0c3cdeb8ac902bde4fbb55afe26ea7238585a'),
  ('040f4861-24b2-4869-9da1-e75d68086880'::uuid, 2, '32e51bc02faf256ac1b9872b58dd13938ed3ff4e85de189f5cb265100cbc97c6', 'savour-m2.1', '32e51bc02faf256ac1b9872b58dd13938ed3ff4e85de189f5cb265100cbc97c6'),
  ('06d9614b-e5ae-47dd-a012-0ba960db27cf'::uuid, 1, 'f6d454abef0bd2e30fa0c2c36f7cadd21f212ac034f11461ee2835a502015265', 'savour-m1.1', 'f6d454abef0bd2e30fa0c2c36f7cadd21f212ac034f11461ee2835a502015265'),
  ('06d9614b-e5ae-47dd-a012-0ba960db27cf'::uuid, 2, '44b4243209bf615e86b4ddc3e97dac5bdeb76b394d3b83ef748e27ff3dd0f6ee', 'savour-m1.1', '44b4243209bf615e86b4ddc3e97dac5bdeb76b394d3b83ef748e27ff3dd0f6ee'),
  ('170bfaf7-2cf2-42ee-ab61-ee9564458f6b'::uuid, 1, '1852021e75cbbbf8c336e401bbdbf3621fd0c4ab118e45e11d7ee31c774067ba', 'savour-m1.1', '1852021e75cbbbf8c336e401bbdbf3621fd0c4ab118e45e11d7ee31c774067ba'),
  ('170bfaf7-2cf2-42ee-ab61-ee9564458f6b'::uuid, 2, '5c5bbe697f5f9bc3bfa630b47af6e57661b4ca4b7cfc4a64fec17c57b6a14c6c', 'savour-m1.1', '5c5bbe697f5f9bc3bfa630b47af6e57661b4ca4b7cfc4a64fec17c57b6a14c6c'),
  ('170bfaf7-2cf2-42ee-ab61-ee9564458f6b'::uuid, 3, 'b3e4b5a9b75d8c38e76d23109bcd6a2624b077b7f483d7993d8cc6d7f274ae35', 'savour-m1.1', 'b3e4b5a9b75d8c38e76d23109bcd6a2624b077b7f483d7993d8cc6d7f274ae35'),
  ('23f53a3e-6955-4c1e-a963-841140e728c9'::uuid, 1, '446595d3a2810658f0889fbdde89d30648bbf3773d100003114773632a976132', 'savour-m1.1', '446595d3a2810658f0889fbdde89d30648bbf3773d100003114773632a976132'),
  ('327f5ca7-f240-42cf-8690-f0487da15229'::uuid, 1, '773d2c8520651d9ec63f750f4cb62efc0287ccb65238f93025eaaae9ecc60c1a', 'savour-m2.1', '773d2c8520651d9ec63f750f4cb62efc0287ccb65238f93025eaaae9ecc60c1a'),
  ('c35501f7-5bcb-42be-b3d4-ad74315006e3'::uuid, 1, '7d8279db89fe53ff90bac0f9ac5e7d694dd8cc1a2421460c0376d77d49b06841', 'savour-m2.1', '7d8279db89fe53ff90bac0f9ac5e7d694dd8cc1a2421460c0376d77d49b06841'),
  ('c5d724ff-0244-4589-8aac-8787f406289b'::uuid, 1, '723a4ef1f57267277f7b85af073c48d960c29bf517c45fd20af3ca99ce2f81f6', 'savour-m2.1', '723a4ef1f57267277f7b85af073c48d960c29bf517c45fd20af3ca99ce2f81f6'),
  ('dcdd34e1-b8dc-43e1-8934-b011ce6ddd49'::uuid, 1, 'fc8b6a6a6b0ab382a060f2b7ab031265ae7e98d87a294577f6a47865630840ec', 'savour-m2.1', 'fc8b6a6a6b0ab382a060f2b7ab031265ae7e98d87a294577f6a47865630840ec'),
  ('dcdd34e1-b8dc-43e1-8934-b011ce6ddd49'::uuid, 2, 'dd58f462c5b49cf1af93116cb6a327927b7b280a961186cc051ee8c69edbc64e', 'savour-m2.1', 'dd58f462c5b49cf1af93116cb6a327927b7b280a961186cc051ee8c69edbc64e'),
  ('ed3b7127-ba79-4cc3-b597-01943b5350bc'::uuid, 1, 'fc9c489b112e1c0314998e5f7239eb178d28be003325a695e9ca9d576ca1fbf1', 'savour-m2.1', 'fc9c489b112e1c0314998e5f7239eb178d28be003325a695e9ca9d576ca1fbf1')
  ) p(session_id, revision, inputs_hash, formula_version, content_sha256)
  where not exists (
    select 1 from public.report_revisions r
    where r.session_id = p.session_id and r.revision = p.revision
      and r.inputs_hash = p.inputs_hash and r.formula_version = p.formula_version
      and r.inputs->>'formula_version' = p.formula_version
      and encode(sha256(convert_to(r.inputs::text, 'UTF8')), 'hex') = p.content_sha256
  );
  if missing > 0 then raise exception 'FAIL: % pinned baseline revisions missing or changed', missing; end if;
end $$;
select count(*) as snapshots_checked, 15 as baseline_snapshots_pinned from public.report_revisions;
rollback;
