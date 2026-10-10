# Sol independent review — resolved initial findings

All seven initial findings below were fixed by Opus. Sol independently re-ran the location/null-version reproduction and confirmed denial. The complete transactional test passed 153 assertions on the real savour-dev project after applying the reviewed migration. The test transaction rolled back; zero workspaces and zero fixture users remained. The end-to-end application milestone is still under implementation.

## Reproduced against freshly replayed migration in PGlite

Test script /tmp/savour-qa/independent-db.mjs ran successfully through actual RPCs with authenticated role and auth claims (not superuser assertions).

- P1: private.is_assigned only checks role+assignment, not current location scope. After owner changes assessor from Location A to Location B, old Location A session still SELECTs and submit_assessment succeeds with the same identity. Fix helper and all assigned_subject/template paths. Enforce active, nonexpired membership; regular members need current session location; guests need matching guest_session_id and unexpired scope. Reject initial assignments outside location too.
- P1: NULL expected versions bypass <> SQL comparisons. resolve_outcome(...,null) and approve_session(...,null) both succeeded. Use IS DISTINCT FROM or explicit null rejection in every version guard including set_assignment, confirm_na, resolve_outcome, approve_session; add tests.

## Code review findings to verify/fix

- resolve_outcome absent/not_assessed clears answers but leaves notes; current quality feedback must be cleared too, preserving immutable event history. Assessor observed absent currently accepts notes and stores them as quality feedback; treat reason separately or prevent quality notes on absence.
- submit_assessment derives amendment solely from p_assessor != auth.uid(). A reviewer/owner who assessed their own session cannot correct their own score after close/reopen, even with a reason. Support explicitly reasoned reviewer amendments to own scores while in_review, preserving ordinary assessor window rules and audit events.
- Guest invitation auto-assigns all roster subjects with no selection. Support explicit permitted subject IDs in invitation, validate same session/workspace and apply only that scope. UI must disclose and allow selection. Guest role grants one session only.
- subjects_read grants Viewer and Reviewer every workspace subject, ignoring location/session scope. Viewers should receive subjects through authorized approved snapshot/report only. Restrict reviewer directory exposure to permitted sessions if needed; no workspace-wide accidental directory read.
- Require expected readiness time for scored attendance when creating session; it is currently nullable. Preserve that time in approved snapshot so reports show what Early/Middle/Late refers to.

Maintain shared session lock for evidence writes. No cloud mutation by developer. Coordinator applies after fixes and passing local/integration tests.

## Database advisor review

No security error or warning was returned. One informational notice says report_revisions has RLS and no policy; this is intentional deny-all direct access, with no client SELECT grant. Authorized report reads go through redacting RPCs. [Supabase explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).

Performance advisor identified 16 foreign-key covering-index suggestions and a new unused audit index; assess query plans as realistic data grows. Do not remove the audit index based on an empty database. Auth connection allocation is a production sizing consideration. These informational suggestions did not block functional checks. [Index guidance](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys).
