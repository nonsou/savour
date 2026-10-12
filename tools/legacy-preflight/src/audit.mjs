// Offline, read-only inspection of a legacy Savour Firebase RTDB JSON export.
//
// The audit describes what the source contains. It never computes, rescales or
// defaults scores or attendance, never fabricates approval metadata or source
// keys, and never emits raw source values. Every source-derived string that
// could carry PII (map keys, vendorIds, unknown field names, unknown enum
// values) is reduced to a hashed label; only field names and enum constants
// taken from the MVP writers (see docs/milestone-5/source-schema-notes.md)
// appear in clear text.

import { hashLabel, sha256Hex } from './hash.mjs';

export const STATES = Object.freeze({
  UNKNOWN_SCHEMA: 'UNKNOWN_SCHEMA',
  INSPECTED_WITH_EXCEPTIONS: 'INSPECTED_WITH_EXCEPTIONS',
  INSPECTED_CLEAN: 'INSPECTED_CLEAN',
});

export const REPORT_FORMAT = 'savour-legacy-preflight-report/2';
export const DEFAULT_MAX_EXCEPTIONS = 50000;

export const NOTICE = Object.freeze([
  'Source inspection only. No state in this report means migration-ready, verified, approved, or signed off.',
  'Sign-off is a human step performed outside this tool.',
  'Hashed labels are truncated SHA-256 pseudonyms, not anonymisation. Treat this report as confidential.',
  'No food or attendance value is computed or defaulted; per-entry values are never reproduced.',
]);

const ROOT_COLLECTIONS = ['categories', 'reviewers', 'sessions', 'vendors'];
const RECORD_COLLECTIONS = ['categories', 'reviewers', 'vendors'];
// Food criteria dbKeys. The MVP stores each quality score as
// entry[dbKey] = Number(input) and the enabled set in criteriaSnapshot.
const CRITERIA = ['aroma', 'appear', 'environ', 'hygiene', 'safety', 'storage', 'taste'];
const SNAPSHOT_FIELDS = [...CRITERIA, 'attendance'];
// admin.html session writer plus the approval stamp.
const KNOWN_SESSION_FIELDS = new Set([
  'activeFrom', 'activeUntil', 'approvedAt', 'approvedBy', 'date', 'name', 'notes',
  'reviewerCode', 'status', 'submissions',
]);
const KNOWN_STATUSES = new Set(['approved', 'pending']);
// index.html submission writer.
const KNOWN_SUBMISSION_FIELDS = new Set(['actions', 'role', 'taster', 'time', 'timestamp', 'vendors']);
const ENTRY_TEXT_FIELDS = ['businessName', 'categoryName', 'vendorName'];
// index.html vendor entry writer: identity, attendance, version/snapshot, food
// scores, absent-entry fields (notice, absenceReason) and present-entry fields
// (sample, cust, obs, fu, pi). Only names are known here, never values.
const KNOWN_ENTRY_FIELDS = new Set([
  'absenceReason', 'assessmentVersion', 'att', 'attendance', 'criteriaSnapshot', 'cust', 'fu',
  'notice', 'obs', 'pi', 'sample', 'vendorId', ...ENTRY_TEXT_FIELDS, ...CRITERIA,
]);
// entry.att is a text label: att = attendanceValue(i) || "—".
const SCORED_ATT_LABELS = new Set(['Early', 'Middle', 'Late', 'Absent']);
const PRESENCE_ATT_LABELS = new Set(['Present', 'Absent']);
const ATT_PLACEHOLDER = '—';
// entry.attendance is a stored point number, written only when
// criteriaSnapshot.attendance is true: Early 5, Middle 3, Late 1, Absent 0.
const LABEL_POINTS = new Map([['Early', 5], ['Middle', 3], ['Late', 1], ['Absent', 0]]);
const POINT_NAMES = new Map([[5, 'early_5'], [3, 'middle_3'], [1, 'late_1'], [0, 'absent_0']]);
const VALUE_TYPES = ['array', 'boolean', 'missing', 'null', 'number', 'object', 'string'];
// ECMAScript Date range in milliseconds. Only integer/range semantics are
// checked; no calendar window is assumed (seconds-vs-ms cannot be told apart).
const DATE_MS_LIMIT = 8.64e15;

