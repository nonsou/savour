# Fable 5.1 Milestone 2 architecture review

**Decision record: SAVOUR M2 architecture (read-only review, no changes made)**

Verdict: M2 fits the existing schema with additive migrations only. Four forward migrations, one formula bump, and roughly a dozen new RPCs. The two applied migrations stay untouched; every replaced function uses CREATE OR REPLACE with a diff comment, as the guest migration did.

## Invariants that must hold throughout M2

- **Evidence lock.** Every new write that touches roster, assignments, reviewers, window, waivers, correction requests, opening or reopening calls `private.lock_session` first and carries an expected `data_version`. Null is rejected.
- **Snapshots never change.** No migration or RPC updates `report_revisions` or any row referenced by a snapshot in a way the snapshot depends on. Snapshot inputs stay self-contained. Test pins the `inputs_hash` of existing QA revisions before and after each M2 RPC.
- **Legacy formula.** Snapshots labelled savour-m1.1 render with m1.1 semantics. The module accepts m1.1 and m2.1, refuses unknown labels visibly, and m2.1 on m1.1-shaped inputs is proven identical by fixture.
- **Denominators are frozen content.** Criteria live in `template_versions` and in snapshots. Categories are a subject directory attribute and never feed template selection, criteria or denominators.
- **Guests read only through the live-collection path.** Contacts and categories never enter guest-visible rows. Anything new a guest can see goes through `is_assigned` and `guest_collection_live`.
- **No client writes, invoker wrappers over private definers, empty search_path, explicit grants.** Default privileges already revoke, so every new private function needs an explicit grant line or it fails at runtime.
- **Sample data never counts.** Dashboard, rollups, dashboard CSV and the activation checklist filter `is_sample = false` in SQL, not in the UI.

## Minimal schema and semantics

| Area | Change | Decision |
| --- | --- | --- |
| Categories | `categories(workspace_id, id, name, archived_at)`, unique on lower(name) per workspace. `subjects.category_id` nullable composite FK. | Pure directory attribute. No link to templates or packs. |
| Subject locations | `subject_locations(workspace_id, subject_id, location_id)`. | Advisory filter for roster building. Does not gate assessment scope; location scope stays on the session. |
| Contacts | `subject_contacts` table, policy owner/admin/reviewer only. | Separate table, not columns on `subjects`, because the subjects policy already exposes rows to guests. Never included in `build_inputs`. |
| CSV import | `subjects.external_id` nullable, unique per workspace. `subject_imports(workspace_id, idempotency_key, payload_hash, status, result)`, unique on key. | Preview RPC is read-only and returns per-row verdicts: create, update by external ID, error, in-file duplicate. Commit locks the workspace row, re-validates all rows, raises on any error so nothing partial writes. Same key and hash returns the stored result. Same key and different hash fails with conflict. A name match without a matching external ID is a row error, never a merge. Cap at 500 rows. |
| Draft sessions | Add enum value `draft` to `session_status` in its own migration. `sessions.opened_at`. | Keep `create_session` unchanged, so M1 assertions stand. Add `create_session_draft` and `open_session`. Opening requires location, template, roster, at least one reviewer, and sets opens_at to now and closes_at from the window. `is_assigned` gains a status not draft check so assessors see nothing before opening. Guest invitations already require open. |
| Post-open edits | `set_reviewer`, `set_roster_subject`, `update_session_window`, each with reason and expected version. | Owner/Admin only. Reason optional in draft, required once opened. opens_at is immutable after opening. Only closes_at moves. UTC instants plus hours make DST a display concern only. |
| Roster removal | `session_subjects.removed_at, removed_by, removal_reason`. | Soft removal, same primary key, so re-adding restores the row and its assessments. Assessments and events stay. Removed subjects leave `build_inputs.subjects` and the approval loop, and appear in a new `removed_subjects` array in inputs for disclosure. `submit_assessment`, `resolve_outcome`, `confirm_na`, guest invitations and `is_assigned` all refuse removed subjects. |
| Collection reopen | `reopen_collection(session, hours, reason, expected)`. `sessions.collection_reopens` counter. | Allowed only from in_review with no current report. An approved session needs `reopen_session` first, then this. Status returns to open, revision untouched. Guest refresh: extend `expires_at` only for guest memberships that are active, bound to this session, and whose expires_at equals the old closes_at. Revoked memberships and removed assignments are never revived. `get_dashboard` under_revision gains status open with revision above one. |
| Waivers | `session_assignments.waived_at, waived_by, waiver_reason`. | Columns on the assignment, so removing the assignment removes the waiver. `set_waiver` needs `can_review`, a reason, a recorded outcome, no submitted assessment, and not the caller's own assignment. Approval rule becomes complete at least one and complete plus waived at least required. All-waived stays blocked. A later submission clears the waiver and audits it. |
| Formula | Snapshot gains per-subject `waived_assessors` and `waivers[]`. `build_inputs` stamps savour-m2.1. | m2.1 treats a missing waived field as zero, so m1.1 snapshots compute identically. A waived subject gets a quality number from the submitted responses, flagged, but counts as incomplete in coverage. Required denominator is never reduced. |
| Corrections | `correction_requests(session_id, subject_id, assessor_id, requested_by, reason, revision, status, resolved_*)`, one open per assignment. | Created by `can_review` only while collection is open. Read policy: reviewer scope or the named assessor while assigned. Resubmission or amendment resolves it. Approval is blocked while any request is open. Completeness, disagreement and spread are pure functions in the scoring module over existing inputs. No schema. |
| Sample | `sessions.is_sample`, `subjects.is_sample`. | `create_sample_session` requires an existing location and published template, creates clearly named sample subjects, assigns the creator as assessor and reviewer. Sample and real subjects cannot mix. No guest invitations on samples. Snapshot inputs carry `session.is_sample` so renderers label it. |
| Checklist | None. | Derived in the server component from existing owner-readable SELECTs, excluding samples. |

