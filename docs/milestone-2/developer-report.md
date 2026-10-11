# SAVOUR Milestone 2 — developer report (Claude Code, Opus 5.5)

> **Update after Sol applied migrations 1–3 to savour-dev (real Postgres scripts passed 153+23+82+158 = 416
> assertions; snapshot pin confirmed the 7 hashes).** Those three files are now sealed and pinned. Two final
> local repairs followed: a new, unapplied forward migration `20261010235525_m2_fk_covering_indexes.sql`
> (SHA-256 `b68b800086ea9db7a2f48bec1c565abc69260e6b75643f3ddfaf6e242be25ccd`) adding six non-partial
> covering indexes for the M2 composite foreign keys, and `reviewSignals` no longer reporting an aggregate
> score spread across different N/A patterns (disclosed on the review screen instead). Details in
> `sol-review-findings.md` items 8–9. Local result: 163 tests passed (1 opt-in skip), typecheck, lint and
> isolated build clean.

Status: **implemented and verified locally only.** Nothing was committed, pushed, deployed or applied
to any cloud project. No browser, Auth, cloud or real-Postgres verification has been done by the
developer; those remain Sol's acceptance steps. No production readiness is claimed.

Branch `feat/saas-milestone-2`, working tree on top of `41c9857` (application base `ee1bd87`).

## Migrations (forward only, created with `npx supabase migration new`)

| Order | File | SHA-256 |
| --- | --- | --- |
| applied | `20261010202119_m1_core.sql` | `adb428ade9e34f0ae7bfa0e49f1a4205ee455ce9813b38015a4050002343c205` (unchanged, pinned by test) |
| applied | `20261010224854_guest_read_closes_with_collection.sql` | `b72c274444729514aa39a01bc5fb3959257db1fa4a7721e2fa740c4f7c758e0e` (unchanged, pinned by test) |
| 1 | `20261010230958_m2_session_status_draft.sql` | `4fbe4e2f0a4ad461107c47e2243b581d6c578b62a136e580ed87faf6a3846b0b` (applied by Sol, sealed, pinned) |
| 2 | `20261010230959_m2_directory.sql` | `a65dcfbae0b1a58fba517463ffb2b627641474d94a9b5e4c3630f9fc503eeaf1` (applied by Sol, sealed, pinned) |
| 3 | `20261010231001_m2_session_lifecycle.sql` | `a76c2f8a292a4639fcf82a8512ed98de1d34c8df7f032e64b736017a70d0ff5f` (applied by Sol, sealed, pinned) |
| 4 | `20261010235525_m2_fk_covering_indexes.sql` | `b68b800086ea9db7a2f48bec1c565abc69260e6b75643f3ddfaf6e242be25ccd` (new, not applied) |

Apply in this order. Migration 1 only adds the enum value (it cannot be used in the transaction that
adds it). Fable proposed four migrations; lifecycle and waivers/corrections are combined so
`build_inputs`, `approve_session` and `submit_assessment` are each replaced once. Every replaced M1
function carries a "Diff from m1_core" comment. No extensions, custom operators or unrelated upgrades
(PG 17.11 changelog items do not apply). New tables: RLS on, explicit `SELECT` grants only, no client
writes; new functions: public `SECURITY INVOKER` wrappers over private `SECURITY DEFINER`
implementations with `search_path=''`, execute revoked from `PUBLIC`/`anon` explicitly (PostgreSQL's
global default would otherwise grant `PUBLIC` execute; the replay test caught this during development).

## Transactional SQL scripts for real Postgres (each ROLLS BACK)

| Script | Assertions | Covers |
| --- | --- | --- |
| `saas/supabase/tests/m1_security.sql` | 153 | M1 (unchanged, still passing) |
| `saas/supabase/tests/m1_guest_closure.sql` | 23 | M1 guest closure (unchanged, still passing) |
| `saas/supabase/tests/m2_directory.sql` | 82 | directory, contacts, CSV import |
| `saas/supabase/tests/m2_lifecycle.sql` | 158 | drafts, scope edits, reopen, guests, waivers, corrections, samples, snapshots |
| `saas/supabase/tests/m2_snapshot_pin.sql` | read-only | all snapshot hashes + the 7 baseline QA snapshots; run before and after applying |

`psql "$DB_URL" -v ON_ERROR_STOP=1 -f <script>`. Fixture prefixes: `eeeeeeee-0000-4000-8000-0000000002xx`
(directory), `...3xx` (lifecycle). Locally all run on PGlite via `npm test`.

## Changed paths

New: `saas/supabase/migrations/2026101023095{8,9}_*.sql`, `20261010231001_m2_session_lifecycle.sql`;
`saas/supabase/tests/m2_directory.sql`, `m2_lifecycle.sql`, `m2_snapshot_pin.sql`;
`saas/src/lib/csv-import.ts`; `saas/src/app/w/[ws]/setup/import/page.tsx`, `import-client.tsx`;
`saas/tests/sql/import.test.ts`, `legacy.test.ts`, `m1_legacy_fixture.sql`;
`saas/tests/unit/csv-import.test.ts`, `scoring-m2.test.ts`, `time.test.ts`;
`docs/milestone-2/developer-report.md`.

