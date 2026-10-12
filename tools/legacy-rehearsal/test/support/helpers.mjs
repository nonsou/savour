import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openRehearsalDb } from '../../src/db.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_DIR = path.resolve(here, '..', '..');
export const REPO_ROOT = path.resolve(TOOL_DIR, '..', '..');
export const BIN = path.join(TOOL_DIR, 'bin', 'legacy-rehearsal.mjs');
export const DENY_NETWORK_URL = pathToFileURL(path.join(here, 'deny-network.mjs')).href;

export function fixtureBytes(name) {
  return fs.readFileSync(path.join(TOOL_DIR, 'fixtures', `${name}.json`));
}

// Every CLI run goes through the network/Firebase/Supabase tripwire.
export function runCli(args, { cwd = TOOL_DIR } = {}) {
  const result = spawnSync(process.execPath, ['--import', DENY_NETWORK_URL, BIN, ...args], {
    cwd,
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Fresh in-memory database per test, always closed.
export async function withDb(t) {
  const db = await openRehearsalDb();
  t.after(() => db.close());
  return db;
}

export async function rejectsWithCode(promiseOrFn, code) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (err) {
    if (err.code !== code) throw new Error(`expected ${code}, got ${err.code ?? err.message}`);
    if (err.message !== code) throw new Error('error message must be the static code only');
    return;
  }
  throw new Error(`expected ${code}, but it resolved`);
}

// Every source string (keys and string leaves) of at least `min` characters.
export function sourceStrings(value, out = new Set(), min = 3) {
  if (typeof value === 'string') {
    if (value.length >= min) out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) sourceStrings(item, out, min);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key.length >= min) out.add(key);
      sourceStrings(child, out, min);
    }
  }
  return out;
}
