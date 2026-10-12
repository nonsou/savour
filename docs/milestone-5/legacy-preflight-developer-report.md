# Milestone 5: legacy preflight auditor, developer report

**Revision 3:** 2026-10-12. Minimal fix after Sol's final review. Revision 2 notes follow below.

**Scope:** development-only. Synthetic fixtures only. No real export was used, requested or authorised, and nothing here implies permission to run against one.

## Revision 3: stored points outside v2 scored mode

**Issue:** stored `attendance` was graded with modern 5/3/1/0 meanings in every mode. For example, a legacy `att: "Absent"` entry with `attendance: 3` raised `ATT_LABEL_POINTS_MISMATCH` and was counted as `middle_3`.

**Fix** (one branch in `inspectAttendance` in `src/audit.mjs`, plus a new `uninterpreted` profile bucket):

- **v2 scored mode:** exact point, range, type and label checks, unchanged.
- **v2 presence-only mode:** stored points are flagged `ATTENDANCE_POINTS_UNEXPECTED` but not graded.
- **Legacy and undetermined modes:** the value is counted by type and as `uninterpreted`, with no grade, range, type or label check.

`LEGACY_ENTRY_ORIGINAL_SEMANTICS_REVIEW` and the unknown-version and snapshot codes are unchanged.

**Tests:** two new tests in `audit.test.mjs`.

- Legacy entries with attendance 3, 0, `true`, 42 and `"3"`, an unknown-version snapshot, a snapshot without a version, and a non-boolean `criteriaSnapshot.attendance`. Each gets only its schema code, no modern code, and no graded bucket.
- v2 presence-only is flagged without grading, and v2 scored mismatch, unrecognised and not-number regressions are kept.

The `nested-invalid` assertion that expected `ATTENDANCE_POINTS_UNRECOGNIZED` on a legacy entry was the bug itself. It now asserts that the value is uninterpreted.

## Revision 2: what changed and why

Sol's review found that the first pass misclassified valid MVP exports. Fixes are grounded in the source facts now recorded in `source-schema-notes.md`.

1. **`att` is a text label, not a number.**
   - Label handling (`att`) and stored points (`attendance`) are now separate. The scored or presence-only mode comes from `criteriaSnapshot.attendance`.
   - These are now valid and inspect clean: presence-only `Present` with no points, and scored `Absent`/0 with no food scores.
   - A numeric or boolean `att` raises `ATT_NOT_TEXT` and is never turned into a label.
   - Unknown labels are hashed.
   - Label/points disagreement, wrong label for the mode, unexpected or missing points, and the `"—"` placeholder each raise a separate code. Nothing is recomputed or defaulted.
   - A v2 Absent entry with food scores raises `V2_ABSENT_ENTRY_HAS_FOOD_SCORES`, and the values are left untouched.
2. **Sessions.**
   - The admin writer's fields (`date`, `name`, `notes`, `activeFrom`, `activeUntil`, `reviewerCode`) are known.
   - `pending` without a stamp is unapproved, not unrecognised. `pending` with a stamp is flagged as stale.
   - Other statuses are still `SESSION_STATUS_UNRECOGNIZED`. A missing status is now `SESSION_STATUS_MISSING`, because the writer always sets one.
   - `reviewerCode` values are never output.
3. **Submissions and entries.** Fields known from the writers:
   - submission: `taster`, `role`
   - absent entries: `notice`, `absenceReason`
   - present entries: `sample`, `cust`, `obs`, `fu`, `pi`

   Food scores are confirmed to live under the seven dbKeys, and the earlier "score field names undocumented" comment is removed. Non-numeric food scores raise `FOOD_SCORE_NOT_NUMBER`. Unknown field names at every level are still hashed and reported.
4. **Timestamps.**
   - The invented 2000–2099 window is removed. `approvedAt` and numeric submission `timestamp` are checked only as safe integers within the ECMAScript Date range (±8.64e15 ms).
   - The codes are renamed `*_NOT_INTEGER_MS` and `*_OUTSIDE_DATE_RANGE`.
5. **Independent cases.** All ten cases are regressions in `test/independent.test.mjs`, using byte-exact copies whose SHA-256 is pinned. Each one checks the expected state and exact code counts, that no private value leaks, that input bytes are unchanged, and that output is deterministic.
6. **Duplicate groups.**
   - Before: every duplicate record repeated the whole index array, so report size grew quadratically.
   - Now: each record carries `{ occurrences, firstIndex }` and keeps its own `at.index`.
   - A 20,000-entry duplicate-group test checks that the report stays linear in input size and that the counts are exact.
7. **Blank stamps.** An `approvedBy` that is empty or whitespace-only (including NBSP and em space) raises `APPROVED_BY_BLANK`, and the stamp is never counted as complete.
8. **Also added.**
   - Detection of duplicate JSON object keys (`INPUT_DUPLICATE_OBJECT_KEYS`). `JSON.parse` silently collapses them; this was previously only listed as a limitation.
   - Strict-JSON rejection tests.
   - `reportFormat` is now `savour-legacy-preflight-report/2`.