const hasOwn = Object.hasOwn;

function isMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeOf(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function sortedKeys(obj) {
  return Object.keys(obj).sort();
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

class Counter {
  constructor(seed = []) {
    this.map = new Map(seed.map((key) => [key, 0]));
  }

  add(key, n = 1) {
    this.map.set(key, (this.map.get(key) ?? 0) + n);
  }

  toObject() {
    return Object.fromEntries([...this.map.entries()].sort(([a], [b]) => compareStrings(a, b)));
  }
}

// Converts counters to sorted plain objects so the returned report is plain
// data. Only walks the report's own fixed-depth structure.
function materialize(value) {
  if (value instanceof Counter) return value.toObject();
  if (Array.isArray(value)) return value.map(materialize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, materialize(child)]));
  }
  return value;
}

function epochMsProblem(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 'NOT_INTEGER_MS';
  if (Math.abs(value) > DATE_MS_LIMIT) return 'OUTSIDE_DATE_RANGE';
  return null;
}

function createContext(maxExceptions) {
  return {
    maxExceptions,
    exceptions: [],
    exceptionCounts: new Counter(),
    exceptionsOmitted: 0,
    rootShape: 'not_parsed',
    unknownSchema: false,
    collections: Object.fromEntries(ROOT_COLLECTIONS.map((name) => [name, {
      collection: 'not_inspected', records: 0, recordsNotObject: 0, softDeleted: 0,
    }])),
    vendorKeys: null,
    softDeletedVendorKeys: new Set(),
    inventory: {
      sessions: 0,
      sessionsWithoutSubmissions: 0,
      submissions: 0,
      vendorEntries: 0,
      vendorEntriesNotObject: 0,
      actionEntries: 0,
    },
    profile: {
      entrySchema: new Counter(['legacy', 'unrecognized', 'v2']),
      assessmentVersion: new Counter(['missing', 'other', 'v2']),
      criteriaSnapshot: new Counter(VALUE_TYPES),
      snapshotAttendance: new Counter(VALUE_TYPES),
      unknownCriteria: new Counter(),
      attendanceMode: new Counter(['legacy', 'presence_only', 'scored', 'undetermined']),
      attType: new Counter(VALUE_TYPES),
      attLabel: new Counter([...new Set([...SCORED_ATT_LABELS, ...PRESENCE_ATT_LABELS]), 'placeholder']),
      attendancePointsType: new Counter(VALUE_TYPES),
      attendancePoints: new Counter([...POINT_NAMES.values(), 'uninterpreted', 'unrecognized']),
      entriesWithFoodScores: 0,
      legacyAbsentWithFoodScores: 0,
      approval: new Counter([
        'approval_fields_without_approved_status', 'approved_complete', 'approved_partial',
        'pending_unapproved', 'status_invalid_type', 'status_missing', 'status_unrecognized',
      ]),
      sessionStatus: new Counter(['approved', 'missing', 'pending']),
      submissionVendorsShape: new Counter(['array_empty', 'array_nonempty', 'missing', 'null', 'other']),
      submissionTime: new Counter(VALUE_TYPES),
      submissionTimestamp: new Counter(VALUE_TYPES),
      unrecognizedFields: {
        root: new Counter(), session: new Counter(), submission: new Counter(), entry: new Counter(),
      },
    },
    references: {
      vendorIdCheck: 'not_inspected',
      resolved: 0,
      resolvedToSoftDeleted: 0,
      dangling: 0,
      notChecked: 0,
    },
  };
}

function addException(ctx, code, level, at, detail) {
  ctx.exceptionCounts.add(code);
  if (ctx.exceptions.length >= ctx.maxExceptions) {
    ctx.exceptionsOmitted += 1;
    return;
  }
  const record = { code, level, at: { ...at } };
  if (detail !== undefined) record.detail = detail;
  ctx.exceptions.push(record);
}

