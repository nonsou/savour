import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { auditBytes } from '../../legacy-preflight/src/audit.mjs';
import { countArchiveRows, importBatch, rollbackBatch, verifyBatch } from '../src/archive.mjs';
import { openRehearsalDb } from '../src/db.mjs';
import { FIXTURES } from '../src/fixtures.mjs';
import { buildManifest, manifestSha256 } from '../src/manifest.mjs';
import { sha256Hex } from '../src/source.mjs';
import { fixtureBytes, rejectsWithCode, REPO_ROOT, TOOL_DIR, withDb } from './support/helpers.mjs';

const WS_A = 'synthetic-ws-alpha';
const WS_B = 'synthetic-ws-beta';
const MIXED = 'mixed-legacy-v2';
const PRIVATE = 'private-markers-precision';

const manifestFor = (name, ws) => buildManifest(name, ws, fixtureBytes(name));

async function archive(db, name, ws) {
  const manifest = manifestFor(name, ws);
  return { manifest, result: await importBatch(db, manifest, ws) };
}

async function snapshot(db, fp) {
  const { rows } = await db.query(`select
      (select encode(sha256(source_bytes), 'hex') || manifest_sha256 from legacy_archive.batches where batch_fingerprint = $1) as batch,
      (select string_agg(ordinal || ':' || raw_sha256 || ':' || xmin::text, ',' order by ordinal) from legacy_archive.records where batch_fingerprint = $1) as records,
      (select string_agg(ordinal || ':' || code || ':' || xmin::text, ',' order by ordinal) from legacy_archive.exceptions where batch_fingerprint = $1) as exceptions`, [fp]);
  return rows[0];
}

async function assertEmpty(db) {
  assert.deepEqual(await countArchiveRows(db), { batches: 0, records: 0, exceptions: 0 });
}

test('full fixtures archive exact source bytes, record slices, counts and preflight exceptions', async (t) => {
  const db = await withDb(t);
  for (const name of [MIXED, PRIVATE]) {
    const bytes = fixtureBytes(name);
    const report = auditBytes(bytes);
    const { manifest, result } = await archive(db, name, WS_A);
    assert.equal(result.state, 'ARCHIVED');
    const fp = manifest.batchFingerprint;

    const batch = (await db.query('select * from legacy_archive.batches where batch_fingerprint = $1', [fp])).rows[0];
    assert.ok(Buffer.from(batch.source_bytes).equals(bytes), 'batch holds the exact source bytes');
    assert.equal(batch.source_sha256, report.input.sha256, 'whole-source checksum equals preflight');
    assert.equal(batch.source_sha256, FIXTURES[name].sha256);
    assert.equal(batch.status, 'LOCAL_ARCHIVE_REHEARSAL_ONLY');

    const records = (await db.query(
      'select record_kind, byte_start, byte_end, raw_slice, raw_sha256 from legacy_archive.records where batch_fingerprint = $1 order by ordinal',
      [fp],
    )).rows;
    const counts = {};
    for (const r of records) {
      counts[r.record_kind] = (counts[r.record_kind] ?? 0) + 1;
      const expected = bytes.subarray(r.byte_start, r.byte_end);
      assert.ok(Buffer.from(r.raw_slice).equals(expected));
      assert.equal(r.raw_sha256, sha256Hex(expected));
    }
    assert.equal(counts.vendor ?? 0, report.collections.vendors.records);
    assert.equal(counts.category ?? 0, report.collections.categories.records);
    assert.equal(counts.reviewer ?? 0, report.collections.reviewers.records);
    assert.equal(counts.session ?? 0, report.inventory.sessions);
    assert.equal(counts.submission ?? 0, report.inventory.submissions);
    assert.equal(counts.entry ?? 0, report.inventory.vendorEntries);

    const exceptions = (await db.query(
      'select code, level, location, resolution from legacy_archive.exceptions where batch_fingerprint = $1 order by ordinal',
      [fp],
    )).rows;
    assert.deepEqual(exceptions.map((e) => [e.code, e.level, e.location]), report.exceptions.map((e) => [e.code, e.level, e.at]));
    assert.ok(exceptions.every((e) => e.resolution === 'UNRESOLVED_REVIEW_REQUIRED'));
    assert.equal(exceptions.filter((e) => e.code === 'VENDOR_REFERENCE_DANGLING').length, report.references.dangling);
    assert.ok((await verifyBatch(db, WS_A, fp)).ok);
  }
});

