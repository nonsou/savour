-- SAVOUR Milestone 5 OPS02: bounded, user-session-reported application outcome counters for inspection saves
-- and report/analytics/dashboard exports, plus a read-only aggregate snapshot for the founder platform admin.
--
-- Additive only. Earlier migrations, tables, triggers, cron jobs, worker paths and existing grants are untouched.
--
-- What this measures (and what it does not)
-- * The app server reports one outcome per instrumented operation, AFTER the response, through the caller's
--   own authenticated session (there is no privileged server database client). The trusted record is the
--   structured host log line the server writes first; these counters are a best-effort convenience copy.
-- * Any signed-in user can call the logger directly and so can inflate or suppress their OWN counters
--   (never anyone else's): counts are unverified user-session reports, not tamper-proof observations.
--   Signed-out callers, an unreachable database, a killed process or a report slower than the app's 750 ms
--   bound are not counted at all.
--
-- Storage is bounded by construction (no append log, no cleanup job, no scan)
-- * operations.application_outcome_counts has one row per (actor, UTC hour-of-day slot 0-23, op, outcome).
--   The primary key caps each actor at 24 x 6 x 4 = 576 rows. A report landing in a slot that still holds an
--   older hour overwrites it (count restarts at 1), so rows rotate in place and never accumulate.
-- * Each bucket count is clamped at 1000, so one session can add at most 1000 per op/outcome per hour.
-- * Actor, hour and time come from the database (auth.uid(), statement time); the logger takes no actor,
--   workspace, timestamp, payload or free text. op and outcome are checked against static allowlists.
-- * The logger never reads inspection, report, analytics, billing or platform tables.
--
-- Security model (the established M1/M4/M5 pattern; no SECURITY DEFINER function in public)
-- * Schema operations is not exposed by the API, has no usage grant to any client role, and its table has RLS
--   enabled with no policy and no table grant: only the database owner (through the guarded definers) reads
--   or writes it.
-- * public.record_application_outcome(op, outcome): SECURITY INVOKER wrapper -> private guarded definer that
--   stamps auth.uid() via private.require_uid() (not_authenticated otherwise). Executable by authenticated only.
-- * public.platform_application_outcomes(): SECURITY INVOKER wrapper -> private.platform_application_outcomes(),
--   SECURITY DEFINER, which calls private.platform_actor(false) (live, unrevoked platform.admins row for the
--   verified JWT subject, the same registry check as platform_operations_snapshot) BEFORE reading anything,
--   then the owner-only invoker data helper private.application_outcomes_snapshot().
-- * The table does hold actor_id (the auth user ID): it is the internal bucket identity that bounds storage per
--   user and confines each caller to their own counters. It is never exposed: the snapshot returns only static
--   op/outcome enums, whole counts (including a distinct-user count) and UTC timestamps, and the server log line
--   carries no user ID. The table holds no workspace IDs, payloads, labels or error text.
--
-- Windows (UTC, coarse by design): "last 24 hours" means the current partial UTC hour plus the 23 whole UTC
-- hours before it. Hourly buckets cannot answer "last 15 minutes", so no such figure is offered.

create schema if not exists operations;
revoke all on schema operations from public;
alter default privileges in schema operations revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema operations revoke all on functions from public, anon, authenticated, service_role;

create table operations.application_outcome_counts (
  actor_id uuid not null references auth.users (id) on delete cascade,
  slot smallint not null check (slot between 0 and 23),
  op text not null check (op in ('assessment_save', 'report_pdf', 'report_csv', 'analytics_pdf', 'analytics_csv', 'dashboard_csv')),
  outcome text not null check (outcome in ('success', 'replayed', 'rejected', 'failed')),
  hour_start timestamptz not null check (hour_start = date_trunc('hour', hour_start, 'UTC')),
  count integer not null check (count between 1 and 1000),
  last_at timestamptz not null check (last_at >= hour_start and last_at < hour_start + interval '1 hour'),
  primary key (actor_id, slot, op, outcome),
  check (slot = extract(hour from hour_start at time zone 'UTC'))
);
alter table operations.application_outcome_counts enable row level security;
-- Read path: the snapshot only looks at the last 24 hour_start values.
create index application_outcome_counts_hour_idx on operations.application_outcome_counts (hour_start);
revoke all on table operations.application_outcome_counts
  from public, anon, authenticated, service_role, billing_intake, billing_gateway, billing_worker;

-- ---------------------------------------------------------------------------
-- Logger: guarded private definer + public invoker wrapper
-- ---------------------------------------------------------------------------
create function private.record_application_outcome(p_op text, p_outcome text) returns void
language plpgsql volatile security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '2s' set lock_timeout = '1s' as $$
declare
  v_uid uuid := private.require_uid();
  v_now timestamptz := statement_timestamp();
  v_hour timestamptz := date_trunc('hour', statement_timestamp());
begin
  if p_op is null or p_op not in ('assessment_save', 'report_pdf', 'report_csv', 'analytics_pdf', 'analytics_csv', 'dashboard_csv')
     or p_outcome is null or p_outcome not in ('success', 'replayed', 'rejected', 'failed') then
    perform private.fail('invalid_telemetry');
  end if;
  insert into operations.application_outcome_counts as c (actor_id, slot, op, outcome, hour_start, count, last_at)
  values (v_uid, extract(hour from v_hour)::smallint, p_op, p_outcome, v_hour, 1, v_now)
  on conflict (actor_id, slot, op, outcome) do update
    set count = case when c.hour_start = excluded.hour_start then least(c.count + 1, 1000) else 1 end,
        hour_start = excluded.hour_start,
        last_at = greatest(case when c.hour_start = excluded.hour_start then c.last_at end, excluded.last_at)
    -- A row already holding a later hour (clock moved backwards) is left alone rather than rewound.
    where c.hour_start <= excluded.hour_start;
end $$;

create function public.record_application_outcome(p_op text, p_outcome text) returns void
language sql volatile security invoker set search_path = '' as
$$ select private.record_application_outcome(p_op, p_outcome) $$;

-- ---------------------------------------------------------------------------
-- Snapshot: owner-only data helper, guarded private entry, public invoker wrapper
-- ---------------------------------------------------------------------------
create function private.application_outcomes_snapshot() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_now timestamptz := statement_timestamp();
  v_from timestamptz := date_trunc('hour', statement_timestamp(), 'UTC') - interval '23 hours';
  v_to timestamptz := date_trunc('hour', statement_timestamp(), 'UTC');
begin
  return jsonb_build_object(
    'observed_at', v_now,
    'window_start', v_from,
    'bucket_cap', 1000,
    'stored_buckets', (select count(*) from operations.application_outcome_counts),
    'reporting_actors_24h', (
      select count(distinct b.actor_id) from operations.application_outcome_counts b
      where b.hour_start between v_from and v_to),
    'operations', (
      select jsonb_agg(jsonb_build_object(
          'op', a.op, 'success', a.success, 'replayed', a.replayed, 'rejected', a.rejected, 'failed', a.failed,
          'capped_buckets', a.capped_buckets, 'latest_reported_at', a.latest_reported_at,
          'failed_hours', coalesce((
            select jsonb_agg(f.hour_start order by f.hour_start)
            from (select distinct x.hour_start from operations.application_outcome_counts x
                  where x.op = a.op and x.outcome = 'failed' and x.hour_start between v_from and v_to) f), '[]'::jsonb))
        order by a.ord)
      from (
        select o.ord, o.op,
          coalesce(sum(b.count) filter (where b.outcome = 'success'), 0) as success,
          coalesce(sum(b.count) filter (where b.outcome = 'replayed'), 0) as replayed,
          coalesce(sum(b.count) filter (where b.outcome = 'rejected'), 0) as rejected,
          coalesce(sum(b.count) filter (where b.outcome = 'failed'), 0) as failed,
          count(b.actor_id) filter (where b.count >= 1000) as capped_buckets,
          max(b.last_at) as latest_reported_at
        from (values (1, 'assessment_save'), (2, 'report_pdf'), (3, 'report_csv'), (4, 'analytics_pdf'), (5, 'analytics_csv'),
                     (6, 'dashboard_csv')) o (ord, op)
        left join operations.application_outcome_counts b on b.op = o.op and b.hour_start between v_from and v_to
        group by o.ord, o.op) a));
end $$;

create function private.platform_application_outcomes() returns jsonb
language plpgsql stable security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '5s' set lock_timeout = '2s' as $$
begin
  perform private.platform_actor(false);
  return private.application_outcomes_snapshot();
end $$;

create function public.platform_application_outcomes() returns jsonb
language sql stable security invoker set search_path = '' as
$$ select private.platform_application_outcomes() $$;

-- ---------------------------------------------------------------------------
-- Grants: data helper owner-only; authenticated may execute only the two guarded entries and their wrappers.
-- No schema, table or role grant is added anywhere.
-- ---------------------------------------------------------------------------
revoke all on function private.record_application_outcome(text, text), public.record_application_outcome(text, text),
  private.application_outcomes_snapshot(), private.platform_application_outcomes(), public.platform_application_outcomes()
  from public, anon, authenticated, service_role, billing_intake, billing_gateway, billing_worker;
grant execute on function private.record_application_outcome(text, text), public.record_application_outcome(text, text),
  private.platform_application_outcomes(), public.platform_application_outcomes() to authenticated;
