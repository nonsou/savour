Nothing was written or changed. Here is the decision record.

**Model identity:** Claude Fable 5.1, model ID `claude-fable-5-1`, read-only review of branch feat/saas-milestone-3 at b76b400. Read: the M3 brief, all six sealed migrations, the scoring/report/CSV/PDF helpers, the migration, legacy and scoring tests, the M1/M2 architecture, review, verification and developer records. Not read: any env, Vercel, auth state or data files.

# SAVOUR M3 architecture decision record

**Verdict.** M3 fits additively. Five forward migrations, one formula label bump to `savour-m3.1` with identical arithmetic, about fourteen new RPCs, and six replaced functions using CREATE OR REPLACE with diff comments as M2 did. The six sealed migrations stay byte-identical and pinned.

**Facts from inspection that shape the design**

- Snapshots carry no category and no location ID. The session block stores only the location name, and M2 made categories a pure directory attribute. Truthful category analytics therefore needs a stamp from the next approval onward, and legacy snapshots must fall into a "not recorded" bucket.
- The criteria validator rebuilds each criterion from a fixed key list, so any `critical` or trigger field a client sends today is silently dropped. Triggers need a replaced validator.
- No scheduler extension is referenced anywhere in the repo. Nothing exists to reuse for reminders.
- The session lock helper requires only an active membership, so an assignee can take the same evidence lock as reviewers.
- The dashboard RPC returns every approved snapshot unfiltered. Analytics needs its own filtered RPC rather than a wider dashboard payload.
- The lock-order test forbids FOR UPDATE on workspace, membership and directory rows. New action and finding rows must use FOR NO KEY UPDATE after the session lock so that test stays true and FK inserts never block.

**Minimal additive schema** (text plus CHECK for states, as `correction_requests` does; no new enums)

| Object | Columns and constraints | Notes |
| --- | --- | --- |
| `template_versions.settings jsonb not null default '{}'` | `repeat_window` 1..6, default 3 | Column add only; immutability trigger untouched. Validated by a new helper. |
| criteria entries | optional `critical boolean`, `trigger_at_or_below int 1..4` | Preserved by the replaced validator; old versions have neither. |
| `findings` | id, workspace_id, session_id, subject_id, revision, kind `generated/manual`, criterion_key null for manual, severity `critical/high/medium/low`, title, detail jsonb, created_by, created_at, withdrawn_at, withdraw_reason, version | Composite FK to `session_subjects`. Partial unique on (session_id, subject_id, criterion_key) where kind = generated. Detail holds `min_score`, `trigger`, `assessors_below`, `assessors_total`, never assessor IDs. |
| `actions` | id, workspace_id, finding_id, session_id, subject_id, location_id, issue, severity, assignee_id, due_date date, action_required, status `open/in_progress/ready_for_verification/closed/cancelled`, resolution_evidence, resolved_by, resolved_at, verified_by, verified_at, cancel_reason, reopen_count, version, created_by, created_at, updated_at | Composite FKs to findings, session_subjects, locations, memberships(workspace_id,user_id). Location is copied from the session row by the RPC, never accepted from the client. |
| `action_events` | id, workspace_id, action_id, kind, from_status, to_status, before jsonb, after jsonb, actor_id, reason, idempotency_key, payload_hash, created_at | Insert-only trigger. Unique (actor_id, idempotency_key), same pattern as assessment events. |
| `notifications` | id, workspace_id, recipient_id, kind, action_id, session_id, correction_id, dedupe_key, payload jsonb, created_at, read_at | Unique (workspace_id, recipient_id, dedupe_key). RLS on with no SELECT policy; read only through the inbox RPC. |
| indexes | every composite FK gets a non-partial covering index; plus actions (assignee_id, status), (workspace_id, status, due_date); findings (session_id, subject_id); notifications (recipient_id, created_at desc) | Avoids the advisor finding M2 had to fix afterwards. |

