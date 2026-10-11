# SAVOUR SaaS — Milestones 1 and 2

Multi-business inspection app: private workspaces and roles, versioned templates, sessions with
assessor assignments, scoring with optional attendance, review/approve/reopen, and consistent
reports (dashboard, PDF, CSV). Milestone 2 adds the subject directory (categories, location links,
private contacts, CSV import), a setup checklist and labelled sample inspection, draft sessions with
explicit opening, audited roster/reviewer/window changes, explicit collection reopening, reasoned
waivers, correction requests and review signals. Lives entirely in `saas/`; the legacy Firebase MVP
(root HTML files) is untouched.

## Setup

Requirements: Node 22.12+ (tested on 24), npm 11.

```bash
cd saas
npm ci
cp .env.example .env.local   # or `vercel env pull`; public values only
npm run dev                  # http://localhost:3000
```

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable (client) key. **No service-role or secret key is used anywhere.** |
| `SITE_URL` (optional, recommended when deployed) | Origin used in copied invitation links instead of request headers |

Supabase Auth settings (dashboard): add `<origin>/auth/callback` to the redirect allow-list for each
environment (local and preview). Email confirmation should stay on. To let users type the emailed
code instead of clicking the link, add `{{ .Token }}` to the magic-link email template.

### Database

Migrations, in order (applied ones must never be edited; add forward fixes with
`npx supabase migration new <name>`):

| File | Status |
| --- | --- |
| `20261010202119_m1_core.sql` | applied to savour-dev (SHA-256 pinned by the test suite) |
| `20261010224854_guest_read_closes_with_collection.sql` | applied to savour-dev (SHA-256 pinned) |
| `20261010230958_m2_session_status_draft.sql` | Milestone 2, not yet applied (enum value only) |
| `20261010230959_m2_directory.sql` | Milestone 2, not yet applied |
| `20261010231001_m2_session_lifecycle.sql` | Milestone 2, not yet applied |

Transactional SQL checks. Each runs as the database owner, creates disposable fixture users and
tenants, switches to `authenticated` with JWT claims as PostgREST does, and **rolls back**:

```bash
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m1_security.sql       # 153 assertions
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m1_guest_closure.sql  # 23
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m2_directory.sql      # 82 (directory, contacts, import)
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m2_lifecycle.sql      # 158 (drafts, scope, reopen, waivers, corrections, samples)
psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m2_snapshot_pin.sql   # read-only: approved snapshots unchanged
```

### Checks

```bash
npm run typecheck   # tsc (TypeScript 6.0.3; typescript-eslint does not support TS 7 yet)
npm run lint
npm test            # unit tests, migration replay, all SQL scripts, legacy-snapshot upgrade and import e2e on PGlite
NEXT_DIST_DIR=.next-verify npx next build   # production build without touching a running dev server's .next
QA_SAMPLE_PDF=/tmp/savour-qa/sample-report.pdf npx vitest run tests/qa   # disposable sample PDF via buildPdf
```

## Production build guard (fail closed)

The SaaS must not reach Vercel Production until the owner separately approves a production release.
`scripts/build-guard.mjs` enforces this in two layers:

1. `npm run build` runs the guard (`node scripts/build-guard.mjs && next build`) before Next.js starts.
2. `next.config.ts` runs the same check during the production-build phase, so a direct `next build`
   (for example an overridden Vercel Build Command) is refused too. `next dev` is unaffected.

| Environment | Result |
| --- | --- |
| Local (no `VERCEL*` variables), or `VERCEL_ENV=development` off Vercel | allowed |
| Vercel with `VERCEL_ENV=preview` | allowed |
| `VERCEL_ENV=production` or `VERCEL_TARGET_ENV=production` (any casing, on or off Vercel) | **refused, exit 1** |
| On Vercel with a missing, `development` or unrecognised `VERCEL_ENV` | **refused** |

Tests: `tests/unit/build-guard.test.ts` spawns the real script and the real `npm run build` with a
production environment (it stops at the guard), and checks the `next.config` layer. Removing the
guard later requires the owner's production approval.

Platform blocker (10 October 2026): the project's first Vercel deployment auto-targeted Production
even with `--target preview`. Sol deleted both deployments; the project has zero deployments, and no
further cloud deployment will happen until the owner approves a protected placeholder. The guard
means a repeat of that mistargeting fails the build instead of serving the app on Production.

## Architecture

Milestone 1 foundations below; Milestone 2 additions follow.

