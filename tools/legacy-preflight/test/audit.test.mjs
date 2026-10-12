import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditBytes, renderReport, STATES } from '../src/audit.mjs';
import { hashLabel } from '../src/hash.mjs';
import { readFixture } from './support/helpers.mjs';

function audit(value, options) {
  return auditBytes(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'), options);
}

function codes(report) {
  return report.exceptions.map((e) => e.code);
}

function exceptionsAt(report, code) {
  return report.exceptions.filter((e) => e.code === code);
}

const SCORED = {
  taste: true, aroma: true, appear: true, hygiene: true, environ: true, storage: true, safety: true, attendance: true,
};
const PRESENCE_ONLY = { ...SCORED, attendance: false };
const FOOD = { taste: 4, aroma: 4, appear: 4, hygiene: 4, environ: 4, storage: 4, safety: 4 };

// One approved session with one submission holding the given entries.
function exportWith(entries, { session = {}, submission = {} } = {}) {
  const vendorIds = [...new Set(entries.map((e) => e && e.vendorId).filter((id) => typeof id === 'string'))];
  return {
    categories: null,
    reviewers: null,
    vendors: Object.fromEntries(vendorIds.map((id) => [id, { name: 'Synthetic' }])),
    sessions: {
      s: {
        status: 'approved', approvedBy: 'Synthetic Reviewer', approvedAt: 1791806400000,
        ...session,
        submissions: { u: { taster: 'Synthetic', timestamp: 1791806300000, ...submission, vendors: entries } },
      },
    },
  };
}

function v2(fields) {
  return { vendorId: 'v', vendorName: 'S', businessName: 'S', categoryName: 'S', assessmentVersion: 2, ...fields };
}

const MIXED_SUB = hashLabel('sub-mixed');

function mixedIndices(report, code) {
  return exceptionsAt(report, code).filter((e) => e.at.submission === MIXED_SUB).map((e) => e.at.index);
}

test('clean v2 fixture with full MVP metadata inspects clean', () => {
  const report = auditBytes(readFixture('clean-v2.json'));
  assert.equal(report.state, STATES.INSPECTED_CLEAN);
  assert.deepEqual(report.exceptions, []);
  assert.equal(report.rootShape, 'all_known_collections_present');
  assert.deepEqual(report.inventory, {
    sessions: 2, sessionsWithoutSubmissions: 0, submissions: 2,
    vendorEntries: 4, vendorEntriesNotObject: 0, actionEntries: 1,
  });
  assert.deepEqual(report.collections.vendors, { collection: 'map', records: 3, recordsNotObject: 0, softDeleted: 1 });
  assert.equal(report.profile.entrySchema.v2, 4);
  assert.equal(report.profile.approval.approved_complete, 1);
  assert.equal(report.profile.approval.pending_unapproved, 1);
  assert.deepEqual(report.profile.sessionStatus, { approved: 1, missing: 0, pending: 1 });
  assert.deepEqual(report.profile.attLabel, { Absent: 2, Early: 1, Late: 0, Middle: 0, Present: 1, placeholder: 0 });
  assert.deepEqual(report.profile.attendanceMode, { legacy: 0, presence_only: 2, scored: 2, undetermined: 0 });
  assert.deepEqual(report.profile.attendancePoints,
    { absent_0: 1, early_5: 1, late_1: 0, middle_3: 0, uninterpreted: 0, unrecognized: 0 });
  for (const level of ['root', 'session', 'submission', 'entry']) {
    assert.deepEqual(report.profile.unrecognizedFields[level], {}, level);
  }
  assert.equal(report.references.resolved, 4);
  assert.equal(report.references.resolvedToSoftDeleted, 1);
});

test('every source-written field name is known; unknown names still hash and report', () => {
  const sessionFields = ['date', 'name', 'notes', 'activeFrom', 'activeUntil', 'reviewerCode'];
  const submissionFields = ['taster', 'role', 'time', 'timestamp', 'actions'];
  const entryFields = ['notice', 'absenceReason', 'sample', 'cust', 'obs', 'fu', 'pi'];
  const sessionExtra = Object.fromEntries(sessionFields.map((f) => [f, 'x']));
  const submissionExtra = { taster: 'x', role: 'x', time: 'x', timestamp: 1791806300000, actions: [] };
  const entryExtra = Object.fromEntries(entryFields.map((f) => [f, 'x']));
  const known = audit(exportWith([v2({ att: 'Early', attendance: 5, criteriaSnapshot: SCORED, ...FOOD, ...entryExtra })],
    { session: sessionExtra, submission: submissionExtra }));
  assert.equal(known.state, STATES.INSPECTED_CLEAN, JSON.stringify(known.exceptionSummary.byCode));
  assert.deepEqual(Object.keys(submissionExtra), submissionFields);

  const unknown = audit(exportWith([v2({ att: 'Early', attendance: 5, criteriaSnapshot: SCORED, entryOddity: 1 })],
    { session: { sessionOddity: 1 }, submission: { submissionOddity: 1 } }));
  assert.deepEqual(exceptionsAt(unknown, 'UNRECOGNIZED_FIELD').map((e) => [e.level, e.detail.label]), [
    ['session', hashLabel('sessionOddity')],
    ['submission', hashLabel('submissionOddity')],
    ['entry', hashLabel('entryOddity')],
  ]);
  const root = audit({ ...exportWith([v2({ att: 'Early', attendance: 5, criteriaSnapshot: SCORED })]), rootOddity: {} });
  assert.deepEqual(exceptionsAt(root, 'UNRECOGNIZED_FIELD').map((e) => e.detail.label), [hashLabel('rootOddity')]);
});

test('valid MVP attendance shapes inspect clean', () => {
  const cases = {
    'scored Early with points 5 and food scores': v2({ att: 'Early', attendance: 5, criteriaSnapshot: SCORED, ...FOOD }),
    'scored Middle with points 3': v2({ att: 'Middle', attendance: 3, criteriaSnapshot: SCORED, ...FOOD }),
    'scored Late with points 1': v2({ att: 'Late', attendance: 1, criteriaSnapshot: SCORED, ...FOOD }),
    'scored Absent with points 0 and no food scores': v2({ att: 'Absent', attendance: 0, criteriaSnapshot: SCORED, notice: 'x', absenceReason: 'x' }),
    'presence-only Present without points': v2({ att: 'Present', criteriaSnapshot: PRESENCE_ONLY, ...FOOD }),
    'presence-only Absent without points or food scores': v2({ att: 'Absent', criteriaSnapshot: PRESENCE_ONLY }),
  };
  for (const [name, entry] of Object.entries(cases)) {
    const report = audit(exportWith([entry]));
    assert.equal(report.state, STATES.INSPECTED_CLEAN, `${name}: ${JSON.stringify(report.exceptionSummary.byCode)}`);
  }
});

test('non-text att is never turned into a label', () => {
  for (const att of [5, 0, true, null, { label: 'Early' }]) {
    const report = audit(exportWith([v2({ att, attendance: 5, criteriaSnapshot: SCORED })]));
    assert.deepEqual(codes(report), ['ATT_NOT_TEXT'], JSON.stringify(att));
    assert.ok(Object.values(report.profile.attLabel).every((n) => n === 0));
    assert.equal(report.profile.attendancePoints.early_5, 1);
  }
});

test('label and stored points are checked separately and only compared', () => {
  const report = auditBytes(readFixture('mixed-legacy-v2.json'));
  assert.deepEqual(exceptionsAt(report, 'ATT_NOT_TEXT').map((e) => [e.at.index, e.detail.valueType]),
    [[1, 'number'], [2, 'boolean']]);
  assert.deepEqual(mixedIndices(report, 'ATT_MISSING'), [3]);
  assert.deepEqual(exceptionsAt(report, 'ATT_LABEL_POINTS_MISMATCH').map((e) => [e.at.index, e.detail]),
    [[4, { attLabel: 'Middle' }]]);
  assert.deepEqual(exceptionsAt(report, 'ATT_LABEL_MODE_MISMATCH').map((e) => [e.at.index, e.detail]),
    [[7, { mode: 'presence_only', attLabel: 'Early' }], [9, { mode: 'scored', attLabel: 'Present' }]]);
  assert.deepEqual(mixedIndices(report, 'ATTENDANCE_POINTS_UNEXPECTED'), [8]);
  assert.deepEqual(exceptionsAt(report, 'ATT_LABEL_UNRECOGNIZED').map((e) => [e.at.index, e.detail.label]),
    [[10, hashLabel('Tardy')]]);
  assert.equal(report.profile.attLabel[hashLabel('Tardy')], 1);
  assert.deepEqual(mixedIndices(report, 'ATT_PLACEHOLDER_RECORDED'), [11]);
  assert.equal(report.profile.attLabel.placeholder, 1);
  assert.deepEqual(exceptionsAt(report, 'ATTENDANCE_POINTS_MISSING').map((e) => [e.at.index, e.detail]),
    [[12, { attLabel: 'Early' }]]);
  assert.deepEqual(exceptionsAt(report, 'ATTENDANCE_POINTS_NOT_NUMBER').map((e) => [e.at.index, e.detail]),
    [[13, { valueType: 'string' }]]);
  assert.deepEqual(exceptionsAt(report, 'FOOD_SCORE_NOT_NUMBER').map((e) => [e.at.index, e.detail]),
    [[14, { field: 'taste', valueType: 'string' }]]);
  assert.equal(report.profile.snapshotAttendance.number, 1);
  assert.equal(report.profile.attendanceMode.undetermined >= 1, true);
});

test('stored points outside 5/3/1/0 are unrecognized, never re-derived', () => {
  for (const points of [2, 4, -1, 5.5, 50]) {
    const report = audit(exportWith([v2({ att: 'Early', attendance: points, criteriaSnapshot: SCORED })]));
    assert.deepEqual(codes(report), ['ATTENDANCE_POINTS_UNRECOGNIZED'], String(points));
    assert.equal(report.profile.attendancePoints.unrecognized, 1);
  }
});

test('stored attendance outside v2 scored mode is never given modern point meaning', () => {
  const graded = ['early_5', 'middle_3', 'late_1', 'absent_0', 'unrecognized'];
  const modernCodes = ['ATT_LABEL_POINTS_MISMATCH', 'ATTENDANCE_POINTS_UNRECOGNIZED', 'ATTENDANCE_POINTS_NOT_NUMBER'];
  const legacy = (fields) => ({ vendorId: 'v', vendorName: 'S', businessName: 'S', categoryName: 'S', ...fields });
  const cases = [
    ['legacy Absent with attendance 3', legacy({ att: 'Absent', attendance: 3 }), ['LEGACY_ENTRY_ORIGINAL_SEMANTICS_REVIEW'], 'number'],
    ['legacy Early with attendance 0', legacy({ att: 'Early', attendance: 0 }), ['LEGACY_ENTRY_ORIGINAL_SEMANTICS_REVIEW'], 'number'],
    ['legacy boolean attendance', legacy({ att: 'Absent', attendance: true }), ['LEGACY_ENTRY_ORIGINAL_SEMANTICS_REVIEW'], 'boolean'],
    ['legacy unknown number', legacy({ att: 'Late', attendance: 42 }), ['LEGACY_ENTRY_ORIGINAL_SEMANTICS_REVIEW'], 'number'],
    ['legacy string attendance', legacy({ att: 'Absent', attendance: '3' }), ['LEGACY_ENTRY_ORIGINAL_SEMANTICS_REVIEW'], 'string'],
    ['unknown version with snapshot', v2({ assessmentVersion: 3, att: 'Absent', attendance: 3, criteriaSnapshot: SCORED }),
      ['ASSESSMENT_VERSION_UNRECOGNIZED'], 'number'],
    ['snapshot without version', legacy({ att: 'Absent', attendance: 3, criteriaSnapshot: SCORED }),
      ['SNAPSHOT_WITHOUT_VERSION'], 'number'],
    ['v2 with non-boolean snapshot.attendance', v2({ att: 'Absent', attendance: 3, criteriaSnapshot: { ...SCORED, attendance: 1 } }),
      ['SNAPSHOT_FIELD_NOT_BOOLEAN'], 'number'],
  ];
  for (const [name, entry, expectedCodes, pointsType] of cases) {
    const report = audit(exportWith([entry]));
    assert.deepEqual(codes(report), expectedCodes, name);
    for (const code of modernCodes) assert.ok(!codes(report).includes(code), `${name}: ${code}`);
    for (const bucket of graded) assert.equal(report.profile.attendancePoints[bucket], 0, `${name}: ${bucket}`);
    assert.equal(report.profile.attendancePoints.uninterpreted, 1, name);
    assert.equal(report.profile.attendancePointsType[pointsType], 1, name);
    assert.equal(report.profile.attendanceMode.scored, 0, name);
  }
});

test('v2 presence-only flags stored points without grading them; v2 scored keeps exact checks', () => {
  const presence = audit(exportWith([v2({ att: 'Present', attendance: 5, criteriaSnapshot: PRESENCE_ONLY })]));
  assert.deepEqual(codes(presence), ['ATTENDANCE_POINTS_UNEXPECTED']);
  assert.equal(presence.profile.attendancePoints.early_5, 0);
  assert.equal(presence.profile.attendancePoints.uninterpreted, 1);

  const scored = (fields) => codes(audit(exportWith([v2({ criteriaSnapshot: SCORED, ...fields })])));
  assert.deepEqual(scored({ att: 'Absent', attendance: 3 }), ['ATT_LABEL_POINTS_MISMATCH']);
  assert.deepEqual(scored({ att: 'Early', attendance: 42 }), ['ATTENDANCE_POINTS_UNRECOGNIZED']);
  assert.deepEqual(scored({ att: 'Early', attendance: true }), ['ATTENDANCE_POINTS_NOT_NUMBER']);
  const graded = audit(exportWith([v2({ att: 'Middle', attendance: 3, criteriaSnapshot: SCORED })]));
  assert.equal(graded.state, STATES.INSPECTED_CLEAN);
  assert.equal(graded.profile.attendancePoints.middle_3, 1);
});

test('v2 Absent with leftover food scores is flagged; values untouched and unreported', () => {
  const report = auditBytes(readFixture('mixed-legacy-v2.json'));
  const hits = exceptionsAt(report, 'V2_ABSENT_ENTRY_HAS_FOOD_SCORES');
  assert.deepEqual(hits.map((e) => [e.at.index, e.detail]), [[0, { fields: ['taste'] }]]);
  const presenceAbsent = audit(exportWith([v2({ att: 'Absent', criteriaSnapshot: PRESENCE_ONLY, ...FOOD })]));
  assert.deepEqual(codes(presenceAbsent), ['V2_ABSENT_ENTRY_HAS_FOOD_SCORES']);
  assert.deepEqual(presenceAbsent.exceptions[0].detail.fields, ['aroma', 'appear', 'environ', 'hygiene', 'safety', 'storage', 'taste']);
});

test('legacy entries are flagged for original-semantics review, never upgraded', () => {
  const report = auditBytes(readFixture('mixed-legacy-v2.json'));
  const legacySub = hashLabel('sub-legacy');
  const legacy = exceptionsAt(report, 'LEGACY_ENTRY_ORIGINAL_SEMANTICS_REVIEW');
  assert.deepEqual(legacy.map((e) => [e.at.submission, e.at.index]), [0, 1, 2, 3].map((i) => [legacySub, i]));
  assert.equal(report.profile.entrySchema.legacy, 4);
  assert.equal(report.profile.attendanceMode.legacy, 4);
  // No invented attendance for the presence-only legacy entry without att.
  assert.ok(!report.exceptions.some((e) => e.at.submission === legacySub && e.code === 'ATT_MISSING'));
  // Legacy absence with scores is profiled, not treated as a v2 leftover.
  assert.equal(report.profile.legacyAbsentWithFoodScores, 1);
  assert.ok(!report.exceptions.some((e) => e.at.submission === legacySub && e.code === 'V2_ABSENT_ENTRY_HAS_FOOD_SCORES'));
});

test('unknown criteria keys are hashed and missing snapshot criteria reported', () => {
  const report = auditBytes(readFixture('mixed-legacy-v2.json'));
  const unknown = exceptionsAt(report, 'SNAPSHOT_UNKNOWN_CRITERION');
  assert.deepEqual(unknown.map((e) => e.detail.label), [hashLabel('freshness')]);
  assert.deepEqual(report.profile.unknownCriteria, { [hashLabel('freshness')]: 1 });
  assert.deepEqual(exceptionsAt(report, 'SNAPSHOT_FIELD_MISSING').filter((e) => e.at.submission === MIXED_SUB)
    .map((e) => [e.at.index, e.detail.field]), [[3, 'storage']]);
});

test('duplicate vendorIds keep index identity with constant-size detail', () => {
  const report = auditBytes(readFixture('mixed-legacy-v2.json'));
  const dups = exceptionsAt(report, 'DUPLICATE_VENDOR_ID_IN_SUBMISSION');
  assert.deepEqual(dups.map((e) => [e.at.index, e.at.vendorId, e.detail]), [
    [0, hashLabel('ven-mix-1'), { occurrences: 2, firstIndex: 0 }],
    [4, hashLabel('ven-mix-1'), { occurrences: 2, firstIndex: 0 }],
    [3, hashLabel('ven-mix-4'), { occurrences: 2, firstIndex: 3 }],
    [6, hashLabel('ven-mix-4'), { occurrences: 2, firstIndex: 3 }],
  ]);
  assert.equal(report.inventory.vendorEntries, 4 + 15 + 3);
});

test('a large duplicate group produces a report linear in input size', () => {
  const n = 20000;
  const entry = v2({ att: 'Early', attendance: 5, criteriaSnapshot: SCORED });
  const input = Buffer.from(JSON.stringify(exportWith(Array.from({ length: n }, () => entry))));
  const report = auditBytes(input);
  const dups = exceptionsAt(report, 'DUPLICATE_VENDOR_ID_IN_SUBMISSION');
  assert.equal(dups.length, n);
  assert.equal(report.exceptionSummary.byCode.DUPLICATE_VENDOR_ID_IN_SUBMISSION, n);
  assert.deepEqual(dups.map((e) => e.at.index), Array.from({ length: n }, (_, i) => i));
  for (const e of dups) assert.deepEqual(e.detail, { occurrences: n, firstIndex: 0 });
  const rendered = renderReport(report);
  assert.ok(rendered.length < 400 * n, `report ${rendered.length} bytes for ${n} entries`);
  assert.ok(rendered.length < input.length * 2);
  const capped = renderReport(auditBytes(input, { maxExceptions: 100 }));
  assert.ok(capped.length < 64 * 1024);
});

test('dangling references reported only when the vendors collection is supplied', () => {
  const report = auditBytes(readFixture('mixed-legacy-v2.json'));
  assert.deepEqual(exceptionsAt(report, 'VENDOR_REFERENCE_DANGLING').map((e) => e.at.vendorId), [hashLabel('ven-ghost')]);
  assert.equal(report.references.dangling, 1);

  const base = exportWith([v2({ vendorId: 'ven-x', att: 'Early', attendance: 5, criteriaSnapshot: SCORED })]);
  const { vendors, ...withoutVendors } = base;
  const missing = audit(withoutVendors);
  assert.equal(missing.references.vendorIdCheck, 'skipped_vendors_missing');
  assert.equal(missing.references.notChecked, 1);
  assert.deepEqual(codes(missing), ['ROOT_COLLECTION_MISSING']);
  assert.ok(vendors);

  const nullVendors = audit({ ...base, vendors: null });
  assert.equal(nullVendors.references.vendorIdCheck, 'checked_against_vendors_null');
  assert.deepEqual(codes(nullVendors), ['VENDOR_REFERENCE_DANGLING']);
});

test('session statuses: approved and pending known, others and absence exceptioned', () => {
  const report = auditBytes(readFixture('mixed-legacy-v2.json'));
  assert.deepEqual(report.profile.approval, {
    approval_fields_without_approved_status: 2, approved_complete: 0, approved_partial: 2,
    pending_unapproved: 1, status_invalid_type: 0, status_missing: 0, status_unrecognized: 1,
  });
  assert.equal(exceptionsAt(report, 'SESSION_STATUS_UNRECOGNIZED')[0].detail.label, hashLabel('open'));
  assert.equal(report.profile.sessionStatus[hashLabel('open')], 1);
  assert.deepEqual(exceptionsAt(report, 'SESSION_STATUS_MISSING').map((e) => e.at.session), [hashLabel('sess-no-status')]);
  assert.deepEqual(exceptionsAt(report, 'APPROVAL_FIELDS_WITHOUT_APPROVED_STATUS').map((e) => [e.at.session, e.detail]), [
    [hashLabel('sess-no-status'), { present: ['approvedAt'] }],
    [hashLabel('sess-pending-stamped'), { present: ['approvedAt'] }],
  ]);
  const pending = exportWith([v2({ att: 'Early', attendance: 5, criteriaSnapshot: SCORED })]);
  pending.sessions.s = { status: 'pending', submissions: pending.sessions.s.submissions };
  assert.equal(audit(pending).state, STATES.INSPECTED_CLEAN);
});

test('blank or whitespace approvedBy is never a complete stamp', () => {
  const report = auditBytes(readFixture('mixed-legacy-v2.json'));
  assert.deepEqual(exceptionsAt(report, 'APPROVED_BY_BLANK').map((e) => e.at.session), [hashLabel('sess-legacy')]);
  assert.deepEqual(exceptionsAt(report, 'APPROVAL_TRIPLE_INCOMPLETE').map((e) => [e.at.session, e.detail]), [
    [hashLabel('sess-legacy'), { missing: [] }],
    [hashLabel('sess-v2-mixed'), { missing: ['approvedBy'] }],
  ]);
  for (const blank of ['', ' ', '\t\n', ' ', '  ']) {
    const r = audit(exportWith([v2({ att: 'Early', attendance: 5, criteriaSnapshot: SCORED })], { session: { approvedBy: blank } }));
    assert.deepEqual(codes(r), ['APPROVED_BY_BLANK', 'APPROVAL_TRIPLE_INCOMPLETE'], JSON.stringify(blank));
    assert.equal(r.profile.approval.approved_partial, 1);
  }
});

test('approvedAt and timestamp: integer ms within the Date range, no calendar window', () => {
  const entries = [v2({ att: 'Early', attendance: 5, criteriaSnapshot: SCORED })];
  const approvedAt = (value) => codes(audit(exportWith(entries, { session: { approvedAt: value } })));
  const timestamp = (value) => codes(audit(exportWith(entries, { submission: { timestamp: value } })));
  for (const ok of [0, -1, 1714560000, 946684799999, 1791806400000, 4102444800000, 8.64e15, -8.64e15]) {
    assert.deepEqual(approvedAt(ok), [], `approvedAt ${ok}`);
    assert.deepEqual(timestamp(ok), [], `timestamp ${ok}`);
  }
  for (const out of [8.64e15 + 1, -8.64e15 - 1]) {
    assert.deepEqual(approvedAt(out), ['APPROVED_AT_OUTSIDE_DATE_RANGE', 'APPROVAL_TRIPLE_INCOMPLETE']);
    assert.deepEqual(timestamp(out), ['SUBMISSION_TIMESTAMP_OUTSIDE_DATE_RANGE']);
  }
  for (const bad of [1.5, 2 ** 53, '1791806400000', '2026-10-12T00:00:00Z']) {
    assert.deepEqual(approvedAt(bad), ['APPROVED_AT_NOT_INTEGER_MS', 'APPROVAL_TRIPLE_INCOMPLETE'], String(bad));
  }
  assert.deepEqual(timestamp(1.5), ['SUBMISSION_TIMESTAMP_NOT_INTEGER_MS']);
  // Non-numeric submission timestamps are profiled by type only.
  assert.deepEqual(timestamp('10:00'), []);
});

test('version and snapshot shapes outside v2/legacy are unrecognized, not guessed', () => {
  const report = auditBytes(readFixture('mixed-legacy-v2.json'));
  assert.equal(report.profile.entrySchema.unrecognized, 3);
  assert.equal(exceptionsAt(report, 'ASSESSMENT_VERSION_UNRECOGNIZED').length, 1);
  assert.equal(exceptionsAt(report, 'V2_SNAPSHOT_MISSING').length, 1);
  assert.equal(exceptionsAt(report, 'SNAPSHOT_WITHOUT_VERSION').length, 1);
  assert.deepEqual(exceptionsAt(report, 'SNAPSHOT_NOT_OBJECT').map((e) => e.detail), [{ valueType: 'array' }]);
});

test('empty vendors array, unknown entry field and soft-delete type problems are exceptioned', () => {
  const report = auditBytes(readFixture('mixed-legacy-v2.json'));
  assert.equal(exceptionsAt(report, 'SUBMISSION_VENDORS_EMPTY').length, 1);
  assert.equal(report.profile.submissionVendorsShape.array_empty, 1);
  assert.deepEqual(exceptionsAt(report, 'UNRECOGNIZED_FIELD').map((e) => e.detail.label), [hashLabel('total')]);
  assert.equal(exceptionsAt(report, 'DELETED_NOT_BOOLEAN').length, 1);
  assert.equal(report.collections.vendors.softDeleted, 1);
});

test('nested invalid shapes produce reason codes and never throw', () => {
  const report = auditBytes(readFixture('nested-invalid.json'));
  assert.equal(report.state, STATES.INSPECTED_WITH_EXCEPTIONS);
  const byCode = report.exceptionSummary.byCode;
  for (const code of [
    'COLLECTION_NOT_MAP', 'RECORD_NOT_OBJECT', 'SESSION_NOT_OBJECT', 'SUBMISSIONS_NOT_MAP',
    'SESSION_STATUS_INVALID_TYPE', 'SUBMISSION_NOT_OBJECT', 'SUBMISSION_VENDORS_NOT_ARRAY',
    'SUBMISSION_VENDORS_NULL', 'SUBMISSION_VENDORS_MISSING', 'ACTIONS_NOT_ARRAY',
    'SUBMISSION_TIMESTAMP_NOT_INTEGER_MS', 'ENTRY_NOT_OBJECT', 'VENDOR_ID_INVALID', 'VENDOR_ID_MISSING',
    'ATT_NOT_TEXT', 'ASSESSMENT_VERSION_UNRECOGNIZED', 'SNAPSHOT_NOT_OBJECT', 'SNAPSHOT_FIELD_NOT_BOOLEAN',
    'FOOD_SCORE_NOT_NUMBER', 'ENTRY_FIELD_TYPE_UNEXPECTED', 'UNRECOGNIZED_FIELD',
  ]) {
    assert.ok(byCode[code] > 0, `expected ${code}`);
  }
  // attendance: 4 sits on a legacy entry, so it is counted but never range-checked.
  assert.equal(byCode.ATTENDANCE_POINTS_UNRECOGNIZED, undefined);
  assert.equal(report.profile.attendancePoints.uninterpreted, 1);
  assert.deepEqual(exceptionsAt(report, 'ENTRY_NOT_OBJECT').map((e) => [e.at.index, e.detail.valueType]),
    [[0, 'null'], [1, 'array'], [2, 'string']]);
  assert.equal(report.inventory.vendorEntries, 6);
  assert.equal(report.inventory.vendorEntriesNotObject, 3);
  assert.equal(report.profile.submissionVendorsShape.other, 1);
  assert.equal(report.collections.categories.collection, 'not_map');
});

test('unknown root shapes are UNKNOWN_SCHEMA and not walked', () => {
  for (const value of ['[]', 'null', '"text"', '42', '{}', '{"users":{"u1":{"sessions":{}}}}']) {
    const report = audit(value);
    assert.equal(report.state, STATES.UNKNOWN_SCHEMA, value);
    assert.equal(report.rootShape, 'unrecognized');
    assert.equal(report.inventory.sessions, 0);
  }
});

test('partial and empty exports are reported truthfully', () => {
  const partial = audit({ vendors: { v1: {} } });
  assert.equal(partial.state, STATES.INSPECTED_WITH_EXCEPTIONS);
  assert.equal(partial.rootShape, 'some_known_collections_missing');
  assert.deepEqual(exceptionsAt(partial, 'ROOT_COLLECTION_MISSING').map((e) => e.at.collection),
    ['categories', 'reviewers', 'sessions']);

  const empty = audit({ sessions: null, vendors: null, categories: null, reviewers: null });
  assert.deepEqual(codes(empty), ['SESSIONS_EMPTY']);
  const emptyMap = audit({ sessions: {}, vendors: {}, categories: {}, reviewers: {} });
  assert.deepEqual(codes(emptyMap), ['SESSIONS_EMPTY']);
});

test('input-level failures are UNKNOWN_SCHEMA with a code and a checksum', () => {
  const cases = [
    [Buffer.alloc(0), 'INPUT_EMPTY'],
    [Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), 'INPUT_UTF8_BOM'],
    [Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), 'INPUT_NOT_UTF8'],
    [readFixture('malformed-pii.json'), 'INPUT_MALFORMED_JSON'],
    [Buffer.from('   '), 'INPUT_MALFORMED_JSON'],
  ];
  for (const [bytes, code] of cases) {
    const report = auditBytes(bytes);
    assert.equal(report.state, STATES.UNKNOWN_SCHEMA, code);
    assert.equal(report.input.parse, 'failed');
    assert.deepEqual(codes(report), [code]);
    assert.match(report.input.sha256, /^[0-9a-f]{64}$/);
  }
});

