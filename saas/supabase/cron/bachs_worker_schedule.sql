-- SAVOUR billing worker schedule (pg_cron + pg_net). NOT a migration and not applied by any tool:
-- the operator (Sol) runs it in savour-dev after the Edge functions are deployed and the two Vault
-- secrets below exist. It contains no secret values: the worker URL and bearer token are read from
-- Vault at each run. Creating Vault secrets is a separate operator step, e.g. (placeholders only):
--   select vault.create_secret('<worker-token-at-least-32-random-characters>', 'savour_billing_worker_token');
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/bachs-worker', 'savour_billing_worker_url');
-- Proof of the job path is a cron.job_run_details row AND a billing.worker_runs row with trigger 'cron';
-- a manual call records trigger 'manual' and proves nothing about scheduling.
begin;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then raise exception 'pg_cron is not enabled'; end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then raise exception 'pg_net is not enabled'; end if;
  if (select count(*) from vault.decrypted_secrets where name in ('savour_billing_worker_token', 'savour_billing_worker_url')) <> 2 then
    raise exception 'Vault secrets savour_billing_worker_token and savour_billing_worker_url are required';
  end if;
  if exists (select 1 from vault.decrypted_secrets where name = 'savour_billing_worker_token' and length(decrypted_secret) < 32) then
    raise exception 'savour_billing_worker_token must be at least 32 characters';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'savour_billing_worker_url'
                 and decrypted_secret ~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/bachs-worker$') then
    raise exception 'savour_billing_worker_url must be the project bachs-worker function URL';
  end if;
end $$;

create or replace function private.savour_billing_worker_call(p_mode text) returns bigint
language plpgsql security definer set search_path = '' as $fn$
begin
  if p_mode not in ('process', 'discover', 'reconcile', 'housekeeping') then raise exception 'invalid mode'; end if;
  return net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'savour_billing_worker_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'savour_billing_worker_token')),
    body := jsonb_build_object('mode', p_mode, 'trigger', 'cron'),
    timeout_milliseconds := 10000);
end $fn$;
revoke all on function private.savour_billing_worker_call(text) from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname in ('savour-billing-process', 'savour-billing-housekeeping', 'savour-billing-reconcile', 'savour-billing-discover');
select cron.schedule('savour-billing-process', '* * * * *', $$select private.savour_billing_worker_call('process')$$);
select cron.schedule('savour-billing-housekeeping', '*/15 * * * *', $$select private.savour_billing_worker_call('housekeeping')$$);
-- Bounded missed-payment discovery (renewals without a webhook): at most 5 list pages and 7 detail reads per run.
select cron.schedule('savour-billing-discover', '41 * * * *', $$select private.savour_billing_worker_call('discover')$$);
select cron.schedule('savour-billing-reconcile', '17 3 * * *', $$select private.savour_billing_worker_call('reconcile')$$);

commit;
