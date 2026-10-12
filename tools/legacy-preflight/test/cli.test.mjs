import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixturePath, makeScratchDir, runCli } from './support/helpers.mjs';

const SECRET = 'priya.synthetic@example.test';

function assertSanitizedError(result, code) {
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `legacy-preflight: error ${code}. Run with --help for usage.\n`);
}

test('exit codes follow report state', () => {
  assert.equal(runCli(['test/fixtures/clean-v2.json']).code, 0);
  assert.equal(runCli(['test/fixtures/mixed-legacy-v2.json']).code, 10);
  assert.equal(runCli(['test/fixtures/malformed-pii.json']).code, 11);
});

test('stdout is the JSON report; stderr is a fixed summary that disclaims sign-off', () => {
  const result = runCli([fixturePath('clean-v2.json')]);
  const report = JSON.parse(result.stdout);
  assert.equal(report.state, 'INSPECTED_CLEAN');
  assert.equal(result.stderr,
    'legacy-preflight: state=INSPECTED_CLEAN exceptions=0. Source inspection only; not migration-ready. '
    + 'Sign-off is a human step outside this tool.\n');
  assert.ok(report.notice.some((line) => line.includes('Sign-off is a human step')));
});

test('missing input path is not echoed', () => {
  const result = runCli([`test/fixtures/${SECRET}-export.json`]);
  assertSanitizedError(result, 'E_INPUT_NOT_FOUND');
});

test('URLs and stdin are refused without echo', () => {
  assertSanitizedError(runCli([`https://${SECRET}/export.json`]), 'E_INPUT_URL_UNSUPPORTED');
  assertSanitizedError(runCli([`file:///tmp/${SECRET}.json`]), 'E_INPUT_URL_UNSUPPORTED');
  assertSanitizedError(runCli(['-']), 'E_INPUT_STDIN_UNSUPPORTED');
  assertSanitizedError(runCli([]), 'E_INPUT_MISSING');
});

test('unknown options and bad numbers are not echoed', () => {
  assertSanitizedError(runCli([`--${SECRET}`, 'test/fixtures/clean-v2.json']), 'E_USAGE_UNKNOWN_OPTION');
  assertSanitizedError(runCli(['--max-bytes', SECRET, 'test/fixtures/clean-v2.json']), 'E_USAGE_MAX_BYTES_INVALID');
  assertSanitizedError(runCli(['--max-bytes', '0', 'test/fixtures/clean-v2.json']), 'E_USAGE_MAX_BYTES_INVALID');
  assertSanitizedError(runCli(['--max-bytes', String(2 ** 40), 'test/fixtures/clean-v2.json']), 'E_USAGE_MAX_BYTES_INVALID');
  assertSanitizedError(runCli(['--max-exceptions', '-1', 'test/fixtures/clean-v2.json']), 'E_USAGE_MAX_EXCEPTIONS_INVALID');
  assertSanitizedError(runCli(['a.json', 'b.json']), 'E_USAGE_INPUT_COUNT');
});

test('oversize input is refused before parsing', () => {
  const size = fs.statSync(fixturePath('pii-bearing.json')).size;
  assertSanitizedError(runCli(['--max-bytes', String(size - 1), 'test/fixtures/pii-bearing.json']), 'E_INPUT_TOO_LARGE');
  assert.equal(runCli(['--max-bytes', String(size), 'test/fixtures/pii-bearing.json']).code, 10);
});

test('directories and symlinks are refused', (t) => {
  const dir = makeScratchDir(t);
  assertSanitizedError(runCli([dir]), 'E_INPUT_NOT_REGULAR_FILE');
  const link = path.join(dir, `${SECRET}.json`);
  fs.symlinkSync(fixturePath('clean-v2.json'), link);
  assertSanitizedError(runCli([link]), 'E_INPUT_SYMLINK_REFUSED');
});

test('malformed JSON containing PII yields a code-only report', () => {
  const result = runCli(['test/fixtures/malformed-pii.json']);
  assert.equal(result.code, 11);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.exceptions, [{ code: 'INPUT_MALFORMED_JSON', level: 'input', at: {} }]);
  for (const stream of [result.stdout, result.stderr]) {
    assert.ok(!stream.includes(SECRET));
    assert.ok(!stream.includes('Priya'));
    assert.ok(!/Unexpected|SyntaxError|position/i.test(stream));
  }
});

test('--help prints usage only', () => {
  const result = runCli(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Usage: /);
  assert.match(result.stdout, /Sign-off is a human step/);
});

test('cli writes nothing to disk', (t) => {
  const dir = makeScratchDir(t);
  const input = path.join(dir, 'input.json');
  fs.copyFileSync(fixturePath('mixed-legacy-v2.json'), input);
  const before = fs.readdirSync(dir);
  runCli([input], { cwd: dir });
  assert.deepEqual(fs.readdirSync(dir), before);
});