Keep-workspace triggers on all four tables. Sample sessions refuse findings and actions with `sample_not_allowed`, which keeps every exclusion rule unchanged.

**RPCs and live permission boundaries** (public invoker wrapper over private definer, empty search_path, explicit grants, every write audits in the same transaction)

| RPC | Who | Live checks |
| --- | --- | --- |
| `publish_template` 7-arg overload with settings | Owner/Admin | 6-arg M1 signature kept, delegates with null settings. |
| `create_finding` | `can_review(session)` | Session open, in_review or approved; active roster subject; not sample; idempotency key. |
| `withdraw_finding` | `can_review` | Reason, expected version. Refused while a non-cancelled action links to it. |
| `create_action` | `can_review` | Finding in same session; assignee active staff holding the session location via `user_in_location`; guests refused; due date required; idempotency key. |
| `update_action` fields and reassignment | `can_review` | Expected version; before/after in event; reassignment invalidates old assignee notifications by live recheck. |
| `progress_action` to in_progress, to ready_for_verification | assignee or `can_review` | Assignee path requires assignee_id = uid, active unexpired membership, still holds location, else `not_assigned`. Ready requires non-empty evidence text and records resolved_by. |
| `return_action` ready back to in_progress | `can_review` | Reason required. |
| `verify_action` ready to closed | `can_review` | See self-verification below. |
| `cancel_action`, `reopen_action` | `can_review` | Reason required; reopen only from closed or cancelled, increments reopen_count. |
| `get_actions` | Owner/Admin all; Reviewer sessions in `can_review`; Assessor only own assigned actions; Viewer and Guest `forbidden` | Derived flags: due state, assignee_out_of_scope. |
| `get_analytics(p_ws, p_mode, p_filters, p_purpose)` | Owner/Admin/Reviewer/Viewer; Assessor and Guest forbidden | Approved mode: `can_review or viewer_can_see`, current revisions, `not is_sample` in SQL, inputs always redacted. Provisional mode: `can_review` only, Viewer forbidden. CSV purpose audits. |
| `get_inbox`, `mark_notification_read` | recipient only, active membership | Each row rechecks access before exposing payload or link. |

RLS SELECT policies: findings and actions readable by `can_review(session_id)` or the live assignee; action_events same as actions; notifications none. Viewers never read these tables and get redacted action data only through the report RPC.

**Locking, version and idempotency.** Every finding and action write first calls the existing session lock helper, then locks the action row FOR NO KEY UPDATE. Lock order appended as step 6 after the five documented steps. Rationale: approval reads action state under the session lock, so an action is either frozen in the snapshot or created strictly after `approved_at`, which makes the appendix truthful. Every update carries an expected version; null rejected with `stale_version`. Create and every transition carry an idempotency key; same key and hash replays the original receipt, same key and different hash fails `idempotency_conflict`, and an unauthorized caller fails before any replay lookup, exactly as submissions do today.

**Self-verification.** Verification is refused with `own_verification_forbidden` when the caller is the assignee or the `resolved_by` actor, unless the caller is Owner or Admin and supplies a non-empty override reason, which is recorded in the event and audited as `action.self_verified`. A Reviewer has no override. This lets an owner-only workspace finish the demo while keeping reviewer accountability.

# Reports, analytics, triggers and inbox

**Frozen snapshot versus live appendix.** The replaced inputs builder stamps `savour-m3.1` and adds disclosure only: top-level `actions[]` with action_id, subject_id, finding_id, severity, status, due_date, issue, assignee_id, assignee_label, created_at, updated_at; per subject `category_id`, `category_name`, `subject_type`; session `location_id`; template `pack`. Arithmetic unchanged. Redaction gains a guarded branch that strips assignee_id and assignee_label only when the `actions` key exists, so every m1.1 and m2.1 snapshot redacts byte-identically. The report RPC returns a new `actions_appendix` block with `as_of` server time and the live actions for the session, each flagged `created_after_snapshot` and `changed_since_snapshot` against the revision being viewed, redacted under the same flag as the body. Meta gains `actions_snapshot: frozen | not_recorded`; legacy revisions show "no action state was frozen at this approval" and never list later actions as evidence. PDF and CSV add two sections, "Actions at approval" and "Current actions as of", both built from the envelope through the existing cell writer, so formula-injection defence applies unchanged.

