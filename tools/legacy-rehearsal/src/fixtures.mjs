// Checked-in allowlist of synthetic fixtures. Each name is pinned to the exact
// source sha256, byte length, record inventory and preflight outcome. No other
// input can reach the importer: there is no path, URL, stdin or DSN option.

import fs from 'node:fs';
import { RehearsalError, sha256Hex } from './source.mjs';

const FIXTURE_DIR = new URL('../fixtures/', import.meta.url);

export const FIXTURES = Object.freeze({
  // Byte-identical copy of tools/legacy-preflight/test/fixtures/mixed-legacy-v2.json.
  'mixed-legacy-v2': Object.freeze({
    file: 'mixed-legacy-v2.json',
    sha256: '6ecf4f757feb1b38de99720b8ff5ff63230f087115760a40d87c80e668853df3',
    byteLength: 6785,
    counts: Object.freeze({ category: 0, reviewer: 0, vendor: 12, session: 6, submission: 4, entry: 22 }),
    preflightState: 'INSPECTED_WITH_EXCEPTIONS',
    preflightExceptions: 46,
  }),
  // Synthetic: preflight pii-bearing.json markers plus precision lexemes
  // (large integer, -0, 1E+2, 4.50), raw UTF-8 and \u escapes, unknown fields.
  'private-markers-precision': Object.freeze({
    file: 'private-markers-precision.json',
    sha256: '2d42ccefb9002a56f748cff2f7ede75651aa176c8e448b588d62d2152747fe1e',
    byteLength: 2876,
    counts: Object.freeze({ category: 1, reviewer: 1, vendor: 2, session: 1, submission: 1, entry: 2 }),
    preflightState: 'INSPECTED_WITH_EXCEPTIONS',
    preflightExceptions: 9,
  }),
});

export function getFixture(name) {
  if (typeof name !== 'string' || !Object.hasOwn(FIXTURES, name)) throw new RehearsalError('E_FIXTURE_NOT_ALLOWLISTED');
  return FIXTURES[name];
}

// Reads the pinned fixture and refuses it unless its bytes match the pin.
export function readFixture(name) {
  const fixture = getFixture(name);
  let bytes;
  try {
    bytes = fs.readFileSync(new URL(fixture.file, FIXTURE_DIR));
  } catch {
    throw new RehearsalError('E_FIXTURE_UNREADABLE');
  }
  assertPinned(name, bytes);
  return bytes;
}

export function assertPinned(name, bytes) {
  const fixture = getFixture(name);
  if (!(bytes instanceof Uint8Array) || bytes.length !== fixture.byteLength || sha256Hex(bytes) !== fixture.sha256) {
    throw new RehearsalError('E_FIXTURE_HASH_MISMATCH');
  }
}
