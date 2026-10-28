# Local recovery verification — 28 October 2026

Status: **PASS — LOCAL_NATIVE_LOGICAL_REHEARSAL_ONLY**. This closes only the local synthetic logical archive drill, not OPS01, Milestone 5 or the managed restore release gate.

## Execution and evidence

- Actual Claude Code Opus 5.5 implemented the utility, fixture, probes, tests and draft checklist in a sanitized development copy. Actual Fable 5.1 reviewed the architecture and code. Sol reviewed and repaired integration issues, ran the native drill and repository checks, and maintained evidence. Models received no environment files, credentials or real customer data.
- Native binaries: PostgreSQL 17.11 throughout, from the official Postgres.app 2.9.6 PG17-only image. Image verification and deep/strict code-signature verification passed. Image SHA-256: `b38bb00b8c8702a568270aab85995c550f7f93d1503b818efdc5ff9a519b7168`. Download: [official release](https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.6/Postgres-2.9.6-17.dmg). No app installation or persistent service was created.
- 20 real migrations, 59 tables, four sequences (last_value and is_called), 23 RLS policies, 50 triggers, 335 functions and one view compared. Two synthetic businesses each had one trial billing row and one approved immutable report. Auth/Vault were labelled local doubles; no cloud database was exported.
- Real custom-format pg_dump/pg_restore passed into a fresh empty database. Report and trial-billing row hashes matched; all catalog sections matched. Tenant denial and report immutability probes passed and rolled back. A source-only mutation was recovered from the dump into another empty database. Byte-flipped and truncated copies failed the checksum gate. An injected error after table-data restoration left no partial app schema/data under single-transaction restore.
- Final run: all 17 checks passed, exit zero; server stopped and owned temporary artifacts deleted. See [JSON result](local-recovery-result.json). Durations in that result are measured local timings only, not recovery commitments.
- Repository verification: focused recovery tests 10/10 passed; TypeScript passed. Repository lint passed. No application code, dependency, schema migration, hosted data or Preview deployment changed. Historical full-suite counts are not presented as rerun evidence.

## Findings and fixes

Fable independently confirmed the teardown defect also found by Sol: a partially successful startup could skip stop, or failed stop could still delete live data. Startup attempts now always trigger stop; unverified shutdown fails and preserves the owned directory. Socket error tokens are redacted instead of destroying the JSON failure report. Unknown argument values are never echoed. Node >=22.12.0 is documented. Sequence is_called and view definitions are included; ACL arrays are sorted and use effective defaults.

The first two native runs failed strictly on schema representation. Diagnosis showed owner-only explicit ACLs versus equivalent null default ACLs, and an equivalent nested AND check-expression tree. Defaults now use PostgreSQL acldefault (sequence type lowercase s), and constraints use pg_get_constraintdef(..., true). No permission or constraint comparison was dropped. The final run passed after these corrections. Earlier failed runs also verified shutdown and their owned artifacts were subsequently removed.

## Limits and next gate

This verifies neither paid/refund/dispute billing state nor real Auth/MFA, Vault encryption, Storage, extensions, hosted configuration, managed backups or PITR. Roles share a single local cluster; role re-keying was not tested. No RTO/RPO or SLA is established.

Do not physically clone the current Supabase project: copied encryption roots and immediately active cron/net jobs risk provider/email egress. The [managed checklist](managed-restore-checklist.md) prepares a reviewed logical restore into an approved isolated empty target, with no credentials/jobs/egress and new role keys. Target, any cost and any real-data export need separate approval. Existing development approval does not cover another paid project.

Support hours, escalation coverage and six named pilot partners remain owner decisions. Deferred Bachs lifecycle/NGN tests and Paystack/Stripe integrations remain open. No pilot outreach or production changes were made.
