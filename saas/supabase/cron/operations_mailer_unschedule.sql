-- SAVOUR operations mailer unschedule (OPERATOR SOURCE, NOT A MIGRATION). Removes only the job named
-- savour-operations-mailer and its owner-only helper. The five other jobs are never touched. Safe to run twice.
-- To stop sending without removing the job, an aal2 platform admin can switch automatic email off on /platform/alerts.
begin;
select cron.unschedule(j.jobid) from cron.job j where j.jobname = 'savour-operations-mailer';
drop function if exists private.operations_mailer_invoke();
commit;
