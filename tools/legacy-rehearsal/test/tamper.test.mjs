// Stored-row tampering must be caught by re-deriving the expected archive from
// the pinned source bytes, not by trusting stored counts or hashes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { importBatch, rollbackBatch, verifyBatch } from '../src/archive.mjs';
import { buildManifest } from '../src/manifest.mjs';
import { fixtureBytes, rejectsWithCode, withDb } from './support/helpers.mjs';

const WS = 'synthetic-ws-sol';
const MIXED = 'mixed-legacy-v2';
const PRIVATE = 'private-markers-precision';

// Whole-archive fingerprint: any changed byte in any row changes it.
async function archiveState(db) {
  const { rows } = await db.query(`select
    (select md5(coalesce(string_agg(t::text, '|' order by t.batch_fingerprint), '')) from legacy_archive.batches t) ||
    (select md5(coalesce(string_agg(t::text, '|' order by t.batch_fingerprint, t.ordinal), '')) from legacy_archive.records t) ||
    (select md5(coalesce(string_agg(t::text, '|' order by t.batch_fingerprint, t.ordinal), '')) from legacy_archive.exceptions t) as s`);
  return rows[0].s;
}

const R = 'update legacy_archive.records set';
const E = 'update legacy_archive.exceptions set';
const B = 'update legacy_archive.batches set';
const SELF_CONSISTENT_SLICE = `raw_slice = convert_to('{"x":1}', 'UTF8'),
  raw_sha256 = encode(sha256(convert_to('{"x":1}', 'UTF8')), 'hex'), byte_end = byte_start + 7, payload = '{"x":1}'`;

