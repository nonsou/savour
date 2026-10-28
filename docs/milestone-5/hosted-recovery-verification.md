# Hosted recovery verification — 29 October 2026

Status: **backup inventory verified; hosted restore NOT executed**.

## Read-only observations

- `savour-dev` (`ilhutasrxnbtssswmgam`), eu-west-1, reports ACTIVE_HEALTHY and PostgreSQL 17.11.0.003. No development branches exist.
- Supabase CLI 2.120.0 `backups list --project-ref ilhutasrxnbtssswmgam --output json` returned eight backup records, all physical and COMPLETED. Record dates span 21–28 October 2026. This is the observed inventory, not a promised retention period or proof of recoverability.
- Latest record: ID `2094400118`, inserted_at `2026-10-28T06:59:05.104Z` (07:59:05 Africa/Lagos). Oldest listed: ID `2027268846`, inserted_at `2026-10-21T06:59:53.937Z`.
- `pitr_enabled=false`, `walg_enabled=true`, region eu-west-1. No PITR add-on was enabled.
- Read-only SQL observed 25 approved report revisions and six active jobs. A new baseline using `md5(string_agg(row_to_json(r)::text, E'\n' order by r.id))` is `0b8afa24048b9a13a1c16961f1817f3a`. This serialization differs from the earlier historical fingerprint and is not compared to that hash. No database mutation was performed in this verification.
- Current official changelog and backup documentation were consulted. Relevant recent fixes concern missed daily schedules and credential resynchronization after restore; completed inventory is not substituted for a restore test.

## Owner decision and execution boundary

The owner selected nonsou's Org (`flpqwxxymurgbjltlkvv`) for the proposed isolated target. Supabase quoted an additional USD10/month. The owner explicitly declined a paid project on 29 October. No cost confirmation, new project, branch, paid add-on, restore or real-data export was performed.

Prepared test target: `savour-recovery-test`, eu-west-1, synthetic inspections/reports only, with no payment/email credentials, cron jobs, worker deployments or outbound integrations; remove after verification. This remains a proposal, not an existing resource. A free target must be explicitly selected and verified isolated before use; unrelated existing projects must not be reused.

The current development project cannot serve as its own destructive restore target. Physically cloning it would copy encryption roots and could immediately run cron/net jobs. Existing Firebase MVP and Preview application are untouched. No login or secret disclosure was needed for the inventory check.

## Remaining acceptance

- An approved free isolated target, or a separately approved paid target, must be available before execution.
- Apply reviewed application migrations and clearly labelled synthetic fixtures on the target without copying existing users or Vault secrets. Verify source/target version compatibility and absence of egress first.
- Distinguish a logical archive round trip on hosted Supabase from a provider-managed backup restoration. For managed restoration, capture an actual backup containing the fixture before mutation and restore only the disposable target. Daily backup availability may require waiting; do not enable paid PITR to accelerate it.
- Compare dump/backup-time report hashes, row counts, sequence state, catalog permissions/RLS, and tenant/immutability probes; verify no outbound effects and final cleanup.
- Real Auth/MFA, Storage bytes, custom-role re-keying and paid/refund/dispute billing reconciliation remain separate unverified checks. Do not declare OPS01, Milestone 5 or hosted recovery complete from inventory alone.

[Local native drill](local-recovery-rehearsal.md) passed previously. [Managed restore checklist](managed-restore-checklist.md) preserves the target/export isolation controls.

Sources: [Supabase backups](https://supabase.com/docs/guides/platform/backups), [clone behavior](https://supabase.com/docs/guides/platform/clone-project), [backup scheduling fix](https://supabase.com/changelog/bulk-prepare-retry-on-transient-failure), [credential resynchronization fix](https://supabase.com/changelog/restore-credential-resync).