function flagUnrecognizedFields(ctx, node, known, level, at) {
  for (const key of sortedKeys(node)) {
    if (known.has(key)) continue;
    const label = hashLabel(key);
    ctx.profile.unrecognizedFields[level].add(label);
    addException(ctx, 'UNRECOGNIZED_FIELD', level, at, { label });
  }
}

// JSON.parse keeps only the last of repeated object keys. This scan runs on
// text that JSON.parse has already accepted and counts keys repeated within
// one object (compared after unescaping), without building values.
function countDuplicateObjectKeys(text) {
  const stack = [];
  let duplicates = 0;
  let expectKey = false;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x7b) {
      stack.push(new Set());
      expectKey = true;
    } else if (c === 0x5b) {
      stack.push(null);
      expectKey = false;
    } else if (c === 0x7d || c === 0x5d) {
      stack.pop();
      expectKey = false;
    } else if (c === 0x2c) {
      expectKey = stack.length > 0 && stack[stack.length - 1] !== null;
    } else if (c === 0x22) {
      let j = i + 1;
      while (text.charCodeAt(j) !== 0x22) j += text.charCodeAt(j) === 0x5c ? 2 : 1;
      if (expectKey) {
        const raw = text.slice(i, j + 1);
        const key = raw.includes('\\') ? JSON.parse(raw) : raw.slice(1, -1);
        const keys = stack[stack.length - 1];
        if (keys.has(key)) duplicates += 1;
        else keys.add(key);
        expectKey = false;
      }
      i = j;
    }
    i += 1;
  }
  return duplicates;
}

function parseJsonBytes(bytes) {
  if (bytes.length === 0) return { ok: false, code: 'INPUT_EMPTY' };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { ok: false, code: 'INPUT_UTF8_BOM' };
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, code: 'INPUT_NOT_UTF8' };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    // The engine's message quotes input text, so only a code is kept.
    return { ok: false, code: err instanceof RangeError ? 'INPUT_JSON_TOO_DEEP' : 'INPUT_MALFORMED_JSON' };
  }
  return { ok: true, value, duplicateKeys: countDuplicateObjectKeys(text) };
}

function inspectRecordCollection(ctx, name, value) {
  const summary = ctx.collections[name];
  const at = { collection: name };
  if (value === undefined) {
    summary.collection = 'missing';
    return;
  }
  if (value === null) {
    summary.collection = 'null';
    if (name === 'vendors') ctx.vendorKeys = new Set();
    return;
  }
  if (!isMap(value)) {
    summary.collection = 'not_map';
    addException(ctx, 'COLLECTION_NOT_MAP', 'collection', at, { valueType: typeOf(value) });
    return;
  }
  summary.collection = 'map';
  const keys = sortedKeys(value);
  if (name === 'vendors') ctx.vendorKeys = new Set(keys);
  for (const key of keys) {
    summary.records += 1;
    const record = value[key];
    const recordAt = { collection: name, record: hashLabel(key) };
    if (!isMap(record)) {
      summary.recordsNotObject += 1;
      addException(ctx, 'RECORD_NOT_OBJECT', 'collection', recordAt, { valueType: typeOf(record) });
      continue;
    }
    if (!hasOwn(record, 'deleted')) continue;
    if (record.deleted === true) {
      summary.softDeleted += 1;
      if (name === 'vendors') ctx.softDeletedVendorKeys.add(key);
    } else if (record.deleted !== false) {
      addException(ctx, 'DELETED_NOT_BOOLEAN', 'collection', recordAt, { valueType: typeOf(record.deleted) });
    }
  }
}

