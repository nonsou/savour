// Local archive rehearsal: import one allowlisted fixture into the
// legacy_archive schema inside a single transaction, verify, and support an
// explicit per-batch rollback. Never writes operational tables, never computes
// scores or attendance, never invents UUIDs for people, rosters or approvals.

import { isDeepStrictEqual } from 'node:util';
import { assertPGlite } from './db.mjs';
import { readFixture } from './fixtures.mjs';
import { assertWorkspaceToken, buildManifest, inspectSource, validateManifest } from './manifest.mjs';
import { RehearsalError, sha256Hex } from './source.mjs';

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

const INSERT_BATCH_SQL = `
insert into legacy_archive.batches (batch_fingerprint, target_workspace, status, fixture_name, mapping_version,
  source_bytes, source_sha256, source_byte_length, preflight_report_format, preflight_state, manifest,
  manifest_sha256, record_count, exception_count)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text::jsonb, $12, $13, $14)`;

const INSERT_RECORD_SQL = `
insert into legacy_archive.records (target_workspace, batch_fingerprint, ordinal, record_kind, json_pointer,
  collection_key, session_key, submission_key, entry_index, value_type, byte_start, byte_end, raw_slice,
  raw_sha256, payload)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, convert_from($13::bytea, 'UTF8')::jsonb)`;

const INSERT_EXCEPTION_SQL = `
insert into legacy_archive.exceptions (target_workspace, batch_fingerprint, ordinal, code, level, location, detail)
values ($1, $2, $3, $4, $5, $6::text::jsonb, $7::text::jsonb)`;

const RESOLUTION = 'UNRESOLVED_REVIEW_REQUIRED';

// Everything the archive should contain for one batch, re-derived from the
// pinned fixture bytes. Stored counts and hashes are never trusted on their own.
function deriveExpected(fixture, workspace, bytes) {
  const { report, records } = inspectSource(fixture, bytes);
  return { manifest: buildManifest(fixture, workspace, bytes), report, records };
}

const sameJsonText = (text, expected) => text !== null && isDeepStrictEqual(JSON.parse(text), expected);

function batchMatches(b, { manifest, report, records }, bytes) {
  return b.batch_fingerprint === manifest.batchFingerprint
    && b.target_workspace === manifest.targetWorkspace
    && b.status === manifest.status
    && b.fixture_name === manifest.fixture
    && b.mapping_version === manifest.mappingVersion
    && Buffer.from(b.source_bytes).equals(bytes)
    && b.source_sha256 === manifest.sourceSha256
    && b.source_byte_length === manifest.sourceByteLength
    && b.preflight_report_format === report.reportFormat
    && b.preflight_state === report.state
    && b.record_count === records.length
    && b.exception_count === report.exceptions.length
    && b.manifest_sha256 === manifest.manifestSha256
    && sameJsonText(b.manifest_text, manifest);
}

function recordMatches(s, r, ordinal, workspace, bytes) {
  const slice = bytes.subarray(r.start, r.end);
  return s.ordinal === ordinal && s.target_workspace === workspace && s.record_kind === r.kind
    && s.json_pointer === r.pointer && s.collection_key === r.collectionKey && s.session_key === r.sessionKey
    && s.submission_key === r.submissionKey && s.entry_index === r.entryIndex && s.value_type === r.valueType
    && s.byte_start === r.start && s.byte_end === r.end
    && Buffer.from(s.raw_slice).equals(slice) && s.raw_sha256 === sha256Hex(slice);
}

function exceptionMatches(s, e, ordinal, workspace) {
  // A missing detail is stored as SQL NULL, never as JSON null.
  const detailOk = e.detail === undefined ? s.detail_text === null : sameJsonText(s.detail_text, e.detail);
  return s.ordinal === ordinal && s.target_workspace === workspace && s.code === e.code && s.level === e.level
    && sameJsonText(s.location_text, e.at) && detailOk && s.resolution === RESOLUTION;
}

