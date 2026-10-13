-- SAVOUR Milestone 5: internal operational alert state for the founder platform admin (development groundwork).
--
-- Additive only. Earlier migrations, tables, triggers, worker paths, cron jobs and existing grants are untouched.
-- This migration creates NO cron job and activates nothing: the evaluator only runs when the database owner calls
-- it, or when the operator separately applies supabase/cron/operations_alerts_schedule.sql (a later decision).
-- Nothing here sends email, messages, HTTP requests or notifications, and nothing reads Vault.
--
-- Scope: exactly two signals.
-- * billing_authoritative: WEBHOOK_BACKLOG_STALE / DISCOVERY_BACKLOG_STALE per connection, read from the existing
--   owner-only private.operations_snapshot(). Same rule as the TypeScript evaluator (src/lib/operations.ts): the
--   oldest backlog item is strictly older than 15 minutes against the snapshot's own observed_at, compared at
--   millisecond precision (as Date.parse does). Exactly 15 minutes is not stale.
-- * app_unverified: APP_FAILURES_REPORTED per operation, read from the existing owner-only
--   private.application_outcomes_snapshot(): failed > 0 in the current partial UTC hour plus the 23 before it.
--   Severity 'high' when failures were reported in two adjacent UTC hours (the proposed sustained signal), else
--   'warning'. Success, replayed and rejected outcomes never count. These counts are user-session reports, so
--   an alert is a prompt to check the hosting logs, not a confirmed incident. An app alert stops being active
--   only when its failed hours leave the window: that is expiry of the report, not confirmed recovery.
--
-- Alert state (operations.alert_state) is bounded CURRENT state, never an append log: one row per stable slot
-- key (code:connection_id or code:op), so at most 2 x connections + 6 rows. A row is created the first time its
-- condition is observed. Re-observing an active condition updates last_seen and the observed count/oldest time
-- only; an inactive -> active transition (including the first) increments episode_count on the same row. A row is
-- cleared only by a successful, validated read of its OWN source that lacks the condition. If a source helper
-- raises, or its snapshot is malformed (missing, null, wrong type, negative count, unknown operation, impossible
-- or future timestamp), that source is marked unavailable for the run and none of its rows change; the other
-- source is still evaluated. Billing validation is minimal (only the fields its rule uses); the app snapshot is
-- validated with the full exact shape and bounds of the TypeScript validator. A billing slot whose connection is no longer listed is kept as it was and marked
-- unobserved_since; it is never cleared from absence. Rows are never deleted. No payload, raw error, SQLERRM,
-- label, note or email is stored anywhere.
--
-- Heartbeat (operations.alert_heartbeat) is a singleton: the latest attempt (trigger and each source's status
-- independently), and separate cron and manual columns, so a manual run can never hide a failing or missing
-- scheduled run. Runs take pg_try_advisory_xact_lock on one fixed key; a run that finds it busy returns 'busy'
-- and writes nothing (it does not freshen the heartbeat). The run time (clock_timestamp) is read only after the
-- lock is held. Each run is one transaction; each source runs inside its own exception block (savepoint).
--
-- Security model (the established M1/M4/M5 pattern; no SECURITY DEFINER function in public)
-- * Evaluator, findings helpers, apply helper, lock helper and read helper: SECURITY INVOKER with no grant to any
--   role, so only the database owner (the cron job owner, or a trusted SQL session) can run them. No client call
--   can evaluate or refresh alerts.
-- * public.platform_operations_alerts(): SECURITY INVOKER wrapper -> private.platform_operations_alerts(), SECURITY
--   DEFINER, which calls private.platform_actor(false) (live, unrevoked platform.admins row for the verified JWT
--   subject; JWT metadata confers nothing) BEFORE reading anything, then the owner-only read helper.
-- * Both tables live in the existing unexposed operations schema with RLS on, no policy and no table grant.
--
-- Timeouts: the function-level statement_timeout below applies to statements started inside the call. It is not a
-- proven bound on the outer RPC or cron statement (PostgreSQL arms that timer when the top-level statement starts).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table operations.alert_state (
  alert_key text primary key,
  source text not null check (source in ('billing_authoritative', 'app_unverified')),
  code text not null check (code in ('WEBHOOK_BACKLOG_STALE', 'DISCOVERY_BACKLOG_STALE', 'APP_FAILURES_REPORTED')),
  connection_id uuid,
  op text check (op in ('assessment_save', 'report_pdf', 'report_csv', 'analytics_pdf', 'analytics_csv', 'dashboard_csv')),
  severity text not null check (severity in ('high', 'warning')),
  active boolean not null,
  episode_count integer not null check (episode_count >= 1),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  last_changed_at timestamptz not null,
  cleared_at timestamptz,
  unobserved_since timestamptz,
  observed_count bigint not null check (observed_count >= 1),
  observed_oldest_at timestamptz not null,
  check ((source = 'billing_authoritative' and code in ('WEBHOOK_BACKLOG_STALE', 'DISCOVERY_BACKLOG_STALE')
          and connection_id is not null and op is null)
      or (source = 'app_unverified' and code = 'APP_FAILURES_REPORTED' and op is not null and connection_id is null
          and unobserved_since is null)),
  check (alert_key = code || ':' || coalesce(connection_id::text, op)),
  check (active = (cleared_at is null)),
  check (first_seen_at <= last_seen_at and first_seen_at <= last_changed_at),
  check (cleared_at is null or cleared_at >= last_seen_at)
);
alter table operations.alert_state enable row level security;