test('string scalars, approval metadata, attendance labels and unknown fields round-trip exactly', async (t) => {
  const db = await withDb(t);
  for (const name of [MIXED, PRIVATE]) {
    const { manifest } = await archive(db, name, WS_A);
    const bytes = fixtureBytes(name);
    const rows = (await db.query(
      `select ordinal, byte_start, byte_end, payload::text as payload_text from legacy_archive.records
       where batch_fingerprint = $1 order by ordinal`, [manifest.batchFingerprint],
    )).rows;
    for (const row of rows) {
      const source = JSON.parse(bytes.subarray(row.byte_start, row.byte_end).toString('utf8'));
      if (source === null || typeof source !== 'object' || Array.isArray(source)) continue;
      const projected = (await db.query(
        `select k, jsonb_typeof(payload -> k) as t, payload ->> k as v from legacy_archive.records,
         jsonb_object_keys(payload) as k where batch_fingerprint = $1 and ordinal = $2`,
        [manifest.batchFingerprint, row.ordinal],
      )).rows;
      assert.deepEqual(projected.map((p) => p.k).sort(), Object.keys(source).sort(), 'no key dropped, unknown keys kept');
      for (const p of projected) {
        const value = source[p.k];
        if (typeof value === 'string') assert.equal(p.v, value, 'string kept verbatim, never coerced');
        if (typeof value === 'number') assert.equal(p.t, 'number');
      }
    }
  }
  // Raw slice is authoritative; jsonb is a projection that normalises some lexemes.
  const fp = manifestFor(PRIVATE, WS_A).batchFingerprint;
  const entry = (await db.query(
    `select convert_from(raw_slice, 'UTF8') as raw, payload->>'syntheticPrecisionProbe' as big,
       payload->>'syntheticNegativeZero' as negzero, payload->>'syntheticExponent' as exp, payload->>'aroma' as aroma
     from legacy_archive.records where batch_fingerprint = $1 and record_kind = 'entry' and entry_index = 0`, [fp],
  )).rows[0];
  assert.equal(entry.big, '123456789012345678901234567890');
  assert.ok(entry.raw.includes('-0') && entry.negzero === '0');
  assert.ok(entry.raw.includes('1E+2') && entry.exp === '100');
  assert.equal(entry.aroma, '4.50');
  const session = (await db.query(
    `select payload->>'approvedBy' as by, payload->>'approvedAt' as at, payload->>'status' as status
     from legacy_archive.records where batch_fingerprint = $1 and record_kind = 'session'`, [fp],
  )).rows[0];
  assert.deepEqual(session, { by: 'Synthetic Approver Ngaio', at: '1735650000000', status: 'approved' });
  const mixedSession = (await db.query(
    `select payload->>'approvedBy' as by from legacy_archive.records
     where batch_fingerprint = $1 and record_kind = 'session' and session_key = 'sess-legacy'`,
    [manifestFor(MIXED, WS_A).batchFingerprint],
  )).rows[0];
  assert.equal(mixedSession.by, '   ', 'blank approver kept as-is, not trimmed or replaced');
});

test('manifest is deterministic, carries no source values and binds the target workspace', () => {
  const a1 = manifestFor(MIXED, WS_A);
  assert.deepEqual(manifestFor(MIXED, WS_A), a1);
  assert.notEqual(manifestFor(MIXED, WS_B).batchFingerprint, a1.batchFingerprint);
  assert.equal(a1.manifestSha256, manifestSha256(a1));
  const text = JSON.stringify(a1);
  for (const value of ['sess-legacy', 'ven-mix', 'Synthetic', 'approved', 'Early']) assert.ok(!text.includes(value));
});

test('re-import is idempotent and leaves stored rows untouched', async (t) => {
  const db = await withDb(t);
  const { manifest } = await archive(db, MIXED, WS_A);
  const before = await snapshot(db, manifest.batchFingerprint);
  const again = await importBatch(db, manifest, WS_A);
  assert.equal(again.state, 'ALREADY_ARCHIVED_UNCHANGED');
  assert.equal(again.batchFingerprint, manifest.batchFingerprint);
  assert.deepEqual(await snapshot(db, manifest.batchFingerprint), before);
});

