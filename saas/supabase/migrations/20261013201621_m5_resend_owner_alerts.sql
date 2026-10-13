-- SAVOUR Milestone 5, Stage 1: owner-initiated email verification through Resend (development groundwork).
--
-- Additive only. Earlier migrations, the alert tables, evaluator, heartbeat, read RPC and every existing grant are
-- untouched. This migration creates NO cron job, sends nothing, makes no HTTP request, reads no Vault secret and uses
-- no pg_net (the hosted pg_net request/response tables are readable through PUBLIC grants, so no key may pass through
-- them). The only sender is the Next.js server action on a Preview deployment, started by a platform admin's click.
--
-- What is stored: one ledger row per UTC day (at most one verification attempt per day, ever; no retries in this
-- stage). Each row holds only its id, day, status, times and an optional provider message id (a uuid). No actor,
-- user id, recipient, body, note, raw error, HTTP body, header or key is stored. Rows older than 90 days are deleted
-- when a new attempt is reserved (the only write path besides finishing).
--
-- The message is fixed here, never taken from the caller: from onboarding@resend.dev to the owner address, with a
-- fixed subject and text that carry no alert or customer content. Resend's onboarding sender delivers only to the
-- account owner's own address, so a changed recipient could not deliver anyway.
--
-- Status meaning (honest by construction):
-- * reserved: the day is claimed; the server action is about to call (or is calling) Resend.
-- * accepted / rejected / unknown: SELF-REPORTED by the admin session that ran the server action (2xx with a valid id,
--   4xx, anything else). A live AAL2 admin can call the finish RPC directly, so these are not proof of anything;
--   "accepted" means Resend accepted the request as reported by that session, never that the email was delivered.
-- * A row still reserved more than 15 minutes after it was requested is shown as unknown; it never frees the day.
--
-- Security model (the established M1/M4/M5 pattern; no SECURITY DEFINER function in public)
-- * public.platform_*_alert_email_verification*: SECURITY INVOKER wrappers, granted to authenticated only.
-- * private.platform_*: SECURITY DEFINER entries that call private.platform_actor(...) BEFORE touching anything:
--   reserve and finish require a live admin row AND aal2; the read requires a live admin row (aal1 is enough).
-- * The fixed-message and read helpers are SECURITY INVOKER with no grant (owner-only).
-- * The ledger lives in the existing unexposed operations schema with RLS on, no policy and no table grant.

-- ---------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------
create table operations.alert_email_verifications (
  id uuid primary key default gen_random_uuid(),
  utc_day date not null unique, -- the singleton per UTC day: a second reservation for the same day cannot exist
  status text not null check (status in ('reserved', 'accepted', 'rejected', 'unknown')),
  requested_at timestamptz not null,
  finished_at timestamptz,
  provider_message_id uuid,
  check ((status = 'reserved') = (finished_at is null)),
  check ((status = 'accepted') = (provider_message_id is not null)),
  check (finished_at is null or finished_at >= requested_at)
);
alter table operations.alert_email_verifications enable row level security;
revoke all on table operations.alert_email_verifications
  from public, anon, authenticated, service_role, billing_intake, billing_gateway, billing_worker;

-- ---------------------------------------------------------------------------
-- Fixed message (owner-only). The only source of recipient, sender, subject and text.
-- ---------------------------------------------------------------------------
create function private.alert_email_verification_message() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'from', 'onboarding@resend.dev',
    'to', 'nonsou@gmail.com',
    'subject', 'SAVOUR email verification test',
    'text', 'This is a SAVOUR email verification test, requested by hand from the platform admin page. '
         || 'It contains no alert and no customer information. Automatic alert emails are not connected. '
         || 'No action is needed.')
$$;

-- ---------------------------------------------------------------------------
-- Read helper (owner-only): sanitized latest 14 UTC days.
-- ---------------------------------------------------------------------------
create function private.alert_email_verifications_read() returns jsonb
language plpgsql stable set search_path = '' set timezone = 'UTC' as $$
declare
  v_now timestamptz := statement_timestamp();
  v_day date := (statement_timestamp() at time zone 'UTC')::date;
begin
  return jsonb_build_object(
    'observed_at', v_now,
    'utc_day', v_day,
    'daily_limit', 1,
    'used_today', exists (select 1 from operations.alert_email_verifications e where e.utc_day = v_day),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
          'utc_day', e.utc_day,
          'status', case when e.status = 'reserved' and v_now - e.requested_at > interval '15 minutes' then 'unknown'
                         when e.status = 'reserved' then 'in_progress' else e.status end,
          'reported', e.status <> 'reserved',
          'requested_at', e.requested_at,
          'finished_at', e.finished_at,
          'provider_message_id', e.provider_message_id)
        order by e.utc_day desc)
      from operations.alert_email_verifications e
      where e.utc_day > v_day - 14), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Guarded entries (SECURITY DEFINER): admin gate first, then the bounded work.
