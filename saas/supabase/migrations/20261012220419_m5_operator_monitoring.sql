-- SAVOUR Milestone 5 OPS01: read-only billing operations snapshot for the founder platform admin.
--
-- Additive only. No table, column, trigger, cron job, worker path or grant on any existing object changes;
-- earlier migrations are untouched. Nothing here writes: all three functions are STABLE (PostgreSQL
-- refuses INSERT/UPDATE/DELETE inside a non-volatile function) and only read billing/platform tables.
--
-- Security model (the established M1/M4 pattern; no SECURITY DEFINER function in public)
-- * public.platform_operations_snapshot(): SECURITY INVOKER wrapper, search_path='', no parameters,
--   executable by authenticated only. It only calls the guarded private entry.
-- * private.platform_operations_snapshot(): the guarded entry. SECURITY DEFINER, search_path='', UTC,
--   statement_timeout 5s, lock_timeout 2s. It calls private.platform_actor(false) before reading anything,
--   so the caller must be a live, unrevoked row in platform.admins resolved from auth.uid() (the verified
--   JWT subject). JWT metadata, roles or claims other than sub confer nothing. Read-only, so aal1 and aal2
--   are both accepted (same rule as the existing platform_overview). Executable by authenticated, like the
--   existing private.platform_overview(); a direct call enforces exactly the same actor check.
-- * private.operations_snapshot(): the data helper. SECURITY INVOKER with no grant to any role: it runs
--   only as the database owner (through the guarded entry above or a trusted SQL session).
-- * Output is an explicit allowlist built with jsonb_build_object: IDs, provider/status enums, whole
--   counts and timestamps. No labels, bodies, event IDs, error/kind/worker free text, notes, details,
--   provider refs, fingerprints, emails or secret IDs. Worker error codes are collapsed in SQL to
--   success (finished, error_code null, failed = 0), partial (error_code null, failed > 0) and failure
--   (error_code not null); 'none' when no cron run of that mode ever finished.
-- * "Required" connections are exactly billing.worker_connections(), the selector the worker itself
--   calls (id = any(...)). The predicate is not restated here.
--
-- Time: every age is computed by the caller against observed_at = statement_timestamp(), which is the
-- same instant for every read in this snapshot. Timestamps are emitted in UTC (guarded entry SET timezone).
-- Bounded: 24-hour windows for recent counts, no arbitrary lookback parameter.
-- statement_timeout below applies to statements started inside the call; PostgreSQL arms the timer for
-- the top-level RPC statement when it starts, so the effective bound for one call is the role-level
-- timeout PostgREST applies. lock_timeout is honoured per lock wait (AccessShare only conflicts with DDL).

-- ---------------------------------------------------------------------------
-- Read-path indexes (partial: only non-terminal or unfinished rows, which are few)
-- ---------------------------------------------------------------------------
create index webhook_inbox_backlog_idx on billing.webhook_inbox (connection_id, received_at)
  where status in ('pending', 'processing', 'failed');
create index discovered_payments_backlog_idx on billing.discovered_payments (connection_id, first_seen_at)
  where state in ('pending', 'processing', 'retry');
create index worker_runs_cron_finished_idx on billing.worker_runs (connection_id, mode, finished_at desc, id desc)
  where trigger = 'cron' and finished_at is not null;
create index worker_runs_cron_unfinished_idx on billing.worker_runs (connection_id, mode, started_at)
  where trigger = 'cron' and finished_at is null;
create index review_queue_unresolved_idx on billing.review_queue (connection_id, created_at)
  where resolved_at is null;
create index inbox_collisions_conn_received_idx on billing.inbox_collisions (connection_id, received_at);

-- ---------------------------------------------------------------------------
-- Snapshot (owner-only helper)
-- ---------------------------------------------------------------------------
create function private.operations_snapshot() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_now timestamptz := statement_timestamp();
  v_required uuid[] := billing.worker_connections();
