-- SAVOUR Milestone 5: development-only automatic owner email for operational alerts (outbox + scoped worker role).
--
-- Additive only. Earlier migrations, the alert evaluator/state/heartbeat, the manual verification ledger, the billing
-- roles and jobs, and every existing grant are untouched. This migration creates NO cron job, makes no HTTP request,
-- reads no Vault secret, uses no pg_net and changes no extension ACL; it only READS the pg_cron catalog (fixed job name,
-- when present) for the scheduler probe. Sending happens only in the operations-mailer Edge Function, which holds the
-- Resend key in its own function secrets; no key or password ever enters SQL. The one replaced object is the manual
-- verification message helper (create or replace at the end), whose fixed text no longer asserts automatic status.
--
-- Flow: the operator's cron job (supabase/cron/operations_mailer_schedule.sql, applied later by the root operator)
-- POSTs an opaque trigger token to the function. The function logs in as operations_mail (NOLOGIN here; LOGIN and a
-- password are set out of band). This migration grants it exactly three application entry points. Like every role it
-- also keeps whatever PUBLIC holds by baseline (built-in functions, and any PUBLIC grants an extension such as pg_net
-- puts on its own tables); that cannot be excluded per role and is not changed here. The three entry points:
-- * operations.mailer_heartbeat(status): records whether the worker has its provider key (ready / not_configured).
-- * operations.mailer_claim(): housekeeping, then (only while enabled) enqueue + lease at most 3 rows.
-- * operations.mailer_finish(lease, outcome, provider_id): records the self-reported outcome of one lease.
-- The trigger token can only make an already-approved, quota-bounded outbox move sooner; it cannot read a secret,
-- choose a recipient or body, or finish a row it did not lease (each lease is a fresh random token).
--
-- Outbox rules (all fixed here, none from the caller):
-- * Source: operations.alert_state rows that are active, have no unobserved_since, were last seen <= 10 minutes ago,
--   and whose source read ok in the latest evaluator attempt with its last success <= 10 minutes ago.
-- * One ledger row per (alert_key, episode) forever (unique): no second email for an episode whatever the outcome,
--   and no email when an alert clears. Subject and text are frozen at enqueue from static mapped text only (title,
--   code, operation label, count, observed time); no connection id, actor, customer, vendor label, error or secret.
-- * A pending row whose alert episode is no longer active before its first dispatch is cancelled without sending; one
--   whose source is merely not fresh is held. Pending rows older than 23 hours go to review.
-- * Quota: two fixed, intentionally separate budgets: at most 5 automatic attempts per UTC day plus the manual
--   verification's own 1 per day, so at most 6 sends a day. At most 20 new rows enqueued per run (high severity, then
--   oldest change, then key), at most 3 leases per run, at most 5 attempts per row, and no attempt later than 23 hours after the first dispatch (the same
--   immutable body and idempotency key savour-alert-<ledger id> on every attempt, as Resend requires).
-- * A lease not finished within 15 minutes becomes unknown before it can be leased again; the old token is void.
-- * accepted, rejected, review and cancelled are terminal. accepted means Resend accepted the request as reported by
--   the worker, never delivered. Terminal rows older than 90 days are pruned (never the current episode).
-- * Claims are serialized by a non-blocking advisory lock; the clock is read after the lock is held.
--
-- Admin surface (the established M5 pattern): public SECURITY INVOKER wrappers -> private SECURITY DEFINER entries that
-- call private.platform_actor(...) first. Read needs a live admin (aal1); enable/disable need aal2 and record the bound
-- admin as changed_by. Enable refuses unless the worker reported ready in the last 10 minutes AND the named job
-- savour-operations-mailer is active in pg_cron. The enabled flag only gates claims. No RPC stores or returns a key.
-- Times later than "now" (alert sightings, source successes, the worker heartbeat) are never treated as fresh.

-- ---------------------------------------------------------------------------
-- Scoped worker role (NOLOGIN; no password in source)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'operations_mail') then
    create role operations_mail nologin noinherit;
  end if;
end $$;
grant usage on schema operations to operations_mail;

-- ---------------------------------------------------------------------------
-- Tables (unexposed operations schema; RLS on, no policy, no grant)
-- ---------------------------------------------------------------------------
create table operations.mailer_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  changed_at timestamptz,
  changed_by uuid, -- the live admin bound by private.platform_actor(true) in the switch; never caller-supplied
  check ((changed_at is null) = (changed_by is null))
);
insert into operations.mailer_config (id) values (true);