-- ---------------------------------------------------------------------------
create function private.platform_reserve_alert_email_verification() returns jsonb
language plpgsql volatile security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '5s' set lock_timeout = '2s' as $$
declare
  v_now timestamptz;
  v_day date;
  v_id uuid;
begin
  perform private.platform_actor(true);
  v_now := statement_timestamp();
  v_day := (v_now at time zone 'UTC')::date;
  delete from operations.alert_email_verifications e where e.utc_day < v_day - 90;
  insert into operations.alert_email_verifications (utc_day, status, requested_at)
  values (v_day, 'reserved', v_now)
  on conflict (utc_day) do nothing
  returning id into v_id;
  if v_id is null then perform private.fail('verification_daily_limit'); end if;
  return jsonb_build_object('id', v_id) || private.alert_email_verification_message();
end $$;

-- Records the self-reported outcome once. Returns 'recorded', 'already_recorded' (any later call, which changes
-- nothing) or 'expired' (still reserved after 15 minutes: left as is and shown as unknown).
create function private.platform_finish_alert_email_verification(p_id uuid, p_outcome text, p_provider_message_id uuid)
returns text
language plpgsql volatile security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '5s' set lock_timeout = '2s' as $$
declare
  v_row operations.alert_email_verifications;
begin
  perform private.platform_actor(true);
  if p_outcome is null or p_outcome not in ('accepted', 'rejected', 'unknown') then perform private.fail('invalid_verification_outcome'); end if;
  if (p_outcome = 'accepted') <> (p_provider_message_id is not null) then perform private.fail('invalid_verification_outcome'); end if;
  if p_id is null then perform private.fail('not_found'); end if;
  select * into v_row from operations.alert_email_verifications e where e.id = p_id for update;
  if not found then perform private.fail('not_found'); end if;
  if v_row.status <> 'reserved' then return 'already_recorded'; end if;
  if statement_timestamp() - v_row.requested_at > interval '15 minutes' then return 'expired'; end if;
  update operations.alert_email_verifications e
     set status = p_outcome, finished_at = statement_timestamp(), provider_message_id = p_provider_message_id
   where e.id = p_id;
  return 'recorded';
end $$;

create function private.platform_alert_email_verifications() returns jsonb
language plpgsql stable security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '5s' set lock_timeout = '2s' as $$
begin
  perform private.platform_actor(false);
  return private.alert_email_verifications_read();
end $$;

-- ---------------------------------------------------------------------------
-- Public invoker wrappers
-- ---------------------------------------------------------------------------
create function public.platform_reserve_alert_email_verification() returns jsonb
language sql volatile security invoker set search_path = '' as
$$ select private.platform_reserve_alert_email_verification() $$;

create function public.platform_finish_alert_email_verification(p_id uuid, p_outcome text, p_provider_message_id uuid default null)
returns text
language sql volatile security invoker set search_path = '' as
$$ select private.platform_finish_alert_email_verification(p_id, p_outcome, p_provider_message_id) $$;

create function public.platform_alert_email_verifications() returns jsonb
language sql stable security invoker set search_path = '' as
$$ select private.platform_alert_email_verifications() $$;

-- ---------------------------------------------------------------------------
-- Grants: helpers owner-only; guarded entries and wrappers to authenticated only. No schema or table grant.
-- ---------------------------------------------------------------------------
revoke all on function private.alert_email_verification_message(), private.alert_email_verifications_read(),
  private.platform_reserve_alert_email_verification(), private.platform_finish_alert_email_verification(uuid, text, uuid),
  private.platform_alert_email_verifications(),
  public.platform_reserve_alert_email_verification(), public.platform_finish_alert_email_verification(uuid, text, uuid),
  public.platform_alert_email_verifications()
  from public, anon, authenticated, service_role, billing_intake, billing_gateway, billing_worker;
grant execute on function private.platform_reserve_alert_email_verification(), private.platform_finish_alert_email_verification(uuid, text, uuid),
  private.platform_alert_email_verifications(),
  public.platform_reserve_alert_email_verification(), public.platform_finish_alert_email_verification(uuid, text, uuid),
  public.platform_alert_email_verifications()
  to authenticated;