const CASES = [
  // [name, fixture, sql, verifier failure, rollback code]
  ['session_key on session records (Sol finding)', MIXED, `${R} session_key = 'synthetic-tampered' where record_kind = 'session'`, 'RECORD_MISMATCH'],
  ['collection_key on a vendor record', MIXED, `${R} collection_key = 'ven-other' where record_kind = 'vendor' and ordinal = (select min(ordinal) from legacy_archive.records where record_kind = 'vendor')`, 'RECORD_MISMATCH'],
  ['submission_key set to NULL', MIXED, `${R} submission_key = null where record_kind = 'entry' and entry_index = 0`, 'RECORD_MISMATCH'],
  ['entry_index shifted', MIXED, `${R} entry_index = entry_index + 1 where record_kind = 'entry' and entry_index = 2`, 'RECORD_MISMATCH'],
  ['json_pointer rewritten', MIXED, `${R} json_pointer = '/vendors/tampered' where ordinal = 0`, 'RECORD_MISMATCH'],
  ['record_kind relabelled', MIXED, `${R} record_kind = 'reviewer' where record_kind = 'vendor'`, 'RECORD_MISMATCH'],
  ['value_type relabelled', MIXED, `${R} value_type = 'string' where ordinal = 1`, 'RECORD_MISMATCH'],
  ['two ordinals swapped', MIXED, [
    `${R} ordinal = 9999 where ordinal = 0`, `${R} ordinal = 0 where ordinal = 1`, `${R} ordinal = 1 where ordinal = 9999`,
  ], 'RECORD_MISMATCH'],
  ['self-consistent raw slice + hash + range + payload', MIXED, `${R} ${SELF_CONSISTENT_SLICE} where ordinal = 3`, 'RECORD_MISMATCH'],
  ['payload projection only', MIXED, `${R} payload = payload || '{"x":1}' where ordinal = 2`, 'RECORD_MISMATCH'],
  ['payload numeric lexeme 4.50 -> 4.5', PRIVATE, `${R} payload = jsonb_set(payload, '{aroma}', '4.5') where record_kind = 'entry' and entry_index = 0`, 'RECORD_MISMATCH'],
  ['record deleted with batch count lowered to match', MIXED, [
    'delete from legacy_archive.records where ordinal = 43', `${B} record_count = record_count - 1`,
  ], 'BATCH_METADATA_MISMATCH'],
  ['record deleted with count and manifest JSON lowered', MIXED, [
    'delete from legacy_archive.records where ordinal = 43',
    `${B} record_count = record_count - 1, manifest = jsonb_set(manifest, '{recordCounts,entry}', '21')`,
  ], 'BATCH_METADATA_MISMATCH'],
  ['exception code changed', MIXED, `${E} code = 'RESOLVED_BY_HAND' where ordinal = 0`, 'EXCEPTION_MISMATCH'],
  ['exception location changed', MIXED, `${E} location = jsonb_set(location, '{session}', '"h:0000000000000000"') where location ? 'session' and ordinal = (select min(ordinal) from legacy_archive.exceptions where location ? 'session')`, 'EXCEPTION_MISMATCH'],
  ['exception level changed', MIXED, `${E} level = 'root' where ordinal = 5`, 'EXCEPTION_MISMATCH'],
  ['exception SQL NULL detail replaced by JSON null', MIXED, `${E} detail = 'null'::jsonb where ordinal = (select min(ordinal) from legacy_archive.exceptions where detail is null)`, 'EXCEPTION_MISMATCH'],
  ['exception detail changed', MIXED, `${E} detail = '{}'::jsonb where ordinal = (select min(ordinal) from legacy_archive.exceptions where detail is not null)`, 'EXCEPTION_MISMATCH'],
  ['exception deleted with batch count lowered to match', MIXED, [
    'delete from legacy_archive.exceptions where ordinal = 45', `${B} exception_count = exception_count - 1`,
  ], 'BATCH_METADATA_MISMATCH'],
  ['manifest JSON body changed', MIXED, `${B} manifest = jsonb_set(manifest, '{preflight,exceptionCount}', '0')`, 'BATCH_METADATA_MISMATCH'],
  ['preflight state relabelled', MIXED, `${B} preflight_state = 'INSPECTED_CLEAN'`, 'BATCH_METADATA_MISMATCH'],
  ['mapping version relabelled', MIXED, `${B} mapping_version = 'savour-legacy-archive-map/0'`, 'BATCH_METADATA_MISMATCH'],
  ['fixture name swapped to the other allowlisted name', MIXED, `${B} fixture_name = '${PRIVATE}'`, 'SOURCE_PIN_MISMATCH'],
  ['source bytes replaced with self-consistent sha and length', MIXED,
    `${B} source_bytes = convert_to('{}', 'UTF8'), source_sha256 = encode(sha256(convert_to('{}', 'UTF8')), 'hex'), source_byte_length = 2`,
    'SOURCE_PIN_MISMATCH'],
  ['manifest_sha256 replaced', MIXED, `${B} manifest_sha256 = repeat('a', 64)`, 'BATCH_METADATA_MISMATCH', 'E_ROLLBACK_PRECONDITION_FAILED'],
];

test('untouched batches verify ok against the pinned source', async (t) => {
  const db = await withDb(t);
  for (const fixture of [MIXED, PRIVATE]) {
    const manifest = buildManifest(fixture, WS, fixtureBytes(fixture));
    await importBatch(db, manifest, WS);
    const v = await verifyBatch(db, WS, manifest.batchFingerprint);
    assert.equal(v.ok, true);
    assert.equal(v.failure, null);
  }
});

for (const [name, fixture, sql, failure, rollbackCode = 'E_BATCH_VERIFY_FAILED'] of CASES) {
  test(`tamper fails closed: ${name}`, async (t) => {
    const db = await withDb(t);
    const manifest = buildManifest(fixture, WS, fixtureBytes(fixture));
    await importBatch(db, manifest, WS);
    for (const statement of [sql].flat()) {
      const res = await db.query(statement);
      assert.ok(res.affectedRows >= 1, 'mutation must hit at least one row');
    }
    const tampered = await archiveState(db);

    const v = await verifyBatch(db, WS, manifest.batchFingerprint);
    assert.equal(v.ok, false);
    assert.equal(v.failure, failure);
    await rejectsWithCode(importBatch(db, manifest, WS), 'E_EXISTING_BATCH_MISMATCH');
    await rejectsWithCode(rollbackBatch(db, {
      targetWorkspace: WS, batchFingerprint: manifest.batchFingerprint, manifestSha256: manifest.manifestSha256,
    }), rollbackCode);
    assert.equal(await archiveState(db), tampered, 'neither re-import nor rollback mutated any row');
  });
}
