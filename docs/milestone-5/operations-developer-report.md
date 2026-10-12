# M5 OPS01 developer report: read-only billing operations monitor

Developer: Claude Opus 5.5 (`claude-opus-5-5`), 12 October 2026, isolated folder, no commit, no push, no deploy.
Review input: `fable-operations-review.md` plus the owner's corrections (worker selector, collisions, grants).

## What shipped

| File | Change |
| --- | --- |
| `saas/supabase/migrations/20261012220419_m5_operator_monitoring.sql` | New (filled the empty scaffold). Six partial/read-path indexes and three STABLE, parameterless functions in the established M1/M4 pattern (see "Final architecture"). |
| `saas/src/lib/operations.ts` | New. Exact-allowlist validator (fail closed, calendar-checked UTC timestamps), evaluator against `observed_at` only, codes typed to `ActionId`, static in-app action catalogue (`ACTIONS`, `INCIDENT_STEPS`), disclosures, UNASSIGNED ownership. |
| `saas/src/app/platform/operations/page.tsx` | New. Server-rendered, `dynamic = "force-dynamic"`, GET refresh link (`.btn`, 44 px), findings link to the in-page "What to do" guide, run tables inside a labelled `.table-wrap` region with a caption, no client code, no forms, no polling. |
| `saas/src/app/platform/page.tsx` | One navigation link. |
| `saas/tests/sql/m5-operator-monitoring.test.ts` | New (13 tests, embedded PostgreSQL via the M4 harness, every migration). |
| `saas/tests/unit/m5-operations.test.ts` | New (75 tests: validation including impossible dates, boundaries, precedence, runbook mapping, rendered page, guide anchors, table region). |
| `docs/milestone-5/operations-runbooks.md` | New runbooks. |

No old migration, worker, cron, Edge function, credential, env file or dependency changed.

## Final architecture (security)

| Function | Kind | Config | Execute |
| --- | --- | --- | --- |
| `public.platform_operations_snapshot()` | SECURITY INVOKER wrapper, body only `select private.platform_operations_snapshot()` | `search_path=''` | `authenticated` only |
| `private.platform_operations_snapshot()` | Guarded entry, SECURITY DEFINER. Calls `private.platform_actor(false)` first, then the data helper | `search_path=''`, `TimeZone=UTC`, `statement_timeout=5s`, `lock_timeout=2s` | `authenticated` only (same as the existing `private.platform_overview()`) |
| `private.operations_snapshot()` | Owner-only data helper, SECURITY INVOKER | `search_path=''` | none: revoked from PUBLIC, anon, authenticated, service_role and the three billing roles |

- PUBLIC, anon, service_role and `billing_intake`/`billing_gateway`/`billing_worker` have no execute on any of
  the three. No schema or table grant changed; `authenticated` still has no SELECT on any billing or platform
  table (tested).
- A direct call to the guarded private entry enforces the same rules as the wrapper: a live, unrevoked
  `platform.admins` row for `auth.uid()`, aal1 or aal2 (read-only), with JWT metadata and role claims ignored.
  Tested through both entries: anon gets permission denied; a plain user, a workspace owner, a revoked admin
  (aal1 and aal2) and spoofed metadata get `forbidden`; a missing subject gets `not_authenticated`. An enrolled
  admin succeeds at aal1 and aal2. The data helper and `billing.worker_connections()` are denied even to that
  admin.
- The actor check runs before any data is read: the test checks that the guard's source calls
  `platform_actor(false)` before `operations_snapshot()`.

**Earlier design corrected, not waived.** The first two passes made `public.platform_operations_snapshot()`
itself SECURITY DEFINER, as the original grant instruction asked. That broke the project invariant in
`tests/sql/migration.test.ts:281` (no SECURITY DEFINER function in `public`): in the real repository the full
suite had 1 failure. That design is gone. The invariant test is unchanged and now passes, and the new SQL test
repeats it alongside the other two invariants from the same test.

## Design facts

- **Required connections** are `billing.worker_connections()` output (`id = any(...)`), the same call the worker
  makes. Tested: enabled, disabled-with-credential and no pinned subscription (required); draft and disabled
  without credential (not required); enabled-without-credential is refused by the existing check constraint.
- **Runs**: per connection and mode (process, discover, reconcile), cron only: latest finished outcome (by
  `finished_at desc, id desc`), latest successful finish, unfinished count and oldest start, failed/partial counts
  in the last 24 hours. Outcomes collapsed in SQL; `error_code` and `worker` are never emitted.
- **Queues**: webhook pending/processing/failed (oldest received, future retries and live leases included),
  expired leases separately, dead and quarantined separately; discovery pending/processing/retry (oldest
  first seen), expired leases, dead; unresolved reviews per connection plus a global no-connection count;
  collisions in the last 24 hours (count only).
- **Evaluator**: strict `>` thresholds (backlog 15 min; process 5 min, discover 2 h, reconcile 26 h; unfinished
  5 min). Future timestamps make the result an error. No finished run means not measured. Connections the
  worker doesn't serve are not measured for runs, but their queue and review issues are still attention.
  Precedence: error > attention > not measured > within thresholds. The page never claims platform health.
- **Page errors**: `forbidden` returns not found, `not_authenticated` redirects to login, and any other error
  shows "unavailable" with Retry and no message text. Invalid data shows the error state with none of the
  payload.

## Sol review repairs (second pass)