// Internal: accepts a PGlite instance or one of its transaction handles.
// Returns null if no batch has this workspace + fingerprint, otherwise
// { ok, failure } where failure is a static code (never a source value).
async function verifyAgainstSource(handle, targetWorkspace, fingerprint) {
  const batches = await handle.query(
    `select *, manifest::text as manifest_text from legacy_archive.batches
     where target_workspace = $1 and batch_fingerprint = $2`, [targetWorkspace, fingerprint],
  );
  if (batches.rows.length === 0) return null;
  const b = batches.rows[0];
  const result = (failure) => ({ ok: failure === null, failure, manifestSha256: b.manifest_sha256 });
  const bytes = Buffer.from(b.source_bytes);
  let expected;
  try {
    expected = deriveExpected(b.fixture_name, targetWorkspace, bytes);
  } catch {
    return result('SOURCE_PIN_MISMATCH');
  }
  if (!batchMatches(b, expected, bytes)) return result('BATCH_METADATA_MISMATCH');

  const records = (await handle.query(
    'select * from legacy_archive.records where batch_fingerprint = $1 order by ordinal', [fingerprint],
  )).rows;
  if (records.length !== expected.records.length
    || !expected.records.every((r, i) => recordMatches(records[i], r, i, targetWorkspace, bytes))) {
    return result('RECORD_MISMATCH');
  }
  // Raw slices are now known to be exact, so this cast cannot fail. Text
  // comparison (not jsonb equality) also catches e.g. 4.50 -> 4.5.
  const projection = await handle.query(
    `select count(*)::int as n from legacy_archive.records where batch_fingerprint = $1
     and payload::text is distinct from convert_from(raw_slice, 'UTF8')::jsonb::text`, [fingerprint],
  );
  if (projection.rows[0].n !== 0) return result('RECORD_MISMATCH');

  const exceptions = (await handle.query(
    `select ordinal, target_workspace, code, level, location::text as location_text, detail::text as detail_text,
       resolution from legacy_archive.exceptions where batch_fingerprint = $1 order by ordinal`, [fingerprint],
  )).rows;
  const expectedExceptions = expected.report.exceptions;
  if (exceptions.length !== expectedExceptions.length
    || !expectedExceptions.every((e, i) => exceptionMatches(exceptions[i], e, i, targetWorkspace))) {
    return result('EXCEPTION_MISMATCH');
  }
  return { ...result(null), records: records.length, exceptions: exceptions.length };
}

export async function verifyBatch(db, targetWorkspace, fingerprint) {
  await assertPGlite(db);
  return verifyAgainstSource(db, targetWorkspace, fingerprint);
}

function summary(state, manifest, exceptionCount) {
  return {
    state,
    status: manifest.status,
    fixture: manifest.fixture,
    batchFingerprint: manifest.batchFingerprint,
    manifestSha256: manifest.manifestSha256,
    sourceSha256: manifest.sourceSha256,
    recordCounts: { ...manifest.recordCounts },
    exceptionCount,
  };
}

