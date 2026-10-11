# SAVOUR Milestone 3 — developer report (Claude Code, Opus 5.5)

**Identity:** Claude Opus 5.5, model ID `claude-opus-5-5`, working as SAVOUR's authorized Milestone 3 developer on
branch `feat/saas-milestone-3` (base `b76b400`).

> **Update (follow-up, below):** Sol has since applied and sealed all three M3 migrations on savour-dev, run the
> real-PostgreSQL scripts (657 assertions) and the 15-snapshot pin, and found one browser defect (P2) in the action
> page's save feedback. It is fixed in application code only; see "Follow-up: persistent action save result".

**Status: implemented and verified locally only. Not accepted.** Nothing was committed, pushed, deployed or applied
to any cloud project. No cloud, MCP or remote API was used; no environment, credential, `.vercel`, auth/session or
token file was read; no email was sent and no account created; no dependency was installed or updated. Sol's
independent review, development migration application, real-Postgres and two-connection checks, browser and
protected Preview verification, and the founder demonstration all still follow. No production-readiness or
certification claim is made.

## Migrations (forward only; filenames created with `./node_modules/.bin/supabase migration new` from `saas/`)

| Order | File | SHA-256 | Status |
| --- | --- | --- | --- |
| 1–6 | the six M1/M2 files | unchanged (`adb428ad…`, `b72c2744…`, `4fbe4e2f…`, `a65dcfba…`, `a76c2f8a…`, `b68b8000…`) | applied, sealed, pinned by the test suite |
| 7 | `20261011144333_m3_actions_inbox.sql` | `5751b0341d5516da11a0aaa6b33be2e3cbd10af718e3ab499f69e86744033cce` | applied by Sol, sealed |
| 8 | `20261011144335_m3_report_snapshot.sql` | `a2f74c6a0229b4c1b71f4b198a795cf08736e4c1d536f7533f3de46a1af3600a` | applied by Sol, sealed |
| 9 | `20261011144337_m3_analytics.sql` | `efa8733057fbce7594163945c4e05ab7cb84e3b58ee016e9ef130828c0c62267` | applied by Sol, sealed |

Apply in filename order. Fable proposed five migrations; three give the smallest clean dependency order and replace
each earlier function at most once (every replacement carries a "Diff from …" comment):

1. **actions/inbox** — `template_versions.settings` (column add only; immutability trigger untouched); replaced
   `validate_criteria` (adds optional `critical` / `trigger_at_or_below` 1–4, emitted only when set, so criteria without
   them validate to exactly the M1 output — tested against the real M1 validator); `validate_template_settings`
   (repeat window 1–6, default 3); 7-argument `publish_template` (6-argument M1 signature kept, delegates); tables
   `findings`, `actions`, `action_events` (insert-only), `notifications` (only `read_at` mutable); `sessions` gains
   `unique (workspace_id, id, location_id)` so an action's location is proven equal to its session's by foreign key;
   RPCs `create_finding`, `withdraw_finding`, `get_findings`, `create_action`, `update_action`, `transition_action`,
   `get_actions`, `get_action`, `get_action_assignees`, `get_inbox`, `mark_notification_read(p_ws, p_notification)`,
   `mark_all_notifications_read`; replaced `request_correction` (adds one notify call).
2. **report snapshot** — replaced `build_inputs` (`savour-m3.1`, same arithmetic; adds `session.location_id`,
   `template.pack/settings`, per-subject `category_id/category_name/subject_type` at approval, `findings[]`,
   `actions[]`); replaced `redact_inputs` (new final branch only when `actions` exists; m1.1/m2.1 bodies redact
   byte-identically); `generate_findings`; replaced `approve_session` (`clock_timestamp()` after the session lock for
   `approved_at` and generated findings; findings generated from the frozen evidence; approval notifications);
   replaced `get_session_report` (`meta.actions_snapshot`, `meta.workspace_id`, server-dated `actions_appendix`,
   repeat-source scrubbing); replaced `get_dashboard` (repeat-source scrubbing only).
3. **analytics** — `get_analytics(p_ws, p_mode, p_filters, p_purpose)`.

