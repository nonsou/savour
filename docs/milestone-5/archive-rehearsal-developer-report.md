# Local archive rehearsal — developer report

> **LOCAL_ARCHIVE_REHEARSAL_ONLY.** These are synthetic fixtures run in a local PGlite. This is not migration sign-off, not hosted RLS evidence, not backup/restore certification, and does not mean M5 is complete.

Model: Claude Opus 5.5 (`claude-opus-5-5`). Date: 2026-10-12. Follows `fable-archive-review.md` plus the architecture refinements given with the task. Revised after Sol's independent acceptance finding (below).

## Acceptance finding and repair (2026-10-12)

**Finding (Sol).** These steps went undetected:

1. Import `mixed-legacy-v2` into `synthetic-ws-sol`.
2. Run `UPDATE legacy_archive.records SET session_key='synthetic-tampered' WHERE record_kind='session'`.
3. Call `verifyBatch` and re-import.

`verifyBatch` returned `ok=true` and `importBatch` returned `ALREADY_ARCHIVED_UNCHANGED`. The old verifier compared only stored counts, slice-vs-source bytes, slice hashes and a few record columns. It trusted the rest of the stored metadata.

**Repair.** One internal verifier, `verifyAgainstSource`, is now used by post-insert verification, idempotent re-import, rollback and the public `verifyBatch`. It re-derives the full expected archive from the stored `source_bytes`:

- those bytes must match the allowlisted fixture pin;
- the fixture is then re-run through preflight and the strict extractor, and the manifest is rebuilt;
- every stored field is compared against that derivation.

Each table is compared field by field:

- **Batch:** fingerprint, workspace, status, fixture name, mapping version, source bytes, sha and length, preflight format and state, record and exception counts, `manifest_sha256`, and the manifest JSON object itself.
- **Records**, one by one: ordinal, workspace, kind, pointer, `collection_key`, `session_key`, `submission_key`, `entry_index`, value type, byte start and end, raw slice bytes, raw sha, and the jsonb projection. The projection is compared as text, so `4.50` → `4.5` is caught.
- **Exceptions**, one by one: ordinal, workspace, code, level, location, detail (SQL NULL is distinguished from JSON `null`) and resolution.

The verifier returns `{ ok: false, failure }` with a static code: `SOURCE_PIN_MISMATCH`, `BATCH_METADATA_MISMATCH`, `RECORD_MISMATCH` or `EXCEPTION_MISMATCH`. No value is included. On failure, re-import throws `E_EXISTING_BATCH_MISMATCH` and rollback throws `E_BATCH_VERIFY_FAILED` (or `E_ROLLBACK_PRECONDITION_FAILED`), and neither changes any row. The public `verifyBatch` requires a live PGlite instance; transaction handles are used only internally.

**Also fixed.** The CLI now exits 1 with `E_ROLLBACK_REMNANTS` if any archive row remains after its own rollback. Before, it printed a success report with a non-zero `remainingRows`.

**Authority.** The checked-in fixture plus its sha256 pin is the current authority. This is integrity checking against a known source. It is not cryptographic authentication: someone who can change both the fixture file and its pin can change what counts as "expected".

## What was built

`tools/legacy-rehearsal/` is a private ESM package. It uses only Node builtins plus the existing PGlite 0.5.8, imported by relative URL through the `saas/node_modules` symlink. Nothing was installed and no lockfile changed.

| File | Purpose |
|---|---|
| `src/source.mjs` | Strict byte-level JSON scanner. It records the byte range of every value and decodes only object keys. It extracts category/reviewer/vendor/session/submission/entry records as `{pointer, source tuple, byte range}`. It fails closed on duplicate keys, malformed JSON, BOM, invalid UTF-8, trailing bytes, excessive depth and non-object roots |
| `src/fixtures.mjs` | Allowlist of two fixture names, each pinned to sha256, byte length, per-kind counts, preflight state and exception count |
| `src/manifest.mjs` | Runs the read-only preflight (`auditBytes`). Checks that its whole-source sha and inventory match the extraction and the pin, and rejects `UNKNOWN_SCHEMA`. Builds a deterministic manifest and batch fingerprint (workspace + source sha + mapping version; no clock or random) |
| `src/schema.sql` | `legacy_archive.{batches,records,exceptions}`. No typed score, attendance, roster or approval columns. No cascades. CHECKs tie `sha256(source_bytes)` and `sha256(raw_slice)` to their stored hashes. `revoke all from public` |
| `src/db.mjs` | Loads PGlite and opens an in-memory database (or `dataDir` for the disk lifecycle test). Exposes `assertPGlite`. There is no DSN entry point |
| `src/archive.mjs` | `importBatch`: validate manifest → re-derive from pinned bytes → one transaction (batch, records, exceptions) → full source-derived verification → commit. Re-importing an identical batch returns `ALREADY_ARCHIVED_UNCHANGED`, and any drift gives `E_EXISTING_BATCH_MISMATCH`. `verifyBatch` uses the shared verifier. `rollbackBatch` requires workspace + fingerprint + manifest sha, verifies before deleting, deletes exceptions → records → batch, and checks affected counts |
| `src/cli.mjs`, `bin/legacy-rehearsal.mjs` | `rehearse --fixture <name> --workspace synthetic-ws-<a-z0-9>`. Runs import, idempotent re-import, verify and rollback, requires zero remaining rows, and closes the database, all in memory. Prints only codes, counts, hashes and states. Errors are `{status, error: CODE}` |
| `fixtures/mixed-legacy-v2.json` | Byte-identical copy of the preflight fixture (a test asserts this) |
| `fixtures/private-markers-precision.json` | Synthetic. Preflight `pii-bearing.json` markers, made parseable as an approved session, plus a large integer, `-0`, `1E+2`, `4.50`, raw UTF-8 and `\u` escapes, unknown fields, and a scored-absent entry |
| `test/*.test.mjs`, `test/support/*` | 48 tests (below). `deny-network.mjs` is copied from preflight |

