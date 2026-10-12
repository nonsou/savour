// legacy-rehearsal rehearse --fixture <allowlisted-name> --workspace <synthetic-ws-token>
//
// Runs the whole local archive rehearsal against a fresh in-memory PGlite:
// import, idempotent re-import, verify, rollback, confirm empty, close.
// Output is static codes, counts, hashes and states only. No path, directory,
// byte, URL or DSN option exists, and no SQL or source text is ever printed.

import { countArchiveRows, importBatch, rollbackBatch, verifyBatch } from './archive.mjs';
import { openRehearsalDb } from './db.mjs';
import { readFixture } from './fixtures.mjs';
import { buildManifest, REHEARSAL_STATUS } from './manifest.mjs';
import { RehearsalError } from './source.mjs';

export const NOTICE = Object.freeze([
  'LOCAL_ARCHIVE_REHEARSAL_ONLY: synthetic allowlisted fixture in a local in-memory PGlite.',
  'Not migration sign-off, not hosted RLS evidence, not backup/restore certification, not M5 completion.',
  'Archived preflight exceptions remain unresolved and review-required.',
]);

const USAGE_CODES = new Set(['E_USAGE']);

function parseArgs(argv) {
  if (argv.length !== 5 || argv[0] !== 'rehearse') throw new RehearsalError('E_USAGE');
  const opts = {};
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i];
    if ((flag !== '--fixture' && flag !== '--workspace') || Object.hasOwn(opts, flag)) throw new RehearsalError('E_USAGE');
    opts[flag] = argv[i + 1];
  }
  return { fixture: opts['--fixture'], workspace: opts['--workspace'] };
}

// hooks.afterRollback is an internal test hook (never set by the bin) used to
// prove that leftover rows turn the run into a failure.
async function rehearse({ fixture, workspace }, hooks = {}) {
  const bytes = readFixture(fixture);
  const manifest = buildManifest(fixture, workspace, bytes);
  const db = await openRehearsalDb();
  try {
    const imported = await importBatch(db, manifest, workspace);
    const reimported = await importBatch(db, manifest, workspace);
    const verified = await verifyBatch(db, workspace, manifest.batchFingerprint);
    if (!verified?.ok) throw new RehearsalError('E_BATCH_VERIFY_FAILED');
    const rolledBack = await rollbackBatch(db, {
      targetWorkspace: workspace, batchFingerprint: manifest.batchFingerprint, manifestSha256: manifest.manifestSha256,
    });
    if (hooks.afterRollback) await hooks.afterRollback(db);
    const remaining = await countArchiveRows(db);
    if (remaining.batches + remaining.records + remaining.exceptions !== 0) {
      throw new RehearsalError('E_ROLLBACK_REMNANTS');
    }
    return {
      status: REHEARSAL_STATUS,
      notice: NOTICE,
      fixture,
      targetWorkspace: workspace,
      mappingVersion: manifest.mappingVersion,
      sourceSha256: manifest.sourceSha256,
      manifestSha256: manifest.manifestSha256,
      batchFingerprint: manifest.batchFingerprint,
      recordCounts: imported.recordCounts,
      exceptionCount: imported.exceptionCount,
      exceptionResolution: 'UNRESOLVED_REVIEW_REQUIRED',
      steps: {
        import: imported.state,
        reimport: reimported.state,
        verify: 'VERIFIED',
        rollback: rolledBack.state,
        remainingRows: 0,
      },
    };
  } finally {
    await db.close();
  }
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, hooks } = {}) {
  try {
    const result = await rehearse(parseArgs(argv), hooks);
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    const code = err instanceof RehearsalError ? err.code : 'E_INTERNAL';
    stderr.write(`${JSON.stringify({ status: REHEARSAL_STATUS, error: code })}\n`);
    return USAGE_CODES.has(code) ? 2 : 1;
  }
}