## What exists

`tools/legacy-preflight/` is a standalone Node 24 CLI.

- **Dependencies:** built-in modules only (`node:crypto`, `node:fs`). No installs and no runtime configuration.
- **Isolation:** no link to Next, Supabase or the Firebase MVP. MVP HTML was not read or modified by this work.

| Path | Purpose |
| --- | --- |
| `bin/legacy-preflight.mjs` | CLI entry |
| `src/cli.mjs` | Arguments, fixed error codes, exit codes |
| `src/input.mjs` | Bounded, read-only, local-file-only input |
| `src/audit.mjs` | Pure audit from bytes to report (no I/O, clock, locale or timezone) |
| `src/hash.mjs` | Input SHA-256 and domain-separated label hashes |
| `README.md` | Safe use, encoded source facts, states, report, reason codes |
| `package.json` | `private`, `type: module`, `scripts.test` only |
| `test/*.test.mjs` | Six files, 70 tests |
| `test/support/` | Spawn helper and network/Firebase tripwire preload |
| `test/fixtures/` | Five tool fixtures, plus `independent/` (ten byte-exact copies of Sol's cases) |

## Tests

Command, run from `tools/legacy-preflight`:

```
node --test test/*.test.mjs
ℹ tests 70
ℹ pass 70
ℹ fail 0
```

| File | Covers |
| --- | --- |
| `audit.test.mjs` (27) | Clean fixture with full MVP metadata. Every writer field name is known, and unknown names still hash. Six valid attendance shapes are clean. Non-text `att`. Label versus points versus mode codes. Points outside 5/3/1/0. v2 Absent leftover food scores. Legacy review without upgrade. Unknown and missing criteria. Duplicate detail. 20k duplicate group stays linear. Reference checks. Statuses (pending, stale stamp, missing, unknown). Blank `approvedBy` variants. Integer-ms and Date-range boundaries (seconds accepted, ±8.64e15 edges). Unrecognised versions. Empty vendors, hashed `total`, soft-delete. Nested invalid shapes. Unknown roots. Partial and empty exports. Input failures. Strict-JSON rejects. Duplicate-key detection, including escaped keys and decoy strings. 200k-deep nesting. Exception cap. |
| `independent.test.mjs` (18) | Pinned SHA of the ten copies. Per case: state, exact `byCode`, exit code, input bytes unchanged, no private values or keys in stdout or stderr, determinism. Profile and identity checks for complete, presence-only, scored-absence, historic, private-keys, duplicate, dangling and partial-approval. URL and oversize refusal without echo. |
| `cli.test.mjs` (10) | Exit codes, sign-off disclaimer, non-echo of paths, URLs, options and numbers, oversize, directory and symlink refusal, malformed-with-PII, `--help`, no files written. |
| `determinism.test.mjs` (4) | Byte-identical runs, checksum equals raw SHA-256, three TZ/locale settings, map key order changes only the checksum. |
| `privacy.test.mjs` (4) | PII fixture by relative and absolute path: no names, emails, `reviewerCode`, notes, scores, dates or paths. Known PII-bearing fields are recognised by name only. Every report string is a hash, checksum, identifier or fixed notice. |
| `safety.test.mjs` (7) | Tripwire positive control (fetch, net, https, dns, firebase, supabase). The CLI never trips it. A stubbed fetch is never called. Imports are `node:` or relative only, with no write, `Date` or `Intl` APIs. Input bytes, size, mtime and mode are unchanged. No total keys, and every number is a non-negative integer. No readiness keys. |

### Independent cases

The CLI was also run on the originals in `independent-fixtures/`. Codes and counts only; SHA-256 was unchanged before and after for every file.

| Case | Exit | State | Exceptions |
| --- | --- | --- | --- |
| complete-v2 | 0 | INSPECTED_CLEAN | none |
| valid-scored-absence | 0 | INSPECTED_CLEAN | none |
| presence-only-v2 | 0 | INSPECTED_CLEAN | none |
| historic-absence | 10 | INSPECTED_WITH_EXCEPTIONS | LEGACY_ENTRY_ORIGINAL_SEMANTICS_REVIEW 1 |
| partial-approval | 10 | INSPECTED_WITH_EXCEPTIONS | APPROVAL_TRIPLE_INCOMPLETE 1 |
| duplicate-entry | 10 | INSPECTED_WITH_EXCEPTIONS | DUPLICATE_VENDOR_ID_IN_SUBMISSION 2 |
| dangling-reference | 10 | INSPECTED_WITH_EXCEPTIONS | VENDOR_REFERENCE_DANGLING 1 |
| private-keys | 10 | INSPECTED_WITH_EXCEPTIONS | SNAPSHOT_UNKNOWN_CRITERION 1 |
| unknown-root | 11 | UNKNOWN_SCHEMA | ROOT_NO_RECOGNIZED_COLLECTIONS 1 |
| malformed | 11 | UNKNOWN_SCHEMA | INPUT_MALFORMED_JSON 1 |

## Deliberate divergences from the Fable review (unchanged)

1. **Source keys** are emitted as hashes plus the array index, not as raw keys.
2. **No preserved-originals copy** and no option to write one. The untouched input plus its SHA-256 serves as the preservation, and tests check that the bytes, size, mtime and mode are unchanged.
3. **Notion gate** not recorded, because no external services are allowed. Left for a human.
4. **Mapping table draft** not produced, because mapping is excluded from this slice.

## Source facts versus unsupported assumptions

**Encoded as fact** (from MVP code via Sol):

- Session, submission and entry field names.
- `pending` and `approved` statuses, and that reopening deletes the stamp.
- `att` labels, including the `"—"` fallback.
- Stored points 5/3/1/0, written only when `criteriaSnapshot.attendance` is true.
- Food scores stored under the seven dbKeys as `Number(input)`.
- Scored Absent clears food scores.

**Unsupported, so flagged or left uninterpreted rather than assumed:**

1. **Missing `attendance` on a scored entry** whose label is Early, Middle, Late or Absent raises `ATTENDANCE_POINTS_MISSING`. The writer emits points in scored mode, but whether an omission can legitimately happen is not established. Sol should confirm.
2. **The `"—"` placeholder** is flagged as `ATT_PLACEHOLDER_RECORDED` (attendance was not chosen). Whether it is acceptable in historic data is a human decision.
3. **Missing session `status`** is flagged as `SESSION_STATUS_MISSING`. Older MVP versions may not have written one. This is unverified.
4. **Timestamp semantics.**
   - Only integer milliseconds within the Date range are checked.
   - A seconds value (for example `1714560000`) passes, because it cannot be told apart from 1970-era milliseconds without inventing a calendar bound.
   - Whether `approvedAt` is always `Date.now()`, and the clock and timezone of submission `timestamp`, are unverified human semantics.
   - Non-numeric `timestamp` and every `time`, `date`, `activeFrom` and `activeUntil` value are profiled by type only and never parsed.
5. **Legacy entries.** Their `att`, food score and absence meaning is not established. Each one raises `LEGACY_ENTRY_ORIGINAL_SEMANTICS_REVIEW`, legacy Absent entries with food scores are counted, and nothing is upgraded.
6. **Food score range** is unknown. Only finiteness is checked.
7. **Record collections** (`vendors`, `categories`, `reviewers`) are checked only for `deleted` type. Their other field names are not established and are not inspected. `categoryName` and reviewer references are not checked, and category settings are never compared with snapshots.

## Known limitations

1. **Duplicate JSON object keys** are detected and counted, but only the last value survives parsing, so earlier values are not inspected.
2. **Numbers** are parsed as IEEE doubles. Unsafe integers fail integer checks but are never printed.
3. **Object-shaped `vendors`** (sparse arrays) raise an exception but are not walked.
4. **Hashes** are 64-bit truncated, deterministic and unsalted, so they can be confirmed by guessing. Lone surrogates hash as U+FFFD. Reports stay confidential and outside the repo and CI.
5. **BOM:** a UTF-8 BOM is refused rather than stripped.
6. **Memory:** the whole file is held in memory, bounded by `--max-bytes` (hard cap 512 MiB), plus a key-set scan for duplicate keys. Fixture timings are not representative of real exports or the later load target.
7. **Exception list cap:** default 50,000 records. Counts stay complete.
8. **Symlinks:** `O_NOFOLLOW` covers only the final path component.

## What remains (not in this slice)

- An owner-authorised real export, a run on it, and human review and sign-off of the report.
- Sol confirmation of the unsupported items above, then updates to the known sets in `src/audit.mjs`.
- Field-level mapping table, field mapping, importer, restore and rollback rehearsal, pilot runbook, OPS01 telemetry.
- Rules ensuring `reviewerCode` never reaches SaaS identities. The tool only guarantees it never outputs the value.
- Vendor onboarding and recruitment, and any live pilot.
- This is **not** a migration, and the tool does not make any data migration-ready.

## Independent integration verification — Sol, 12 October 2026

Integrated the reviewed offline tool on `feat/saas-milestone-5`. All 70 local tests passed. Ten separately authored synthetic fixtures passed repeated CLI checks for deterministic output, untouched source bytes and no private marker leakage. Three additional legacy attendance probes (numeric, boolean and unknown numeric values) retain source-review exceptions without modern point semantics. The suite also retains recognised v2 scored-mode mismatch and type/range checks.

The Firebase MVP HTML files remain byte-identical to commit `5e26088`. No application, database, deployment, dependency or production change forms part of this slice. Food-score inspection checks stored presence and finite numeric types; it does not certify score completeness, score ranges, totals or migration readiness. No real export has been used.

Remaining M5 work: explicit legacy-to-SaaS mapping, exception acceptance, disposable import/rollback rehearsal, OPS01 monitoring/runbooks and six-partner onboarding/acceptance preparation. Real exports, partner outreach and live pilot activation require separate owner authorization. Remaining Bachs tests are deferred release gates, not passed checks.
