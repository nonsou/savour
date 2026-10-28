# Local recovery rehearsal (LOCAL_NATIVE_LOGICAL_REHEARSAL_ONLY)

**This is not managed-backup certification.** It is a synthetic, local logical `pg_dump`/`pg_restore` round trip on a private throwaway PostgreSQL 17 cluster. It provides no evidence for Supabase managed backups, PITR, GoTrue/MFA, real Vault encryption, Storage, extensions (pg_cron/pg_net), hosted config, or paid/refund/dispute billing state. It cannot close the billing or hosted recovery gates. Timings are measured drill durations, not an RTO/RPO or SLA.

## What it does

`saas/scripts/recovery/local-rehearsal.mjs` (helpers in `rehearsal-lib.mjs`, SQL in `seed.sql` and `probes.sql`):

1. Accepts only `--pg-bin <dir>` and an optional `--keep-artifacts`. It refuses connection URLs, hosts, database names, credentials and backup paths. It also refuses to run as root. Every one of `initdb pg_ctl postgres psql pg_dump pg_restore` must report the same PostgreSQL 17.x version.
2. Removes `PG*`, `DATABASE_URL` and `SUPABASE*` from the environment and pins `LC_ALL=C` and `TZ=UTC`. Every child process is spawned with an argument array (`shell: false`). Every psql call uses `-X` and `ON_ERROR_STOP=1`. Any stderr output from a step that is expected to succeed fails the run.
3. Creates a private `mkdtemp` directory (0700) under the OS temp dir. It runs `initdb` with bootstrap user `savour_rehearsal`, so no OS user name is used. `pg_hba.conf` contains a single line, `local all savour_rehearsal trust`, and the server runs with `listen_addresses = ''` and a 0700 socket directory.
4. Builds the source database in this order: `tests/sql/supabase-stub.sql` (the labelled local Auth/Vault doubles), then every real migration in order, each in its own transaction, then `seed.sql`. The seed uses the real RPCs to create two businesses. Each business gets a trial `billing.workspace_billing` row and one approved, immutable `report_revisions` row. The seeded plan and currency reference rows come from the migrations.
5. Takes the manifest, runs `pg_dump -Fc`, and takes the manifest again; the two manifests must be equal. It then records the archive's SHA-256 and size and runs `pg_restore --list`.
6. Makes byte-flip and truncated copies of the archive. Both must be rejected by the SHA-256/size gate before any restore. `pg_restore --list` is **not** relied on to detect payload corruption.
7. Restores into a freshly created, verified-empty database with `pg_restore --single-transaction --exit-on-error` (no `--clean`, `--create` or `pg_dumpall`; roles are never restored). The result must equal the dump-time manifest. It then runs `probes.sql` (rolled back):
   - Owner A reads its approved report with an unchanged `inputs_hash`.
   - Owner A gets `not_found` for Business B's report.
   - `authenticated` cannot read `report_revisions` directly.
   - An UPDATE or DELETE on `report_revisions` raises `immutable_record`, even for the database owner.
8. **Recovery:** renames workspace A in the source only. The manifest must show `public.workspaces` changed. The script then restores the original archive into another fresh database, which must equal the dump-time manifest.
9. **Negative atomicity control:** in a separate database it creates a local event trigger in schema `rehearsal_negative_control` that raises on the first `CREATE TRIGGER`. The TOC must place every trigger after all table data, so the error is late. The restore must fail with the marker, leaving only `public` and the control schema and no app relations.
10. In a `finally` block, stops the server with `pg_ctl stop -m fast`, falling back to `immediate`. It checks that the postmaster PID is gone, `postmaster.pid` is removed and the socket file is gone. It deletes only the exact mkdtemp directory it created, and only after verified shutdown. If shutdown cannot be verified, the run fails and keeps the directory for inspection; `--keep-artifacts` also retains it. No partially restored database or app service is ever started.

The JSON report goes to stdout. Its first field is `label`. Private paths and socket-file tokens are redacted, and the script refuses to print a report that contains anything credential-like. Unknown arguments are rejected without echoing their values. Requires the repository Node engine (>=22.12.0).

## Manifest coverage inventory

- **Archive:** SHA-256 and size; PostgreSQL versions of all binaries.
- **Data:** for every ordinary table outside `pg_*` and `information_schema`, the row count and the SHA-256 of rows ordered by their text form (C collation, UTC, fixed date and float output). This covers `public.report_revisions`, `billing.workspace_billing`, auth/vault doubles, and others.
- **Sequences:** `last_value` and `is_called` of every app sequence (identity columns).
- **Catalog** (a count and a hash for each section):
  - schemas (owner and ACL)
  - relations (kind, owner, `relrowsecurity`, `relforcerowsecurity`, ACL)
  - views (canonical body)
  - columns (type, not-null, default, column ACL)
  - constraints, indexes, policies
  - triggers (definition and enabled state)
  - functions (signature, owner, `SECURITY DEFINER`, `proconfig`, ACL, source md5)
  - enum, domain and composite types
  - default ACLs, event triggers

ACL arrays are sorted, null ACLs use PostgreSQL effective defaults, and constraints use PostgreSQL pretty rendering to avoid false differences from equivalent parse trees. Schema equality is decided from these catalog hashes, not from textual `pg_dump` comparison. Textual dumps contain `\restrict` nonces and comments that change between runs.

**Not covered:** roles and role attributes (cluster-global and never dumped), extension objects, comments and security labels, publications, storage, auth internals, and data outside the seeded fixture.

## Root execution steps

1. Before running, review the migrations for extensions that a vanilla PostgreSQL does not provide. The current migrations contain no `CREATE EXTENSION`; they only probe `cron.job` when it is present.
2. From `saas/`, using the verified Postgres.app 17.11 bin dir:
   ```sh
   node scripts/recovery/local-rehearsal.mjs \
     --pg-bin /tmp/savour-pg17-runtime/mount/Postgres.app/Contents/Versions/17/bin > /tmp/savour-rr-report.json
   echo "exit=$?"
   ```
   Add `--keep-artifacts` to keep the stopped cluster, archive and `manifest.json`. stderr prints their location; delete them by hand afterwards.
3. Accept the run only when the exit code is 0, `status` is `PASS`, every step has `ok: true` and `controls.server_stopped` is `true`. Also confirm that no `postgres` process remains (`pgrep -fl savour-rr-` returns nothing).
4. Run the guards with `npx vitest run tests/unit/m5-recovery-rehearsal.test.ts`. They cover input refusal, env scrubbing, the version gate, the corruption gate, the manifest diff, TOC ordering, report sanitizing and runner static safety. A PGlite check also proves the seed, probes and manifest SQL on the real migrations; it does not exercise `pg_dump`.

## Known limitations

- The fixture contains no verified paid period, provider connection, checkout, Vault secret or cron/mail state.
- All databases share one cluster, so the roles are the same objects in source and target. Re-keying roles on a real target is not exercised.
- The first native run may surface differences that PGlite cannot show. These include catalog renderings and native-only stderr warnings. Treat any FAIL as a finding to review; do not loosen the checks to make it pass.
- No consistent snapshot is exported. Consistency rests on the private cluster having no other clients, which is checked by taking equal manifests before and after the dump.