function inspectApproval(ctx, session, at) {
  const { profile } = ctx;
  const hasStatus = hasOwn(session, 'status');
  const hasBy = hasOwn(session, 'approvedBy');
  const hasAt = hasOwn(session, 'approvedAt');
  const status = session.status;

  if (!hasStatus) profile.sessionStatus.add('missing');
  else if (typeof status !== 'string') profile.sessionStatus.add(`type:${typeOf(status)}`);
  else if (KNOWN_STATUSES.has(status)) profile.sessionStatus.add(status);
  else profile.sessionStatus.add(hashLabel(status));

  // Stamp field types are checked whenever present, whatever the status says.
  let byOk = hasBy;
  if (hasBy && typeof session.approvedBy !== 'string') {
    byOk = false;
    addException(ctx, 'APPROVED_BY_INVALID', 'session', at, { valueType: typeOf(session.approvedBy) });
  } else if (hasBy && session.approvedBy.trim().length === 0) {
    byOk = false;
    addException(ctx, 'APPROVED_BY_BLANK', 'session', at);
  }
  let atOk = hasAt;
  if (hasAt) {
    const problem = epochMsProblem(session.approvedAt);
    if (problem) {
      atOk = false;
      addException(ctx, `APPROVED_AT_${problem}`, 'session', at, { valueType: typeOf(session.approvedAt) });
    }
  }
  const stampFields = [hasBy && 'approvedBy', hasAt && 'approvedAt'].filter(Boolean);

  if (hasStatus && typeof status !== 'string') {
    profile.approval.add('status_invalid_type');
    addException(ctx, 'SESSION_STATUS_INVALID_TYPE', 'session', at, { valueType: typeOf(status) });
    return;
  }

  if (status === 'approved') {
    if (byOk && atOk) {
      profile.approval.add('approved_complete');
    } else {
      profile.approval.add('approved_partial');
      const missing = [!hasBy && 'approvedBy', !hasAt && 'approvedAt'].filter(Boolean);
      addException(ctx, 'APPROVAL_TRIPLE_INCOMPLETE', 'session', at, { missing });
    }
    return;
  }

  if (status === 'pending') {
    // Reopening sets pending and deletes the stamp, so a stamp here is stale.
    profile.approval.add(stampFields.length === 0 ? 'pending_unapproved' : 'approval_fields_without_approved_status');
  } else if (hasStatus) {
    profile.approval.add('status_unrecognized');
    addException(ctx, 'SESSION_STATUS_UNRECOGNIZED', 'session', at, { label: hashLabel(status) });
  } else {
    // The admin writer always sets status; its absence has unknown semantics.
    profile.approval.add(stampFields.length === 0 ? 'status_missing' : 'approval_fields_without_approved_status');
    addException(ctx, 'SESSION_STATUS_MISSING', 'session', at);
  }
  if (stampFields.length > 0) {
    addException(ctx, 'APPROVAL_FIELDS_WITHOUT_APPROVED_STATUS', 'session', at, { present: stampFields });
  }
}

function inspectSnapshot(ctx, snapshot, at) {
  const { profile } = ctx;
  profile.snapshotAttendance.add(typeOf(snapshot.attendance));
  for (const field of SNAPSHOT_FIELDS) {
    if (!hasOwn(snapshot, field)) {
      addException(ctx, 'SNAPSHOT_FIELD_MISSING', 'snapshot', at, { field });
    } else if (typeof snapshot[field] !== 'boolean') {
      addException(ctx, 'SNAPSHOT_FIELD_NOT_BOOLEAN', 'snapshot', at, { field, valueType: typeOf(snapshot[field]) });
    }
  }
  const known = new Set(SNAPSHOT_FIELDS);
  for (const key of sortedKeys(snapshot)) {
    if (known.has(key)) continue;
    const label = hashLabel(key);
    profile.unknownCriteria.add(label);
    addException(ctx, 'SNAPSHOT_UNKNOWN_CRITERION', 'snapshot', at, { label });
  }
}

