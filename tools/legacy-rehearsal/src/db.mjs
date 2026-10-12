// Local PGlite only. The pinned PGlite (0.5.8) is the existing package supplied
// by the saas/node_modules symlink; it is resolved relative to this file, so no
// dependency is installed and no absolute directory is assumed. There is no
// connection-string entry point.

import fs from 'node:fs';
import { RehearsalError } from './source.mjs';

const PGLITE_URL = new URL('../../../saas/node_modules/@electric-sql/pglite/dist/index.js', import.meta.url);
const SCHEMA_SQL = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

let pgliteClass;

export async function loadPGlite() {
  if (!pgliteClass) {
    try {
      ({ PGlite: pgliteClass } = await import(PGLITE_URL.href));
    } catch {
      throw new RehearsalError('E_PGLITE_UNAVAILABLE');
    }
  }
  return pgliteClass;
}

export async function assertPGlite(db) {
  const PGlite = await loadPGlite();
  if (!(db instanceof PGlite) || db.closed) throw new RehearsalError('E_DB_NOT_LOCAL_PGLITE');
  return db;
}

// In-memory by default. `dataDir` exists only for the test harness's disk
// lifecycle check; the CLI never passes it.
export async function openRehearsalDb({ dataDir } = {}) {
  const PGlite = await loadPGlite();
  let db;
  try {
    db = dataDir === undefined ? await PGlite.create() : await PGlite.create({ dataDir });
    await db.exec(SCHEMA_SQL);
  } catch {
    if (db) await db.close().catch(() => {});
    throw new RehearsalError('E_DB_OPEN_FAILED');
  }
  return db;
}
