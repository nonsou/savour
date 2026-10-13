-- SAVOUR operations mailer schedule (OPERATOR SOURCE, NOT A MIGRATION). The root operator runs this later, as the
-- database owner, in the development project only, after:
--   1. migration 20261013203437_m5_operations_mailer.sql is applied;
--   2. operations_mail has LOGIN and a password set out of band, and the pooler accepts it;
--   3. the operations-mailer function is deployed (no JWT verification) with its own function secrets
--      SAVOUR_MAIL_DATABASE_URL, SAVOUR_MAIL_TRIGGER_TOKEN and SAVOUR_MAIL_RESEND_API_KEY;
--   4. two Vault secrets exist: savour_operations_mailer_url (the function URL) and savour_operations_mailer_trigger
--      (the same trigger token, distinct from the billing worker token).
-- It adds a sixth job, savour-operations-mailer, every 5 minutes. The five existing jobs are not touched. The Resend
-- key and the database password never enter SQL or pg_net; only the trigger token is sent, as a bearer header.
-- Caveat: pg_net keeps request rows (including headers) readable by roles that can read its tables, so the trigger
-- token is queue-readable, the same exposure class as the billing trigger. Its holder can only make the
-- already-approved, quota-bounded outbox send sooner; it cannot read a secret, pick a recipient or forge a finish.
-- The whole script is one transaction: any failed check rolls back the helper and the job together.
-- Note: pg_cron's "succeeded" for this job means the HTTP request was queued, not that an email was sent or delivered.

begin;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then raise exception 'pg_cron is not enabled'; end if;
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then raise exception 'pg_net is not enabled'; end if;
  if to_regprocedure('cron.schedule(text, text, text)') is null then raise exception 'cron.schedule is missing'; end if;
  if to_regprocedure('net.http_post(text, jsonb, jsonb, jsonb, integer)') is null then raise exception 'net.http_post is missing'; end if;
  if to_regprocedure('operations.mailer_claim()') is null then raise exception 'operations mailer migration is not applied'; end if;
end $$;

-- Owner-only helper: reads the URL and trigger by fixed Vault names on every run (the job command holds neither),
-- validates them, and posts an empty JSON body with only the bearer header and a 10 second timeout.
create or replace function private.operations_mailer_invoke() returns bigint
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_url text;
  v_trigger text;
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'savour_operations_mailer_url';
  select s.decrypted_secret into v_trigger from vault.decrypted_secrets s where s.name = 'savour_operations_mailer_trigger';
  if v_url is distinct from 'https://ilhutasrxnbtssswmgam.supabase.co/functions/v1/operations-mailer' then
    raise exception 'savour_operations_mailer_url must be the fixed development function URL';
  end if;
  if v_trigger is null or length(v_trigger) < 32 or v_trigger !~ '^[A-Za-z0-9._~+/=-]+$' then
    raise exception 'savour_operations_mailer_trigger must be set (at least 32 token characters)';
  end if;
  return net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_trigger, 'Content-Type', 'application/json'),
    timeout_milliseconds := 10000);
end $$;
revoke all on function private.operations_mailer_invoke()
  from public, anon, authenticated, service_role, billing_intake, billing_gateway, billing_worker, operations_mail;

-- Validate both secrets once before scheduling (same checks as each run, without sending anything).
do $$
declare
  v_url text;
  v_trigger text;
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'savour_operations_mailer_url';
  select s.decrypted_secret into v_trigger from vault.decrypted_secrets s where s.name = 'savour_operations_mailer_trigger';
  if v_url is distinct from 'https://ilhutasrxnbtssswmgam.supabase.co/functions/v1/operations-mailer' then
    raise exception 'savour_operations_mailer_url must be the fixed development function URL';
  end if;
  if v_trigger is null or length(v_trigger) < 32 or v_trigger !~ '^[A-Za-z0-9._~+/=-]+$' then
    raise exception 'savour_operations_mailer_trigger must be set (at least 32 token characters)';
  end if;
end $$;

select cron.schedule('savour-operations-mailer', '*/5 * * * *', 'select private.operations_mailer_invoke()');

commit;
