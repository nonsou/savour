import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixturePath, makeScratchDir, readFixture, runCli } from './support/helpers.mjs';

const FIXTURE_NAMES = ['clean-v2.json', 'mixed-legacy-v2.json', 'nested-invalid.json', 'pii-bearing.json', 'malformed-pii.json'];

test('same fixture yields byte-identical stdout and stderr across runs', () => {
  for (const name of FIXTURE_NAMES) {
    const a = runCli([`test/fixtures/${name}`]);
    const b = runCli([`test/fixtures/${name}`]);
    assert.equal(a.stdout, b.stdout, name);
    assert.equal(a.stderr, b.stderr, name);
    assert.equal(a.code, b.code, name);
  }
});

test('report checksum is SHA-256 of the raw input bytes', () => {
  for (const name of FIXTURE_NAMES) {
    const report = JSON.parse(runCli([`test/fixtures/${name}`]).stdout);
    const bytes = readFixture(name);
    assert.equal(report.input.sha256, createHash('sha256').update(bytes).digest('hex'), name);
    assert.equal(report.input.byteLength, bytes.length, name);
  }
});

test('host timezone and locale do not change the report', () => {
  for (const name of FIXTURE_NAMES) {
    const runs = [
      runCli([`test/fixtures/${name}`], { env: { TZ: 'UTC', LANG: 'C' } }),
      runCli([`test/fixtures/${name}`], { env: { TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' } }),
      runCli([`test/fixtures/${name}`], { env: { TZ: 'America/St_Johns', LANG: 'de_DE.UTF-8' } }),
    ];
    assert.equal(runs[1].stdout, runs[0].stdout, name);
    assert.equal(runs[2].stdout, runs[0].stdout, name);
  }
});

function reverseMapKeys(value) {
  if (Array.isArray(value)) return value.map(reverseMapKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).reverse().map((k) => [k, reverseMapKeys(value[k])]));
  }
  return value;
}

test('map key order in the source does not change anything but the checksum', (t) => {
  const dir = makeScratchDir(t);
  for (const name of ['clean-v2.json', 'mixed-legacy-v2.json', 'nested-invalid.json']) {
    const reordered = path.join(dir, name);
    fs.writeFileSync(reordered, JSON.stringify(reverseMapKeys(JSON.parse(readFixture(name)))));
    const original = JSON.parse(runCli([fixturePath(name)]).stdout);
    const shuffled = JSON.parse(runCli([reordered]).stdout);
    assert.notEqual(shuffled.input.sha256, original.input.sha256);
    delete original.input;
    delete shuffled.input;
    assert.deepEqual(shuffled, original, name);
  }
});