All new tables: RLS on, SELECT-only grants (notifications: no grant, no policy; `findings.detail` and the
idempotency columns not selectable), composite `(workspace_id, …)` foreign keys each with a non-partial covering
index, keep-workspace triggers. All new functions: public `SECURITY INVOKER` wrappers over private `SECURITY DEFINER`
with `search_path=''`, explicit grants, no PUBLIC/anon execute. Every write is audited in the same transaction.

## What was built (by requirement)

* **Corrective actions (ACT01).** Linked finding, subject, session and location (location copied from the session
  and FK-proven). Required issue, severity, assignee, due date, action required. Open → In progress → Ready for
  verification → Closed, strictly linear; Cancel and Reopen need reasons; Return needs a reason and clears the
  resolution. Evidence text required to reach Ready. Assignee must be live (active, unexpired staff holding the
  location) on every read and write; reassignment makes the old assignee's notices stale and their writes fail.
  Reviewer/Owner/Admin may progress someone else's work only with a recorded override reason; nobody verifies a
  resolution they own or recorded, except Owner/Admin with a recorded override reason (Reviewer never).
  While Ready for verification only the due date may change (`return_required`), so old evidence cannot close
  different work. Expected version on every change; idempotency key on every command (replay returns the original
  receipt; changed payload conflicts; unauthorized callers fail before any replay lookup). Before/after state, actor,
  reason and override flag in `action_events`, plus audit rows. Viewer and Guest are refused everywhere. An action
  never grants its assignee the session, roster, assessments or report.
* **Findings.** Manual (reviewers in scope; idempotent; reasoned, version-checked withdrawal, refused while any
  non-cancelled action links) and generated at approval by versioned template triggers (critical criterion default
  trigger 2; severity Critical for critical criteria, else High). Generated findings are append-only per approved
  revision (unique session/subject/criterion/revision); reapproval adds new rows linking back
  (`previous_revision_finding_id`) and never rewrites earlier ones. Repeat tag uses only prior approved, non-sample
  sessions of the **same template version**, within the frozen window; fewer than the window without a repeat is
  `insufficient_data`. Samples refuse findings/actions; sample approvals generate nothing. Rule text is stored with
  each generated finding and states it is not a certification or penalty.
* **Reports (RPT01).** New approvals freeze findings and action state under the session lock. Old approvals are never
  modified and say "No action state was frozen at this approval". The current appendix is server-dated, compares
  live actions with the frozen IDs/versions of the revision viewed (unchanged / changed since approval (was X) /
  created after this approval), and is never part of the evidence. One shared action presentation
  (`ActionLine`) feeds page, CSV and PDF for both sections (required work, evidence, verified-at, cancellation,
  reopen count). Viewers get pseudonymous assignees ("Assignee N" in the snapshot, "Assigned staff member" in the
  appendix). CSV formula-injection defence applies to all new cells.
* **Analytics (ANA01–03).** Overview, template-version groups and version breaks, Needs attention, location
  comparison, category comparison, subject history; filters period, location, pack, template version, category,
  subject type and subject; approved by default; reviewer-only provisional mode labelled and never blended (mixed
  datasets throw). One aggregator (`src/lib/analytics.ts`) for page, CSV and PDF; tabular sections render from the
  same `analyticsSections()` in all three. Quality means only within template version + formula + applicable-criteria
  groups; subject-sessions equal weight; missing, waived (including for unknown outcomes), absent, not-assessed and
  unknown counted; attendance only where on; null is "No data". Categories/types as recorded at approval; legacy
  "Not recorded at approval"; current names are annotations only. Flags: decline ≥ 10 points (latest 3 vs preceding 3
  of 6 comparable; exact −10 flagged with a floating-point tolerance), late/absent in 2 of last 3 attendance-on
  recorded sessions, open critical (current evidence) findings, overdue actions; each with rule text, sources and a
  live-vs-approved label; category/type filters match live flags by source inspection, a subject filter selects
  that subject's live work even before its first approval. Samples excluded in SQL and again in TS. Exports audited
  with their filters.