1. **Impossible timestamps accepted (reproduced).** `Date.parse` rolled `2026-02-30T12:00:00+00:00` over to
   2 March, so validation passed it. The validator now captures year, month, day, hour, minute and second from
   the PostgreSQL UTC form (`+00:00`, 0 to 6 fractional digits), parses the string, and requires every UTC
   whole-second component to match. Impossible month days, non-leap 29 Feb (including 1900), month 00 or 13,
   hour 24, minute 60, second 60, 7-digit fractions, `Z`, a space separator, a short offset and an expanded year
   all give the error state, both at `observed_at` and in nested timestamps (webhook oldest, run finish). Leap days
   (2024, 2000), 1-digit and microsecond fractions are accepted, and the 15-minute threshold stays exact at
   millisecond precision with microsecond strings.
2. **Runbook not usable from the UI.** Each finding now shows its plain message, a link "What to do: <title>"
   to an in-page anchor, and the code in small muted text. A "What to do" section renders on every load,
   including the error state: one heading per action ID (10 in all) with concise review, record and escalate
   steps, plus "Telling people about a problem". Steps say which assignments are pending (escalation contact,
   trusted database operator) and that outside messages need the owner's approval. The repo path, SQL, schema
   names and provider or credential commands are gone from the UI (tested). `CODES.action` is typed to
   `ActionId`, and a test checks that every action is linked from some rendered finding and that every link
   resolves to an `id` on the page.
3. **Run table on narrow screens.** Each six-column table sits in the existing `.table-wrap` (horizontal
   overflow) as `role="region"` with an `aria-label`, `tabindex="0"` and a matching `<caption>`. Column and row
   headers carry `scope`. The heading now shows the short connection ID, and the full UUID sits on its own line
   with `overflow-wrap: anywhere`. Refresh and Retry use the existing `.btn` (44 px minimum). No new stylesheet.
   Not checked in a browser at 390 px; this is asserted on markup only.
4. **Route config and timeouts.** `dynamic = "force-dynamic"` is valid here: Sol's
   `reference-next/route-segment-config.md` lists it as removed only when Cache Components is enabled, and this
   app doesn't enable it. The runbook now states that a function-level `statement_timeout` is not proof of a
   5 s outer query timer, and that PGlite doesn't exercise timeouts. In a direct probe, a function with a 200 ms
   timeout ran a 1 s sleep to completion, so this slice makes no claim of strict 5-second cancellation.

## Commands and results (run in `saas/`, final pass)

| Command | Result |
| --- | --- |
| `npm run test -- tests/sql/m5-operator-monitoring.test.ts tests/unit/m5-operations.test.ts tests/sql/migration.test.ts` | 3 files, 108 tests passed (13 SQL + 75 unit + 20 migration, including the no-public-definer invariant) |
| `npm run typecheck` | passed |
| `npm run lint` | passed |

The full isolated suite was not rerun in the final pass, because this folder lacks git, env and baseline docs.
Before the fix, the earlier isolated run had 14 environmental failures (`repo-hygiene` ×11 and the
`m4-billing-ui` secret scan need git and `.env.example`; `legacy.test.ts` and `sol-legacy-m3.test.ts` need the
`docs/milestone-2|3/qa-snapshot-baseline.json` files) plus the one invariant failure now fixed. Root reruns the
full suite in the actual repository. Root reports that the actual repository build passed. The app code did not
change in this pass.

Not run here: `npm run build` (writes `.next` and edits `tsconfig.json`/`next-env.d.ts`). No browser test was run; the UI checks are server-render assertions with
`renderToStaticMarkup` and mocked auth, not a browser or Supabase run.

## Limits and honest gaps

- "Real local Postgres" here is embedded PostgreSQL (PGlite) through the M4 harness. No `psql`/server was
  available. It's single connection, so there's no concurrency evidence.
- **Timeouts are unverified.** PGlite enforces neither function-level nor session-level `statement_timeout`
  (checked directly). In real PostgreSQL, a function-level `statement_timeout` does not bound the top-level RPC
  statement that is already running, so the effective bound is the role-level PostgREST/Supabase timeout.
  `lock_timeout` applies per lock wait. There is no claim of strict 5 s cancellation.
- **Layout untested in a browser.** The 390 px no-spill result is inferred from `.table-wrap`, `overflow-wrap`
  and the markup tests. No browser or screenshot check was run.
- Guest membership was not fixtured. Denial is tested for anon, a plain authenticated user, a workspace owner,
  a revoked admin, spoofed JWT/user metadata and a missing subject. The actor check reads only
  `platform.admins` by `auth.uid()`, so a guest falls under "plain authenticated".
- Index usability is shown with `enable_seqscan=off` EXPLAIN on equivalent standalone queries, not production
  plans or volumes.
- A row committed between the statement start and the snapshot can rarely show as a future timestamp (error
  state). One refresh clears it (RB-OPS-02).
- Housekeeping runs, pg_cron history and every non-billing signal are listed as not instrumented on the page.
- Detection is manual only. There's no external alerting, schedule or messaging. Ownership, hours, escalation
  and the restore drill stay UNASSIGNED or planned.

## Sol integration verification

The complete suite in the actual repository passed: 496 tests passed, one optional fixture skipped. Type checking, lint and the guarded local application build passed. Independent checks covered the strict 15-minute backlog boundary, discovery retry age, latest run failure, missing jobs, future timestamps, impossible calendar dates and rejection of an extra private field.

The existing test rejecting all public SECURITY DEFINER functions initially caught the proposed endpoint. The implementation was repaired using the established public invoker -> guarded private definer -> owner-only private data helper pattern; the existing security test was preserved and now passes. Fable re-reviewed the final design. Only the platform navigation link, new read-only page/evaluator, additive migration, focused tests and operator documents changed. Firebase MVP HTML is unchanged from 5e26088.

Hosted migration, actual role checks, protected Preview and responsive browser evidence are the next verification step. This is bounded billing monitoring only: external alert delivery and non-billing telemetry are not implemented; support assignments and target restore remain pending.