**Historical categorization semantics.** Grouping uses only what the snapshot says. Category comparisons group by the stamped `category_id` and display the stamped name, with "now called X" or "archived" added from the live directory purely as annotation. Legacy snapshots group under "Not recorded at approval". Subject history keys on `subject_id`, shows the approval-time name and annotates the current name. Pack for legacy snapshots is joined from the template row, which no RPC ever changes. Location filter uses `sessions.location_id`, immutable after opening.

**Reproducible like-for-like analytics.** A new pure module beside the scoring module takes the RPC output and reuses `summarizeSession` per snapshot. The unit is the subject-session with equal weight. A comparability key is template_version_id plus the sorted applicable criterion set; quality means never cross keys, and every row shows n, scored, incomplete, mixed N/A, absent, not assessed, unknown, waived and missing counts. Timelines mark version breaks. Attendance appears only where the snapshot's mode is not off. Null means "No data", never zero. Provisional mode is a separate RPC call whose records carry `mode = provisional`; the aggregator throws if it receives mixed modes, so blending is impossible rather than discouraged.

Flag rules, each returned with its rule text and source session or action IDs:

- Quality decline: six or more scored subject-sessions under one comparability key, ordered by local_date then approved_at; mean of latest three minus mean of preceding three at or below minus ten points. Fewer than six returns "Insufficient data" with the count.
- Attendance: late or absent in at least two of the last three subject-sessions whose template had attendance enabled; fewer than three is insufficient.
- Open critical finding: a non-withdrawn critical finding with no closed action linked. Derived, no status column to keep in sync.
- Overdue action: status open or in_progress and due_date before today in the workspace timezone, computed by one SQL function shared with the inbox.

Viewer sees the snapshot-derived flags only; finding and action flags need `can_review`.

**Template critical triggers.** Generated at approval inside the replaced approval function, under the session lock, from the frozen evidence: for each active, assessable subject and each criterion with a trigger, one finding when any complete submitted score is at or below the trigger. Severity is critical when the criterion is critical, otherwise high. A critical criterion with no explicit trigger defaults to 2. On reapproval the generated finding keeps its row, updates revision and detail, and is withdrawn with reason "not triggered in revision N" only if no action links to it. Repeat tag: the same subject and criterion generated a finding in any of the previous `repeat_window` approved sessions of the same template. Triggers never touch averages, and no screen or export may word a finding as certification or a penalty.

**Durable inbox and due reminders.** Notification kinds: correction_requested to the named assessor, action_assigned, action_ready to session reviewers and creator, action_verified or returned to the assignee, action_due_today and action_overdue to the assignee and creator, session_approved to session reviewers and creator excluding the actor. Each insert uses `on conflict do nothing` on the dedupe key, which for due reminders is action_id, kind and the workspace-local date, so retries and due-date changes cannot duplicate. Minimal durable approach: the inbox RPC first runs an idempotent sync of due reminders for the caller's own actions, then returns rows. No scheduler, no spending, no outbound message; a later pg_cron call to a workspace-wide sync is additive. Stale rows remain in the inbox as kind plus `stale: true` with no payload or link when the live recheck fails.

# Acceptance tests and implementation order

Critical and high-risk tests, all on real Postgres and rolled back where transactional:

