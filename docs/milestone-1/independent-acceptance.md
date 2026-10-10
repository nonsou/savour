# Milestone 1 independent acceptance

Prepared by Sol before implementation review. Use only disposable records in savour-dev. No production or legacy Firebase access.

1. Identity: two signed-in users create distinct businesses with identical labels. Guess IDs through HTTP/database; cross-business selects return no rows, mutations fail, exports fail. Anonymous access cannot list workspace data. Changing user metadata cannot change role.
2. Invitation: wrong email, expired/revoked invite, reuse and role tampering fail. Correct signed-in email joins exactly once. Guest receives only assigned subjects and no reports. Removing membership or location/assignment scope denies the next request with the same session token.
3. Authority: assessor cannot assign, approve, reopen, edit another response or view peer drafts; viewer sees approved reports only; reviewer cannot reopen; admin cannot grant owner. Last owner cannot be removed or demoted.
4. Scoring: [4,5] quality 90. Early 93.3, Middle 80, Late 66.7 combined. Absent quality null; scored attendance zero. Presence mode has no attendance points; off does not penalize absence. Allowed N/A needs reason; disallowed N/A, all N/A and out-of-range/fractional/extra/missing criteria cannot produce misleading totals.
5. Attendance: two assessors do not count attendance twice. Mark absent clears both current quality responses. Restore present cannot resurrect those scores; new submissions required.
6. Integrity: matching retry is idempotent; same retry key with altered data conflicts. Stale version cannot overwrite. Expired collection disallows assessor save. Approve races with save/attendance/assignment changes; one serialization boundary preserves complete immutable inputs.
7. Approval/reopen: missing required response blocks approval. Reviewer can approve in scope; all future writes to approved revision fail. Owner reopens with reason, preserving original snapshot and approval metadata. Default analytics exclude current draft; reapproval counts once. Historical exports retain their values.
8. Reports: dashboard, CSV and PDF match fixed data and revision; redacted exports contain no assessor names in serialized content or document metadata. Leading formula characters and whitespace are escaped in CSV. Unauthenticated/revoked export requests fail.
9. Usability: at 390x844 and desktop, signup/login, onboarding, member invitation, session creation, assessment, review and reports work with keyboard and visible errors. Inputs >=16px, primary touch controls >=44px. Failed save never announces success.
10. Delivery: pinned dependencies, clean build/typecheck/relevant tests, migration replay from empty schema, database advisor review, reviewed branch push, protected preview smoke check. Root legacy file checksums unchanged. No credentials committed. Document limitations honestly; production release is not authorized.

Status: authorized Milestone 1 package ready for founder demonstration. Execution evidence and remaining production gates are recorded in sol-verification.md; guest sign-in, scoped submission, collection closure and preserved approved evidence are complete.