begin
  return jsonb_build_object(
    'observed_at', v_now,
    'worker_connection_ids', to_jsonb(v_required),
    'connections', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', c.id,
          'provider_code', c.provider_code,
          'status', c.status,
          'worker_required', c.id = any (v_required),
          'webhook', (
            select jsonb_build_object(
              'pending', count(*) filter (where w.status = 'pending'),
              'processing', count(*) filter (where w.status = 'processing'),
              'failed', count(*) filter (where w.status = 'failed'),
              'expired_leases', count(*) filter (where w.status = 'processing' and w.lease_until < v_now),
              'oldest_received_at', min(w.received_at))
            from billing.webhook_inbox w
            where w.connection_id = c.id and w.status in ('pending', 'processing', 'failed')),
          'webhook_dead', (select count(*) from billing.webhook_inbox w where w.connection_id = c.id and w.status = 'dead'),
          'webhook_quarantined', (select count(*) from billing.webhook_inbox w where w.connection_id = c.id and w.status = 'quarantined'),
          'discovery', (
            select jsonb_build_object(
              'pending', count(*) filter (where d.state = 'pending'),
              'processing', count(*) filter (where d.state = 'processing'),
              'retry', count(*) filter (where d.state = 'retry'),
              'expired_leases', count(*) filter (where d.state = 'processing' and d.lease_until < v_now),
              'oldest_first_seen_at', min(d.first_seen_at))
            from billing.discovered_payments d
            where d.connection_id = c.id and d.state in ('pending', 'processing', 'retry')),
          'discovery_dead', (select count(*) from billing.discovered_payments d where d.connection_id = c.id and d.state = 'dead'),
          'reviews', (
            select jsonb_build_object('open', count(*), 'oldest_created_at', min(r.created_at))
            from billing.review_queue r where r.connection_id = c.id and r.resolved_at is null),
          'collisions_24h', (
            select count(*) from billing.inbox_collisions x
            where x.connection_id = c.id and x.received_at > v_now - interval '24 hours'),
          'runs', (
            select jsonb_object_agg(m.mode, (
              select jsonb_build_object(
                'latest_finished_at', l.finished_at,
                'latest_outcome', case
                  when l.id is null then 'none'
                  when l.error_code is not null then 'failure'
                  when l.failed > 0 then 'partial'
                  else 'success' end,
                'latest_success_at', (
                  select max(s.finished_at) from billing.worker_runs s
                  where s.connection_id = c.id and s.mode = m.mode and s.trigger = 'cron' and s.finished_at is not null
                    and s.error_code is null and s.failed = 0),
                'unfinished', (
                  select count(*) from billing.worker_runs u
                  where u.connection_id = c.id and u.mode = m.mode and u.trigger = 'cron' and u.finished_at is null),
                'oldest_unfinished_started_at', (
                  select min(u.started_at) from billing.worker_runs u
                  where u.connection_id = c.id and u.mode = m.mode and u.trigger = 'cron' and u.finished_at is null),
                'failed_24h', (
                  select count(*) from billing.worker_runs f
                  where f.connection_id = c.id and f.mode = m.mode and f.trigger = 'cron' and f.finished_at > v_now - interval '24 hours'
                    and f.error_code is not null),
                'partial_24h', (
                  select count(*) from billing.worker_runs f
                  where f.connection_id = c.id and f.mode = m.mode and f.trigger = 'cron' and f.finished_at > v_now - interval '24 hours'
                    and f.error_code is null and f.failed > 0))
              from (select 1) one
              left join lateral (
                select r.id, r.finished_at, r.error_code, r.failed from billing.worker_runs r
                where r.connection_id = c.id and r.mode = m.mode and r.trigger = 'cron' and r.finished_at is not null
                order by r.finished_at desc, r.id desc limit 1) l on true))
            from (values ('process'), ('discover'), ('reconcile')) m (mode)))
        order by c.created_at, c.id)
      from platform.provider_connections c), '[]'::jsonb),
    'unassigned_reviews', (
      select jsonb_build_object('open', count(*), 'oldest_created_at', min(r.created_at))
      from billing.review_queue r where r.connection_id is null and r.resolved_at is null));
end $$;

-- ---------------------------------------------------------------------------
-- Guarded private entry (platform admin checked live first) and public invoker wrapper
-- ---------------------------------------------------------------------------
create function private.platform_operations_snapshot() returns jsonb
language plpgsql stable security definer
set search_path = '' set timezone = 'UTC' set statement_timeout = '5s' set lock_timeout = '2s' as $$
begin
  perform private.platform_actor(false);
  return private.operations_snapshot();
end $$;

create function public.platform_operations_snapshot() returns jsonb
language sql stable security invoker set search_path = '' as
$$ select private.platform_operations_snapshot() $$;

-- ---------------------------------------------------------------------------
-- Grants: the data helper is owner-only; authenticated may execute only the guarded entry and the
-- wrapper. No schema or table grant changes.
-- ---------------------------------------------------------------------------
revoke all on function private.operations_snapshot(), private.platform_operations_snapshot(), public.platform_operations_snapshot()
  from public, anon, authenticated, service_role, billing_intake, billing_gateway, billing_worker;
grant execute on function private.platform_operations_snapshot(), public.platform_operations_snapshot() to authenticated;