The read-only parts are unchanged: preflight's own suite still passes 70/70, and no file outside `tools/legacy-rehearsal` and `docs/milestone-5` was changed.

## Lossless approach

- **Authoritative restore input.** `batches.source_bytes` holds the exact export bytes. Its sha256 must equal the preflight whole-source checksum and the pin.
- **Per-record copies.** Each record stores its original byte slice and sha256(slice). These hashes are computed by the archive importer; preflight provides no per-record checksum, and none is claimed.
- **Payload projection.** `payload` jsonb is parsed by PostgreSQL from the original slice and is non-authoritative. Tests show the effect: `123456789012345678901234567890` survives in jsonb, but `-0` and `1E+2` are normalised there while staying exact in `raw_slice`.
- **No JS re-serialisation.** JS never turns a payload value back into JSON. Structure comes from the scanner; values stay as bytes.

## Test run

```
cd tools/legacy-rehearsal && node --test test/*.test.mjs
ℹ tests 48  ℹ pass 48  ℹ fail 0   (~17 s)
  source.test.mjs 5 · archive.test.mjs 13 · cli.test.mjs 4 · tamper.test.mjs 26
cd tools/legacy-preflight && node --test test/*.test.mjs
ℹ tests 70  ℹ pass 70  ℹ fail 0
```

### Acceptance test cases (rehearsal evidence only)

| # | Test | Covers |
|---|---|---|
| 1 | full fixtures archive exact source bytes… | `source_bytes` equals the fixture bytes. Source sha equals the preflight checksum and the pin. Every slice equals `bytes[start:end]` and its sha matches. Per-kind counts equal the preflight inventory. Exceptions equal the preflight list in order, all `UNRESOLVED_REVIEW_REQUIRED`. Dangling-reference count matches |
| 2 | string scalars, approval metadata… round-trip | Every key of every object record is present in jsonb (unknown keys kept). String values are identical and never coerced (`att` `"5"`/`"4"` strings, blank `approvedBy` `"   "`). `approvedBy` and `approvedAt` are exact. Large integer kept; `-0` and `1E+2` exact in raw only |
| 3 | manifest deterministic | Same inputs give an identical manifest. Workspace changes the fingerprint. No source values in the manifest |
| 4 | idempotent re-import | Returns `ALREADY_ARCHIVED_UNCHANGED`. Row `xmin`s and hashes are unchanged |
| 5 | altered payload / manifest / target | Covers a flipped byte, a duplicate-key payload, an unsealed or resealed count, a swapped fixture, the wrong workspace and an invalid token. All give a static code and zero rows |
| 6 | injected mid-batch failure | Whole batch rolled back. The other batch is unchanged |
| 7 | rollback A preserves B | Workspace-B batches of different and identical sources keep their snapshots (`xmin`, hashes) |
| 8 | rollback refusals | Missing fingerprint, wrong workspace, wrong manifest sha, malformed key, and a self-consistent tampered slice. Nothing is deleted in any case |
| 9 | re-import detects corruption | An edited or deleted exception gives `E_EXISTING_BATCH_MISMATCH` |
| 10 | schema self-contained | Only the 3 archive tables exist. No FK cascades. A fresh PGlite role is denied `select` |
| 11 | only a live local PGlite | Fake object, DSN string and closed instance are all rejected |
| 12 | disk lifecycle | `mkdtemp` under `test/scratch-*`, then close and `rm` in `finally`. The directory is absent after both success and failure |
| 13 | sources untouched | Pins still match. The mixed copy equals the preflight original |
| 14–17 | CLI | Runs from the tool dir and the repo root, so it does not depend on cwd. Output is byte-identical across runs. No fixture key or value appears in output. **Leftover rows after rollback give exit 1 and `E_ROLLBACK_REMNANTS`.** Paths, unknown fixtures, extra options, DSN-like tokens and duplicate flags are refused with codes only. Subprocess runs go through the network/Firebase/Supabase tripwire |
| 18–22 | source scanner | Slice equals the value at its pointer. Precision lexemes are kept. Duplicate keys are refused, including an escaped key that decodes to the same name. 14 malformed or structurally unknown cases. Allowlist refuses paths and prototype names |
| 23 | untouched batches verify | Both fixtures give `ok: true, failure: null` |
| 24–48 | tamper fails closed (25 cases) | See the list below |

