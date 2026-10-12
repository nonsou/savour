# Legacy source → archive mapping (mapping version `savour-legacy-archive-map/1`)

**Status: LOCAL_ARCHIVE_REHEARSAL_ONLY.** This maps legacy Firebase export fields to the local archive container in `tools/legacy-rehearsal/src/schema.sql`. Fields are not mapped into operational SaaS tables. Operational targets are named from the SaaS migrations `saas/supabase/migrations/20261010202119_m1_core.sql` and `saas/supabase/migrations/20261010230959_m2_directory.sql`, only to record which mappings are not implemented yet. This is not a hosted migration, not migration sign-off and not RLS evidence.

Field names come from `source-schema-notes.md` and `tools/legacy-preflight/src/audit.mjs`. No customer values appear here.

## Archive container

| Archive table | Holds | Authoritative? |
|---|---|---|
| `legacy_archive.batches` | `source_bytes` (exact whole export, bytea); `source_sha256`, which is checked against the preflight whole-source checksum and the fixture pin; manifest jsonb + `manifest_sha256`; counts; `target_workspace`; `batch_fingerprint` = sha256(domain ‖ workspace ‖ source sha ‖ mapping version) | **Yes.** `source_bytes` is the restore input |
| `legacy_archive.records` | One row per category, reviewer, vendor, session, submission and vendor entry. Each row has a source tuple (`json_pointer`, `collection_key`, `session_key`, `submission_key`, `entry_index`), byte range, `raw_slice` (the original bytes), `raw_sha256`, and `payload` jsonb | `raw_slice` yes. `payload` no (see below) |
| `legacy_archive.exceptions` | Preflight exceptions copied as code, level, hashed location and detail. `resolution` is fixed to `UNRESOLVED_REVIEW_REQUIRED` | Review list only |

Notes on the record columns:

- **Record hashes are computed by the archive importer, not by preflight.** Preflight only supplies the whole-source sha256.
- **`payload` comes from PostgreSQL.** It is `convert_from(raw_slice,'UTF8')::jsonb`, parsed from the original slice. JS never re-serialises a value. jsonb normalises some lexemes (`-0` → `0`, `1E+2` → `100`, key order), so `payload` is a query convenience only.
- **Slices nest.** A session slice contains its submissions, and a submission slice contains its entries.
- **Some data is kept only in `batches.source_bytes`.** This covers unknown root keys, and children of `vendors` when it is not an array.

**Verification.** Every stored batch, record and exception field is checked against values re-derived from the pinned source bytes, not against stored counts or hashes. The fixture allowlist and its sha256 pins are the current authority. This is an integrity check, not cryptographic authentication.

## Field mapping

Legend:

- **Fidelity** gives the rule for each field. `raw` means it is kept only as original bytes inside the record slice. `not recomputed here` means this slice derives no score, total, point or label from it.
- **Operational target — status** names the M1/M2 column a later slice might fill, and what that slice still needs.
- **ID crosswalk pending:** generating new internal record ids (uuids) with a stable, approved source-key → target-id crosswalk is a normal migration strategy for records such as categories, vendors and sessions. It is not implemented in this slice. Any later crosswalk must:
  - keep the original source keys and `vendorId`s;
  - not merge records by name.
- **Verified identity:** ids for *people* (users, assessors, approvers, memberships, rosters) are a different matter. Legacy actor names and keys are not auth identities, so no verified user uuid may be invented for them.

### Root

| Source | Archive | Fidelity | Operational target — status |
|---|---|---|---|
| `categories{key}` | record `category`, `collection_key` | raw; source key kept | `public.categories` — ID crosswalk pending. Keep the source key. Do not merge categories by name, even though `categories_name_uq` (`norm_name`) would collide distinct legacy keys that share a name |
| `reviewers{key}` | record `reviewer` | raw | `memberships` / `session_reviewers` — not mappable from source alone. Reviewer records are not auth identities, so no verified `user_id` may be invented. Needs a human-approved account match |
| `vendors{key}` | record `vendor` | raw; source key kept | `subjects` (+`external_id`) — ID crosswalk pending. The source key must be kept, but the `external_id` constraints (≤64 chars, trimmed, unique case-insensitively) are not yet checked against legacy keys. `subject_type` is not stated in the source |
| `*.deleted` | inside record slice | raw boolean as stored (non-boolean is preflight `DELETED_NOT_BOOLEAN`) | `archived_at` — not implemented. The source has no deletion time; any timestamp would need an approved convention |
| unknown root key | `batches.source_bytes` only | raw | none |

### Session (`sessions{key}`)

| Source | Archive | Fidelity | Operational target — status |
|---|---|---|---|
| key | `session_key`, `json_pointer` | exact string | `sessions.id` — ID crosswalk pending; keep the source key |
| `date` | slice | raw | `sessions.local_date` — not implemented. The MVP writer sets this field, but the format of historical values in a real export is unverified |
| `name`, `notes` | slice | raw | `sessions.name` — not implemented. Also needs `location_id` and `template_version_id` decisions |
| `activeFrom`, `activeUntil` | slice | raw | `opens_at`/`closes_at` — not implemented. Historical value format and clock are unverified, so `closes_at > opens_at` cannot be asserted yet |
| `reviewerCode` | slice (archive only) | raw; **never** output, never copied to identities or invitations | none — permanently excluded from operational mapping |
| `status` | slice | raw string. `pending`/`approved` are established writer values; others are exceptions | `sessions.status` — not implemented. The legacy vocabulary differs from `open/in_review/approved/cancelled`, and the source has no reopen history |
| `approvedBy` | slice | exact string, including blank or whitespace | `report_revisions.approver_name` could keep the text later. `approved_by` (uuid) cannot be filled from a name; it needs a verified identity |
| `approvedAt` | slice | exact numeric lexeme | `report_revisions.approved_at` — not implemented. The current MVP writer uses `Date.now()` ms, but whether every historical value follows that is unverified (see the next section) |
| unknown session fields | slice | raw, review-required (`UNRECOGNIZED_FIELD`) | none |

