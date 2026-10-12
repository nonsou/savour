import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_DIR = path.resolve(here, '..', '..');
export const BIN = path.join(TOOL_DIR, 'bin', 'legacy-preflight.mjs');
export const FIXTURES = path.join(TOOL_DIR, 'test', 'fixtures');
export const DENY_NETWORK_URL = pathToFileURL(path.join(here, 'deny-network.mjs')).href;

export function fixturePath(name) {
  return path.join(FIXTURES, name);
}

export function readFixture(name) {
  return fs.readFileSync(fixturePath(name));
}

// Every CLI run in the suite goes through the network/Firebase tripwire.
export function runCli(args, { env = {}, cwd = TOOL_DIR } = {}) {
  const result = spawnSync(process.execPath, ['--import', DENY_NETWORK_URL, BIN, ...args], {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Scratch space lives inside this tool folder only and is removed afterwards.
export function makeScratchDir(t) {
  const dir = fs.mkdtempSync(path.join(TOOL_DIR, 'test', '.scratch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}
