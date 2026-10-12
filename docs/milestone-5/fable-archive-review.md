# Fable 5.1 local archive rehearsal review

Verdict: useful, with trimming. The field-level mapping document is the highest-value item and should land first. The PGlite rehearsal is justified only as a proof of the archive container and its rollback behaviour. Anything that starts to look like operational-table mapping is overbuilding and should stay in the "blocked" section of the mapping document.

**Keep in this slice**

- Mapping document with three columns per source field: destination archive field, blocking reason for any operational table, and fidelity rule (raw, string, never recomputed). Enumerate every blocked operational mapping with its concrete cause, such as unverified assessor identity or missing template version.
- One legacy schema of three tables: batches, records, exceptions. Records hold raw bytes, parsed JSON, source tuple, and record sha256. Batches hold workspace id, batch fingerprint, manifest counts, and manifest sha256. No typed columns for scores, attendance, or rosters.
- One importer function taking a fixture name resolved through a checked-in allowlist. It parses, hashes, compares to the manifest, inserts inside one transaction, and verifies counts before commit.
- Batch-owned delete that touches only rows with the matching batch fingerprint. No cascade declarations in the schema.

**Cut or defer**

- Two workspace scopes as distinct code paths. Test isolation with two batches in one run instead of building scope machinery.
- Role-based protection of raw content. PGlite has no live roles to protect against. Document the intended revoke in the mapping doc and defer the proof to the real target.
- Any view, API, or query helper that reads archive rows for the app. The archive is write-and-verify only in this slice.

**Fidelity invariants to assert**

- Record sha256 of stored raw bytes equals the preflight sha256 for every record.
- Per-category counts in the archive equal the preflight inventory counts.
- Original scores, attendance labels, approval names and times, and vendor IDs round-trip as identical strings. No numeric coercion of attendance.
- Unknown legacy fields survive as raw JSON with no key dropped or reordered in the stored bytes.
- Pseudonym key and index references resolve to the same targets as in the preflight inventory, or are recorded as exceptions, never silently repaired.
- Import is idempotent. Re-running the same fixture yields identical row counts and identical batch fingerprint.

**Rollback and scope safety**

- Altered payload with an unchanged manifest fails before any insert.
- Mismatched target workspace id fails before any insert.
- A failure mid-batch leaves zero rows for that batch after rollback.
- Deleting batch A leaves every batch B row intact and B's checksums unchanged.
- The local database is closed and its directory removed in a finally block, including on failure.

**Privacy decisions**

- Fixtures are synthetic and checked in. Real exports never enter the repository, test output, or logs.
- Reports contain counts, hashes, field names, and exception codes. No source values, no names, no free text from records.
- Default library entry point accepts no connection string. Only the test harness can construct the PGlite instance.
- Error messages name the record index and field path, never the value.

**Risks**

- Scope creep toward operational mapping once a database exists. Mitigate by keeping the blocked mappings list explicit and by having no typed score columns.
- Misreading the rehearsal as evidence for Supabase RLS or backup certification. Mitigate by the naming you proposed and a one-line disclaimer at the top of the report.
- Fixture drift from real export shape. Mitigate by generating fixtures from the preflight inventory's schema, not by hand.

**Tests, in order of value**

1. Manifest and record sha256 match after import.
2. Idempotent re-import produces identical counts and fingerprint.
3. Altered payload fails closed with zero rows.
4. Wrong workspace id fails closed with zero rows.
5. Injected insert failure rolls back the whole batch.
6. Batch delete preserves the other batch.
7. Attendance label and unknown field round-trip as exact strings.
8. Report output contains no fixture values.
9. Disallowed fixture name is rejected.
10. Database directory is absent after success and after failure.

Call it the local archive rehearsal in code, docs, and the report header. Expected size is roughly one schema file, one importer, one allowlist, two fixtures, and the ten tests above.