test('strict JSON only: lenient syntax is rejected as malformed', () => {
  for (const text of [
    '{"sessions":{},}', '{"sessions":{}} // c', '/* c */{"sessions":{}}', "{'sessions':{}}",
    '{sessions:{}}', '{"sessions":NaN}', '{"sessions":Infinity}', '{"sessions":0x10}', '{"a":1}{"b":2}',
  ]) {
    assert.deepEqual(codes(audit(text)), ['INPUT_MALFORMED_JSON'], text);
  }
});

test('duplicate object keys, which JSON.parse silently collapses, are detected', () => {
  const ok = exportWith([v2({ att: 'Early', attendance: 5, criteriaSnapshot: SCORED })]);
  const text = JSON.stringify(ok);
  assert.equal(audit(text).input.duplicateObjectKeys, 0);

  const dupSession = text.replace('"sessions":{', '"sessions":{"s":{"status":"pending"},');
  const r1 = audit(dupSession);
  assert.equal(r1.input.duplicateObjectKeys, 1);
  assert.deepEqual(r1.exceptions[0], { code: 'INPUT_DUPLICATE_OBJECT_KEYS', level: 'input', at: {}, detail: { occurrences: 1 } });
  assert.equal(r1.state, STATES.INSPECTED_WITH_EXCEPTIONS);

  const escaped = text.replace('"att":"Early"', '"att":"Early","\\u0061tt":"Late"');
  assert.equal(audit(escaped).input.duplicateObjectKeys, 1);
  // Same key in sibling objects or arrays, and braces/quotes inside strings, are not duplicates.
  const tricky = '{"sessions":null,"vendors":{"a":{"name":"{\\"x\\":1,\\"x\\":2}"},"b":{"name":"a"}},'
    + '"categories":{"c":{"deleted":false}},"reviewers":{"r":{"deleted":false}},"z":[{"k":1},{"k":2}]}';
  assert.equal(audit(tricky).input.duplicateObjectKeys, 0);
});

test('deeply nested JSON does not crash the walker', () => {
  const depth = 200000;
  const report = audit(`${'['.repeat(depth)}${']'.repeat(depth)}`);
  assert.equal(report.state, STATES.UNKNOWN_SCHEMA);
  assert.ok(['ROOT_NOT_OBJECT', 'INPUT_JSON_TOO_DEEP'].includes(report.exceptions[0].code));
  const deep = JSON.parse(`${'{"a":'.repeat(5000)}1${'}'.repeat(5000)}`);
  assert.equal(audit(exportWith([deep])).inventory.vendorEntries, 1);
});

test('exception list is capped but counts stay complete', () => {
  const report = audit(exportWith(Array.from({ length: 50 }, () => null)), { maxExceptions: 10 });
  assert.equal(report.exceptionSummary.count, 50);
  assert.equal(report.exceptionSummary.listed, 10);
  assert.equal(report.exceptionSummary.omitted, 40);
});
