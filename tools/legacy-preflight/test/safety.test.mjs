import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { auditBytes, renderReport } from '../src/audit.mjs';
import { DENY_NETWORK_URL, TOOL_DIR, collectKeys, fixturePath, makeScratchDir, readFixture, runCli } from './support/helpers.mjs';

const FIXTURE_NAMES = ['clean-v2.json', 'mixed-legacy-v2.json', 'nested-invalid.json', 'pii-bearing.json', 'malformed-pii.json'];
const SOURCE_FILES = ['bin/legacy-preflight.mjs', 'src/audit.mjs', 'src/cli.mjs', 'src/hash.mjs', 'src/input.mjs']
  .map((f) => path.join(TOOL_DIR, f));

function tripwire(code) {
  return spawnSync(process.execPath, ['--import', DENY_NETWORK_URL, '--input-type=module', '-e', code], { encoding: 'utf8' });
}

test('tripwire positive control: network and Firebase attempts are caught', () => {
  for (const code of [
    "await fetch('http://192.0.2.1/');",
    "(await import('node:net')).connect(80, '192.0.2.1');",
    "(await import('node:https')).get('https://192.0.2.1/');",
    "(await import('node:dns')).lookup('example.invalid', () => {});",
    "await import('firebase/app');",
    "await import('@supabase/supabase-js');",
  ]) {
    const result = tripwire(code);
    assert.equal(result.status, 99, code);
    assert.match(result.stderr, /NETWORK_TRIPWIRE:/, code);
  }
});

test('CLI never trips the network/Firebase tripwire on any fixture', () => {
  for (const name of FIXTURE_NAMES) {
    const result = runCli([`test/fixtures/${name}`]);
    assert.notEqual(result.code, 99, name);
    assert.ok(!result.stderr.includes('NETWORK_TRIPWIRE'), name);
  }
});

test('in-process audit does not call a stubbed fetch', (t) => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error('fetch must not be called');
  };
  t.after(() => { globalThis.fetch = original; });
  for (const name of FIXTURE_NAMES) auditBytes(readFixture(name));
  assert.equal(calls, 0);
});

test('tool source imports only node: builtins or its own modules and has no write APIs', () => {
  for (const file of SOURCE_FILES) {
    const source = fs.readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specifiers) {
      assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'), `${file}: ${spec}`);
    }
    assert.ok(!/\brequire\s*\(/.test(source), file);
    assert.ok(!specifiers.some((spec) => /firebase|supabase/i.test(spec)), file);
    assert.ok(!/\bfetch\s*\(|https?:\/\/|WebSocket|node:(net|tls|http|https|http2|dgram|dns)\b/.test(source), file);
    assert.ok(!/writeFile|appendFile|createWriteStream|copyFile|\brename|unlink|\brmSync|mkdir|truncate(Sync)?\(|O_WRONLY|O_RDWR|O_CREAT|\bnew\s+Date\b|\bDate\s*[.(]|toLocale|Intl\./
      .test(source), file);
  }
});

test('input bytes, size and mtime are unchanged after an audit', (t) => {
  const dir = makeScratchDir(t);
  for (const name of FIXTURE_NAMES) {
    const input = path.join(dir, name);
    fs.copyFileSync(fixturePath(name), input);
    const old = new Date('2001-02-03T04:05:06Z');
    fs.utimesSync(input, old, old);
    const before = { bytes: fs.readFileSync(input), stat: fs.statSync(input) };
    runCli([input]);
    const after = { bytes: fs.readFileSync(input), stat: fs.statSync(input) };
    assert.ok(before.bytes.equals(after.bytes), name);
    assert.ok(before.bytes.equals(readFixture(name)), name);
    assert.equal(after.stat.size, before.stat.size, name);
    assert.equal(after.stat.mtimeMs, before.stat.mtimeMs, name);
    assert.equal(after.stat.mode, before.stat.mode, name);
  }
});

test('no totals or score values are computed or reproduced', () => {
  for (const name of FIXTURE_NAMES) {
    const report = auditBytes(readFixture(name));
    const text = renderReport(report);
    for (const key of collectKeys(report)) {
      assert.ok(!/total|^sum$|Sum$|average|mean|overall|weighted/i.test(key), `${name}: key ${key}`);
    }
    assert.ok(!/total/i.test(text), name);
    // Only counts, indices and byte lengths: every number is a non-negative integer.
    const numbers = [];
    JSON.stringify(report, (_, v) => { if (typeof v === 'number') numbers.push(v); return v; });
    assert.ok(numbers.every((n) => Number.isSafeInteger(n) && n >= 0), name);
  }
  const mixed = renderReport(auditBytes(readFixture('mixed-legacy-v2.json')));
  assert.ok(!mixed.includes('31.5'));
  const pii = renderReport(auditBytes(readFixture('pii-bearing.json')));
  assert.ok(!pii.includes('4.8125') && !pii.includes('9.4375'));
});

test('report never claims readiness or sign-off', () => {
  for (const name of FIXTURE_NAMES) {
    const report = auditBytes(readFixture(name));
    assert.ok(['UNKNOWN_SCHEMA', 'INSPECTED_WITH_EXCEPTIONS', 'INSPECTED_CLEAN'].includes(report.state));
    const keys = [...collectKeys(report)].join(' ');
    assert.ok(!/ready|signed|signoff|approvedFor|migrat/i.test(keys), name);
  }
});