// Text label (att) and stored points (attendance) are inspected separately and
// only compared; neither is ever derived from the other.
function inspectAttendance(ctx, entry, schema, snapshot, at) {
  const { profile } = ctx;
  let mode = 'undetermined';
  if (schema === 'legacy') mode = 'legacy';
  else if (schema === 'v2' && typeof snapshot.attendance === 'boolean') {
    mode = snapshot.attendance ? 'scored' : 'presence_only';
  }
  profile.attendanceMode.add(mode);

  const att = entry.att;
  profile.attType.add(typeOf(att));
  let label = null;
  if (att === undefined) {
    if (schema !== 'legacy') addException(ctx, 'ATT_MISSING', 'entry', at);
  } else if (typeof att !== 'string') {
    addException(ctx, 'ATT_NOT_TEXT', 'entry', at, { valueType: typeOf(att) });
  } else if (att === ATT_PLACEHOLDER) {
    // The writer's fallback when no attendance was chosen.
    profile.attLabel.add('placeholder');
    addException(ctx, 'ATT_PLACEHOLDER_RECORDED', 'entry', at);
  } else if (SCORED_ATT_LABELS.has(att) || PRESENCE_ATT_LABELS.has(att)) {
    profile.attLabel.add(att);
    label = att;
  } else {
    const hashed = hashLabel(att);
    profile.attLabel.add(hashed);
    addException(ctx, 'ATT_LABEL_UNRECOGNIZED', 'entry', at, { label: hashed });
  }
  if (label !== null) {
    const allowed = mode === 'scored' ? SCORED_ATT_LABELS : mode === 'presence_only' ? PRESENCE_ATT_LABELS : null;
    if (allowed && !allowed.has(label)) {
      addException(ctx, 'ATT_LABEL_MODE_MISMATCH', 'entry', at, { mode, attLabel: label });
    }
  }

  const points = entry.attendance;
  profile.attendancePointsType.add(typeOf(points));
  if (hasOwn(entry, 'attendance') && mode !== 'scored') {
    // Point meanings are only established for v2 scored mode. Elsewhere the
    // stored value is counted as present but never graded or range-checked.
    profile.attendancePoints.add('uninterpreted');
    if (mode === 'presence_only') addException(ctx, 'ATTENDANCE_POINTS_UNEXPECTED', 'entry', at);
  } else if (hasOwn(entry, 'attendance')) {
    if (typeof points !== 'number') {
      addException(ctx, 'ATTENDANCE_POINTS_NOT_NUMBER', 'entry', at, { valueType: typeOf(points) });
    } else if (!POINT_NAMES.has(points)) {
      profile.attendancePoints.add('unrecognized');
      addException(ctx, 'ATTENDANCE_POINTS_UNRECOGNIZED', 'entry', at);
    } else {
      profile.attendancePoints.add(POINT_NAMES.get(points));
      if (label !== null && LABEL_POINTS.has(label) && LABEL_POINTS.get(label) !== points) {
        addException(ctx, 'ATT_LABEL_POINTS_MISMATCH', 'entry', at, { attLabel: label });
      }
    }
  } else if (mode === 'scored' && label !== null && LABEL_POINTS.has(label)) {
    addException(ctx, 'ATTENDANCE_POINTS_MISSING', 'entry', at, { attLabel: label });
  }
  return label;
}

