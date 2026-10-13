-- Removes only the SAVOUR operations alert job (operator step). Alert state, heartbeat and every other job stay.
select cron.unschedule(jobid) from cron.job where jobname = 'savour-operations-alerts';
