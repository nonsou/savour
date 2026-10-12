// Regressions from Sol's independent synthetic cases (copied byte-exact into
// test/fixtures/independent). Expectations come from the MVP source facts in
// docs/milestone-5/source-schema-notes.md, not from the tool's output.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { hashLabel } from '../src/hash.mjs';
import { fixturePath, readFixture, runCli } from './support/helpers.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const CASES = {
  'complete-v2.json': {
    sha: 'fade133142ca37386277b27c34251b53519baab3232461a148f894292be6a362',
    state: 'INSPECTED_CLEAN', exit: 0, byCode: {},
  },
  'valid-scored-absence.json': {
    sha: '321fab114d0ea0ea9d78f881ab7da425c8589ab096a39cd5d1c29c798bdcb22f',
    state: 'INSPECTED_CLEAN', exit: 0, byCode: {},
  },
  'presence-only-v2.json': {
    sha: '2116d9bf3ffc2cc85ce8f7c6f097da44d6e6bd49e285287f817e72c6b100719f',
    state: 'INSPECTED_CLEAN', exit: 0, byCode: {},
  },
  'historic-absence.json': {
    sha: '18b384c5afead2b882c99ed1d71b84d7d1baeb797f1e126981b2f692809a07ba',
    state: 'INSPECTED_WITH_EXCEPTIONS', exit: 10, byCode: { LEGACY_ENTRY_ORIGINAL_SEMANTICS_REVIEW: 1 },
  },
  'partial-approval.json': {
    sha: 'ef3501a315716fc62e88efb0c91cdba211d91dd3b24018e5f3cf6fb31a0e88a1',
    state: 'INSPECTED_WITH_EXCEPTIONS', exit: 10, byCode: { APPROVAL_TRIPLE_INCOMPLETE: 1 },
  },
  'duplicate-entry.json': {
    sha: '3824d2be1072109fad2a9d0f38261294f0daaae08251af1246120410662f03cd',
    state: 'INSPECTED_WITH_EXCEPTIONS', exit: 10, byCode: { DUPLICATE_VENDOR_ID_IN_SUBMISSION: 2 },
  },
  'dangling-reference.json': {
    sha: 'b2e3047247be85a1718af82934c3c15143ebb467b8e92a080712932625cea14c',
    state: 'INSPECTED_WITH_EXCEPTIONS', exit: 10, byCode: { VENDOR_REFERENCE_DANGLING: 1 },
  },
  'private-keys.json': {
    sha: '09845e271727a1361ab1da62ce90be7d30cd2c2e6b0edce5743c3163567c875b',
    state: 'INSPECTED_WITH_EXCEPTIONS', exit: 10, byCode: { SNAPSHOT_UNKNOWN_CRITERION: 1 },
  },
  'unknown-root.json': {
    sha: '2e9c19d5afed28ea1eff3bde28d03b03a486537380104d65d20eee4dd4ff7527',
    state: 'UNKNOWN_SCHEMA', exit: 11, byCode: { ROOT_NO_RECOGNIZED_COLLECTIONS: 1 },
  },
  'malformed.json': {
    sha: 'ae98ac0077d0f14f4ebc90924e0d7d31bf3f217e076068dd2c1a1fc7d5c7370f',
    state: 'UNKNOWN_SCHEMA', exit: 11, byCode: { INPUT_MALFORMED_JSON: 1 },
  },
};

// Every distinctive value or private key string in the independent fixtures.
const FORBIDDEN = [
  'Private Test Name', 'private-value', 'session-secret', 'assessor-secret', 'criterion-secret', 'secret',
  'example.test', '@', 'Synthetic Session', 'Synthetic Reviewer', 'Synthetic Assessor', 'Synthetic Vendor',
  'Synthetic Business', 'Synthetic Category', '20261012', '2026-10-12', '1791806400000', '1791806300000',
  'v_test', 'c_test', 'r_test', 's_test', 'missing_vendor', 'independent',
];

const rel = (name) => `test/fixtures/independent/${name}`;

test('independent fixture copies are byte-identical to the supplied cases', () => {
  for (const [name, { sha }] of Object.entries(CASES)) {
    assert.equal(sha256(readFixture(`independent/${name}`)), sha, name);
  }
});