1. Two workspaces with identical labels: cross-workspace `get_actions`, `create_action`, `progress_action`, `get_analytics`, `get_inbox` and report exports return no rows or `not_found`; forged finding, session, subject or location IDs fail; location in the action row always equals the session's.
2. Assessor reads only their own action and its finding; Reviewer reads only sessions where assigned; Viewer gets `forbidden` from actions, inbox and provisional analytics, and redacted appendices with no assignee fields; Guest gets `forbidden` from every new module and zero rows from every new table.
3. Revoke the assignee mid-flow: next progress fails `not_assigned`; next inbox read returns the entry as stale with no payload. Remove the reviewer's location: verify fails `forbidden`.
4. Workflow: create, assign, progress, evidence, verify, close, reopen, cancel succeed in order; skipping states, missing evidence, missing reasons, stale version and same key with changed payload all fail with their codes; same key and payload replays the identical receipt.
5. Self-verification: Reviewer who resolved fails `own_verification_forbidden`; Owner without override reason fails; Owner with reason succeeds and the audit row records it.
6. Snapshot integrity: pin all twelve existing snapshots plus the seven baselines before and after each M3 migration and after every action transition; new approval freezes `actions[]`; reopen and reapprove leaves revision one's actions untouched; appendix shows the later action as created after the snapshot; legacy revision shows `not_recorded`.
7. Legacy render: m3.1 on m2.1 and m1.1 shaped inputs computes identically; redaction byte-identical for inputs without `actions`; unknown label still refused.
8. Analytics fixtures across all three packs: six comparable sessions trigger the decline flag at exactly minus ten; five give insufficient; a version change splits the key; differing N/A sets never average together; waiver, absence, unknown and attendance-off counted and labelled; sample excluded even when forced through a direct filter; provisional records mixed into approved throw; category rename and archive change nothing in historical rows; tables, CSV and PDF reconcile to the same numbers.
9. Triggers: critical score 2 generates a critical finding, a 3 on a trigger-3 criterion generates high, old template versions generate nothing, reapproval deduplicates on the same row, and withdrawal is blocked while an action links.
10. Inbox: due-date change and repeated sync insert one row per local date; mark read by a non-recipient fails; approval notifies reviewers once.
11. Two-connection races by Sol: concurrent `progress_action` and `verify_action` on one action yield one winner and one `stale_version`; concurrent `create_action` and `approve_session` yield either the action inside `actions[]` with created_at at or before approved_at, or outside it with created_at after. M2 import and invite overlaps stay listed as regression follow-ups, not live coverage.
12. Standard gate: empty replay, SHA pins for all six sealed files, RLS and grant sweep including the new tables and functions, advisor with zero unindexed FKs, typecheck, lint, isolated build, 390x844 and desktop, Preview, root MVP bytes unchanged, publishable key only.

Implementation order for Opus after Sol's decision review:

1. Migration `m3_template_triggers`: replaced validator, settings column, publish overload. Unit tests for criteria shape.
2. Scoring module: add m3.1 to known formulas, optional criterion fields, action and category types; extend legacy test to prove identity.
3. Migration `m3_inbox_core`: notifications table, notify helper, inbox and mark-read RPCs, replaced `request_correction` with a notify call.
4. Migration `m3_findings_actions`: tables, helpers, RPCs, RLS, grants, lock step 6; SQL script `m3_actions.sql`.
5. Migration `m3_report_actions_snapshot`: replaced inputs builder, redaction, approval with finding generation and approval notifications, report RPC appendix; extend snapshot pin to twelve.
6. Migration `m3_analytics`: analytics RPC and indexes; analytics TypeScript module with fixtures; analytics page and CSV route.
7. UI: actions list and detail, report appendix, PDF and CSV sections, inbox, mobile pass.
8. Sol: migration review and application in order, real Postgres scripts, two-connection races, Preview, founder demonstration.

Reviewable defaults I chose: samples refuse actions; a critical criterion defaults its trigger to 2; the workflow is strictly linear with no state skipping; due reminders go to assignee and creator only; analytics inputs are always redacted for every role.
