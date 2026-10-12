import assert from 'node:assert/strict';
import test from 'node:test';
import { importBatch } from '../src/archive.mjs';
import { main } from '../src/cli.mjs';
import { FIXTURES } from '../src/fixtures.mjs';
import { buildManifest } from '../src/manifest.mjs';
import { fixtureBytes, REPO_ROOT, runCli, sourceStrings, TOOL_DIR } from './support/helpers.mjs';

const ALL_SOURCE_STRINGS = new Set(Object.keys(FIXTURES).flatMap((name) => [
  ...sourceStrings(JSON.parse(fixtureBytes(name).toString('utf8'))),
]));
// Field names and enum constants from the MVP writers may appear as code words.
const ALLOWED = new Set(['sessions', 'vendors', 'categories', 'reviewers', 'submissions', 'status', 'approved', 'notice']);

function assertNoSourceValues(text) {
  for (const value of ALL_SOURCE_STRINGS) {
    // Whitespace-only values (a blank approver) would match JSON indentation.
    if (ALLOWED.has(value) || value.trim() === '') continue;
    assert.ok(!text.includes(value), 'CLI output must not contain fixture values');
  }
}

test('rehearse runs import, idempotent re-import, verify and rollback from any cwd', () => {
  for (const cwd of [TOOL_DIR, REPO_ROOT]) {
    for (const fixture of Object.keys(FIXTURES)) {
      const run = runCli(['rehearse', '--workspace', 'synthetic-ws-alpha', '--fixture', fixture], { cwd });
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stderr, '');
      const out = JSON.parse(run.stdout);
      assert.equal(out.status, 'LOCAL_ARCHIVE_REHEARSAL_ONLY');
      assert.equal(out.sourceSha256, FIXTURES[fixture].sha256);
      assert.deepEqual(out.recordCounts, { ...FIXTURES[fixture].counts });
      assert.equal(out.exceptionCount, FIXTURES[fixture].preflightExceptions);
      assert.deepEqual(out.steps, {
        import: 'ARCHIVED', reimport: 'ALREADY_ARCHIVED_UNCHANGED', verify: 'VERIFIED', rollback: 'ROLLED_BACK', remainingRows: 0,
      });
      assertNoSourceValues(run.stdout);
    }
  }
});

test('output is byte-identical across runs (no clock or randomness)', () => {
  const args = ['rehearse', '--fixture', 'mixed-legacy-v2', '--workspace', 'synthetic-ws-alpha'];
  assert.equal(runCli(args).stdout, runCli(args).stdout);
});

test('rehearse fails nonzero instead of reporting success when rows remain after its rollback', async () => {
  let stdout = '';
  let stderr = '';
  const code = await main(['rehearse', '--fixture', 'mixed-legacy-v2', '--workspace', 'synthetic-ws-alpha'], {
    stdout: { write: (s) => { stdout += s; } },
    stderr: { write: (s) => { stderr += s; } },
    hooks: {
      afterRollback: async (db) => {
        const other = 'private-markers-precision';
        await importBatch(db, buildManifest(other, 'synthetic-ws-alpha', fixtureBytes(other)), 'synthetic-ws-alpha');
      },
    },
  });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.deepEqual(JSON.parse(stderr), { status: 'LOCAL_ARCHIVE_REHEARSAL_ONLY', error: 'E_ROLLBACK_REMNANTS' });
});

test('paths, unknown fixtures, extra options and bad workspace tokens are refused with codes only', () => {
  const cases = [
    [['rehearse', '--fixture', '../legacy-preflight/test/fixtures/pii-bearing.json', '--workspace', 'synthetic-ws-a'], 1, 'E_FIXTURE_NOT_ALLOWLISTED'],
    [['rehearse', '--fixture', 'clean-v2', '--workspace', 'synthetic-ws-a'], 1, 'E_FIXTURE_NOT_ALLOWLISTED'],
    [['rehearse', '--fixture', 'mixed-legacy-v2', '--workspace', 'postgres://user:pw@host/db'], 1, 'E_WORKSPACE_TOKEN_INVALID'],
    [['rehearse', '--fixture', 'mixed-legacy-v2', '--workspace', 'synthetic-ws-a', '--data-dir', 'x'], 2, 'E_USAGE'],
    [['rehearse', '--input', 'x.json', '--workspace', 'synthetic-ws-a'], 2, 'E_USAGE'],
    [['rehearse', '--fixture', 'mixed-legacy-v2', '--fixture', 'mixed-legacy-v2'], 2, 'E_USAGE'],
    [[], 2, 'E_USAGE'],
  ];
  for (const [args, code, error] of cases) {
    const run = runCli(args);
    assert.equal(run.code, code);
    assert.equal(run.stdout, '');
    assert.deepEqual(JSON.parse(run.stderr), { status: 'LOCAL_ARCHIVE_REHEARSAL_ONLY', error });
  }
});
