# SAVOUR SaaS — Milestone 1

Multi-business inspection app: private workspaces and roles, versioned templates, sessions with
assessor assignments, scoring with optional attendance, review/approve/reopen, and consistent
reports (dashboard, PDF, CSV). Lives entirely in `saas/`; the legacy Firebase MVP (root HTML files)
is untouched.

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

* Schema: `supabase/migrations/20261010202119_m1_core.sql` (already applied to savour-dev; **do not
  edit** — add new migrations with `npx supabase migration new <name>`).
* Transactional security test: `supabase/tests/m1_security.sql`, which you can run against any database
  as the owner role. It creates disposable fixture users/tenants, runs 153 assertions as
  `authenticated` with JWT claims, then **rolls back**:
  `psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/m1_security.sql`

### Checks

```bash
npm run typecheck   # tsc (TypeScript 6.0.3; typescript-eslint does not support TS 7 yet)
npm run lint
npm test            # unit tests + migration replay + SQL security script on embedded Postgres (PGlite)
NEXT_DIST_DIR=.next-verify npx next build   # production build without touching a running dev server's .next
QA_SAMPLE_PDF=/tmp/savour-qa/sample-report.pdf npx vitest run tests/qa   # disposable sample PDF via buildPdf
```

## Architecture

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

## Known gaps (Milestone 1)

* **Browser authentication is untested.** No sign-up, sign-in, email link, MFA or invitation
  acceptance has been run against real Auth, and no screen has been browser-tested end to end
  (coordinator to run this at 390×844 and desktop).
* Concurrency safety rests on row locks and version checks. The local tests are sequential (PGlite is
  single-connection); a true parallel two-connection race test is still pending.
* MFA: TOTP enrollment/verification UI exists; **owner/admin enforcement is not on** (release gate).
* Not implemented yet: assignment waivers (approval requires every response), reopening collection
  after close, editing reviewers/roster after creation, subject–location links, a separate categories
  entity, CSV subject import, ownership transfer, a provisional-analytics toggle, trends/attention
  rules, corrective actions, notifications, billing/quotas, rate limits beyond platform defaults, and
  a backup restore rehearsal.
* Dashboard CSV downloads are not audit-logged (session PDF/CSV exports are).
* Redaction removes assessor identities, but free-text notes may still contain names.
* PDFs embed Noto Sans in full (about 650 KB per file), because pdf-lib's subsetting dropped glyphs.
  The font covers Latin, Greek and Cyrillic. Other scripts appear as boxes with a visible warning;
  the CSV keeps the exact text.
* `npm audit` reports 5 high-severity issues in the dev-only ESLint dependency chain. Runtime
  dependencies have 0.