* **Inbox.** Correction requested, action assigned/ready/returned/verified/cancelled/reopened, session approved,
  due today, overdue. Rows store IDs only; titles, bodies and links are built at read time after live access and
  condition checks (reassignment, revocation, location loss, closed correction, changed due date, finished action,
  and a due-today day that has ended all make entries stale with no payload or link). Due reminders: idempotent lazy
  sync when the recipient opens the inbox, disclosed on the page; due state from the server clock in the workspace
  timezone; ready-for-verification is still overdue. Mark-read: recipient only, within the business in the URL.
  No email, SMS or WhatsApp.
* **Template editing.** Editor sets critical, finding trigger and repeat window per new version; templates page shows
  the frozen settings.
* **Business context (Sol 8).** Action detail and report pages/exports compare the entity's `workspace_id` with the
  URL; every finding/action form checks the entity's business (`src/lib/workspace-guard.ts`) before calling the RPC;
  mark-read is bound to the URL business in SQL.

## Sol review findings (`sol-review-findings.md`) — all eight addressed

1. Ready-action substantive edits → `return_required`; due-date-only allowed; UI shows only the due-date form and
   explains the return step. 2. Due-today/overdue notices recheck `due_state` against the workspace-local date.
3. Finding-create replay returns the original receipt (version 1). 4. `scrub_finding_detail` / `scrub_inputs` keep
   only prior-inspection IDs the reader can open (`can_review` or `viewer_can_see`) and report `sources_withheld`;
   applied in report, dashboard, analytics records and live findings, `get_findings` and `get_action`;
   `findings.detail` not directly selectable; stored snapshots unchanged. 5. Unknown outcomes disclose missing/waived
   quality work. 6. Source-specific live-flag filtering. 7. Shared action presentation across formats; e2e test closes
   an action after approval with Unicode evidence and checks identified and redacted CSV/PDF. 8. Business-context
   checks as above. Sol's test files were not edited; all 18 of their tests pass.

## Verification (local)

* `npm test`: **23 files, 230 passed, 1 skipped** (opt-in QA PDF writer). Baseline was 164. New: 48 of mine (analytics
  unit 26, report/actions/steps 10, end-to-end analytics and report exports 2, migration/schema/scripts 5, legacy
  M2→M3 upgrade 1, workspace guard 3, baseline/pin agreement 1) and 18 of Sol's (all passing).
* Transactional SQL (each rolls back; run on PGlite by `npm test`, unchanged command for real Postgres):
  `m3_actions.sql` **205** assertions, `m3_analytics.sql` **36**; existing `m1_security` 153, `m1_guest_closure` 23,
  `m2_directory` 82, `m2_lifecycle` 158 all still pass on the M3 schema.
* Empty replay of all nine migrations; six sealed SHA-256 pins unchanged; RLS/grant/definer/anon sweep; covering
  indexes for all 10 new foreign keys; lock-order and clock invariants; M1 validator identity.
* Legacy: M1 snapshots across M2 (unchanged test) and M1+M2 snapshots across M3: rows, hashes, labels and redaction
  byte-identical, values identical; legacy report says `not_recorded`; a later action appears only in the appendix;
  reapproval stamps m3.1 with identical numbers. The saved disposable QA snapshots in `/tmp` were present, so that
  check also ran and now compares M3 redaction too. `tests/unit/snapshot-baseline.test.ts` checks all 15 rows of
  `qa-snapshot-baseline.json` appear identically in Sol's `sol_m3_snapshot_pin.sql` (neither file modified).
* `npm run typecheck` and `npm run lint`: clean.
* `NEXT_DIST_DIR=.next-m3-opuscheck npm run build`: succeeded (build guard ran; all 26 routes including
  `/w/[ws]/actions`, `/actions/[id]`, `/analytics`, `/analytics/export`, `/inbox`). Fonts are traced for both PDF
  routes. The build's edits to `tsconfig.json` and the gitignored `next-env.d.ts` were restored to their exact
  pre-build checksums. `.next-m2-finalcheck` was not touched.
* Root `index.html`/`admin.html`/`review.html`, root `AGENTS.md`, PRD DOCX/PDF and `qa-snapshot-baseline.json`:
  unchanged versus HEAD.

## Changed paths