Migration order and strategy:

1. `m2_session_status_draft` holds only the ALTER TYPE. A new enum value cannot be used in the transaction that adds it.
2. `m2_directory` adds categories, locations links, contacts, external IDs, imports and their RPCs. Independent of sessions.
3. `m2_session_lifecycle` adds draft, open, edits, soft removal, collection reopen, sample, and the replaced `is_assigned`, `assigned_subject`, `build_inputs`, `approve_session`, `submit_assessment`, `set_assignment`, `create_invitation`, `get_dashboard`.
4. `m2_waivers_corrections` adds waiver columns, correction requests, the approval rule, and the m2.1 snapshot shape.

Each file replays from empty on PGlite with the existing 153 plus 23 assertions, then the new ones. The test suite should pin SHA-256 for both applied files, not just the first. Apply to savour-dev only after review, in order.

Build order: scoring module m2.1 with fixtures first, then directory and import, then lifecycle, then waivers, then corrections, then sample and checklist, then the pack, legacy and mobile regression pass.

## Independent high-risk tests and chosen defaults

Tests that must run on real Postgres, not only PGlite, because they involve locking or concurrency:

- **Legacy render.** Export the three QA snapshots as fixtures. m2.1 code must reproduce the recorded quality, combined and mean values exactly, and the report view must show formula m1.1 for them.
- **Waiver.** Two required, one submitted, one waived: approval succeeds, snapshot shows required two and waived one, coverage counts the subject as incomplete, quality is present and flagged. Assessor and guest calls fail. Unknown outcome fails. All-waived blocks approval.
- **Removal after submission.** Assessment rows and events intact, assessor's next read and save denied, prior snapshot hash unchanged, new snapshot lists the removal.
- **Collection reopen.** Approved to revision reopen to collection reopen. Schedule-expired guest regains access. Revoked guest and removed assignment do not. Direct collection reopen on approved fails.
- **Import atomicity.** Two-connection concurrent commit with the same key yields one import. One bad row yields zero subjects. BOM, quoted newlines, Unicode, duplicate names.
- **Isolation.** Same category names, subject names and external IDs in two workspaces. Guest direct SELECT on contacts returns zero rows.
- **Attendance-only pack.** Approve, PDF and CSV show attendance only with no quality field.

