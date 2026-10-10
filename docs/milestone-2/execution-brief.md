# SAVOUR Milestone 2 execution brief

Status: authorized development; architecture and implementation pending.

The founder accepted the Milestone 1 demonstration and explicitly authorized Milestone 2 under the same development-only rules. Local code, tests, feature branches, commits and pushes, protected Preview deployments and disposable development data are permitted until demonstration. Production merges/changes, Firebase MVP changes and new spending require separate approval. Base commit: ee1bd87. Branch: feat/saas-milestone-2. Canonical PRD and SOP remain the private Notion documents.

## Outcome
A business can complete setup and manage a real inspection lifecycle on mobile without rebuilding Milestone 1 features. Preserve the tested scoring, permissions, approval snapshots and reports.

## Remaining inspection scope

1. CFG01: explicit subject category/location links and optional contacts; CSV example, preview, row errors, duplicate detection and atomic idempotent confirmation. Never silently merge by name. Contacts must not become visible to guests through subject SELECT policies.
2. CFG02 and first run: retain all three editable starter packs; publish and preserve versions; short setup checklist and explicitly labelled sample inspection excluded from analytics and activation. Attendance-only categories must work without a fake quality score.
3. SES01/SES02: draft creation and explicit opening; audited Admin/Owner reviewer, roster and collection-time changes. Separate collection reopening from report revision reopening. Multiple same-date sessions, UTC storage and IANA timezone display remain intact.
4. SC02: Reviewer/Owner/Admin may waive required work only with an audit reason. Waived work stays visible as missing coverage; do not inflate coverage or silently remove the required denominator. Unresolved outcomes cannot be waived away.
5. REV01: actionable correction request on the assigned assessment screen; visible completeness, disagreement and score spread. Reviewer amendments retain reasons and optimistic version checks. General notification delivery belongs to a later milestone.
6. Regression: all three customer packs, attendance-only, legacy formulas and immutable snapshots, online failure/retry state, desktop and 390x844 mobile.

## Exclusions
Corrective actions, general notifications/inbox, advanced analytics, billing, ownership transfer, real Firebase import/cutover, backup restore rehearsal and production MFA enforcement remain later work. No production readiness claim.

## Independent acceptance before demonstration

- Identical labels in two workspaces remain isolated through direct SELECT/RPC/export; category/location/contact IDs cannot cross workspace boundaries. Guests cannot read contacts or another subject.
- CSV quoted fields, commas/newlines, Unicode, BOM, blank rows, invalid types, unknown/archived category or location, repeated external IDs and duplicate names give deterministic row feedback. Nothing writes before confirmation. Same confirmed import retried once or concurrently creates one result; changed payload on same key conflicts. Failed import creates no partial rows.
- Archived/restored subjects retain stable IDs and approved labels. Category edits cannot change historical template denominators.
- Draft is not collecting; opening requires valid roster/template/location/reviewer/window and explicit action. Two sessions on one local date coexist. DST gaps/ambiguities and opening/closing order are handled explicitly.
- Roster/window/reviewer amendments require Admin/Owner and a reason after opening. Assessor/guest/viewer cannot alter scope. All changes share the session lock/version. Removing submitted subjects must preserve evidence/audit and never retroactively alter an approved snapshot.
- Collection reopening requires explicit Admin/Owner action and reason, preserves evidence, refreshes intended guest scope without reviving expired/revoked credentials, and does not mutate an approved revision. Revision reopen alone remains in review and grants guests no collection access.
- Waiver cannot be forged by assessor or guest, cannot skip unresolved outcomes, and cannot conceal missing work. Approval admits a resolved reasoned waiver but reports retain the missing response and reduced coverage. Historical snapshots do not reinterpret absent waivers.
- Correction request cannot cross session or assessor scope; revoked members and closed guest collection still fail fresh access/save. Stale edits and approvals reject rather than lose concurrent changes.
- Three packs complete onboarding -> session -> assessment -> review -> approve -> reopen on mobile. Sample reports never count in business totals. Quality/attendance-only/N/A fixtures and old snapshots match prior values.
- Apply only reviewed forward migrations to savour-dev. Empty-schema replay, transactional real Postgres checks, focused tests, lint/typecheck/build and independent browser checks pass. Root MVP bytes remain unchanged. No credentials committed.

## Model execution boundary
Opus 5.5 is the requested developer and Fable 5.1 the architecture adviser. Automatic approval review initially required explicit authorization to process private development code through Claude. The founder subsequently granted that authorization for both models, excluding credentials, environment files and real customer data. Fable read-only architecture review started; Opus implementation follows reviewed decisions.