function inspectEntry(ctx, entry, at) {
  const { profile } = ctx;

  const hasVersion = hasOwn(entry, 'assessmentVersion');
  const hasSnapshot = hasOwn(entry, 'criteriaSnapshot');
  const version = entry.assessmentVersion;
  const snapshot = entry.criteriaSnapshot;
  profile.assessmentVersion.add(!hasVersion ? 'missing' : version === 2 ? 'v2' : 'other');
  profile.criteriaSnapshot.add(typeOf(snapshot));

  let schema;
  if (!hasVersion && !hasSnapshot) {
    schema = 'legacy';
    // Historic entry: original semantics are preserved and flagged, not upgraded.
    addException(ctx, 'LEGACY_ENTRY_ORIGINAL_SEMANTICS_REVIEW', 'entry', at);
  } else if (version === 2 && isMap(snapshot)) {
    schema = 'v2';
  } else {
    schema = 'unrecognized';
    if (hasVersion && version !== 2) {
      addException(ctx, 'ASSESSMENT_VERSION_UNRECOGNIZED', 'entry', at, { valueType: typeOf(version) });
    }
    if (version === 2 && !hasSnapshot) addException(ctx, 'V2_SNAPSHOT_MISSING', 'entry', at);
    if (!hasVersion && hasSnapshot) addException(ctx, 'SNAPSHOT_WITHOUT_VERSION', 'entry', at);
    if (hasSnapshot && !isMap(snapshot)) {
      addException(ctx, 'SNAPSHOT_NOT_OBJECT', 'entry', at, { valueType: typeOf(snapshot) });
    }
  }
  profile.entrySchema.add(schema);
  if (isMap(snapshot)) inspectSnapshot(ctx, snapshot, at);

  const label = inspectAttendance(ctx, entry, schema, snapshot, at);

  // Food scores are read for presence and type only; values are never used.
  const foodFields = CRITERIA.filter((field) => hasOwn(entry, field));
  for (const field of foodFields) {
    if (typeof entry[field] !== 'number' || !Number.isFinite(entry[field])) {
      addException(ctx, 'FOOD_SCORE_NOT_NUMBER', 'entry', at, { field, valueType: typeOf(entry[field]) });
    }
  }
  if (foodFields.length > 0) profile.entriesWithFoodScores += 1;
  // v2 clears food scores for Absent; leftovers are reported, not removed.
  if (schema === 'v2' && label === 'Absent' && foodFields.length > 0) {
    addException(ctx, 'V2_ABSENT_ENTRY_HAS_FOOD_SCORES', 'entry', at, { fields: foodFields });
  }
  if (schema === 'legacy' && label === 'Absent' && foodFields.length > 0) profile.legacyAbsentWithFoodScores += 1;

  for (const field of ENTRY_TEXT_FIELDS) {
    if (hasOwn(entry, field) && typeof entry[field] !== 'string') {
      addException(ctx, 'ENTRY_FIELD_TYPE_UNEXPECTED', 'entry', at, { field, valueType: typeOf(entry[field]) });
    }
  }
  flagUnrecognizedFields(ctx, entry, KNOWN_ENTRY_FIELDS, 'entry', at);
}

function checkVendorReference(ctx, vendorId, at) {
  const refs = ctx.references;
  if (ctx.vendorKeys === null) {
    refs.notChecked += 1;
    return;
  }
  if (!ctx.vendorKeys.has(vendorId)) {
    refs.dangling += 1;
    addException(ctx, 'VENDOR_REFERENCE_DANGLING', 'entry', at);
    return;
  }
  refs.resolved += 1;
  if (ctx.softDeletedVendorKeys.has(vendorId)) refs.resolvedToSoftDeleted += 1;
}

function inspectVendorsArray(ctx, vendors, baseAt) {
  const { inventory } = ctx;
  const groups = new Map();
  vendors.forEach((entry, index) => {
    inventory.vendorEntries += 1;
    const at = { ...baseAt, index };
    if (!isMap(entry)) {
      inventory.vendorEntriesNotObject += 1;
      addException(ctx, 'ENTRY_NOT_OBJECT', 'entry', at, { valueType: typeOf(entry) });
      return;
    }
    if (!hasOwn(entry, 'vendorId')) {
      addException(ctx, 'VENDOR_ID_MISSING', 'entry', at);
      ctx.references.notChecked += 1;
    } else if (typeof entry.vendorId !== 'string' || entry.vendorId.length === 0) {
      addException(ctx, 'VENDOR_ID_INVALID', 'entry', at, { valueType: typeOf(entry.vendorId) });
      ctx.references.notChecked += 1;
    } else {
      at.vendorId = hashLabel(entry.vendorId);
      const group = groups.get(entry.vendorId);
      if (group) group.indices.push(index);
      else groups.set(entry.vendorId, { hash: at.vendorId, indices: [index] });
      checkVendorReference(ctx, entry.vendorId, at);
    }
    inspectEntry(ctx, entry, at);
  });
  // Array index is the only entry identity; duplicates are reported, never
  // merged. Each record carries constant-size detail so a large group stays
  // linear in report size.
  const duplicates = [...groups.values()].filter((group) => group.indices.length > 1);
  duplicates.sort((a, b) => a.indices[0] - b.indices[0]);
  for (const { hash, indices } of duplicates) {
    const detail = { occurrences: indices.length, firstIndex: indices[0] };
    for (const index of indices) {
      addException(ctx, 'DUPLICATE_VENDOR_ID_IN_SUBMISSION', 'entry', { ...baseAt, index, vendorId: hash }, { ...detail });
    }
  }
}

