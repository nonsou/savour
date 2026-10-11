-- SAVOUR Milestone 2: read-only snapshot pin for savour-dev (run BEFORE and AFTER applying the
-- Milestone 2 migrations). Writes nothing and ends with ROLLBACK.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m2_snapshot_pin.sql
-- Checks: (1) every approved snapshot still matches its recorded inputs_hash byte for byte;
-- (2) the seven disposable QA snapshots captured before Milestone 2
-- (docs/milestone-2/qa-snapshot-baseline.json) exist with the same hash and formula savour-m1.1;
-- (3) no snapshot was rewritten to another formula label. Raises 'FAIL: ...' on any mismatch.

begin;
set transaction read only;


do $$
declare v_bad integer; v_missing integer;
begin
  select count(*) into v_bad from public.report_revisions
  where inputs_hash <> encode(sha256(convert_to(inputs::text, 'UTF8')), 'hex');
  if v_bad > 0 then raise exception 'FAIL: % snapshot(s) no longer match their recorded hash', v_bad; end if;

  select count(*) into v_missing from (values
  ('040f4861-24b2-4869-9da1-e75d68086880'::uuid, 1, '48561ca52a459edb004f942918f0c3cdeb8ac902bde4fbb55afe26ea7238585a'),
  ('06d9614b-e5ae-47dd-a012-0ba960db27cf'::uuid, 1, 'f6d454abef0bd2e30fa0c2c36f7cadd21f212ac034f11461ee2835a502015265'),
  ('06d9614b-e5ae-47dd-a012-0ba960db27cf'::uuid, 2, '44b4243209bf615e86b4ddc3e97dac5bdeb76b394d3b83ef748e27ff3dd0f6ee'),
  ('170bfaf7-2cf2-42ee-ab61-ee9564458f6b'::uuid, 1, '1852021e75cbbbf8c336e401bbdbf3621fd0c4ab118e45e11d7ee31c774067ba'),
  ('170bfaf7-2cf2-42ee-ab61-ee9564458f6b'::uuid, 2, '5c5bbe697f5f9bc3bfa630b47af6e57661b4ca4b7cfc4a64fec17c57b6a14c6c'),
  ('170bfaf7-2cf2-42ee-ab61-ee9564458f6b'::uuid, 3, 'b3e4b5a9b75d8c38e76d23109bcd6a2624b077b7f483d7993d8cc6d7f274ae35'),
  ('23f53a3e-6955-4c1e-a963-841140e728c9'::uuid, 1, '446595d3a2810658f0889fbdde89d30648bbf3773d100003114773632a976132')
  ) as p (session_id, revision, inputs_hash)
  where not exists (select 1 from public.report_revisions r where r.session_id = p.session_id and r.revision = p.revision
                    and r.inputs_hash = p.inputs_hash and r.formula_version = 'savour-m1.1');
  if v_missing > 0 then raise exception 'FAIL: % baseline QA snapshot(s) missing or changed', v_missing; end if;

  if exists (select 1 from public.report_revisions r join (values
  ('040f4861-24b2-4869-9da1-e75d68086880'::uuid, 1, '48561ca52a459edb004f942918f0c3cdeb8ac902bde4fbb55afe26ea7238585a'),
  ('06d9614b-e5ae-47dd-a012-0ba960db27cf'::uuid, 1, 'f6d454abef0bd2e30fa0c2c36f7cadd21f212ac034f11461ee2835a502015265'),
  ('06d9614b-e5ae-47dd-a012-0ba960db27cf'::uuid, 2, '44b4243209bf615e86b4ddc3e97dac5bdeb76b394d3b83ef748e27ff3dd0f6ee'),
  ('170bfaf7-2cf2-42ee-ab61-ee9564458f6b'::uuid, 1, '1852021e75cbbbf8c336e401bbdbf3621fd0c4ab118e45e11d7ee31c774067ba'),
  ('170bfaf7-2cf2-42ee-ab61-ee9564458f6b'::uuid, 2, '5c5bbe697f5f9bc3bfa630b47af6e57661b4ca4b7cfc4a64fec17c57b6a14c6c'),
  ('170bfaf7-2cf2-42ee-ab61-ee9564458f6b'::uuid, 3, 'b3e4b5a9b75d8c38e76d23109bcd6a2624b077b7f483d7993d8cc6d7f274ae35'),
  ('23f53a3e-6955-4c1e-a963-841140e728c9'::uuid, 1, '446595d3a2810658f0889fbdde89d30648bbf3773d100003114773632a976132')
  ) as p (session_id, revision, inputs_hash) on p.session_id = r.session_id and p.revision = r.revision
             where (r.inputs ->> 'formula_version') <> 'savour-m1.1') then
    raise exception 'FAIL: a baseline snapshot carries a different formula label';
  end if;
end $$;

select count(*) as snapshots_checked,
  7 as baseline_snapshots_pinned
from public.report_revisions;
rollback;