New: the three migrations; `supabase/tests/m3_actions.sql`, `m3_analytics.sql`; `src/lib/analytics.ts`,
`analytics-export.ts`, `corrective.ts`, `workspace-guard.ts`; `src/app/w/[ws]/actions/` (`page.tsx`, `[id]/page.tsx`,
`commands.ts`), `analytics/` (`page.tsx`, `export/route.ts`), `inbox/page.tsx`, `sessions/[id]/findings-panel.tsx`;
tests `tests/unit/analytics.test.ts`, `report-actions.test.ts`, `snapshot-baseline.test.ts`, `workspace-guard.test.ts`,
`tests/sql/analytics.test.ts`; this report.

Modified: `src/lib/scoring.ts` (m3.1 known; types only), `report.ts`, `pdf.ts`, `labels.ts`, `errors.ts`,
`validation.ts`; `globals.css`; workspace `layout.tsx` (Actions/Analytics/Inbox navigation by role; inbox never
prefetched), Overview `page.tsx` (link), session `page.tsx`, report `page.tsx` and `export/route.ts`, templates
`page.tsx`/`editor.tsx`/`actions.ts`; `next.config.ts` (font tracing for the analytics PDF route); `README.md`;
`tests/sql/migration.test.ts`, `legacy.test.ts`; `supabase/tests/m2_lifecycle.sql` — two assertions that hard-coded
the label stamped on **new** inputs now accept `savour-m2.1` or `savour-m3.1`, so the script stays valid before and
after M3 is applied (no arithmetic or permission assertion changed).

## Decisions within the brief (reviewable defaults)

* One `transition_action` RPC carries all state commands; `update_action` edits fields (null keeps a value).
* Due dates: today (workspace-local) up to two years ahead when set or changed.
* Due reminders go to the assignee and to the action's creator while they still review the session; dedupe key
  `kind:action:due_date`, so retries and repeated visits never duplicate and a changed date gets new reminders.
* Generated findings are append-only per revision; "current" evidence = manual, or generated in the session's current
  approved revision. A finding is resolved only when an action is closed and none is active.
* Analytics groups by formula label as well as version, so m2.1 and m3.1 approvals of the same version are separate
  groups with a visible break (strict reading of Sol's correction 8).
* Category and subject type for analytics are approval-time stamps only; the subject-type filter treats legacy rows
  as "Not recorded at approval".
* Starter packs ship without triggers (no implied standard); owners enable them per version.
* The existing Overview rollup (M1/M2 behaviour) is unchanged and links to Analytics.

## Concurrency: structure tested, live overlap not claimed

PGlite is single-connection, so no overlapping transactions were run. Covered structurally: every finding/action
writer takes `private.lock_session` first, then `FOR NO KEY UPDATE` on its own row (lock-order step 6), never
`FOR UPDATE` on findings/actions/notifications; approval and action times use `clock_timestamp()` after the lock;
version checks reject stale saves; inbox due sync never references the session row. Suggested two-connection
harness for Sol on savour-dev (psql, explicit transactions, disposable fixtures):

1. **Return vs verify from the same Ready state** (both valid). Connection A: `begin; set local role authenticated;
   select set_config('request.jwt.claims', '<reviewer A>', true); select public.transition_action(:act, 'return', :v,
   null, 'race check', gen_random_uuid());` — leave open. Connection B (a different eligible verifier):
   `begin; …claims B…; select public.transition_action(:act, 'verify', :v, null, null, gen_random_uuid());` — it
   blocks. Observer: `select pid, wait_event_type, wait_event, query from pg_stat_activity where wait_event_type =
   'Lock'` and `select locktype, relation::regclass, granted from pg_locks where not granted` (expect B waiting on the
   `sessions` tuple). `commit` A; B then fails `stale_version`. Repeat with B first.
2. **Action creation vs approval.** A: `begin; …; select public.approve_session(:s, :dv);` (holds the session lock);
   B: `begin; …; select public.create_action(:finding, …);` blocks; commit A, then B. Expect the action absent from the
   new snapshot's `actions[]` and `created_at > approved_at`. Reverse the order: the snapshot contains the action
   (matched by ID and version) and `created_at <= approved_at`.
3. M2 import/invite overlaps remain regression follow-ups as recorded in M2; not re-run here.

## Honest gaps

* No real-Postgres, Supabase advisor, browser (desktop or 390×844), hosted, Preview or founder verification by the
  developer. Mobile layout follows the existing patterns (single-column grid at 390 px, horizontally scrolling tables,
  16 px inputs, 44 px targets, including `<summary>` toggles) but was not viewed in a browser.
* Due reminders exist only after a recipient opens their inbox; no scheduler or outbound delivery.
* Analytics loads at most the latest 1,000 matching sessions per request (disclosed). Free-text notes, issues and
  evidence may contain names; redaction covers identities, not free text (disclosed in exports).
* Inbox for Viewer and Guest is refused in M3 (as agreed in the acceptance matrix).
* Report pages fetched by ID still rely on the database for authorization; the new business check compares the
  envelope's `workspace_id` after the authorized read (an export of another business is audited by the database but
  not returned).