test('altered payload, manifest or target fails before any insert', async (t) => {
  const db = await withDb(t);
  const manifest = manifestFor(MIXED, WS_A);
  const altered = Buffer.from(fixtureBytes(MIXED));
  altered[altered.indexOf('"Early"') + 1] = 0x65; // Early -> early
  await rejectsWithCode(importBatch(db, manifest, WS_A, { sourceBytes: altered }), 'E_FIXTURE_HASH_MISMATCH');
  const duplicated = Buffer.from(fixtureBytes(MIXED).toString('utf8').replace('"status": "open"', '"status": "open", "status": "x"'));
  await rejectsWithCode(importBatch(db, manifest, WS_A, { sourceBytes: duplicated }), 'E_FIXTURE_HASH_MISMATCH');

  const unsealed = { ...manifest, recordCounts: { ...manifest.recordCounts, entry: 21 } };
  await rejectsWithCode(importBatch(db, unsealed, WS_A), 'E_MANIFEST_HASH_MISMATCH');
  const resealed = { ...unsealed, manifestSha256: manifestSha256(unsealed) };
  await rejectsWithCode(importBatch(db, resealed, WS_A), 'E_MANIFEST_MISMATCH');
  const swapped = { ...manifest, fixture: PRIVATE };
  await rejectsWithCode(importBatch(db, { ...swapped, manifestSha256: manifestSha256(swapped) }, WS_A), 'E_MANIFEST_SOURCE_MISMATCH');

  await rejectsWithCode(importBatch(db, manifest, WS_B), 'E_TARGET_WORKSPACE_MISMATCH');
  await rejectsWithCode(importBatch(db, manifest, 'prod-workspace'), 'E_WORKSPACE_TOKEN_INVALID');
  await assertEmpty(db);
});

test('injected mid-batch failure rolls back the whole batch and leaves other batches intact', async (t) => {
  const db = await withDb(t);
  const { manifest: b } = await archive(db, PRIVATE, WS_B);
  const before = await snapshot(db, b.batchFingerprint);
  await rejectsWithCode(importBatch(db, manifestFor(MIXED, WS_A), WS_A, { faultAfterRecords: 10 }), 'E_INJECTED_FAULT');
  assert.deepEqual(await countArchiveRows(db), { batches: 1, records: 8, exceptions: 9 });
  assert.deepEqual(await snapshot(db, b.batchFingerprint), before);
});

test('explicit rollback of batch A preserves every other batch byte-for-byte', async (t) => {
  const db = await withDb(t);
  const { manifest: a } = await archive(db, MIXED, WS_A);
  const { manifest: b } = await archive(db, PRIVATE, WS_B);
  const { manifest: c } = await archive(db, MIXED, WS_B); // same source, other workspace
  const beforeB = await snapshot(db, b.batchFingerprint);
  const beforeC = await snapshot(db, c.batchFingerprint);
  const done = await rollbackBatch(db, {
    targetWorkspace: WS_A, batchFingerprint: a.batchFingerprint, manifestSha256: a.manifestSha256,
  });
  assert.deepEqual(done, { state: 'ROLLED_BACK', batchFingerprint: a.batchFingerprint, records: 44, exceptions: 46 });
  assert.equal(await verifyBatch(db, WS_A, a.batchFingerprint), null);
  assert.deepEqual(await snapshot(db, b.batchFingerprint), beforeB);
  assert.deepEqual(await snapshot(db, c.batchFingerprint), beforeC);
});

test('rollback refuses missing, mismatched or corrupted batches without deleting anything', async (t) => {
  const db = await withDb(t);
  const { manifest: a } = await archive(db, MIXED, WS_A);
  const key = { targetWorkspace: WS_A, batchFingerprint: a.batchFingerprint, manifestSha256: a.manifestSha256 };
  const before = await countArchiveRows(db);
  await rejectsWithCode(rollbackBatch(db, { ...key, batchFingerprint: '0'.repeat(64) }), 'E_BATCH_NOT_FOUND');
  await rejectsWithCode(rollbackBatch(db, { ...key, targetWorkspace: WS_B }), 'E_BATCH_NOT_FOUND');
  await rejectsWithCode(rollbackBatch(db, { ...key, manifestSha256: 'f'.repeat(64) }), 'E_ROLLBACK_PRECONDITION_FAILED');
  await rejectsWithCode(rollbackBatch(db, { ...key, batchFingerprint: '%' }), 'E_ROLLBACK_PRECONDITION_INVALID');
  // Self-consistent tamper: slice and its hash agree, but no longer match the batch source bytes.
  await db.query(`update legacy_archive.records set raw_slice = convert_to('{"x":1}', 'UTF8'),
    raw_sha256 = encode(sha256(convert_to('{"x":1}', 'UTF8')), 'hex'), byte_end = byte_start + 7,
    payload = '{"x":1}' where batch_fingerprint = $1 and ordinal = 0`, [a.batchFingerprint]);
  await rejectsWithCode(rollbackBatch(db, key), 'E_BATCH_VERIFY_FAILED');
  assert.deepEqual(await countArchiveRows(db), before);
});