create table operations.alert_heartbeat (
  id boolean primary key default true check (id),
  last_attempt_at timestamptz,
  last_attempt_trigger text check (last_attempt_trigger in ('cron', 'manual')),
  billing_status text check (billing_status in ('ok', 'unavailable')),
  app_status text check (app_status in ('ok', 'unavailable')),
  billing_ok_at timestamptz,
  app_ok_at timestamptz,
  last_cron_attempted_at timestamptz,
  last_cron_status text check (last_cron_status in ('ok', 'billing_unavailable', 'app_unavailable', 'both_unavailable')),
  last_cron_completed_at timestamptz,
  last_manual_attempted_at timestamptz,
  last_manual_status text check (last_manual_status in ('ok', 'billing_unavailable', 'app_unavailable', 'both_unavailable')),
  check ((last_attempt_at is null) = (last_attempt_trigger is null)
     and (last_attempt_at is null) = (billing_status is null)
     and (last_attempt_at is null) = (app_status is null)),
  check ((last_cron_attempted_at is null) = (last_cron_status is null)),
  check ((last_manual_attempted_at is null) = (last_manual_status is null)),
  check (last_cron_completed_at <= last_cron_attempted_at),
  check (billing_ok_at <= last_attempt_at and app_ok_at <= last_attempt_at)
);
alter table operations.alert_heartbeat enable row level security;
-- The singleton starts empty: no attempt has ever run.
insert into operations.alert_heartbeat (id) values (true);

revoke all on table operations.alert_state, operations.alert_heartbeat
  from public, anon, authenticated, service_role, billing_intake, billing_gateway, billing_worker;

-- ---------------------------------------------------------------------------
-- Snapshot field readers (owner-only). Missing keys, JSON null where a value is required, wrong types, negative
-- or fractional counts and non-PostgreSQL-UTC or impossible timestamps all raise; nothing is coerced to zero.
-- ---------------------------------------------------------------------------
create function private.operations_alert_ts(p jsonb, p_nullable boolean) returns timestamptz
language plpgsql stable set search_path = '' set timezone = 'UTC' as $$
declare v text;
begin
  if p is null then raise exception 'invalid_snapshot'; end if; -- key missing
  if jsonb_typeof(p) = 'null' then
    if p_nullable then return null; end if;
    raise exception 'invalid_snapshot';
  end if;
  if jsonb_typeof(p) <> 'string' then raise exception 'invalid_snapshot'; end if;
  v := p #>> '{}';
  if v !~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?\+00:00$' then raise exception 'invalid_snapshot'; end if;
  return v::timestamptz; -- impossible dates (2026-02-30) raise here
end $$;