Next: Sol's independent review of the three migrations, application to savour-dev in order with the snapshot pin
before and after, real-Postgres runs of all SQL scripts, the two-connection races above, advisors, browser and
Preview checks, then the founder demonstration (finding → assignment → evidence → verification → closure; original
approved report vs dated appendix; analytics, attention and inbox on mobile).

## Follow-up: persistent action save result (browser QA defect, P2)

**Defect (found by Sol in a real signed-in browser):** an action at Ready v11 was returned for work by a held SQL
transaction while the owner clicked Verify with v11. The database behaved correctly (lock wait observed; the losing
verify made no change; the action is In progress v12). But the verify error vanished: the result lived in a
`useActionState` inside the conditional Verify form, and the post-action refresh removed that form. The user saw a
changed action with no explanation.

**Fix (application code only; no SQL change was needed, no migration touched).**
* `src/app/w/[ws]/actions/[id]/action-panel.tsx` (new client component): one always-rendered panel per action
  (`key={action id}`) owns the only `useActionState` for every step and edit form on the action page (fixed hook
  order). Its result region (`role="status"`, `aria-live="polite"`, `aria-atomic`) is always mounted above the forms,
  so a result (success or refusal) survives when the refresh removes the form that produced it. After each save,
  focus moves to the result (the submitted form may be gone). While a save is pending, every submit button in the
  panel is disabled.
* Steps still come only from the fresh server read (`availableSteps` over live `get_action` permissions). Nothing
  stale is kept: unavailable steps, their buttons and their data disappear; edit data is passed only when the live
  read offers editing. Each form still has its own server-minted idempotency key and the version it was rendered
  from (forms are keyed by step and version, so a new version remounts them with fresh defaults).
* `describeActionResult` (`src/lib/corrective.ts`) explains the result against the action as it is now, for example:
  "Verify and close: not saved — This was changed by someone else… Nothing was saved by this attempt. The action is
  now In progress (version 12). Verify and close is no longer available to you. The steps below show what you can do
  now." Success is reported the same way ("Return for more work: saved … now In progress (version 12)").
* `src/app/w/[ws]/actions/commands.ts`: new `saveActionStep` server action, the panel's single entry point; it routes to
  the unchanged `transitionAction` / `updateAction` and tags the result with its step. Those two now also re-read the
  page after a **database refusal** (stale version, invalid transition, lost access…), so the page shows live
  eligibility in the same round trip, following the bundled Next 16.4 mutation guidance (`revalidatePath` in the
  Server Action returns the action result and the refreshed route together). The business-context guard is
  unchanged: a refused cross-business form still never reaches the database and never refreshes (Sol's
  `sol-context-m3.test.ts` passes unmodified).
* `src/app/w/[ws]/actions/[id]/page.tsx`: renders the panel unconditionally and no longer defines per-step
  `ActionForm`s. `src/app/globals.css`: focus outline for the result. Other M1/M2/M3 forms (findings panel, inbox,
  older pages) are unchanged.

**Regressions** (`tests/unit/action-panel.test.ts`, 13 tests):
* The QA case: a verify refusal against a now In progress v12 action explains "not saved", the new state, and that the
  step is gone; a still-offered step is not described as gone; success is explained after its step disappears; a
  blocked self-verification counts as not offered.
* The real `saveActionStep`: a `stale_version` refusal is returned with its step, with exactly one `transition_action`
  call carrying version 11 and the form's key, and a page refresh. Edits go to `update_action`. A replay says nothing
  was duplicated. The business guard still blocks both the RPC and the refresh.