// options.sourceBytes and options.faultAfterRecords are internal hooks for the
// adversarial tests. Supplied bytes are still checked against the fixture pin.
export async function importBatch(db, manifest, targetWorkspace, options = {}) {
  await assertPGlite(db);
  validateManifest(manifest, targetWorkspace);
  const bytes = options.sourceBytes ?? readFixture(manifest.fixture);
  const { report, records } = inspectSource(manifest.fixture, bytes);
  if (buildManifest(manifest.fixture, targetWorkspace, bytes).manifestSha256 !== manifest.manifestSha256) {
    throw new RehearsalError('E_MANIFEST_MISMATCH');
  }
  const exceptions = report.exceptions;
  const ws = manifest.targetWorkspace;
  const fp = manifest.batchFingerprint;

  const existing = await db.query('select 1 from legacy_archive.batches where batch_fingerprint = $1', [fp]);
  if (existing.rows.length > 0) {
    // Read-only check against the source; a drifted batch is refused, never repaired.
    const verified = await verifyAgainstSource(db, ws, fp);
    if (!verified?.ok || verified.manifestSha256 !== manifest.manifestSha256) {
      throw new RehearsalError('E_EXISTING_BATCH_MISMATCH');
    }
    return summary('ALREADY_ARCHIVED_UNCHANGED', manifest, exceptions.length);
  }

  try {
    await db.transaction(async (tx) => {
      await tx.query(INSERT_BATCH_SQL, [
        fp, ws, manifest.status, manifest.fixture, manifest.mappingVersion, bytes, manifest.sourceSha256,
        bytes.length, report.reportFormat, report.state, JSON.stringify(manifest), manifest.manifestSha256,
        records.length, exceptions.length,
      ]);
      for (const [ordinal, r] of records.entries()) {
        if (options.faultAfterRecords === ordinal) throw new RehearsalError('E_INJECTED_FAULT');
        const slice = bytes.subarray(r.start, r.end);
        await tx.query(INSERT_RECORD_SQL, [
          ws, fp, ordinal, r.kind, r.pointer, r.collectionKey, r.sessionKey, r.submissionKey, r.entryIndex,
          r.valueType, r.start, r.end, slice, sha256Hex(slice),
        ]);
      }
      for (const [ordinal, e] of exceptions.entries()) {
        await tx.query(INSERT_EXCEPTION_SQL, [
          ws, fp, ordinal, e.code, e.level, JSON.stringify(e.at), e.detail === undefined ? null : JSON.stringify(e.detail),
        ]);
      }
      const verified = await verifyAgainstSource(tx, ws, fp);
      if (!verified?.ok || verified.records !== records.length || verified.exceptions !== exceptions.length) {
        throw new RehearsalError('E_POST_INSERT_VERIFY_FAILED');
      }
    });
  } catch (err) {
    throw err instanceof RehearsalError ? err : new RehearsalError('E_ARCHIVE_INSERT_FAILED');
  }
  return summary('ARCHIVED', manifest, exceptions.length);
}

// Deletes exactly one batch, identified by workspace + fingerprint, and only if
// the stored manifest hash matches and the batch verifies intact first.
export async function rollbackBatch(db, { targetWorkspace, batchFingerprint, manifestSha256 }) {
  await assertPGlite(db);
  assertWorkspaceToken(targetWorkspace);
  if (typeof batchFingerprint !== 'string' || !FINGERPRINT_RE.test(batchFingerprint)
    || typeof manifestSha256 !== 'string' || !FINGERPRINT_RE.test(manifestSha256)) {
    throw new RehearsalError('E_ROLLBACK_PRECONDITION_INVALID');
  }
  try {
    return await db.transaction(async (tx) => {
      const verified = await verifyAgainstSource(tx, targetWorkspace, batchFingerprint);
      if (!verified) throw new RehearsalError('E_BATCH_NOT_FOUND');
      if (verified.manifestSha256 !== manifestSha256) throw new RehearsalError('E_ROLLBACK_PRECONDITION_FAILED');
      if (!verified.ok) throw new RehearsalError('E_BATCH_VERIFY_FAILED');
      const key = [targetWorkspace, batchFingerprint];
      const where = 'where target_workspace = $1 and batch_fingerprint = $2';
      const e = await tx.query(`delete from legacy_archive.exceptions ${where}`, key);
      const r = await tx.query(`delete from legacy_archive.records ${where}`, key);
      const b = await tx.query(`delete from legacy_archive.batches ${where}`, key);
      if (e.affectedRows !== verified.exceptions || r.affectedRows !== verified.records || b.affectedRows !== 1) {
        throw new RehearsalError('E_ROLLBACK_COUNT_MISMATCH');
      }
      return { state: 'ROLLED_BACK', batchFingerprint, records: r.affectedRows, exceptions: e.affectedRows };
    });
  } catch (err) {
    throw err instanceof RehearsalError ? err : new RehearsalError('E_ROLLBACK_FAILED');
  }
}

export async function countArchiveRows(db) {
  const { rows } = await db.query(`select
    (select count(*) from legacy_archive.batches)::int as batches,
    (select count(*) from legacy_archive.records)::int as records,
    (select count(*) from legacy_archive.exceptions)::int as exceptions`);
  return rows[0];
}