### Submission (`sessions{k}.submissions{key}`)

| Source | Archive | Fidelity | Operational target — status |
|---|---|---|---|
| key | `submission_key` | exact string | `assessments.assessor_id` — not mappable from source alone. The key is not an auth identity, so no verified user uuid may be invented |
| `taster`, `role` | slice | raw | `assessor_name` could keep the text later. Neither field is a membership or a verified `member_role` |
| `time`, `timestamp` | slice | raw lexeme | `assessment_events.created_at` — not implemented. Historical type and clock are unverified |
| `actions` | slice | raw array | `assessment_events` — not implemented. Action semantics are not established, and events are immutable, so they must not be guessed |
| `vendors` | child `entry` records by `entry_index` | array position is the only identity; duplicates not merged | — |

### Vendor entry (`...vendors[i]`)

| Source | Archive | Fidelity | Operational target — status |
|---|---|---|---|
| `vendorId` | slice + (`session_key`,`submission_key`,`entry_index`) | exact string; dangling refs stay `VENDOR_REFERENCE_DANGLING` | `session_subjects.subject_id` — needs the vendor ID crosswalk. Roster rows must come only from entries actually present, never be invented |
| `vendorName`, `businessName`, `categoryName` | slice | raw text as stored | `session_subjects.subject_name` — not implemented; kept as stored, no name merge |
| `att` | slice | **exact text label**, including `—` and non-string values; never coerced to number | `observed_attendance` / `outcome` — not implemented. The label→enum mapping differs by mode and is unverified for legacy entries |
| `attendance` | slice | raw numeric lexeme; never derived from `att` or vice versa | not implemented — see report revisions below |
| `assessmentVersion`, `criteriaSnapshot` | slice | raw; unknown criteria kept | `template_versions` — not implemented. No historic template version exists in the source, and **current category settings must not be re-applied** to old entries |
| `taste` … `safety` | slice | raw numeric lexeme; range unverified | `assessments.answers` — not implemented. SaaS criteria are integer 1..5, and some legacy values (e.g. `4.8125`, `"4"`) do not fit without an approved rule |
| `notice`, `absenceReason` | slice | raw | `assessments.absence_reason` — not implemented |
| `sample`, `cust`, `obs`, `fu`, `pi` | slice | raw | `assessments.notes` — not implemented; semantics and format not established |
| unknown entry fields (e.g. `total`, precision probes) | slice | raw, review-required; **not interpreted**, even if they look like score fields | none |

## Report revisions (approved results)

The `report_revisions` mapping is **not implemented**. This slice does not know the original totals or the formula that produced them, and it does not run the current SaaS formula over legacy values. A later legacy adapter could keep the original semantics, for example by recording the legacy inputs with a legacy formula identifier. That design and its approval belong to a later slice. Nothing here claims that future migration must recalculate legacy scores with the current formula, or that migration is impossible.

## Historical data versus writer facts

Facts about the MVP writer are established. Examples: the `att` labels, `attendance` points 5/3/1/0, `assessmentVersion` 2, `criteriaSnapshot`, and `approvedAt = Date.now()` in the current writer. The open question is whether historical records in a real export all followed those writers. Older code paths, manual edits and units are unverified until a real export is inspected.

## Not implemented in this slice (summary)

This slice writes, references or creates no rows in `workspaces`, `memberships`, `locations`, `subjects`, `categories`, `templates`, `template_versions`, `sessions`, `session_reviewers`, `session_subjects`, `session_assignments`, `assessments`, `assessment_events`, `report_revisions`, `invitations`, `audit_events` or `subject_*`. Outstanding work:

1. **Approved source-to-target ID crosswalk** for categories, vendors and sessions. It must keep source keys and `vendorId`s and must not merge by name.
2. **Verified identity matching for people** (reviewers, tasters, approvers). Without it, `user_id`, `assessor_id` and `approved_by` stay empty and are never invented.
3. **A legacy template/formula representation** that keeps historic snapshots without re-applying current settings.
4. **Report-revision adapter design** (see above).
5. **Conventions for historical dates, clocks and attendance labels**, confirmed against a real export.
6. **Human review of the preflight exceptions.** Archiving an exception does not resolve it.

## Privileges (intended, not proven here)

The schema is `legacy_archive`, which runs `revoke all ... from public`. It has no grants, views, functions, API exposure or RLS policies. A PGlite test checks that a fresh role cannot select from `legacy_archive.records`. That is only a local smoke check. Hosted Supabase roles (`anon`, `authenticated`, `service_role`) and RLS have **not** been tested and must be proven on the real target before any hosted use.