create table operations.mailer_heartbeat (
  id boolean primary key default true check (id),
  status text check (status in ('ready', 'not_configured')),
  last_checked_at timestamptz,
  last_ready_at timestamptz,
  check ((status is null) = (last_checked_at is null)),
  check (last_ready_at <= last_checked_at),
  check (status <> 'ready' or last_ready_at = last_checked_at)
);
insert into operations.mailer_heartbeat (id) values (true);

create table operations.mail_ledger (
  id uuid primary key default gen_random_uuid(),
  alert_key text not null,
  episode integer not null check (episode >= 1),
  code text not null check (code in ('WEBHOOK_BACKLOG_STALE', 'DISCOVERY_BACKLOG_STALE', 'APP_FAILURES_REPORTED')),
  subject text not null check (length(subject) between 1 and 200),
  body text not null check (length(body) between 1 and 2000),
  status text not null check (status in ('pending', 'leased', 'accepted', 'rejected', 'unknown', 'review', 'cancelled')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null,
  first_dispatched_at timestamptz,
  lease_token uuid unique,
  leased_at timestamptz,
  finished_at timestamptz,
  provider_message_id uuid,
  unique (alert_key, episode),
  check ((status = 'leased') = (lease_token is not null)),
  check ((attempts = 0) = (first_dispatched_at is null)),
  check (status not in ('pending', 'cancelled') or attempts = 0),
  check ((status = 'accepted') = (provider_message_id is not null)),
  check (status = 'leased' or status = 'pending' or finished_at is not null)
);
create index mail_ledger_open on operations.mail_ledger (created_at) where status in ('pending', 'leased', 'unknown');

create table operations.mail_attempt_days (
  utc_day date primary key,
  attempts integer not null check (attempts between 1 and 5)
);

alter table operations.mailer_config enable row level security;
alter table operations.mailer_heartbeat enable row level security;
alter table operations.mail_ledger enable row level security;
alter table operations.mail_attempt_days enable row level security;
revoke all on table operations.mailer_config, operations.mailer_heartbeat, operations.mail_ledger, operations.mail_attempt_days
  from public, anon, authenticated, service_role, billing_intake, billing_gateway, billing_worker, operations_mail;

-- Identity, frozen payload and terminal states cannot change, whoever writes.
create function private.operations_mail_ledger_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id <> old.id or new.alert_key <> old.alert_key or new.episode <> old.episode or new.code <> old.code
     or new.subject <> old.subject or new.body <> old.body or new.created_at <> old.created_at then
    raise exception 'mail_ledger_immutable';
  end if;
  if old.status in ('accepted', 'rejected', 'review', 'cancelled') then raise exception 'mail_ledger_terminal'; end if;
  return new;
end $$;
create trigger mail_ledger_guard before update on operations.mail_ledger for each row execute function private.operations_mail_ledger_guard();

-- ---------------------------------------------------------------------------
-- Owner-only helpers
-- ---------------------------------------------------------------------------
-- The only recipient and sender. Resend's onboarding sender delivers only to the account owner's own address.
create function private.operations_mail_target() returns jsonb
language sql immutable set search_path = '' as
$$ select jsonb_build_object('from', 'onboarding@resend.dev', 'to', 'nonsou@gmail.com') $$;

-- Static development warning text for one alert row (title/code, operation label, count, observed time only).
create function private.operations_mail_message(a operations.alert_state) returns jsonb
language plpgsql stable set search_path = '' set timezone = 'UTC' as $$
declare
  v_title text := case a.code
    when 'WEBHOOK_BACKLOG_STALE' then 'Billing events waiting too long'
    when 'DISCOVERY_BACKLOG_STALE' then 'Discovered payments waiting too long'
    when 'APP_FAILURES_REPORTED' then 'Failed saves or exports reported' end;
  v_op text := case a.op
    when 'assessment_save' then 'Inspection assessment save' when 'report_pdf' then 'Session report PDF export'
    when 'report_csv' then 'Session report CSV export' when 'analytics_pdf' then 'Analytics PDF export'
    when 'analytics_csv' then 'Analytics CSV export' when 'dashboard_csv' then 'Dashboard CSV export' end;
begin
  if v_title is null or (a.op is not null and v_op is null) then raise exception 'invalid_alert'; end if;
  return jsonb_build_object(
    'subject', 'SAVOUR development warning: ' || v_title,
    'text', 'SAVOUR development warning. Automatic email from the development project, sent only to the owner test address.' || E'\n\n'
      || 'Warning: ' || v_title || ' (' || a.code || ')' || E'\n'
      || coalesce('Operation: ' || v_op || E'\n', '')
      || 'Count when observed: ' || a.observed_count || E'\n'
      || 'Observed at: ' || to_char(a.last_seen_at, 'YYYY-MM-DD HH24:MI:SS') || ' UTC' || E'\n\n'
      || 'This describes what a check observed at that time. It may no longer be current and is not a confirmed incident. '
      || 'Open the platform alerts page for the current state.' || E'\n'
      || 'Accepted by the email service does not mean delivered. No response time is promised.');
end $$;

-- Alerts that may be emailed now: active, listed, freshly seen, and their source read ok recently. A time later than
-- p_now is impossible data and is never eligible.
create function private.operations_mail_eligible(p_now timestamptz) returns setof operations.alert_state
language sql stable set search_path = '' as $$
  select a.* from operations.alert_state a
  cross join operations.alert_heartbeat h
  where a.active and a.unobserved_since is null
    and a.last_seen_at between p_now - interval '10 minutes' and p_now
    and ((a.source = 'billing_authoritative' and h.billing_status = 'ok' and h.billing_ok_at between p_now - interval '10 minutes' and p_now)
      or (a.source = 'app_unverified' and h.app_status = 'ok' and h.app_ok_at between p_now - interval '10 minutes' and p_now))
$$;

-- Scheduler probe for the sixth job only, by fixed name: {job, last_start_at, last_status}. Without a readable
-- pg_cron catalog (PGlite, or no pg_cron) job is 'not_measured', never healthy. last_status is a static enum of the
-- latest run's state; 'succeeded' means pg_cron ran the command (the HTTP request was queued), nothing more.
create function private.operations_mailer_scheduler() returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_job text := 'not_measured';
  v_n bigint;
  v_active boolean;
  v_start timestamptz;
  v_status text;
begin
  begin
    if to_regclass('cron.job') is not null then
      execute 'select count(*), bool_or(j.active) from cron.job j where j.jobname = $1' into v_n, v_active using 'savour-operations-mailer';
      v_job := case when v_n = 0 then 'absent' when v_n > 1 then 'not_measured' when v_active then 'active' else 'inactive' end;
      if v_n = 1 and to_regclass('cron.job_run_details') is not null then
        execute 'select d.start_time, d.status from cron.job_run_details d join cron.job j on j.jobid = d.jobid
                 where j.jobname = $1 and d.start_time is not null order by d.start_time desc limit 1'
          into v_start, v_status using 'savour-operations-mailer';
      end if;
    end if;
  exception when others then
    v_job := 'not_measured'; v_start := null; v_status := null;
  end;
  return jsonb_build_object('job', v_job, 'last_start_at', v_start,
    'last_status', case when v_start is null then null when v_status in ('succeeded', 'failed') then v_status
                        when v_status in ('starting', 'running', 'sending', 'connecting') then 'running' else 'other' end);
end $$;

-- ---------------------------------------------------------------------------
-- Worker entries (SECURITY DEFINER; EXECUTE granted to operations_mail only)
-- ---------------------------------------------------------------------------
-- The singleton row is locked BEFORE the clock is read, so overlapping calls (a scheduled tick plus a manual call)
-- write in lock order and the later writer always has the later time.
create function operations.mailer_heartbeat(p_status text) returns text
language plpgsql volatile security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '5s' set lock_timeout = '2s' as $$
declare v_now timestamptz;
begin
  if p_status is null or p_status not in ('ready', 'not_configured') then raise exception 'invalid_status'; end if;
  perform 1 from operations.mailer_heartbeat h where h.id for update;
  v_now := clock_timestamp();
  update operations.mailer_heartbeat h
     set status = p_status, last_checked_at = v_now,
         last_ready_at = case when p_status = 'ready' then v_now else h.last_ready_at end
   where h.id;
  return 'ok';
end $$;

-- Returns {"status": "busy" | "disabled" | "ok", "items": [...]}; each item is
-- {lease_token, idempotency_key, from, to, subject, text}. Never more than 3 items.
create function operations.mailer_claim() returns jsonb
language plpgsql volatile security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '10s' set lock_timeout = '2s' as $$
declare
  v_now timestamptz;
  v_day date;
  v_used integer;
  v_row operations.mail_ledger;
  v_lease uuid;
  v_items jsonb := '[]';
begin
  if not pg_catalog.pg_try_advisory_xact_lock(20261013203437) then
    return jsonb_build_object('status', 'busy', 'items', '[]'::jsonb);
  end if;
  v_now := clock_timestamp(); -- read only after the lock is held
  v_day := (v_now at time zone 'UTC')::date;

  -- Housekeeping (always, bounded by the table): stale leases become unknown, the old token void.
  update operations.mail_ledger l set status = 'unknown', lease_token = null, finished_at = v_now
   where l.status = 'leased' and l.leased_at <= v_now - interval '15 minutes';
  -- Past the window or out of attempts: review (terminal; never sent again).
  update operations.mail_ledger l set status = 'review', finished_at = v_now
   where (l.status = 'pending' and l.created_at <= v_now - interval '23 hours')
      or (l.status = 'unknown' and (l.attempts >= 5 or l.first_dispatched_at <= v_now - interval '23 hours'));
  -- Cleared (or a newer episode) before the first dispatch: cancelled without sending.
  update operations.mail_ledger l set status = 'cancelled', finished_at = v_now
   where l.status = 'pending' and not exists (select 1 from operations.alert_state a
     where a.alert_key = l.alert_key and a.active and a.episode_count = l.episode);
  delete from operations.mail_ledger l
   where l.status in ('accepted', 'rejected', 'review', 'cancelled') and l.created_at < v_now - interval '90 days'
     and not exists (select 1 from operations.alert_state a where a.alert_key = l.alert_key and a.episode_count = l.episode);
  delete from operations.mail_attempt_days d where d.utc_day < v_day - 90;

  if not (select c.enabled from operations.mailer_config c where c.id) then
    return jsonb_build_object('status', 'disabled', 'items', '[]'::jsonb);
  end if;

  -- At most 20 new rows per run, high severity first, then oldest change, then key (stable).
  insert into operations.mail_ledger (alert_key, episode, code, subject, body, status, created_at)
  select a.alert_key, a.episode_count, a.code, m ->> 'subject', m ->> 'text', 'pending', v_now
  from (select e.* from private.operations_mail_eligible(v_now) e
        where not exists (select 1 from operations.mail_ledger l where l.alert_key = e.alert_key and l.episode = e.episode_count)
        order by e.severity = 'high' desc, e.last_changed_at, e.alert_key
        limit 20) a
  cross join lateral private.operations_mail_message(a) m
  on conflict (alert_key, episode) do nothing;

  v_used := coalesce((select d.attempts from operations.mail_attempt_days d where d.utc_day = v_day), 0);
  for v_row in
    select * from operations.mail_ledger l
    where (l.status = 'pending' and exists (select 1 from private.operations_mail_eligible(v_now) e
             where e.alert_key = l.alert_key and e.episode_count = l.episode))
       or (l.status = 'unknown' and l.attempts < 5 and l.first_dispatched_at > v_now - interval '23 hours'
             and l.finished_at <= v_now - interval '4 minutes')
    order by l.created_at, l.id
    limit 3
    for update
  loop
    exit when v_used >= 5;
    v_lease := gen_random_uuid();
    update operations.mail_ledger l
       set status = 'leased', lease_token = v_lease, leased_at = v_now, attempts = l.attempts + 1,
           first_dispatched_at = coalesce(l.first_dispatched_at, v_now)
     where l.id = v_row.id;
    insert into operations.mail_attempt_days as d (utc_day, attempts) values (v_day, 1)
    on conflict (utc_day) do update set attempts = d.attempts + 1;
    v_used := v_used + 1;
    v_items := v_items || jsonb_build_array(jsonb_build_object('lease_token', v_lease, 'idempotency_key', 'savour-alert-' || v_row.id,
      'subject', v_row.subject, 'text', v_row.body) || private.operations_mail_target());
  end loop;
  return jsonb_build_object('status', 'ok', 'items', v_items);
end $$;

-- Records the worker's self-reported outcome for one live lease. Returns 'recorded' or 'stale' (unknown, finished,
-- replaced or expired lease: nothing changes).
create function operations.mailer_finish(p_lease uuid, p_outcome text, p_provider_message_id uuid) returns text
language plpgsql volatile security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '5s' set lock_timeout = '2s' as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row operations.mail_ledger;
begin
  if p_outcome is null or p_outcome not in ('accepted', 'rejected', 'unknown') then raise exception 'invalid_outcome'; end if;
  if (p_outcome = 'accepted') <> (p_provider_message_id is not null) then raise exception 'invalid_outcome'; end if;
  if p_lease is null then return 'stale'; end if;
  select * into v_row from operations.mail_ledger l where l.lease_token = p_lease and l.status = 'leased' for update;
  if not found or v_row.leased_at <= v_now - interval '15 minutes' then return 'stale'; end if;
  update operations.mail_ledger l
     set status = case when p_outcome = 'unknown' and (l.attempts >= 5 or l.first_dispatched_at <= v_now - interval '23 hours')
                       then 'review' else p_outcome end,
         lease_token = null, finished_at = v_now, provider_message_id = p_provider_message_id
   where l.id = v_row.id;
  return 'recorded';