function inspectSubmission(ctx, submission, at) {
  const { profile, inventory } = ctx;
  if (!isMap(submission)) {
    addException(ctx, 'SUBMISSION_NOT_OBJECT', 'submission', at, { valueType: typeOf(submission) });
    return;
  }
  flagUnrecognizedFields(ctx, submission, KNOWN_SUBMISSION_FIELDS, 'submission', at);

  // time is profiled by type only. A numeric timestamp must be integer ms in
  // the Date range; its human meaning (clock, timezone) is not verified.
  profile.submissionTime.add(typeOf(submission.time));
  profile.submissionTimestamp.add(typeOf(submission.timestamp));
  if (typeof submission.timestamp === 'number') {
    const problem = epochMsProblem(submission.timestamp);
    if (problem) addException(ctx, `SUBMISSION_TIMESTAMP_${problem}`, 'submission', at);
  }

  if (hasOwn(submission, 'actions')) {
    if (Array.isArray(submission.actions)) inventory.actionEntries += submission.actions.length;
    else addException(ctx, 'ACTIONS_NOT_ARRAY', 'submission', at, { valueType: typeOf(submission.actions) });
  }

  const vendors = submission.vendors;
  if (vendors === undefined) {
    profile.submissionVendorsShape.add('missing');
    addException(ctx, 'SUBMISSION_VENDORS_MISSING', 'submission', at);
  } else if (vendors === null) {
    profile.submissionVendorsShape.add('null');
    addException(ctx, 'SUBMISSION_VENDORS_NULL', 'submission', at);
  } else if (!Array.isArray(vendors)) {
    // Includes object-shaped vendors (e.g. a sparse array exported as a map);
    // its children are not walked because index identity cannot be confirmed.
    profile.submissionVendorsShape.add('other');
    addException(ctx, 'SUBMISSION_VENDORS_NOT_ARRAY', 'submission', at, { valueType: typeOf(vendors) });
  } else if (vendors.length === 0) {
    profile.submissionVendorsShape.add('array_empty');
    addException(ctx, 'SUBMISSION_VENDORS_EMPTY', 'submission', at);
  } else {
    profile.submissionVendorsShape.add('array_nonempty');
    inspectVendorsArray(ctx, vendors, at);
  }
}

function inspectSessions(ctx, value) {
  const summary = ctx.collections.sessions;
  const { inventory } = ctx;
  if (value === undefined) {
    summary.collection = 'missing';
    return;
  }
  if (value === null) {
    summary.collection = 'null';
    addException(ctx, 'SESSIONS_EMPTY', 'root', {});
    return;
  }
  if (!isMap(value)) {
    summary.collection = 'not_map';
    addException(ctx, 'COLLECTION_NOT_MAP', 'collection', { collection: 'sessions' }, { valueType: typeOf(value) });
    return;
  }
  summary.collection = 'map';
  const sessionKeys = sortedKeys(value);
  if (sessionKeys.length === 0) addException(ctx, 'SESSIONS_EMPTY', 'root', {});
  for (const sessionKey of sessionKeys) {
    summary.records += 1;
    inventory.sessions += 1;
    const session = value[sessionKey];
    const at = { session: hashLabel(sessionKey) };
    if (!isMap(session)) {
      summary.recordsNotObject += 1;
      addException(ctx, 'SESSION_NOT_OBJECT', 'session', at, { valueType: typeOf(session) });
      continue;
    }
    flagUnrecognizedFields(ctx, session, KNOWN_SESSION_FIELDS, 'session', at);
    inspectApproval(ctx, session, at);

    const submissions = session.submissions;
    if (submissions === undefined || submissions === null) {
      inventory.sessionsWithoutSubmissions += 1;
      continue;
    }
    if (!isMap(submissions)) {
      addException(ctx, 'SUBMISSIONS_NOT_MAP', 'session', at, { valueType: typeOf(submissions) });
      continue;
    }
    const submissionKeys = sortedKeys(submissions);
    if (submissionKeys.length === 0) inventory.sessionsWithoutSubmissions += 1;
    for (const submissionKey of submissionKeys) {
      inventory.submissions += 1;
      inspectSubmission(ctx, submissions[submissionKey], { ...at, submission: hashLabel(submissionKey) });
    }
  }
}