* **Next.js 16 App Router** (`src/app`). `src/proxy.ts` refreshes the Supabase session cookie
  (`getClaims`). Pages, server actions and route handlers authorize with `auth.getUser()` and a live
  `workspace_context` RPC (role, locations, assurance level) on every request; the URL workspace ID
  never grants access by itself.
* **Database is the authority.** Clients get `SELECT` only, filtered by RLS on every exposed table.
  Every write is a named RPC: a public `SECURITY INVOKER` wrapper over a `private` `SECURITY DEFINER`
  function (`search_path=''`, no `PUBLIC`/`anon` execute) that resolves `auth.uid()` to an active,
  unexpired membership with the right role and location/assignment scope. Child tables use composite
  `(workspace_id, …)` foreign keys; the workspace key cannot change (trigger).
* **One lock for evidence.** Submissions, assignments, outcomes, N/A confirmation, close, approve,
  reopen and cancel all lock the session row. Every edit carries an expected version (null is rejected).
  Submissions need an idempotency key: an identical retry returns the original receipt, while the same
  key with a different payload returns a conflict.
* **Approval** validates every outcome, required response and N/A confirmation, then inserts an
  immutable `report_revisions` snapshot of the exact inputs (with actor, name snapshot, timestamp, hash
  and formula version) and points `sessions.current_report_id` at it. **Reopen** (Owner/Admin, reason
  required) increments the revision and clears the pointer, so the old snapshot stays intact and the
  session leaves analytics until reapproved. Reapproval adds a new snapshot, which counts once.
* **Reports.** `get_session_report` / `get_dashboard` authorize server-side and redact assessor
  identities in SQL (always for Viewers). Guests and assessors get no reports. `src/lib/scoring.ts` is
  the single calculation module used by the UI, dashboard, PDF (`src/lib/pdf.ts`, embedded Noto Sans)
  and CSV (`src/lib/csv.ts`, formula-injection safe). Exports are `private, no-store` and audited.
