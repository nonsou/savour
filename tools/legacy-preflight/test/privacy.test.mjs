import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashLabel } from '../src/hash.mjs';
import { FIXTURES, TOOL_DIR, fixturePath, runCli } from './support/helpers.mjs';

// Every string here occurs in pii-bearing.json as a value, key, or label.
const FORBIDDEN = [
  'priya', 'synthetic@example', 'example.test', 'Testperson', 'Dumplings', 'Catering',
  '555 0199', 'Synthetic Lane', 'freezer', 'private remark', 'signed by', 'market-day',
  'reviewerEmail', 'sessionNotes', 'contact:', '4.8125', '9.4375', '2025-01-01', '+13:00',
  'REVCODE', '7731', 'Gate code', '4417', 'synthetic role', 'market day',
  'pii-bearing', 'fixtures', FIXTURES, TOOL_DIR, 'tools/legacy-preflight', 'savour-m5-offline-work',
  '/private/', '/Users/', '/tmp/', process.env.HOME ?? '/Users/',
];

function assertNoLeak(text, where) {
  const lower = text.toLowerCase();
  for (const needle of FORBIDDEN) {
    assert.ok(!lower.includes(needle.toLowerCase()), `${where} leaked ${JSON.stringify(needle)}`);
  }
  assert.ok(!text.includes('@'), `${where} contains "@"`);
}

for (const [label, arg] of [['relative', 'test/fixtures/pii-bearing.json'], ['absolute', fixturePath('pii-bearing.json')]]) {
  test(`PII-bearing fixture (${label} path) leaks nothing to stdout or stderr`, () => {
    const result = runCli([arg]);
    assert.equal(result.code, 10);
    assertNoLeak(result.stdout, 'stdout');
    assertNoLeak(result.stderr, 'stderr');
  });
}

test('PII-bearing keys and unknown labels appear only as hashes', () => {
  const report = JSON.parse(runCli(['test/fixtures/pii-bearing.json']).stdout);
  const sessionHash = hashLabel('market-day-priya.synthetic@example.test');
  const vendorHash = hashLabel('priya.synthetic@example.test');
  for (const e of report.exceptions) {
    if (e.at.session) assert.equal(e.at.session, sessionHash);
    if (e.at.vendorId) assert.equal(e.at.vendorId, vendorHash);
    if (e.at.record) assert.match(e.at.record, /^h:[0-9a-f]{16}$/);
  }
  assert.deepEqual(Object.keys(report.profile.unrecognizedFields.entry).sort(),
    [hashLabel('notes'), hashLabel('Priya Synthetic-Testperson private remark')].sort());
  assert.deepEqual(Object.keys(report.profile.unrecognizedFields.session), [hashLabel('sessionNotes')]);
  assert.deepEqual(Object.keys(report.profile.unrecognizedFields.submission), [hashLabel('reviewerEmail')]);
  assert.deepEqual(report.profile.unknownCriteria, { [hashLabel('contact:priya.synthetic@example.test')]: 1 });
  assert.ok(report.profile.sessionStatus[hashLabel('signed by Priya Synthetic-Testperson')] === 1);
  // Source-known fields carrying PII (reviewerCode, notes, taster, role, obs) are
  // recognised by name only and never reported as unknown labels.
  for (const field of ['reviewerCode', 'notes', 'name', 'date']) {
    assert.ok(!(hashLabel(field) in report.profile.unrecognizedFields.session), field);
  }
  for (const field of ['taster', 'role']) {
    assert.ok(!(hashLabel(field) in report.profile.unrecognizedFields.submission), field);
  }
  assert.ok(!(hashLabel('obs') in report.profile.unrecognizedFields.entry));
  // approvedAt string is rejected by type only; no date interpretation.
  assert.deepEqual(report.exceptions.find((e) => e.code === 'APPROVED_AT_NOT_INTEGER_MS').detail, { valueType: 'string' });
});

test('report contains only structural strings, hashes, known field names, or fixed text', () => {
  const report = JSON.parse(runCli(['test/fixtures/pii-bearing.json']).stdout);
  const allowedFree = new Set([...report.notice, report.reportFormat]);
  const walk = (value) => {
    if (typeof value === 'string') {
      if (allowedFree.has(value)) return;
      assert.match(value, /^(h:[0-9a-f]{16}|[0-9a-f]{64}|[A-Za-z_:0-9]{1,64})$/, `unexpected string ${JSON.stringify(value)}`);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        walk(k);
        walk(v);
      }
    }
  };
  walk(report);
});
