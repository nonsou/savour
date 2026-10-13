-- SAVOUR internal operations alert check (pg_cron only). NOT a migration and not applied by any tool: the
-- operator (Sol) reviews and runs it in savour-dev only, after the owner decides the alert recipient channel.
-- It schedules exactly one job, savour-operations-alerts, every 5 minutes. The job runs the owner-only evaluator,
-- which reads two existing database snapshots and writes the internal alert state and heartbeat. No pg_net, HTTP,
-- Vault, email or configuration change; no other job is touched. cron.schedule with an existing job name updates
-- that job in place.
-- Run it as the database owner role that owns private.evaluate_operations_alerts(text) (the job runs as the
-- scheduling role). Proof of the job path is a heartbeat whose last cron attempt is recent (shown on
-- /platform/alerts) AND a cron.job_run_details row for this job; a manual run proves nothing about scheduling.
begin;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then raise exception 'pg_cron is not enabled'; end if;
  if to_regprocedure('private.evaluate_operations_alerts(text)') is null then
    raise exception 'private.evaluate_operations_alerts(text) is missing: apply the migration first';
  end if;
end $$;

select cron.schedule('savour-operations-alerts', '*/5 * * * *', $$select private.evaluate_operations_alerts('cron')$$);

commit;