* **Scoring (formula `savour-m1.1`).** Criteria are integers 1–5 with equal weight. N/A needs a permitted
  criterion, a reason and reviewer confirmation. All N/A means Not assessed. Attendance is off,
  presence (no points) or scored (Early 5, Middle 3, Late 1, Absent 0, counted once per
  subject-session from the reviewer's canonical outcome). Absence clears current scores and feedback;
  quality and combined are null. Multiple assessors are averaged first, then attendance is added once.
  Subjects with missing responses or mixed N/A patterns get no headline score and are excluded from
  totals.

### Milestone 2 additions

* **Directory.** Categories are a pure directory label (never linked to templates or scores).
  Subject–location links are advisory (they help build rosters; assessment scope stays on the session).
  Contacts live in `subject_contacts`, readable by Owner/Admin only, never in report inputs, guest or
  assessor rows; `subjects.category_id/external_id/version` are not client-readable (column grant) and
  come from `get_subject_directory`. Names must be unique; external IDs are unique per workspace,
  case-insensitive.
* **CSV import.** The server parses the file (`src/lib/csv-import.ts`), then
  `preview_subject_import` validates every row in SQL and writes nothing. `commit_subject_import`
  takes the directory lock, re-plans the rows, refuses any row error (nothing partial), refuses a plan
  different from the one previewed (`stale_preview`), and records the idempotency key and payload
  hash in the same transaction: the same key and file returns the identical receipt; the same key with a
  different file conflicts. External ID is the only update key; a name match without it is an error,
  never a merge; archived subjects are never restored; blank cells keep current values; duplicate
  active location names are reported as ambiguous.
* **Session lifecycle.** New sessions are drafts (invisible to assessors and guests, no evidence).
  `open_session` validates scope (roster, archived subjects, assessors in scope, at least one reviewer,
  ready time) and starts collection now. Collecting means status `open` and
  `opens_at <= now() < closes_at`; windows are UTC instants plus whole hours, so daylight saving is
  display-only. After opening, roster/reviewer/window changes need Owner/Admin and a reason, share the
  session lock and version, and are audited. Roster removal is soft: evidence and history stay, the
  subject leaves inputs and every assessor/guest path, and reports disclose it; restoring is audited
  with the retained-response count. `reopen_collection` (Owner/Admin, reason) is separate from report
  revision reopening and never touches approved snapshots; it moves only still-live guest grants, never
  expired or revoked ones (they need a fresh invitation, which `accept_invitation` now accepts).
* **Waivers and corrections.** A waiver excuses a missing response for approval only: required counts
  stay, the subject has no quality/combined headline and coverage stays incomplete in every output.
  Unknown outcomes cannot be waived; reviewers cannot waive their own work (Owner/Admin can, with a
  reason). Correction requests need live collection, appear only to reviewers in scope and the named
  assessor on their assessment page, resolve on resubmission or amendment, and block approval while
  open. General notifications are not part of Milestone 2.
* **Formula `savour-m2.1`.** New approvals stamp m2.1: identical arithmetic to m1.1 plus disclosure
  fields (waivers, removed subjects, sample flag). m1.1 snapshots are never rewritten, render with their
  own label, redact byte-identically; unknown labels are refused visibly.
* **Samples.** `create_sample_session` creates a SAMPLE session with two pack-appropriate SAMPLE
  subjects; the sample flag is immutable; sample and real subjects never mix; samples take no guests;
  dashboards, rollups and setup progress exclude them in SQL and again in the client rollup.
* **Lock order.** invitation → session (`FOR UPDATE`, the evidence lock) → directory advisory lock →
  workspace (`FOR NO KEY UPDATE`) → membership/subject/category/contact rows (`FOR NO KEY UPDATE`).
  `FOR NO KEY UPDATE` does not block foreign-key inserts (`FOR KEY SHARE`).

## Recovery

* **Wrong approval:** an Owner/Admin reopens it with a reason. Revision history is preserved and the
  session must be reapproved.
* **Lost or leaked invitation link:** revoke it on Team and create a new one (links are single-use,
  email-bound and expire after 7 days; only a hash is stored).
* **Member should lose access:** remove them or change their locations on Team. This takes effect
  on their next request, including open pages.
* **Schema problem:** write a forward-fix migration (`npx supabase migration new`). Do not edit applied
  migrations. Data restore relies on Supabase project backups (a restore rehearsal is not yet done).
* **Stale-save conflict:** the form keeps the entries; reload, then re-enter against the latest version.

## Known gaps (Milestone 2, local verification only)

* Nothing in Milestone 2 has been applied to savour-dev or browser-tested. Migrations, real-Postgres
  runs of the SQL scripts, two-connection overlap checks and 390×844/desktop browser checks are the
  coordinator's next steps. Local SQL runs on PGlite are sequential and do not prove parallel behaviour.
* The legacy 5-argument `set_assignment` and `create_session` RPCs remain for compatibility; the UI
  uses the draft flow and the reasoned 6-argument assignment call. Assignment changes are audited but
  a reason is not mandatory in the database (M1 semantics; roster, reviewer and window changes do
  require one after opening).
* Contacts: one optional contact per subject, Owner/Admin only. Reviewers do not see contacts.
* CSV import: up to 500 rows / 512 KB per file; it cannot clear an existing value (blank keeps it) or
  restore archived subjects.
* Not implemented (later milestones): notifications/inbox, corrective actions, advanced analytics,
  billing, ownership transfer, real Firebase import, restore rehearsal, production MFA enforcement.

## Known gaps (Milestone 1)

* **Browser authentication is untested.** No sign-up, sign-in, email link, MFA or invitation
  acceptance has been run against real Auth, and no screen has been browser-tested end to end
  (coordinator to run this at 390×844 and desktop).
* Concurrency safety rests on row locks and version checks. The local tests are sequential (PGlite is
  single-connection); a true parallel two-connection race test is still pending.
* MFA: TOTP enrollment/verification UI exists; **owner/admin enforcement is not on** (release gate).
* Not implemented at Milestone 1: assignment waivers, reopening collection after close, editing
  reviewers/roster after creation, subject–location links, a separate categories entity and CSV subject
  import (all added locally in Milestone 2, see above); still not implemented: ownership transfer, a
  provisional-analytics toggle, trends/attention rules, corrective actions, notifications,
  billing/quotas, rate limits beyond platform defaults, and a backup restore rehearsal.
* Dashboard CSV downloads are not audit-logged (session PDF/CSV exports are).
* Redaction removes assessor identities, but free-text notes may still contain names.
* PDFs embed Noto Sans in full (about 650 KB per file), because pdf-lib's subsetting dropped glyphs.
  The font covers Latin, Greek and Cyrillic. Other scripts appear as boxes with a visible warning;
  the CSV keeps the exact text.
* `npm audit` reports 5 high-severity issues in the dev-only ESLint dependency chain. Runtime
  dependencies have 0.