end $$;

-- ---------------------------------------------------------------------------
-- Admin read and switch: owner-only helper, guarded private entries, public invoker wrappers
-- ---------------------------------------------------------------------------
-- Worker heartbeat freshness: a check within the last 10 minutes and not later than p_now (a future time is never fresh).
create function private.operations_mailer_worker_fresh(p_checked timestamptz, p_now timestamptz) returns boolean
language sql immutable set search_path = '' as
$$ select p_checked is not null and p_checked <= p_now and p_now - p_checked <= interval '10 minutes' $$;

-- The worker heartbeat and the scheduler are separate facts: a manual worker call refreshes the heartbeat only, never
-- the scheduled-run time, which comes from the pg_cron catalog.
create function private.operations_mailer_read() returns jsonb
language plpgsql stable set search_path = '' set timezone = 'UTC' as $$
declare
  -- clock_timestamp: read after the statement snapshot, so nothing visible can be later than observed_at.
  v_now timestamptz := clock_timestamp();
  v_day date := (v_now at time zone 'UTC')::date;
  v_c operations.mailer_config;
  v_h operations.mailer_heartbeat;
  v_fresh boolean;
  v_s jsonb := private.operations_mailer_scheduler();
begin
  select * into v_c from operations.mailer_config c where c.id;
  select * into v_h from operations.mailer_heartbeat h where h.id;
  v_fresh := private.operations_mailer_worker_fresh(v_h.last_checked_at, v_now);
  return jsonb_build_object(
    'observed_at', v_now,
    'enabled', v_c.enabled,
    'enabled_changed_at', v_c.changed_at,
    'worker', jsonb_build_object(
      'status', v_h.status,
      'key_present', case when v_h.status is null then null else v_h.status = 'ready' end,
      'last_checked_at', v_h.last_checked_at,
      'last_ready_at', v_h.last_ready_at,
      'freshness', case when v_h.last_checked_at is null then 'never' when v_fresh then 'fresh' else 'stale' end),
    'scheduler', jsonb_build_object('job', v_s ->> 'job', 'last_scheduled_start_at', v_s -> 'last_start_at',
      'last_scheduled_status', v_s -> 'last_status'),
    'ready_to_enable', v_fresh and v_h.status = 'ready' and v_s ->> 'job' = 'active',
    'today', jsonb_build_object('utc_day', v_day, 'automatic_limit', 5, 'manual_limit', 1,
      'automatic_attempts', coalesce((select d.attempts from operations.mail_attempt_days d where d.utc_day = v_day), 0)),
    'queue', jsonb_build_object(
      'pending', (select count(*) from operations.mail_ledger l where l.status = 'pending'),
      'leased', (select count(*) from operations.mail_ledger l where l.status = 'leased'),
      'unknown', (select count(*) from operations.mail_ledger l where l.status = 'unknown'),
      'review', (select count(*) from operations.mail_ledger l where l.status = 'review')),
    'last_accepted_at', (select max(l.finished_at) from operations.mail_ledger l where l.status = 'accepted'),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('code', r.code, 'status', r.status, 'attempts', r.attempts, 'created_at', r.created_at,
          'first_dispatched_at', r.first_dispatched_at, 'finished_at', r.finished_at) order by r.created_at desc, r.id)
      from (select * from operations.mail_ledger l order by l.created_at desc, l.id limit 14) r), '[]'::jsonb));