The 25 tamper cases fall into five groups:

- **Record source tuple:** Sol's `session_key` case; `collection_key`; `submission_key` → NULL; `entry_index` shifted; `json_pointer` rewritten; `record_kind` and `value_type` relabelled; two ordinals swapped.
- **Record content:** a self-consistent raw slice + hash + range + payload; payload changed alone; payload `4.50` → `4.5`.
- **Records and exceptions removed with counts adjusted to match:** a record deleted with the count lowered; a record deleted with the count and manifest JSON lowered; an exception deleted with the count lowered.
- **Exception fields:** exception code, location, level and detail changed; SQL NULL detail replaced by JSON `null`.
- **Batch metadata:** manifest JSON body; preflight state; mapping version; fixture name swapped to the other allowlisted name; source bytes replaced with a self-consistent sha and length; `manifest_sha256` replaced.

Each case asserts four things:

- the expected `failure` code;
- re-import gives `E_EXISTING_BATCH_MISMATCH`;
- rollback refuses;
- a whole-archive row digest is unchanged after both attempts.

### Production gates (not met, and not attempted)

None of these are evidenced by this slice:

- A real export: shape, size limits, encoding and the preflight run on it.
- Human review and resolution of every archived exception.
- A hosted schema migration, with Supabase role/grant/RLS proof for `anon`, `authenticated` and `service_role`.
- Backup and restore of `source_bytes`, verified on the real target.
- Any operational-table mapping. These are not implemented; see `legacy-mapping.md`. That covers the ID crosswalk, verified identity matching and the report-revision adapter.
- Sign-off by a human owner.

## Limitations

- **Allowlisted fixtures only.** The importer accepts the two allowlisted synthetic fixtures and nothing else. There is no real-export import path yet. Verification depends on the fixture pin; a future real-export path needs its own pinned or signed authority for the expected source.
- **Integrity, not authentication.** The verifier detects any stored row that differs from the pinned source. It does not detect a coordinated change to the fixture file and its pin.
- **Verification cost.** Each verify re-runs preflight and extraction and reads every row of the batch. That is fine for fixtures, but it has not been measured at real-export scale.
- **Nested slices duplicate bytes.** Session ⊃ submission ⊃ entry slices store the same bytes more than once. Records whose shape is not walked (unknown root keys, a non-array `vendors`, a non-object `submissions`) exist only in `source_bytes`, flagged through preflight exceptions.
- **jsonb `payload` is lossy for some numeric lexemes** and reorders keys. Do not use it as a restore source.
- **The fingerprint is defined per workspace token.** Re-importing the same bytes under a different mapping version creates a new batch rather than replacing the old one.
- **Some tampering makes the batch unreachable rather than flagged.** If a batch's own `target_workspace` or `batch_fingerprint` is edited, lookups by the original key return "not found". Rollback then refuses with `E_BATCH_NOT_FOUND` and deletes nothing, but the verifier does not attribute the change.
- **Some strings are refused at import.** PostgreSQL jsonb rejects `\u0000` in strings, so such a source would fail closed at import rather than be archived. This is untested here because no fixture contains it.
- **Synthetic workspace tokens only.** `target_workspace` must match `synthetic-ws-*`. Real workspace uuids are intentionally not supported.
- **Roles are proven only locally.** The role check is a PGlite smoke test, not hosted evidence.
- **Exceptions are derived from preflight.** The expected exception rows come from re-running preflight on the pinned bytes, so they are only as complete as preflight itself.

## Sol independent integration verification — 12 October 2026

The integrated package passed all 48 tests in the actual development repository; the unchanged preflight package passed all 70 regression tests. Five separate synthetic corruption probes altered a source tuple, exception code, manifest body, mapping-version metadata and entry position. Each was rejected by verification, re-import and rollback; unrelated batch evidence and row counts remained intact.

The independent review reproduced a tuple-corruption acceptance gap in the first implementation. Opus repaired verification to re-derive expected metadata, record slices and unresolved exception content from pinned source bytes, rather than trusting stored counts and hashes alone. The final independent probes passed after integration.

The source mapping is documented, and six unassigned pilot slots plus monitoring acceptance backlog are recorded in pilot-preparation.md. Neither document recruits partners or claims operational monitoring is installed. Existing Firebase MVP HTML remains unchanged from 5e26088. No saas application files, hosted schema, billing provider, production or deployment was changed. This is local archive-container evidence only; operational migration, original-report comparison, hosted access and target restore acceptance remain pending.