-- A nullable age source: raises when it is later than the observation (millisecond precision).
create function private.operations_alert_past_ts(p jsonb, p_observed timestamptz) returns timestamptz
language plpgsql stable set search_path = '' set timezone = 'UTC' as $$
declare v timestamptz := private.operations_alert_ts(p, true);
begin
  if date_trunc('milliseconds', v) > date_trunc('milliseconds', p_observed) then raise exception 'invalid_snapshot'; end if;
  return v;
end $$;

create function private.operations_alert_count(p jsonb) returns bigint
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) <> 'number' or (p #>> '{}') !~ '^(0|[1-9]\d{0,14})$' then raise exception 'invalid_snapshot'; end if;
  return (p #>> '{}')::bigint;
end $$;

-- ---------------------------------------------------------------------------
-- Pure findings helpers (owner-only). Input: a snapshot; output: a JSON array of static findings
-- {code, source, connection_id, op, severity, count, oldest_at}. They raise on an invalid snapshot. They read no
-- table, so the parity tests feed them the same fixtures as the TypeScript evaluators.
-- ---------------------------------------------------------------------------
create function private.operations_alert_billing_findings(p jsonb) returns jsonb
language plpgsql stable set search_path = '' set timezone = 'UTC' as $$
declare
  v_obs timestamptz;
  v_ms timestamptz;
  v_c jsonb;
  v_q jsonb;
  v_id uuid;
  v_seen uuid[] := '{}';
  v_out jsonb := '[]';
  v_n bigint;
  v_oldest timestamptz;
  v_k record;
  v_mode text;
  v_field text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p -> 'connections') is distinct from 'array'
     or jsonb_typeof(p -> 'unassigned_reviews') is distinct from 'object' then
    raise exception 'invalid_snapshot';
  end if;
  v_obs := private.operations_alert_ts(p -> 'observed_at', false);
  v_ms := date_trunc('milliseconds', v_obs);
  -- Every timestamp the TypeScript evaluator ages is checked for the future, so both fail closed alike.
  perform private.operations_alert_past_ts(p #> '{unassigned_reviews,oldest_created_at}', v_obs);
  for v_c in select e from jsonb_array_elements(p -> 'connections') e loop
    if jsonb_typeof(v_c) <> 'object' or jsonb_typeof(v_c -> 'id') is distinct from 'string'
       or (v_c ->> 'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_c -> 'reviews') is distinct from 'object' or jsonb_typeof(v_c -> 'runs') is distinct from 'object' then
      raise exception 'invalid_snapshot';
    end if;
    v_id := (v_c ->> 'id')::uuid;
    if v_id = any (v_seen) then raise exception 'invalid_snapshot'; end if;
    v_seen := v_seen || v_id;
    for v_k in select * from (values ('WEBHOOK_BACKLOG_STALE', 'webhook', 'failed', 'oldest_received_at'),
                                     ('DISCOVERY_BACKLOG_STALE', 'discovery', 'retry', 'oldest_first_seen_at')) k (code, queue, third, oldest) loop
      v_q := v_c -> v_k.queue;
      if jsonb_typeof(v_q) is distinct from 'object' then raise exception 'invalid_snapshot'; end if;
      v_n := private.operations_alert_count(v_q -> 'pending') + private.operations_alert_count(v_q -> 'processing')
        + private.operations_alert_count(v_q -> v_k.third);
      v_oldest := private.operations_alert_past_ts(v_q -> v_k.oldest, v_obs);
      if (v_n = 0) <> (v_oldest is null) then raise exception 'invalid_snapshot'; end if;
      if v_oldest is not null and v_ms - date_trunc('milliseconds', v_oldest) > interval '15 minutes' then
        v_out := v_out || jsonb_build_array(jsonb_build_object('code', v_k.code, 'source', 'billing_authoritative',
          'connection_id', v_id, 'op', null, 'severity', 'high', 'count', v_n, 'oldest_at', v_oldest));
      end if;
    end loop;
    perform private.operations_alert_past_ts(v_c #> '{reviews,oldest_created_at}', v_obs);
    foreach v_mode in array array['process', 'discover', 'reconcile'] loop
      if jsonb_typeof(v_c -> 'runs' -> v_mode) is distinct from 'object' then raise exception 'invalid_snapshot'; end if;
      foreach v_field in array array['latest_finished_at', 'latest_success_at', 'oldest_unfinished_started_at'] loop
        perform private.operations_alert_past_ts(v_c -> 'runs' -> v_mode -> v_field, v_obs);
      end loop;
    end loop;
  end loop;
  return v_out;
end $$;

-- Exact key set of a JSON object (extra or missing keys raise).
create function private.operations_alert_keys(p jsonb, p_keys text[]) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invalid_snapshot'; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p) k) is distinct from (select array_agg(k order by k) from unnest(p_keys) k) then
    raise exception 'invalid_snapshot';
  end if;
end $$;

-- The app snapshot is validated with the same exact shape and bounds as validateAppSnapshot in
-- src/lib/application-outcomes.ts, so a snapshot the page calls unusable can never be a validated read here (and so
-- can never clear an app alert).
create function private.operations_alert_app_findings(p jsonb) returns jsonb
language plpgsql stable set search_path = '' set timezone = 'UTC' as $$
declare
  v_ops constant text[] := array['assessment_save', 'report_pdf', 'report_csv', 'analytics_pdf', 'analytics_csv', 'dashboard_csv'];
  v_obs timestamptz;
  v_ms timestamptz;
  v_from timestamptz;
  v_cap bigint;
  v_actors bigint;
  v_stored bigint;
  v_o jsonb;
  v_h jsonb;
  v_t timestamptz;
  v_prev timestamptz;
  v_n bigint[];
  v_total bigint;
  v_capped bigint;
  v_failed bigint;
  v_hours timestamptz[];
  v_out jsonb := '[]';
begin
  perform private.operations_alert_keys(p, array['observed_at', 'window_start', 'bucket_cap', 'stored_buckets', 'reporting_actors_24h', 'operations']);
  if jsonb_typeof(p -> 'operations') <> 'array' then raise exception 'invalid_snapshot'; end if;
  if jsonb_array_length(p -> 'operations') <> cardinality(v_ops) then raise exception 'invalid_snapshot'; end if;
  v_obs := private.operations_alert_ts(p -> 'observed_at', false);
  v_ms := date_trunc('milliseconds', v_obs);
  v_from := private.operations_alert_ts(p -> 'window_start', false);
  -- The window is the observation's own UTC hour plus the 23 hours before it.
  if v_from <> date_trunc('hour', v_from) or v_ms < v_from + interval '23 hours' or v_ms >= v_from + interval '24 hours' then
    raise exception 'invalid_snapshot';
  end if;
  v_cap := private.operations_alert_count(p -> 'bucket_cap');
  if v_cap <> 1000 then raise exception 'invalid_snapshot'; end if;
  v_actors := private.operations_alert_count(p -> 'reporting_actors_24h');
  v_stored := private.operations_alert_count(p -> 'stored_buckets');
  if v_actors > v_stored then raise exception 'invalid_snapshot'; end if;
  for i in 1 .. cardinality(v_ops) loop
    v_o := p -> 'operations' -> (i - 1);
    perform private.operations_alert_keys(v_o, array['op', 'success', 'replayed', 'rejected', 'failed', 'capped_buckets',
      'latest_reported_at', 'failed_hours']);
    if (v_o -> 'op') is distinct from to_jsonb(v_ops[i]) or jsonb_typeof(v_o -> 'failed_hours') <> 'array' then
      raise exception 'invalid_snapshot';
    end if;
    if jsonb_array_length(v_o -> 'failed_hours') > 24 then raise exception 'invalid_snapshot'; end if;
    -- success, replayed, rejected, failed: every one must be a whole non-negative count, whichever is used.
    v_n := array[private.operations_alert_count(v_o -> 'success'), private.operations_alert_count(v_o -> 'replayed'),
                 private.operations_alert_count(v_o -> 'rejected'), private.operations_alert_count(v_o -> 'failed')];
    v_failed := v_n[4];
    v_total := v_n[1] + v_n[2] + v_n[3] + v_n[4];
    v_capped := private.operations_alert_count(v_o -> 'capped_buckets');
    v_t := private.operations_alert_past_ts(v_o -> 'latest_reported_at', v_obs);
    if v_t < v_from or (v_total = 0) <> (v_t is null) then raise exception 'invalid_snapshot'; end if;
    v_hours := '{}';
    v_prev := null;
    for v_h in select e from jsonb_array_elements(v_o -> 'failed_hours') e loop
      v_t := private.operations_alert_ts(v_h, false);
      -- Whole hours inside the window, strictly ascending (so the adjacency rule sees the same input as TypeScript).
      if v_t <> date_trunc('hour', v_t) or v_t < v_from or v_t > v_from + interval '23 hours' or v_t <= v_prev then
        raise exception 'invalid_snapshot';
      end if;
      v_prev := v_t;
      v_hours := v_hours || v_t;
    end loop;
    if (v_failed = 0) <> (cardinality(v_hours) = 0) then raise exception 'invalid_snapshot'; end if;
    -- Bounded storage: a capped bucket holds exactly the cap; one bucket per actor, hour, operation and outcome.
    if v_capped * v_cap > v_total
       or (v_total > 0 and v_actors = 0)
       or v_n[1] > v_actors * 24 * v_cap or v_n[2] > v_actors * 24 * v_cap or v_n[3] > v_actors * 24 * v_cap or v_n[4] > v_actors * 24 * v_cap
       or v_failed > v_actors * cardinality(v_hours) * v_cap
       or v_capped > v_actors * 24 * 4 or v_capped > v_stored then
      raise exception 'invalid_snapshot';
    end if;
    if v_failed > 0 then
      v_out := v_out || jsonb_build_array(jsonb_build_object('code', 'APP_FAILURES_REPORTED', 'source', 'app_unverified',
        'connection_id', null, 'op', v_ops[i],
        'severity', case when exists (select 1 from unnest(v_hours) a (h) join unnest(v_hours) b (h) on b.h = a.h + interval '1 hour')
                         then 'high' else 'warning' end,
        'count', v_failed, 'oldest_at', (select min(x) from unnest(v_hours) x)));
    end if;
  end loop;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- State transitions for one source (owner-only). p_slots are the slot keys the validated source observed.
-- ---------------------------------------------------------------------------
create function private.operations_alert_apply(p_source text, p_slots text[], p_findings jsonb, p_now timestamptz) returns void
language plpgsql volatile set search_path = '' as $$
begin
  insert into operations.alert_state as a (alert_key, source, code, connection_id, op, severity, active, episode_count,
      first_seen_at, last_seen_at, last_changed_at, cleared_at, unobserved_since, observed_count, observed_oldest_at)
  select (f ->> 'code') || ':' || coalesce(f ->> 'connection_id', f ->> 'op'), p_source, f ->> 'code',
    (f ->> 'connection_id')::uuid, f ->> 'op', f ->> 'severity', true, 1, p_now, p_now, p_now, null, null,
    (f ->> 'count')::bigint, (f ->> 'oldest_at')::timestamptz
  from jsonb_array_elements(p_findings) f
  where f ->> 'source' = p_source
  on conflict (alert_key) do update
    set active = true,
        episode_count = a.episode_count + case when a.active then 0 else 1 end,
        last_changed_at = case when a.active then a.last_changed_at else excluded.last_changed_at end,
        last_seen_at = excluded.last_seen_at,
        cleared_at = null,
        unobserved_since = null,
        severity = excluded.severity,
        observed_count = excluded.observed_count,
        observed_oldest_at = excluded.observed_oldest_at;

  -- Observed slot, condition absent in a validated read of this source: clear (row kept).
  update operations.alert_state a
     set active = false, cleared_at = p_now, last_changed_at = p_now, unobserved_since = null
   where a.source = p_source and a.active and a.alert_key = any (p_slots)
     and not exists (select 1 from jsonb_array_elements(p_findings) f
                     where (f ->> 'code') || ':' || coalesce(f ->> 'connection_id', f ->> 'op') = a.alert_key);
  update operations.alert_state a set unobserved_since = null
   where a.source = p_source and a.unobserved_since is not null and a.alert_key = any (p_slots);
  -- Slot no longer listed by the source (connection gone): unknown, so left exactly as it was apart from the marker.
  update operations.alert_state a set unobserved_since = p_now
   where a.source = p_source and a.unobserved_since is null and a.alert_key <> all (p_slots);
end $$;

-- One fixed advisory key for every evaluator run (transaction-scoped; released at commit or rollback).
create function private.operations_alerts_try_lock() returns boolean
language sql volatile set search_path = '' as
$$ select pg_catalog.pg_try_advisory_xact_lock(20261013114038) $$;

-- ---------------------------------------------------------------------------
-- Evaluator (owner-only). p_trigger is 'cron' (the separately scheduled job) or 'manual' (a trusted SQL session).
-- Returns 'busy' or the run status; never an error text.
-- ---------------------------------------------------------------------------
create function private.evaluate_operations_alerts(p_trigger text) returns text
language plpgsql volatile security invoker
set search_path = '' set timezone = 'UTC' set statement_timeout = '30s' set lock_timeout = '2s' as $$
declare
  v_now timestamptz;
  v_snap jsonb;
  v_findings jsonb;
  v_bill boolean := false;
  v_app boolean := false;
  v_status text;
begin
  if p_trigger is null or p_trigger not in ('cron', 'manual') then raise exception 'invalid_trigger'; end if;
  if not private.operations_alerts_try_lock() then return 'busy'; end if;
  -- The run time is read only AFTER the lock is held: a run that started earlier but obtained the lock later (after
  -- another run committed) must not record an older time than the run before it. The snapshots keep their own
  -- statement-time observed_at, which is never later than this.
  v_now := clock_timestamp();

  begin
    v_snap := private.operations_snapshot();
    v_findings := private.operations_alert_billing_findings(v_snap); -- validates before anything is interpreted
    perform private.operations_alert_apply('billing_authoritative',
      array(select k || ':' || (c ->> 'id') from jsonb_array_elements(v_snap -> 'connections') c,
              unnest(array['WEBHOOK_BACKLOG_STALE', 'DISCOVERY_BACKLOG_STALE']) k),
      v_findings, v_now);
    v_bill := true;
  exception when others then
    v_bill := false; -- this source's rows are rolled back to the savepoint; nothing about the error is kept
  end;

  begin
    v_snap := private.application_outcomes_snapshot();
    v_findings := private.operations_alert_app_findings(v_snap);
    perform private.operations_alert_apply('app_unverified',
      array(select 'APP_FAILURES_REPORTED:' || o from unnest(array['assessment_save', 'report_pdf', 'report_csv', 'analytics_pdf',
              'analytics_csv', 'dashboard_csv']) o),
      v_findings, v_now);
    v_app := true;
  exception when others then
    v_app := false;
  end;

  v_status := case when v_bill and v_app then 'ok' when v_app then 'billing_unavailable' when v_bill then 'app_unavailable'
                   else 'both_unavailable' end;
  insert into operations.alert_heartbeat (id) values (true) on conflict (id) do nothing;
  update operations.alert_heartbeat h set
    last_attempt_at = v_now,
    last_attempt_trigger = p_trigger,
    billing_status = case when v_bill then 'ok' else 'unavailable' end,
    app_status = case when v_app then 'ok' else 'unavailable' end,
    billing_ok_at = case when v_bill then v_now else h.billing_ok_at end,
    app_ok_at = case when v_app then v_now else h.app_ok_at end,
    last_cron_attempted_at = case when p_trigger = 'cron' then v_now else h.last_cron_attempted_at end,
    last_cron_status = case when p_trigger = 'cron' then v_status else h.last_cron_status end,
    last_cron_completed_at = case when p_trigger = 'cron' and v_status = 'ok' then v_now else h.last_cron_completed_at end,
    last_manual_attempted_at = case when p_trigger = 'manual' then v_now else h.last_manual_attempted_at end,
    last_manual_status = case when p_trigger = 'manual' then v_status else h.last_manual_status end
  where h.id;
  return v_status;
end $$;

-- ---------------------------------------------------------------------------
-- Read: owner-only helper, guarded private entry, public invoker wrapper
-- ---------------------------------------------------------------------------
create function private.operations_alerts_read() returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_now timestamptz := statement_timestamp();
  v_job text := 'not_measured';
  v_n bigint;
  v_active boolean;
  v_h operations.alert_heartbeat;
begin
  -- Optional scheduler catalog probe, fixed job name only. Without a readable cron.job (PGlite, or no pg_cron) the
  -- answer is 'not_measured', never 'inactive'.
  begin
    if to_regclass('cron.job') is not null then
      execute 'select count(*), bool_or(j.active) from cron.job j where j.jobname = $1' into v_n, v_active using 'savour-operations-alerts';
      v_job := case when v_n = 0 then 'absent' when v_n > 1 then 'not_measured' when v_active then 'active' else 'inactive' end;
    end if;
  exception when others then
    v_job := 'not_measured';
  end;
  select * into v_h from operations.alert_heartbeat h where h.id;
  return jsonb_build_object(
    'observed_at', v_now,
    'scheduler_job', v_job,
    'heartbeat', jsonb_build_object(
      'last_attempt_at', v_h.last_attempt_at,
      'last_attempt_trigger', v_h.last_attempt_trigger,
      'billing_status', v_h.billing_status,
      'app_status', v_h.app_status,
      'billing_ok_at', v_h.billing_ok_at,
      'app_ok_at', v_h.app_ok_at,
      'last_cron_attempted_at', v_h.last_cron_attempted_at,
      'last_cron_status', v_h.last_cron_status,
      'last_cron_completed_at', v_h.last_cron_completed_at,
      'last_manual_attempted_at', v_h.last_manual_attempted_at,
      'last_manual_status', v_h.last_manual_status,
      -- Proposed: a scheduled run every 5 minutes, so more than 10 minutes without one is stale.
      'cron_freshness', case
        when v_h.last_cron_attempted_at is null then 'never'
        when v_now - v_h.last_cron_attempted_at > interval '10 minutes' then 'stale'
        when v_h.last_cron_status <> 'ok' then 'unavailable'
        else 'fresh' end),
    'alert_limit', 100,
    'alerts_total', (select count(*) from operations.alert_state),
    'alerts_active', (select count(*) from operations.alert_state a where a.active),
    'alerts_truncated', (select count(*) from operations.alert_state) > 100,
    -- At most 100 rows: active first, then high severity, then most recently changed. Totals above are unbounded.
    'alerts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'code', a.code, 'source', a.source, 'connection_id', a.connection_id, 'op', a.op, 'severity', a.severity,
          'active', a.active, 'episode_count', a.episode_count, 'first_seen_at', a.first_seen_at, 'last_seen_at', a.last_seen_at,
          'last_changed_at', a.last_changed_at, 'cleared_at', a.cleared_at, 'unobserved_since', a.unobserved_since,
          'observed_count', a.observed_count, 'observed_oldest_at', a.observed_oldest_at)
        order by a.active desc, a.severity = 'high' desc, a.last_changed_at desc, a.alert_key)
      from (select * from operations.alert_state s
            order by s.active desc, s.severity = 'high' desc, s.last_changed_at desc, s.alert_key limit 100) a), '[]'::jsonb));
