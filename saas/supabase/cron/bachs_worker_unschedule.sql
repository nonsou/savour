-- Removes the SAVOUR billing worker schedule (operator step; no secrets touched).
select cron.unschedule(jobname) from cron.job where jobname in ('savour-billing-process', 'savour-billing-housekeeping', 'savour-billing-reconcile', 'savour-billing-discover');
drop function if exists private.savour_billing_worker_call(text);
