# Managed restore checklist (for a later, separately approved drill)

Development-only preparation. Nothing here authorizes a real export, a managed restore, a new project, spending or production claims. Approval is required for the target, cost and real-data export. Routine verification within that approved scope does not need repeated approval.

## Rejected: physically cloning the current cloud database

Do **not** use Supabase "restore to new project" or any physical clone of the current database for the drill:

- A physical clone copies the database's **encryption root key**. Vault secrets in the clone would be decryptable with the same key as the source.
- A physical clone brings over **pg_cron jobs and pg_net configuration, which start running immediately**. There is no step to pause them first. The billing worker, operations alert evaluator and mailer could call live providers or send email before anyone can intervene.

## Required approach: reviewed logical restore into an approved empty target

- [ ] The target is disposable, isolated and explicitly approved as an empty target project. The same organization is acceptable if it is isolated and separately approved. Any cost is approved in writing.
- [ ] Use a logical restore only: a reviewed schema and data export of the app schemas (`public`, `private`, `billing`, `platform`, `operations`), produced under a separately approved export.
- [ ] Before loading anything, confirm the target has no cron jobs, workers, Edge Function secrets, database webhooks, auth SMTP, email (Resend) keys or payment provider keys. No cron, worker, email or payment egress is allowed.
- [ ] Omit real Vault contents and all credentials. Create new placeholder secrets and new API keys; never copy live values. Re-key the scoped roles (`billing_*`, `operations_mail`) with new out-of-band passwords, or leave them NOLOGIN.
- [ ] Restore with `--single-transaction --exit-on-error` into a target verified to be empty. Compare against the dump-time manifest using the same coverage as `local-recovery-rehearsal.md`: counts and row hashes for `report_revisions` and billing tables, sequences, RLS, policies, ACLs and triggers.
- [ ] After loading, confirm `cron.job` is empty or inactive and the `net` request queue is empty, and that no outbound call happened. Then run the denial and immutability probes. Tear the target down when finished.
- [ ] Auth users and MFA, Storage objects, API keys, project config and extensions each need their own separate verification. A logical app-schema restore says nothing about them.
- [ ] Billing state covering paid periods, refunds, disputes and reconciliation against the provider has not been rehearsed anywhere yet. It stays an open gate.

The local rehearsal (`LOCAL_NATIVE_LOGICAL_REHEARSAL_ONLY`) proves none of these hosted items.

Sources: [Supabase clone behavior](https://supabase.com/docs/guides/platform/clone-project), [backup limitations](https://supabase.com/docs/guides/platform/backups), [logical backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