Ambiguities I resolved conservatively, listed so they can be overruled:

- Waived subjects get a flagged quality number rather than no number. Without this, a waiver would never let approval produce a result.
- Guest refresh on collection reopen covers only schedule-expired, still-active guests.
- Roster removal is soft and disclosed in the snapshot rather than silent.
- Correction requests need an open collection and block approval while open.
- Name duplicates in CSV are errors. External ID is the only update key.
- The sample session reuses the real location and template rather than fabricating both.
- Formula bumps to m2.1 at approval time rather than inheriting the template's publish-time label, because the label must describe the calculation applied.

## Sol decisions overriding or clarifying recommendations

- Guest collection reopen must NOT revive any expired guest membership, even if originally schedule-bound. Extend only still-active, still-unexpired session-bound grants with scheduled expiry and surviving assignments; already expired or revoked guests require a new email-bound invitation. This matches the founder-facing acceptance brief. Live scope cannot rely on a stale JWT. Do not alter already-consumed invitation records to renew membership.
- A waiver resolves an approval requirement, not the missing assessment. Keep required counts unchanged. Show available assessor scores in detail, but retain null subject quality/combined headlines and exclude that subject from quality averages while any required response is missing, including waived work. Coverage stays incomplete. No flagged partial headline enters averages. Existing m1.1 semantics and complete-entry scoring stay identical.
- Fully waived assignments may permit approval when every canonical outcome is resolved and every missing response is explicitly waived; the report honestly shows no quality/combined score and missing coverage. Do not invent a mandatory response beyond the PRD. Attendance-only subjects use canonical attendance and no quality requirement.
- Reviewer waiver of their own missing assignment is refused; Owner/Admin can waive their own with explicit reason and visible audit. This avoids an owner-only workspace dead end while preserving reviewer accountability.
- New contacts are private owner/admin metadata by default. If reviewers need contacts, limit them to their active session/location scope, never workspace-wide merely due to role. Contact rows stay out of all report inputs and guest/assessor payloads.
- CSV external ID provides create/update identity. Preview must label updates and show changed fields; confirmation is explicit for those changes. Never auto-restore archived records or bypass optimistic directory concurrency. Enforce locking coordination between import and manual directory mutations, or atomic uniqueness/version guards; a workspace lock only in import does not serialize other writers.
- Legacy snapshots are compared by hash/content and rendered using their original formula. New live inputs may stamp m2.1 for waiver disclosures without changing old template rows. Unknown formula errors are visible, never silently recomputed.
- Draft rollout may retain old create_session RPC for test/backward compatibility only if it validates sample/roster constraints and cannot become a bypass. New UI creates drafts by default; opening validates full scope, at least one reviewer, and collection timing. All snapshot/evidence builders, report access and state labels must consider draft and removed subjects.
- Roster removal keeps assessments/history. Restoration explicitly discloses retained assessments to reviewers; never conceal removal/restoration audit. Every write helper AND read helper checks removed roster rows. is_assigned(session,null) must require at least one active roster assignment, not merely an assignment to a removed row.
- Sample flag is immutable; no sample/real mixing on either old or new creation/assignment RPCs. SQL excludes sample from dashboard counts, under-revision counts and inputs. Client rollups also reject/filter sample input defensively. All sample pages and exports visibly label SAMPLE.
- Existing m1_guest_closure SQL should remain valid except deliberate guest reopen cases tested separately. Report revision reopen alone remains closed. General notification delivery remains deferred; correction requests require an open collection and appear only in authorized assessor/reviewer screens.
