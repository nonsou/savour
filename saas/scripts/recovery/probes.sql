-- LOCAL_NATIVE_LOGICAL_REHEARSAL_ONLY post-restore probes through the real SQL surface. Runs in one transaction
-- that is rolled back, so the restored database keeps matching the dump-time manifest. Any failure raises.
begin;
do $$
declare
  a uuid := 'eeeeeeee-0000-4000-8000-000000009501';
  sa uuid; sb uuid; stored text; r jsonb; st text;
begin
  select s.id, rr.inputs_hash into sa, stored from public.sessions s join public.report_revisions rr on rr.id = s.current_report_id
    join public.workspaces w on w.id = s.workspace_id where w.name = 'Rehearsal Business A';
  select s.id into sb from public.sessions s join public.workspaces w on w.id = s.workspace_id where w.name = 'Rehearsal Business B';
  if sa is null or sb is null then raise exception 'PROBE FAIL: fixture sessions missing'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1')::text, true);

  -- 1. Owner A reads its own approved snapshot; hash equals the stored immutable revision.
  perform set_config('role', 'authenticated', true);
  r := public.get_session_report(sa, null, false, 'view');
  perform set_config('role', 'none', true);
  if r -> 'meta' ->> 'status' <> 'approved' or r -> 'meta' ->> 'inputs_hash' is distinct from stored then
    raise exception 'PROBE FAIL: approved report not returned intact';
  end if;

  -- 2. Tenant denial: Owner A cannot read Business B's report.
  begin
    perform set_config('role', 'authenticated', true);
    perform public.get_session_report(sb, null, false, 'view');
    raise exception 'PROBE FAIL: cross-tenant report read succeeded';
  exception when others then
    if sqlerrm like 'PROBE FAIL%' then raise; end if;
    if sqlerrm <> 'not_found' then raise exception 'PROBE FAIL: unexpected tenant denial %', sqlerrm; end if;
  end;

  -- 3. Clients have no direct table access to report revisions.
  begin
    perform set_config('role', 'authenticated', true);
    perform count(*) from public.report_revisions;
    raise exception 'PROBE FAIL: authenticated read report_revisions directly';
  exception when insufficient_privilege then null;
  end;

  -- 4. Even the database owner cannot update or delete an approved revision (immutable trigger restored).
  foreach st in array array['update public.report_revisions set approver_name = ''tampered''', 'delete from public.report_revisions'] loop
    begin
      execute st;
      raise exception 'PROBE FAIL: % succeeded', st;
    exception when others then
      if sqlerrm <> 'immutable_record' then raise exception 'PROBE FAIL: % -> %', st, sqlerrm; end if;
    end;
  end loop;
end $$;
rollback;
select 'probes_passed';