* Server-rendered panel markup at Ready v11, In progress v12 and Closed v13. The same live result region is always
  first. Verify is absent after the return. Forms carry the fresh version only, and none render when no step is
  allowed. Each form has its own key.
* Structure: the page renders the panel unconditionally, keyed by action, with no per-step action state; the panel
  has exactly one top-level `useActionState`.

Limitation: no DOM library is installed (and none may be added), so the client state transition itself — the same
mounted panel keeping its result across the refresh — is covered by the structural and markup tests and React's
keyed-component semantics, not by a simulated browser render. Sol's signed-in browser re-check of the original
scenario remains the authoritative confirmation.

**Checks (this follow-up):** `npm test` 24 files, **243 passed, 1 skipped** (230 before plus my 13; all of Sol's tests
unmodified and passing); `npm run typecheck` and `npm run lint` exit 0;
`NEXT_DIST_DIR=.next-m3-feedbackcheck npm run build` succeeded (build guard OK). The build's `tsconfig.json` and
`next-env.d.ts` edits were restored to their exact pre-build checksums. `.next-m3-opuscheck` (used by the running local
3100 server) was not built or written (its BUILD_ID is unchanged). No migration, SQL script or Sol test file was
modified; nothing was committed, pushed, deployed or applied, and no browser, cloud or database was used. Not accepted;
Sol's browser re-check, Preview and the founder demonstration still follow.

## Follow-up: analytics PDF arrow glyph (browser QA, final)

**Finding (Sol, real owner browser download of the six-inspection analytics CSV/PDF):** the figures agree (6 sessions,
mean quality 75, combined 74.4, decline 80 to 70, late in 2 of the last 3). However, the generated decline sentence
contained a Unicode right arrow ("→") that the embedded Noto Sans font cannot draw. The PDF showed a box and the
unsupported-character warning, although no user text needed it.

**Fix (one generated sentence; no SQL, migration, font or design change):** `src/lib/analytics.ts` now writes
"Mean quality fell 10.0 points: 80.0% to 70.0% (…)" with plain " to ". This sentence is shared by the page, CSV
and PDF, so all three change together. User-authored free text is untouched and keeps the existing honest fallback:
unsupported characters become a visible box, with a warning, and the CSV keeps the exact text. My own earlier
expectation in `tests/unit/analytics.test.ts` was updated from "→" to "to".

**Regression:** `tests/unit/analytics-font.test.ts` (3 tests) embeds the real `NotoSans-Regular.ttf` and
`NotoSans-Bold.ttf` the PDFs use. It builds the QA scenario (80% three times, then 70% three times; late in 2 of the
last 3), then checks:
* the decline sentence's exact text and that every character is drawable (no box, zero missing) in both fonts;
* every generated string in the analytics header rows, rules, section titles, notes, headers and cells is covered
  (fixture user text is plain ASCII);
* user-authored text with "→" and an emoji is still boxed and counted, so the fallback is preserved.

I confirmed the regression is meaningful: with the arrow temporarily restored, both coverage tests failed. The fix was
then restored byte for byte.

**Checks:**
* Focused tests: `analytics-font` and `analytics` 29 passed.
* Full suite: `npm test` 26 files, **249 passed, 1 skipped** (the opt-in QA PDF writer).
* Typecheck and lint: `npm run typecheck` and `npm run lint` exit 0.
* Build: `NEXT_DIST_DIR=.next-m3-releasecheck npm run build` exit 0. The build guard passed and fonts are traced for
  `/w/[ws]/analytics/export`. The build-generated `tsconfig.json` and `next-env.d.ts` edits were restored to their exact
  pre-build checksums. `.next-m3-opuscheck` (local 3100 server) and `.next-m3-feedbackcheck` were not built or written
  (BUILD_IDs unchanged).
* Untouched: all nine migration files, every SQL script, Sol's tests (including the seal tests), Sol's fixture scopes
  and `sol-verification.md`.
* Nothing was committed, pushed, deployed or applied, and no browser, cloud or database was used.

Not accepted; Sol's browser, security and Preview verification and the founder demonstration continue.