end $$;

create function private.platform_operations_mailer() returns jsonb
language plpgsql stable security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '5s' set lock_timeout = '2s' as $$
begin
  perform private.platform_actor(false);
  return private.operations_mailer_read();
end $$;

-- Enable needs a live aal2 admin (bound as changed_by), a fresh ready worker heartbeat (not in the future) AND the
-- named scheduled job active in pg_cron. A manual worker call alone can never satisfy it.
create function private.platform_enable_operations_mailer() returns text
language plpgsql volatile security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '5s' set lock_timeout = '2s' as $$
declare
  v_actor uuid;
  v_now timestamptz;
begin
  v_actor := private.platform_actor(true);
  v_now := clock_timestamp();
  if not exists (select 1 from operations.mailer_heartbeat h where h.id and h.status = 'ready'
                 and private.operations_mailer_worker_fresh(h.last_checked_at, v_now)) then
    perform private.fail('mailer_not_ready');
  end if;
  if private.operations_mailer_scheduler() ->> 'job' is distinct from 'active' then perform private.fail('mailer_not_scheduled'); end if;
  update operations.mailer_config c set enabled = true, changed_at = v_now, changed_by = v_actor where c.id and not c.enabled;
  return 'enabled';
end $$;

create function private.platform_disable_operations_mailer() returns text
language plpgsql volatile security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '5s' set lock_timeout = '2s' as $$
declare
  v_actor uuid;