for (const [name, expected] of Object.entries(CASES)) {
  test(`independent ${name}: ${expected.state} ${JSON.stringify(expected.byCode)}`, () => {
    const before = readFixture(`independent/${name}`);
    const result = runCli([rel(name)]);
    const after = readFixture(`independent/${name}`);
    assert.ok(before.equals(after), 'input bytes changed');
    assert.equal(sha256(after), expected.sha);

    assert.equal(result.code, expected.exit, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.state, expected.state);
    assert.deepEqual(report.exceptionSummary.byCode, expected.byCode);
    assert.equal(report.input.sha256, expected.sha);

    for (const stream of [result.stdout, result.stderr]) {
      for (const needle of FORBIDDEN) assert.ok(!stream.includes(needle), `${name} leaked ${needle}`);
    }
    const again = runCli([fixturePath(`independent/${name}`)]);
    assert.equal(again.stdout, result.stdout, 'not deterministic');
  });
}

test('independent complete-v2 profile reflects text att and numeric stored points', () => {
  const report = JSON.parse(runCli([rel('complete-v2.json')]).stdout);
  assert.equal(report.profile.attLabel.Early, 1);
  assert.equal(report.profile.attType.string, 1);
  assert.equal(report.profile.attendancePoints.early_5, 1);
  assert.equal(report.profile.attendanceMode.scored, 1);
  assert.equal(report.profile.entriesWithFoodScores, 1);
  assert.deepEqual(report.profile.unrecognizedFields, { root: {}, session: {}, submission: {}, entry: {} });
  assert.equal(report.profile.approval.approved_complete, 1);
});

test('independent presence-only and scored absence keep their own semantics', () => {
  const presence = JSON.parse(runCli([rel('presence-only-v2.json')]).stdout);
  assert.equal(presence.profile.attLabel.Present, 1);
  assert.equal(presence.profile.attendanceMode.presence_only, 1);
  assert.equal(presence.profile.attendancePointsType.missing, 1);

  const absence = JSON.parse(runCli([rel('valid-scored-absence.json')]).stdout);
  assert.equal(absence.profile.attLabel.Absent, 1);
  assert.equal(absence.profile.attendancePoints.absent_0, 1);
  assert.equal(absence.profile.entriesWithFoodScores, 0);
});

test('independent historic absence is reviewed in its original semantics only', () => {
  const report = JSON.parse(runCli([rel('historic-absence.json')]).stdout);
  assert.equal(report.profile.entrySchema.legacy, 1);
  assert.equal(report.profile.legacyAbsentWithFoodScores, 1);
  assert.equal(report.exceptions[0].at.index, 0);
});

test('independent private keys appear only as hashes', () => {
  const report = JSON.parse(runCli([rel('private-keys.json')]).stdout);
  const [unknown] = report.exceptions;
  assert.equal(unknown.at.session, hashLabel('session-secret@example.test'));
  assert.equal(unknown.at.submission, hashLabel('assessor-secret@example.test'));
  assert.equal(unknown.detail.label, hashLabel('criterion-secret@example.test'));
});

test('independent duplicate and dangling cases keep index identity', () => {
  const dup = JSON.parse(runCli([rel('duplicate-entry.json')]).stdout);
  assert.deepEqual(dup.exceptions.map((e) => [e.at.index, e.detail]),
    [[0, { occurrences: 2, firstIndex: 0 }], [1, { occurrences: 2, firstIndex: 0 }]]);
  const dangling = JSON.parse(runCli([rel('dangling-reference.json')]).stdout);
  assert.equal(dangling.exceptions[0].at.vendorId, hashLabel('missing_vendor'));
  assert.equal(dangling.references.dangling, 1);
});

test('independent partial approval names only the missing stamp field', () => {
  const report = JSON.parse(runCli([rel('partial-approval.json')]).stdout);
  assert.deepEqual(report.exceptions[0].detail, { missing: ['approvedAt'] });
  assert.equal(report.profile.approval.approved_partial, 1);
});

test('independent cases are refused by URL and size limits without echo', () => {
  const urlResult = runCli(['https://private-value@example.test/complete-v2.json']);
  assert.equal(urlResult.code, 2);
  assert.equal(urlResult.stderr, 'legacy-preflight: error E_INPUT_URL_UNSUPPORTED. Run with --help for usage.\n');
  const size = readFixture('independent/private-keys.json').length;
  const big = runCli(['--max-bytes', String(size - 1), rel('private-keys.json')]);
  assert.equal(big.code, 2);
  assert.equal(big.stdout, '');
  assert.equal(big.stderr, 'legacy-preflight: error E_INPUT_TOO_LARGE. Run with --help for usage.\n');
});