end $$;

create function private.platform_operations_alerts() returns jsonb
language plpgsql stable security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '5s' set lock_timeout = '2s' as $$
begin
  perform private.platform_actor(false);
  return private.operations_alerts_read();
end $$;

create function public.platform_operations_alerts() returns jsonb
language sql stable security invoker set search_path = '' as
$$ select private.platform_operations_alerts() $$;

-- ---------------------------------------------------------------------------
-- Grants: everything owner-only except the guarded read entry and its wrapper (authenticated). No schema, table
-- or role grant is added anywhere.
-- ---------------------------------------------------------------------------
revoke all on function private.operations_alert_ts(jsonb, boolean), private.operations_alert_past_ts(jsonb, timestamptz),
  private.operations_alert_keys(jsonb, text[]),
  private.operations_alert_count(jsonb), private.operations_alert_billing_findings(jsonb), private.operations_alert_app_findings(jsonb),
  private.operations_alert_apply(text, text[], jsonb, timestamptz), private.operations_alerts_try_lock(),
  private.evaluate_operations_alerts(text), private.operations_alerts_read(), private.platform_operations_alerts(),
  public.platform_operations_alerts()
  from public, anon, authenticated, service_role, billing_intake, billing_gateway, billing_worker;
grant execute on function private.platform_operations_alerts(), public.platform_operations_alerts() to authenticated;
