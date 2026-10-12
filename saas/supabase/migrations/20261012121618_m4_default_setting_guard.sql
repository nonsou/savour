-- Scope the singleton setting update for the hosted safe-update guard. Preserve auth, locks, audit and grants.
create or replace function private.platform_set_default(p_conn uuid, p_expected_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.platform_actor(true);
  v_s platform.settings;
begin
  select * into v_s from platform.settings where id = true for no key update;
  if p_expected_version is null or v_s.version <> p_expected_version then perform private.fail('stale_version'); end if;
  if p_conn is not null and not exists (select 1 from platform.provider_connections where id = p_conn and status = 'enabled') then
    perform private.fail('connection_not_enabled');
  end if;
  update platform.settings set default_connection_id = p_conn, version = version + 1, updated_at = now() where id = v_s.id;
  perform private.platform_audit(v_uid, 'settings.default_changed', p_conn, jsonb_build_object('default', v_s.default_connection_id),
    jsonb_build_object('default', p_conn));
  return v_s.version + 1;
end $$;

