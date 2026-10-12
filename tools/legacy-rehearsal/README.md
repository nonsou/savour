# Local legacy archive rehearsal

Milestone 5 development preparation. This tool uses only two pinned synthetic fixtures and a disposable local PostgreSQL-compatible PGlite database. It does not read real exports, connect to Supabase/Firebase or write operational SaaS records.

From the repository root:

```sh
node tools/legacy-rehearsal/bin/legacy-rehearsal.mjs rehearse --fixture mixed-legacy-v2 --workspace synthetic-ws-demo
```

Second fixture: `private-markers-precision`. Only allowlisted names and synthetic workspace tokens are accepted. There are no path, URL, database connection or credential options. The CLI imports, verifies an unchanged re-import, rolls back its batch and closes the in-memory database. Output contains counts, hashes and static states. Exceptions remain unresolved.

Tests:

```sh
cd tools/legacy-rehearsal
node --test test/*.test.mjs
```

Uses Node.js and the existing pinned `@electric-sql/pglite` 0.5.8 installed under `saas/node_modules`; no dependency is installed by this tool. Set up the SaaS dependencies using the repository's established lockfile workflow when needed. Never pass production credentials or real data to the test tools.

Raw whole-source bytes and original record slices are authoritative. JSONB is a query projection and may normalise numeric lexemes/key order. Restoring from the projection would not preserve exact original bytes. Source inspection exceptions are copied for review and never treated as resolved by archiving.

Field mapping and operational gaps: [legacy mapping](../../docs/milestone-5/legacy-mapping.md). Developer evidence: [rehearsal report](../../docs/milestone-5/archive-rehearsal-developer-report.md).

This is a local archive-container rehearsal, not an accepted migration, original-report comparison, hosted tenant/RLS check, backup restoration certificate or Milestone 5 completion. Real target access, authorized exports, exception acceptance, legacy report interpretation and cutover/rollback sign-off remain later work. The existing Firebase MVP is unchanged.