function inspectRoot(ctx, root) {
  if (!isMap(root)) {
    ctx.rootShape = 'unrecognized';
    ctx.unknownSchema = true;
    addException(ctx, 'ROOT_NOT_OBJECT', 'root', {}, { valueType: typeOf(root) });
    return;
  }
  const present = ROOT_COLLECTIONS.filter((name) => hasOwn(root, name));
  if (present.length === 0) {
    // Not inferred to be an export at all; nothing beneath it is walked.
    ctx.rootShape = 'unrecognized';
    ctx.unknownSchema = true;
    addException(ctx, 'ROOT_NO_RECOGNIZED_COLLECTIONS', 'root', {}, { rootKeys: Object.keys(root).length });
    return;
  }
  ctx.rootShape = present.length === ROOT_COLLECTIONS.length
    ? 'all_known_collections_present'
    : 'some_known_collections_missing';
  for (const name of ROOT_COLLECTIONS) {
    if (!hasOwn(root, name)) addException(ctx, 'ROOT_COLLECTION_MISSING', 'root', { collection: name });
  }
  flagUnrecognizedFields(ctx, root, new Set(ROOT_COLLECTIONS), 'root', {});

  // Vendors first so entry references can be checked against its keys.
  for (const name of RECORD_COLLECTIONS) inspectRecordCollection(ctx, name, root[name]);
  const vendorsStatus = ctx.collections.vendors.collection;
  ctx.references.vendorIdCheck = ctx.vendorKeys === null
    ? `skipped_vendors_${vendorsStatus}`
    : `checked_against_vendors_${vendorsStatus}`;
  inspectSessions(ctx, root.sessions);
}

function buildReport(ctx, input) {
  let state;
  if (ctx.unknownSchema) state = STATES.UNKNOWN_SCHEMA;
  else if (ctx.exceptionCounts.map.size > 0) state = STATES.INSPECTED_WITH_EXCEPTIONS;
  else state = STATES.INSPECTED_CLEAN;

  const exceptionCount = [...ctx.exceptionCounts.map.values()].reduce((a, b) => a + b, 0);
  return materialize({
    reportFormat: REPORT_FORMAT,
    state,
    notice: NOTICE,
    input,
    rootShape: ctx.rootShape,
    collections: ctx.collections,
    inventory: ctx.inventory,
    profile: ctx.profile,
    references: ctx.references,
    exceptionSummary: {
      count: exceptionCount,
      listed: ctx.exceptions.length,
      omitted: ctx.exceptionsOmitted,
      byCode: ctx.exceptionCounts,
    },
    exceptions: ctx.exceptions,
  });
}

// Pure function of the input bytes: no clock, locale, timezone, environment,
// filesystem, or network access. Returns a JSON-serialisable report.
export function auditBytes(bytes, options = {}) {
  const maxExceptions = options.maxExceptions ?? DEFAULT_MAX_EXCEPTIONS;
  const ctx = createContext(maxExceptions);
  const input = { sha256: sha256Hex(bytes), byteLength: bytes.length, parse: 'ok', duplicateObjectKeys: 0 };
  const parsed = parseJsonBytes(bytes);
  if (!parsed.ok) {
    input.parse = 'failed';
    ctx.unknownSchema = true;
    addException(ctx, parsed.code, 'input', {});
  } else {
    input.duplicateObjectKeys = parsed.duplicateKeys;
    if (parsed.duplicateKeys > 0) {
      // Only the last value of each repeated key survives parsing.
      addException(ctx, 'INPUT_DUPLICATE_OBJECT_KEYS', 'input', {}, { occurrences: parsed.duplicateKeys });
    }
    inspectRoot(ctx, parsed.value);
  }
  return buildReport(ctx, input);
}

export function renderReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
