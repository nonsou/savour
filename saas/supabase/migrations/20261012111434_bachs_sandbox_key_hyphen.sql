-- Bachs sandbox key suffixes can contain ASCII hyphens. Keep the sandbox-only prefix and length limits.
-- The original applied M4 migration stays sealed; change only the Bachs registry pattern.
-- This registry is sealed to runtime writers. The migration owner changes it atomically
-- and restores the identical protection before the migration can commit.
lock table platform.providers in access exclusive mode;
drop trigger providers_immutable on platform.providers;
update platform.providers
set key_pattern = '^sk_sandbox_[A-Za-z0-9_-]{16,200}$'
where code = 'bachs' and environment = 'sandbox'
  and key_pattern = '^sk_sandbox_[A-Za-z0-9_]{16,200}$';

do $$
begin
  if (select count(*) from platform.providers where code = 'bachs' and environment = 'sandbox'
      and key_pattern = '^sk_sandbox_[A-Za-z0-9_-]{16,200}$') <> 1 then
    raise exception 'bachs sandbox key pattern not in expected state';
  end if;
end $$;

create trigger providers_immutable before update or delete on platform.providers
  for each row execute function private.forbid_change();
