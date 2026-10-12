// Lossless record extraction from a legacy Firebase RTDB export.
//
// The source is scanned byte-by-byte by a strict JSON reader that records the
// byte range of every value. Only structural information (object keys, array
// positions, value types) is taken from JS; every payload value stays as the
// original byte slice. Numbers are never materialised as JS numbers, so large
// integers, negative zero and exponent lexemes survive exactly.
//
// Fails closed (RehearsalError code only, never source text) on: empty input,
// UTF-8 BOM, invalid UTF-8, malformed JSON, duplicate object keys, excessive
// depth, trailing bytes, or a root that is not an object.

import { createHash } from 'node:crypto';

export class RehearsalError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RehearsalError';
    this.code = code;
  }
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export const RECORD_KINDS = Object.freeze(['category', 'reviewer', 'vendor', 'session', 'submission', 'entry']);
const RECORD_COLLECTIONS = new Map([['categories', 'category'], ['reviewers', 'reviewer'], ['vendors', 'vendor']]);
const MAX_DEPTH = 256;

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const SIMPLE_ESCAPES = new Set([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74]);
const NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

function fail(code) {
  throw new RehearsalError(code);
}

function isHex(c) {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

// Returns a tree of { type, start, end, members?: Map, items?: [] } with byte
// offsets into `bytes`. Object keys are decoded; no other value is.
export function scanJson(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('E_SOURCE_NOT_BYTES');
  if (bytes.length === 0) fail('E_SOURCE_EMPTY');
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail('E_SOURCE_UTF8_BOM');
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('E_SOURCE_NOT_UTF8');
  }
  const b = bytes;
  let i = 0;
  const skipWs = () => {
    while (i < b.length && WS.has(b[i])) i += 1;
  };

  function string(decode) {
    const start = i;
    let j = i + 1;
    for (;;) {
      const c = b[j];
      if (c === undefined || c < 0x20) fail('E_SOURCE_MALFORMED');
      if (c === 0x22) break;
      if (c === 0x5c) {
        const e = b[j + 1];
        if (SIMPLE_ESCAPES.has(e)) j += 2;
        else if (e === 0x75 && isHex(b[j + 2]) && isHex(b[j + 3]) && isHex(b[j + 4]) && isHex(b[j + 5])) j += 6;
        else fail('E_SOURCE_MALFORMED');
      } else {
        j += 1;
      }
    }
    i = j + 1;
    return decode ? JSON.parse(Buffer.from(b.buffer, b.byteOffset + start, i - start).toString('utf8')) : undefined;
  }

  function literal(text) {
    for (let k = 0; k < text.length; k += 1) {
      if (b[i + k] !== text.charCodeAt(k)) fail('E_SOURCE_MALFORMED');
    }
    i += text.length;
  }

  function value(depth) {
    if (depth > MAX_DEPTH) fail('E_SOURCE_TOO_DEEP');
    skipWs();
    const start = i;
    const c = b[i];
    if (c === 0x7b) {
      i += 1;
      const members = new Map();
      skipWs();
      if (b[i] === 0x7d) {
        i += 1;
        return { type: 'object', start, end: i, members };
      }
      for (;;) {
        skipWs();
        if (b[i] !== 0x22) fail('E_SOURCE_MALFORMED');
        const key = string(true);
        skipWs();
        if (b[i] !== 0x3a) fail('E_SOURCE_MALFORMED');
        i += 1;
        const child = value(depth + 1);
        if (members.has(key)) fail('E_SOURCE_DUPLICATE_KEY');
        members.set(key, child);
        skipWs();
        if (b[i] === 0x2c) { i += 1; continue; }
        if (b[i] === 0x7d) { i += 1; break; }
        fail('E_SOURCE_MALFORMED');
      }
      return { type: 'object', start, end: i, members };
    }
    if (c === 0x5b) {
      i += 1;
      const items = [];
      skipWs();
      if (b[i] === 0x5d) {
        i += 1;
        return { type: 'array', start, end: i, items };
      }
      for (;;) {
        items.push(value(depth + 1));
        skipWs();
        if (b[i] === 0x2c) { i += 1; continue; }
        if (b[i] === 0x5d) { i += 1; break; }
        fail('E_SOURCE_MALFORMED');
      }
      return { type: 'array', start, end: i, items };
    }
    if (c === 0x22) {
      string(false);
      return { type: 'string', start, end: i };
    }
    if (c === 0x74) { literal('true'); return { type: 'boolean', start, end: i }; }
    if (c === 0x66) { literal('false'); return { type: 'boolean', start, end: i }; }
    if (c === 0x6e) { literal('null'); return { type: 'null', start, end: i }; }
    let j = i;
    while (j < b.length && (b[j] === 0x2d || b[j] === 0x2b || b[j] === 0x2e || b[j] === 0x45 || b[j] === 0x65
      || (b[j] >= 0x30 && b[j] <= 0x39))) j += 1;
    if (j === i || !NUMBER_RE.test(Buffer.from(b.buffer, b.byteOffset + i, j - i).toString('latin1'))) {
      fail('E_SOURCE_MALFORMED');
    }
    i = j;
    return { type: 'number', start, end: i };
  }

  const root = value(0);
  skipWs();
  if (i !== b.length) fail('E_SOURCE_TRAILING_BYTES');
  return root;
}

function pointerToken(key) {
  return String(key).replaceAll('~', '~0').replaceAll('/', '~1');
}

// Walks the known export shape and returns one descriptor per archive record,
// in source document order. Nested records overlap byte ranges: a session
// slice contains its submissions, which contain their entries.
export function extractRecords(bytes) {
  const root = scanJson(bytes);
  if (root.type !== 'object') fail('E_SOURCE_ROOT_NOT_OBJECT');
  const records = [];
  const add = (kind, node, pointer, tuple) => {
    records.push({
      kind,
      pointer,
      collectionKey: tuple.collectionKey ?? null,
      sessionKey: tuple.sessionKey ?? null,
      submissionKey: tuple.submissionKey ?? null,
      entryIndex: tuple.entryIndex ?? null,
      valueType: node.type,
      start: node.start,
      end: node.end,
    });
  };
  for (const [name, collection] of root.members) {
    if (RECORD_COLLECTIONS.has(name)) {
      if (collection.type !== 'object') continue;
      for (const [key, node] of collection.members) {
        add(RECORD_COLLECTIONS.get(name), node, `/${name}/${pointerToken(key)}`, { collectionKey: key });
      }
    } else if (name === 'sessions' && collection.type === 'object') {
      for (const [sessionKey, session] of collection.members) {
        const sessionPtr = `/sessions/${pointerToken(sessionKey)}`;
        add('session', session, sessionPtr, { sessionKey });
        const submissions = session.type === 'object' ? session.members.get('submissions') : undefined;
        if (!submissions || submissions.type !== 'object') continue;
        for (const [submissionKey, submission] of submissions.members) {
          const submissionPtr = `${sessionPtr}/submissions/${pointerToken(submissionKey)}`;
          add('submission', submission, submissionPtr, { sessionKey, submissionKey });
          const vendors = submission.type === 'object' ? submission.members.get('vendors') : undefined;
          if (!vendors || vendors.type !== 'array') continue;
          vendors.items.forEach((entry, entryIndex) => {
            add('entry', entry, `${submissionPtr}/vendors/${entryIndex}`, { sessionKey, submissionKey, entryIndex });
          });
        }
      }
    }
  }
  return records;
}

export function countByKind(records) {
  const counts = Object.fromEntries(RECORD_KINDS.map((kind) => [kind, 0]));
  for (const record of records) counts[record.kind] += 1;
  return counts;
}