test('re-import detects stored corruption instead of accepting or overwriting it', async (t) => {
  const db = await withDb(t);
  const { manifest } = await archive(db, PRIVATE, WS_A);
  await db.query(`update legacy_archive.exceptions set code = 'RESOLVED_BY_HAND'
    where batch_fingerprint = $1 and ordinal = 0`, [manifest.batchFingerprint]);
  await rejectsWithCode(importBatch(db, manifest, WS_A), 'E_EXISTING_BATCH_MISMATCH');
  await db.query('delete from legacy_archive.exceptions where batch_fingerprint = $1 and ordinal = 0', [manifest.batchFingerprint]);
  await rejectsWithCode(importBatch(db, manifest, WS_A), 'E_EXISTING_BATCH_MISMATCH');
});

test('schema is self-contained: no operational tables, no cascades, PUBLIC has no access', async (t) => {
  const db = await withDb(t);
  const tables = (await db.query(`select table_schema || '.' || table_name as t from information_schema.tables
    where table_schema not in ('pg_catalog', 'information_schema') order by 1`)).rows.map((r) => r.t);
  assert.deepEqual(tables, ['legacy_archive.batches', 'legacy_archive.exceptions', 'legacy_archive.records']);
  const cascades = (await db.query(`select count(*)::int as n from pg_constraint
    where contype = 'f' and (confdeltype <> 'a' or confupdtype <> 'a')`)).rows[0].n;
  assert.equal(cascades, 0);
  await archive(db, PRIVATE, WS_A);
  await db.exec('create role archive_probe nologin');
  await db.exec('set role archive_probe');
  try {
    await assert.rejects(db.query('select count(*) from legacy_archive.records'));
  } finally {
    await db.exec('reset role');
  }
});

test('runtime accepts only a live local PGlite instance', async () => {
  const manifest = manifestFor(MIXED, WS_A);
  await rejectsWithCode(importBatch({ query: async () => ({ rows: [] }) }, manifest, WS_A), 'E_DB_NOT_LOCAL_PGLITE');
  await rejectsWithCode(importBatch('postgres://example.invalid/db', manifest, WS_A), 'E_DB_NOT_LOCAL_PGLITE');
  const db = await openRehearsalDb();
  await db.close();
  await rejectsWithCode(importBatch(db, manifest, WS_A), 'E_DB_NOT_LOCAL_PGLITE');
});

test('on-disk database is closed and removed after success and after failure', async () => {
  for (const fail of [false, true]) {
    const dir = fs.mkdtempSync(path.join(TOOL_DIR, 'test', 'scratch-'));
    let db;
    try {
      db = await openRehearsalDb({ dataDir: dir });
      const manifest = manifestFor(PRIVATE, WS_A);
      if (fail) await rejectsWithCode(importBatch(db, manifest, WS_A, { faultAfterRecords: 3 }), 'E_INJECTED_FAULT');
      else assert.equal((await importBatch(db, manifest, WS_A)).state, 'ARCHIVED');
    } finally {
      if (db) await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(db.closed, true);
    assert.equal(fs.existsSync(dir), false);
  }
});

test('source fixtures are untouched and the mixed copy matches the preflight fixture', async (t) => {
  const db = await withDb(t);
  await archive(db, MIXED, WS_A);
  await archive(db, PRIVATE, WS_A);
  for (const [name, pin] of Object.entries(FIXTURES)) assert.equal(sha256Hex(fixtureBytes(name)), pin.sha256);
  const original = fs.readFileSync(path.join(REPO_ROOT, 'tools/legacy-preflight/test/fixtures/mixed-legacy-v2.json'));
  assert.ok(original.equals(fixtureBytes(MIXED)));
});
