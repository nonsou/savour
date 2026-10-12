import assert from 'node:assert/strict';
import test from 'node:test';
import { FIXTURES, getFixture } from '../src/fixtures.mjs';
import { countByKind, extractRecords } from '../src/source.mjs';
import { fixtureBytes, rejectsWithCode } from './support/helpers.mjs';

function resolvePointer(root, pointer) {
  return pointer.split('/').slice(1).reduce((node, token) => node[token.replaceAll('~1', '/').replaceAll('~0', '~')], root);
}

test('every record slice is the exact source bytes at its JSON pointer', () => {
  for (const name of Object.keys(FIXTURES)) {
    const bytes = fixtureBytes(name);
    const parsed = JSON.parse(bytes.toString('utf8'));
    const records = extractRecords(bytes);
    assert.deepEqual(countByKind(records), { ...FIXTURES[name].counts });
    for (const r of records) {
      const slice = bytes.subarray(r.start, r.end).toString('utf8');
      assert.deepEqual(JSON.parse(slice), resolvePointer(parsed, r.pointer), `${name} ${r.pointer}`);
    }
  }
});

test('precision lexemes, escapes and unknown fields survive in the raw entry slice', () => {
  const bytes = fixtureBytes('private-markers-precision');
  const entry = extractRecords(bytes).find((r) => r.kind === 'entry' && r.entryIndex === 0);
  const raw = bytes.subarray(entry.start, entry.end).toString('utf8');
  for (const lexeme of [
    '"syntheticPrecisionProbe": 123456789012345678901234567890',
    '"syntheticNegativeZero": -0',
    '"syntheticExponent": 1E+2',
    '"aroma": 4.50',
    '"syntheticEscapes": "Synthetic é \\u00e9 tab\\tquote\\" end"',
    '"Priya Synthetic-Testperson private remark": 9.4375',
  ]) assert.ok(raw.includes(lexeme), lexeme);
});

test('duplicate object keys fail closed, including escape-equivalent keys', async () => {
  for (const text of [
    '{"sessions":{"s":{"status":"pending","status":"approved"}}}',
    '{"vendors":{"v":{}},"vendors":{}}',
    '{"vendors":{"a":{},"\\u0061":{}}}',
  ]) await rejectsWithCode(() => extractRecords(Buffer.from(text)), 'E_SOURCE_DUPLICATE_KEY');
});

test('malformed or structurally unknown sources fail closed with static codes', async () => {
  const cases = [
    ['', 'E_SOURCE_EMPTY'],
    ['﻿{}', 'E_SOURCE_UTF8_BOM'],
    ['{"a":1,}', 'E_SOURCE_MALFORMED'],
    ["{'a':1}", 'E_SOURCE_MALFORMED'],
    ['{"a":01}', 'E_SOURCE_MALFORMED'],
    ['{"a":+1}', 'E_SOURCE_MALFORMED'],
    ['{"a":NaN}', 'E_SOURCE_MALFORMED'],
    ['{"a":"\u0001"}', 'E_SOURCE_MALFORMED'],
    ['{"a":"\\x"}', 'E_SOURCE_MALFORMED'],
    ['{"a":"open', 'E_SOURCE_MALFORMED'],
    ['{} {}', 'E_SOURCE_TRAILING_BYTES'],
    ['[]', 'E_SOURCE_ROOT_NOT_OBJECT'],
    [`${'['.repeat(300)}${']'.repeat(300)}`, 'E_SOURCE_TOO_DEEP'],
  ];
  for (const [text, code] of cases) await rejectsWithCode(() => extractRecords(Buffer.from(text)), code);
  await rejectsWithCode(() => extractRecords(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), 'E_SOURCE_NOT_UTF8');
});

test('only allowlisted fixture names resolve', async () => {
  for (const name of ['../mixed-legacy-v2', 'mixed-legacy-v2.json', '/etc/passwd', 'clean-v2', '', 'constructor', '__proto__']) {
    await rejectsWithCode(() => getFixture(name), 'E_FIXTURE_NOT_ALLOWLISTED');
  }
});