Modified: `saas/src/lib/scoring.ts`, `report.ts`, `pdf.ts`, `errors.ts`, `labels.ts`;
`saas/src/app/globals.css`; `saas/src/app/w/[ws]/page.tsx`; `setup/page.tsx`, `setup/actions.ts`;
`sessions/actions.ts`, `sessions/page.tsx`, `sessions/new/page.tsx`;
`sessions/[id]/actions.ts`, `data.ts`, `page.tsx`, `manage-panel.tsx`, `review-panel.tsx`,
`assessor-panel.tsx`, `assess/[subject]/page.tsx`, `report/page.tsx`, `report/export/route.ts`;
`templates/page.tsx` (heading), `templates/editor.tsx` (attendance-only hint);
`saas/tests/sql/migration.test.ts`; `saas/eslint.config.mjs` (ignore `.next-verify/**`);
`saas/README.md`; `docs/milestone-2/sol-review-findings.md` (repair checkpoints appended).
Untouched: both applied migrations, root `index.html`/`admin.html`/`review.html`, `AGENTS.md`, PRD
snapshots, running `.next` directories, env files.

## Verification (local)

* `npm test` (final): 13 files, **163 passed**, 1 skipped (opt-in QA PDF writer). Includes migration replay
  from empty, all five SQL scripts, RLS/grant/definer/anon checks over every public table and function,
  applied-migration SHA pins, lock-order invariants, legacy upgrade, import end to end, unit tests.
* `npm run typecheck`, `npm run lint`: clean.
* `NEXT_DIST_DIR=.next-verify npm run build`: succeeded (build guard ran). The build rewrites
  `tsconfig.json` includes for the verify directory; that artefact was reverted.
* Sol's independent repros: `/tmp/savour-m2-directory-repro.mjs` before `false/false/false`, after
  `true/true/true`; `/tmp/savour-m2-expired-guest-repro.mjs` before `false (already_member)`, after
  `true`. Outputs saved under `/tmp/savour-m2-runs/`.

### Baseline snapshot regression

* `tests/sql/legacy.test.ts` part 1 builds four approved M1 snapshots (food scored with N/A and absence,
  restaurant with not-assessed, supplier reopened and reapproved) on an **M1-only schema**, applies the
  M2 migrations, and proves: rows byte-identical (inputs, hash, label, approver), hash still recomputes,
  M2 `redact_inputs` output identical to M1's, `get_session_report` serves the stored snapshot labelled
  `savour-m1.1`, values unchanged (e.g. food 85.0 quality / 71.67 combined), and a post-upgrade
  reapproval of the same evidence stamps `savour-m2.1` with identical numbers.
* Part 2 uses Sol's 7 saved disposable QA snapshots: each hashes to the baseline in
  `qa-snapshot-baseline.json`, M1 and M2 redaction are byte-identical, and `summarizeSession` reproduces
  the recorded quality, combined, attendance, coverage and per-subject values exactly. (Reads `/tmp`
  files; skipped automatically where they are absent; they are not committed.)

## Decisions within the PRD (conservative defaults; Sol overrides applied)

* Waivers never produce a headline: waived subjects stay incomplete, excluded from averages, required
  counts unchanged; fully waived subjects may approve only with every outcome resolved. Reviewer cannot
  waive own work; Owner/Admin can with a reason.
* Collection reopen moves only live, unexpired, session-bound guest grants whose expiry equals the old
  close and which still have an active assignment. Expired/revoked guests need a new invitation; an
  expired membership is replaced (not revived) by a newly accepted invitation, and a narrower scope that
  would drop a submitted response or waiver is refused with `invitation_scope_conflict`.
* Roster removal is soft after opening (evidence kept, disclosed in reports, all paths refuse it); a
  draft has no evidence so removal deletes. Restore is audited with retained-response count and shown to
  reviewers.
* Assignments keep M1 semantics: audited, versioned, Owner/Admin only; a reason is accepted (6-argument
  call used by the UI) but not mandatory in the database, because the M1 5-argument RPC and its tests
  remain. Roster, reviewer and window changes after opening require a reason in the database.
* Legacy `create_session` (create-and-open) remains for compatibility but now refuses sample subjects
  and requires a reviewer; the UI creates drafts.
* Contacts: one per subject, Owner/Admin only (reviewers excluded).
* CSV: header-based; external ID only update key; blank keeps value; archived never restored; duplicate
  names/external IDs within the file mark every occurrence; ambiguous active location names are errors;
  500 rows / 512 KB; names may not contain control characters.
* Lock order documented in the lifecycle migration and README; workspace/membership/directory rows
  locked `FOR NO KEY UPDATE`, guest acceptance takes the session before the workspace.
* `get_setup_progress` reports sample counts separately; activation steps count only real records.

## Known gaps and limits

* **No cloud or browser verification.** Sol must apply the migrations to savour-dev after review, run
  the five SQL scripts and the snapshot pin on real Postgres, run two-connection overlap checks (import
  vs. location/subject edits; concurrent import with one key; guest acceptance vs. roster/directory
  writers), and browser-test owner/admin/reviewer/assessor/guest/viewer flows at 390×844 and desktop.
* PGlite is single-connection: concurrency is verified only as lock/version/plan-hash contracts and
  static lock-order invariants, not as parallel races.
* Dashboard CSV downloads remain unaudited (M1 gap). Notes may contain names (M1 gap).
* Excluded by scope: notifications/inbox, corrective actions, advanced analytics, billing, ownership
  transfer, real Firebase import, restore rehearsal, production MFA enforcement.
* A down-migration is not provided (project policy is forward fixes); the enum value `draft` cannot be
  removed without recreating the type.