begin
  v_actor := private.platform_actor(true);
  update operations.mailer_config c set enabled = false, changed_at = clock_timestamp(), changed_by = v_actor where c.id and c.enabled;
  return 'disabled';
end $$;

create function public.platform_operations_mailer() returns jsonb
language sql stable security invoker set search_path = '' as
$$ select private.platform_operations_mailer() $$;
create function public.platform_enable_operations_mailer() returns text
language sql volatile security invoker set search_path = '' as
$$ select private.platform_enable_operations_mailer() $$;
create function public.platform_disable_operations_mailer() returns text
language sql volatile security invoker set search_path = '' as
$$ select private.platform_disable_operations_mailer() $$;

-- ---------------------------------------------------------------------------
-- Grants. operations_mail: the three worker entries only. authenticated: the admin entries and wrappers only.
-- ---------------------------------------------------------------------------
revoke all on function private.operations_mail_ledger_guard(), private.operations_mail_target(),
  private.operations_mail_message(operations.alert_state), private.operations_mail_eligible(timestamptz),
  private.operations_mailer_read(), private.operations_mailer_scheduler(),
  private.operations_mailer_worker_fresh(timestamptz, timestamptz),
  operations.mailer_heartbeat(text), operations.mailer_claim(), operations.mailer_finish(uuid, text, uuid),
  private.platform_operations_mailer(), private.platform_enable_operations_mailer(), private.platform_disable_operations_mailer(),
  public.platform_operations_mailer(), public.platform_enable_operations_mailer(), public.platform_disable_operations_mailer()
  from public, anon, authenticated, service_role, billing_intake, billing_gateway, billing_worker, operations_mail;
