# legacy-preflight

Offline, read-only **source inspection** of a legacy Savour Firebase Realtime Database JSON export. Milestone 5, first development-only slice.

- A standalone Node CLI using built-in modules only.
- Separate from the Next app, Supabase and the Firebase MVP.
- No dependencies, network access, Firebase SDK, importer or field mapping.

## Use is restricted

- **Nothing in this folder grants permission to run the tool on a real export.** Use synthetic fixtures only until the owner supplies an explicitly authorised export. That gate is a human decision recorded outside this repo.
- Keep inputs and reports outside the repository and outside CI artifacts. The report is pseudonymous, not anonymous (see [Hashing](#hashing)).
- No state this tool produces means migration-ready, correct, approved, or signed off. **Sign-off is a human step outside this tool.**

## Run

Requires the installed Node 24. Nothing to install.

```sh
cd tools/legacy-preflight
node bin/legacy-preflight.mjs test/fixtures/clean-v2.json > /path/outside/repo/report.json
node --test test/*.test.mjs        # or: npm test
```

| Option | Meaning |
| --- | --- |
| `<file.json>` | A local file path only. Refused: URLs (`scheme:` prefixes), `-`/stdin, directories, FIFOs, and a symlink as the final path component. |
| `--max-bytes <n>` | Refuse larger inputs before parsing. Default 64 MiB, hard cap 512 MiB. |
| `--max-exceptions <n>` | Cap on listed exception records. Counts in `exceptionSummary.byCode` stay complete. Default 50000. |
| `--` | The next argument is the input path, even if it starts with `-`. |

**Output:**

- The JSON report goes to stdout, and one fixed summary line goes to stderr.
- The tool writes no files. Redirect stdout yourself, to a path outside the repo.

**Exit codes:** `0` INSPECTED_CLEAN, `10` INSPECTED_WITH_EXCEPTIONS, `11` UNKNOWN_SCHEMA, `2` usage or input error, `70` internal error.

**Errors** are fixed codes only, for example `legacy-preflight: error E_INPUT_NOT_FOUND. Run with --help for usage.` They never include:

- the path or the offending argument
- OS error text or JSON parser messages
- stack traces

## Input handling

- The file is opened with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and checked as a regular file with `fstat`.
- At most `max-bytes + 1` bytes are read.
- The file is never written, copied, renamed or touched.
- No "preserved originals" copy is made. The untouched input *is* the original, and `input.sha256` (SHA-256 of the raw bytes, taken before parsing) lets you verify it later.

### Strict JSON parsing

- **Format:** UTF-8 only. A UTF-8 BOM is refused, not stripped.
- **Grammar:** `JSON.parse` grammar only. No comments, trailing commas, single quotes, `NaN`/`Infinity` or concatenated documents.
- **Duplicate keys:** keys repeated within one object are counted (`input.duplicateObjectKeys`) and raised as `INPUT_DUPLICATE_OBJECT_KEYS`. `JSON.parse` keeps only the last value, so the tool reports the loss and cannot recover the earlier values.
- **Numbers:** parsed as IEEE doubles. Values are never printed.

## Source facts encoded

From MVP code, as recorded in `docs/milestone-5/source-schema-notes.md`.

**Root collections:** `sessions`, `vendors`, `categories`, `reviewers`. Any of them may be `null`.

**Session:**

- **Fields:** `date`, `name`, `notes`, `activeFrom`, `activeUntil`, `reviewerCode`, `status`, `submissions`, `approvedBy`, `approvedAt`.
- **Statuses:** `pending` and `approved` are known.
  - `pending` with no stamp is unapproved, which is normal.
  - A stamp on `pending` is stale, because reopening deletes it.
  - Any other status, or a missing status, is an exception.
- **Approval stamp:** `approved` requires `approvedBy` to be a non-blank string (whitespace-only counts as blank) and `approvedAt` to be integer milliseconds.

**Submission fields:** `taster`, `role`, `time`, `timestamp`, `vendors`, `actions`.

**Vendor entry fields:**

- Identity and attendance: `vendorId`, `vendorName`, `businessName`, `categoryName`, `att`, `assessmentVersion`, `criteriaSnapshot`, `attendance`.
- The seven food-score dbKeys: `taste`, `aroma`, `appear`, `hygiene`, `environ`, `storage`, `safety`.
- Absent entries: `notice`, `absenceReason`. Present entries: `sample`, `cust`, `obs`, `fu`, `pi`.

**Attendance.** These two fields are inspected separately and only ever compared. Neither is derived from the other.

- **`att` (text label).**
  - Scored mode (`criteriaSnapshot.attendance === true`) allows `Early`, `Middle`, `Late`, `Absent`.
  - Presence-only mode (`false`) allows `Present` and `Absent`.
  - `"—"` is the writer's fallback and is flagged (`ATT_PLACEHOLDER_RECORDED`).
  - A non-text `att` is flagged and never turned into a label.
  - Unknown labels are hashed.
- **`attendance` (stored points).**
  - Point meanings are applied only in recognised v2 scored mode, where the value must be 5, 3, 1 or 0 and a label/points disagreement is flagged.
  - In v2 presence-only mode, stored points are flagged (`ATTENDANCE_POINTS_UNEXPECTED`) but not graded.
  - In legacy or undetermined mode (unknown version, snapshot without version, non-boolean `criteriaSnapshot.attendance`), the value is only counted by type and in the `uninterpreted` bucket. No grade, range, type or label check is applied.
  - Missing points on a scored Early/Middle/Late/Absent entry are flagged. This is unverified: see the developer report.

**Food scores.**

- Present scores must be finite numbers. They are read for type and presence only, and their values are never used or printed.
- A v2 `Absent` entry carrying food scores is flagged. A v2 Absent entry without them is valid.
- Legacy entries are never judged by v2 rules.

**Timestamps.**

- `approvedAt` and numeric submission `timestamp` must be safe integers within the ECMAScript Date range (±8.64e15 ms).
- No calendar window is assumed. Seconds and milliseconds cannot be told apart, so a seconds value passes; whether a value is a real `Date.now()` is a human check.
- No timezone or `Date` parsing is used.

## States

| State | Meaning |
| --- | --- |
| `UNKNOWN_SCHEMA` | The input is not walked or inferred. This happens when the bytes are not parseable UTF-8 JSON (empty, BOM, invalid UTF-8, malformed, too deep), the root is not an object, or the root has none of the four collections. |
| `INSPECTED_WITH_EXCEPTIONS` | The root was recognised and walked, and at least one exception was recorded. |
| `INSPECTED_CLEAN` | The root was recognised and walked, and nothing deviated from the encoded source facts. This says nothing about data correctness or migration readiness. |

`rootShape` is one of `all_known_collections_present`, `some_known_collections_missing`, `unrecognized` or `not_parsed`. Having all four keys does **not** establish that the export is complete.

## Report contents

- **`input`:** `sha256`, `byteLength`, `parse`, `duplicateObjectKeys`.
- **`collections`:** each collection's shape, record count, records that are not objects, and soft-delete count (`deleted: true`).
- **`inventory`:** sessions, sessions without submissions, submissions, vendor entries, non-object entries, and `actions` elements.
- **`profile`:**
  - Entry schema (`v2`, `legacy`, `unrecognized`) and attendance mode (`scored`, `presence_only`, `legacy`, `undetermined`).
  - Value-type histograms.
  - `att` label counts. Known labels appear in clear text; unknown labels are hashed.
  - Stored-points counts. Graded buckets are filled in v2 scored mode only; elsewhere points go to `uninterpreted`.
  - Number of entries with food scores, and number of legacy Absent entries with food scores.
  - Hashed unknown criteria and hashed unrecognised field names per level.
  - Approval classification and session status counts. `approved`, `pending` and `missing` appear in clear text; other statuses are hashed.
- **`references`:**
  - Entry `vendorId`s are checked against `vendors` keys when `vendors` is a map, or `null` (which makes every reference dangle).
  - The check is skipped when `vendors` is missing or not a map.
- **`exceptionSummary` and `exceptions`:**
  - Each record has a reason `code`, a `level` and a structural `at` source key: `session`/`submission` hashes, the array `index`, and the `vendorId` hash.
  - The optional `detail` is limited to known field names, enum constants, value types, hashed labels, counts or indices.

Array index is the only identity for an entry.

- Duplicate `vendorId`s within a submission are reported on every involved index with constant-size detail (`occurrences`, `firstIndex`). They are never merged.
- Map keys are visited in code-unit order, so output does not depend on source key order, timezone or locale.

The report never contains food-score, total or per-entry attendance values. It also never contains names, emails, notes, `reviewerCode`, approver identities or raw dates.

## Reason codes

- **Input:** `INPUT_EMPTY`, `INPUT_UTF8_BOM`, `INPUT_NOT_UTF8`, `INPUT_MALFORMED_JSON`, `INPUT_JSON_TOO_DEEP`, `INPUT_DUPLICATE_OBJECT_KEYS`
- **Root and collections:** `ROOT_NOT_OBJECT`, `ROOT_NO_RECOGNIZED_COLLECTIONS`, `ROOT_COLLECTION_MISSING`, `COLLECTION_NOT_MAP`, `RECORD_NOT_OBJECT`, `DELETED_NOT_BOOLEAN`, `SESSIONS_EMPTY`
- **Session and approval:** `SESSION_NOT_OBJECT`, `SUBMISSIONS_NOT_MAP`, `SESSION_STATUS_MISSING`, `SESSION_STATUS_INVALID_TYPE`, `SESSION_STATUS_UNRECOGNIZED`, `APPROVAL_TRIPLE_INCOMPLETE`, `APPROVAL_FIELDS_WITHOUT_APPROVED_STATUS`, `APPROVED_BY_INVALID`, `APPROVED_BY_BLANK`, `APPROVED_AT_NOT_INTEGER_MS`, `APPROVED_AT_OUTSIDE_DATE_RANGE`
- **Submission:** `SUBMISSION_NOT_OBJECT`, `SUBMISSION_VENDORS_MISSING`, `SUBMISSION_VENDORS_NULL`, `SUBMISSION_VENDORS_EMPTY`, `SUBMISSION_VENDORS_NOT_ARRAY`, `ACTIONS_NOT_ARRAY`, `SUBMISSION_TIMESTAMP_NOT_INTEGER_MS`, `SUBMISSION_TIMESTAMP_OUTSIDE_DATE_RANGE`
- **Entry: identity and schema:** `ENTRY_NOT_OBJECT`, `VENDOR_ID_MISSING`, `VENDOR_ID_INVALID`, `VENDOR_REFERENCE_DANGLING`, `DUPLICATE_VENDOR_ID_IN_SUBMISSION`, `LEGACY_ENTRY_ORIGINAL_SEMANTICS_REVIEW`, `ASSESSMENT_VERSION_UNRECOGNIZED`, `V2_SNAPSHOT_MISSING`, `SNAPSHOT_WITHOUT_VERSION`, `SNAPSHOT_NOT_OBJECT`, `ENTRY_FIELD_TYPE_UNEXPECTED`
- **Entry: attendance:** `ATT_MISSING` (non-legacy entries only), `ATT_NOT_TEXT`, `ATT_PLACEHOLDER_RECORDED`, `ATT_LABEL_UNRECOGNIZED`, `ATT_LABEL_MODE_MISMATCH`, `ATT_LABEL_POINTS_MISMATCH`, `ATTENDANCE_POINTS_NOT_NUMBER`, `ATTENDANCE_POINTS_UNRECOGNIZED`, `ATTENDANCE_POINTS_UNEXPECTED`, `ATTENDANCE_POINTS_MISSING`
- **Entry: food scores:** `FOOD_SCORE_NOT_NUMBER`, `V2_ABSENT_ENTRY_HAS_FOOD_SCORES`
- **Snapshot:** `SNAPSHOT_FIELD_MISSING`, `SNAPSHOT_FIELD_NOT_BOOLEAN`, `SNAPSHOT_UNKNOWN_CRITERION`
- **Any level:** `UNRECOGNIZED_FIELD` (field name hashed)

## Hashing

`h:` plus the first 16 hex characters of `SHA-256("savour-legacy-preflight/label/v1\0" + value)`.

- Hashes are deterministic, so the same key correlates across a report and across runs.
- They are pseudonyms, not anonymisation: anyone holding a candidate value can confirm it.

To check a field name such as `taste` locally (never paste real customer values into shared tools):

```sh
node --input-type=module -e "import {hashLabel} from './src/hash.mjs'; console.log(hashLabel('taste'))"
```

## Limitations

`docs/milestone-5/legacy-preflight-developer-report.md` has the full list and the remaining migration work. The main ones:

- Unverified human semantics of dates and timestamps.
- Status values other than `pending`/`approved` are unknown.
- Historic (legacy) semantics are not established.
- Record collections are only checked for `deleted`.
- Object-shaped (sparse) `vendors` arrays are not walked.
- `categoryName` is not reference-checked.
- Fixture timings do not represent real export load.

Scope limit: food-score checks inspect stored field presence and finite numeric types. They do not establish full score completeness or valid ranges, recalculate totals, or certify migration readiness.
