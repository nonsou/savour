// Deterministic batch manifest. No clock, randomness, locale or environment:
// the same fixture, workspace token and mapping version always produce the
// same bytes and the same batch fingerprint.

import { auditBytes, REPORT_FORMAT } from '../../legacy-preflight/src/audit.mjs';
import { assertPinned, getFixture } from './fixtures.mjs';
import { countByKind, extractRecords, RECORD_KINDS, RehearsalError, sha256Hex } from './source.mjs';

export const MANIFEST_FORMAT = 'savour-legacy-archive-manifest/1';
export const MAPPING_VERSION = 'savour-legacy-archive-map/1';
export const REHEARSAL_STATUS = 'LOCAL_ARCHIVE_REHEARSAL_ONLY';
const FINGERPRINT_DOMAIN = 'savour-legacy-archive/batch/v1\u0000';
const WORKSPACE_RE = /^synthetic-ws-[a-z0-9]{1,32}$/;
const ACCEPTED_PREFLIGHT_STATES = new Set(['INSPECTED_CLEAN', 'INSPECTED_WITH_EXCEPTIONS']);

export function assertWorkspaceToken(token) {
  if (typeof token !== 'string' || !WORKSPACE_RE.test(token)) throw new RehearsalError('E_WORKSPACE_TOKEN_INVALID');
  return token;
}

export function batchFingerprint(workspace, sourceSha256, mappingVersion = MAPPING_VERSION) {
  return sha256Hex(`${FINGERPRINT_DOMAIN}${workspace}\u0000${sourceSha256}\u0000${mappingVersion}`);
}

function manifestBody(m) {
  // Fixed key order; values are strings and integers only.
  return JSON.stringify({
    format: m.format,
    status: m.status,
    mappingVersion: m.mappingVersion,
    fixture: m.fixture,
    targetWorkspace: m.targetWorkspace,
    sourceSha256: m.sourceSha256,
    sourceByteLength: m.sourceByteLength,
    batchFingerprint: m.batchFingerprint,
    recordCounts: Object.fromEntries(RECORD_KINDS.map((kind) => [kind, m.recordCounts?.[kind]])),
    preflight: {
      reportFormat: m.preflight?.reportFormat,
      state: m.preflight?.state,
      exceptionCount: m.preflight?.exceptionCount,
    },
  });
}

export function manifestSha256(manifest) {
  return sha256Hex(manifestBody(manifest));
}

// Runs the read-only preflight on the bytes and checks that the strict
// extraction agrees with its inventory. Preflight supplies only a whole-source
// checksum; per-record hashes are computed here, never attributed to it.
export function inspectSource(name, bytes) {
  assertPinned(name, bytes);
  const fixture = getFixture(name);
  const report = auditBytes(bytes);
  if (report.reportFormat !== REPORT_FORMAT) throw new RehearsalError('E_PREFLIGHT_FORMAT');
  if (!ACCEPTED_PREFLIGHT_STATES.has(report.state)) throw new RehearsalError('E_PREFLIGHT_UNKNOWN_SCHEMA');
  if (report.input.sha256 !== fixture.sha256) throw new RehearsalError('E_PREFLIGHT_CHECKSUM_MISMATCH');
  if (report.input.duplicateObjectKeys !== 0) throw new RehearsalError('E_SOURCE_DUPLICATE_KEY');
  if (report.exceptionSummary.omitted !== 0) throw new RehearsalError('E_PREFLIGHT_EXCEPTIONS_TRUNCATED');
  const records = extractRecords(bytes);
  const counts = countByKind(records);
  const c = report.collections;
  const expected = {
    category: c.categories.records,
    reviewer: c.reviewers.records,
    vendor: c.vendors.records,
    session: report.inventory.sessions,
    submission: report.inventory.submissions,
    entry: report.inventory.vendorEntries,
  };
  for (const kind of RECORD_KINDS) {
    if (counts[kind] !== expected[kind] || counts[kind] !== fixture.counts[kind]) {
      throw new RehearsalError('E_INVENTORY_MISMATCH');
    }
  }
  if (report.state !== fixture.preflightState || report.exceptionSummary.count !== fixture.preflightExceptions) {
    throw new RehearsalError('E_PREFLIGHT_PIN_MISMATCH');
  }
  return { report, records, counts };
}

export function buildManifest(name, workspace, bytes) {
  assertWorkspaceToken(workspace);
  const { report, counts } = inspectSource(name, bytes);
  const fixture = getFixture(name);
  const manifest = {
    format: MANIFEST_FORMAT,
    status: REHEARSAL_STATUS,
    mappingVersion: MAPPING_VERSION,
    fixture: name,
    targetWorkspace: workspace,
    sourceSha256: fixture.sha256,
    sourceByteLength: fixture.byteLength,
    batchFingerprint: batchFingerprint(workspace, fixture.sha256),
    recordCounts: counts,
    preflight: { reportFormat: report.reportFormat, state: report.state, exceptionCount: report.exceptionSummary.count },
  };
  return { ...manifest, manifestSha256: manifestSha256(manifest) };
}

// Structural and self-consistency checks only; the importer additionally
// re-derives everything from the pinned bytes and compares.
export function validateManifest(manifest, targetWorkspace) {
  if (manifest === null || typeof manifest !== 'object') throw new RehearsalError('E_MANIFEST_INVALID');
  if (manifest.format !== MANIFEST_FORMAT || manifest.status !== REHEARSAL_STATUS) throw new RehearsalError('E_MANIFEST_INVALID');
  if (manifest.mappingVersion !== MAPPING_VERSION) throw new RehearsalError('E_MAPPING_VERSION_MISMATCH');
  if (manifest.manifestSha256 !== manifestSha256(manifest)) throw new RehearsalError('E_MANIFEST_HASH_MISMATCH');
  assertWorkspaceToken(manifest.targetWorkspace);
  if (assertWorkspaceToken(targetWorkspace) !== manifest.targetWorkspace) throw new RehearsalError('E_TARGET_WORKSPACE_MISMATCH');
  const fixture = getFixture(manifest.fixture);
  if (manifest.sourceSha256 !== fixture.sha256 || manifest.sourceByteLength !== fixture.byteLength) {
    throw new RehearsalError('E_MANIFEST_SOURCE_MISMATCH');
  }
  if (manifest.batchFingerprint !== batchFingerprint(manifest.targetWorkspace, manifest.sourceSha256)) {
    throw new RehearsalError('E_BATCH_FINGERPRINT_MISMATCH');
  }
  return manifest;
}