grant execute on function operations.mailer_heartbeat(text), operations.mailer_claim(), operations.mailer_finish(uuid, text, uuid)
  to operations_mail;
grant execute on function private.platform_operations_mailer(), private.platform_enable_operations_mailer(),
  private.platform_disable_operations_mailer(),
  public.platform_operations_mailer(), public.platform_enable_operations_mailer(), public.platform_disable_operations_mailer()
  to authenticated;

-- ---------------------------------------------------------------------------
-- Manual verification message (replaces the 20261013201621 helper; that applied file is not edited). The new fixed
-- text points to the page for automatic status instead of asserting it, so it stays true whether automatic email is
-- on or off. Same signature and attributes; CREATE OR REPLACE keeps its owner-only ACL. src/lib/alert-email.ts
-- VERIFICATION_TEXT changes in the same release (until both ship, the exact match there fails closed: nothing is sent).
-- ---------------------------------------------------------------------------
create or replace function private.alert_email_verification_message() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'from', 'onboarding@resend.dev',
    'to', 'nonsou@gmail.com',
    'subject', 'SAVOUR email verification test',
    'text', 'This is a SAVOUR email verification test, requested by hand from the platform admin page. '
         || 'It contains no alert and no customer information. Automatic email status is shown on the platform alerts page. '
         || 'No action is needed.')
$$;
revoke all on function private.alert_email_verification_message()
  from public, anon, authenticated, service_role, billing_intake, billing_gateway, billing_worker, operations_mail;
