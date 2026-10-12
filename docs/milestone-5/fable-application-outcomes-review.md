# Fable application outcomes architecture review

Actual Claude Code claude-fable-5-1 verified source review.

Read all eight files. Review follows.

**Verdict:** the candidate architecture is sound and fits the existing patterns. Three corrections and a few gaps below.

**What the code shows**

- **Save path** (`actions.ts`): every outcome is already classified by the database. The RPC error message is a stable code such as stale_version or forbidden, and `friendlyError` renders it. Nothing is logged anywhere. The submit path returns `replayed`, so replays are already distinguishable without new work.
- **Export routes**: all three map the RPC error message to a status and return. The session report route calls `buildPdf` outside any try/catch, so a PDF build failure is an unobserved 500. The analytics route catches its build step. A 200 response means the file was generated and streamed. It never proves the browser finished or saved it.
- **Client**: publishable key only, cookie-bound, RLS everywhere. The existing snapshot migration gives the exact pattern to copy: public invoker wrapper, private definer entry that calls `platform_actor(false)` first, owner-only helper, explicit jsonb allowlist, explicit revokes, bounded 24h windows, STABLE functions.
- **Operations page**: already carries a detection notice and a "not instrumented" list. The new page should reuse that framing rather than inventing a fresh one.

**Corrections to the candidate**

1. **Server logs cannot feed the admin UI.** There is no privileged client, so structured stdout logs stay on the host. The platform page can show only the self-reported counters plus a fixed statement that the trustworthy record is in host logs. Say so on the page, in the same voice as the existing detection notice.
2. **There is already a trusted export signal.** The route comments state that `get_session_report` and `get_analytics` audit each export inside the definer RPC, with purpose set to the format. If that audit table exists, a count of those rows per window is a server-side observation of "report data released for export", with no new write path. Confirm the table and its retention before relying on it. It still does not prove a file was built or downloaded.
3. **Self-reported counters must be a different colour of data.** The UI should never merge them with the audit-derived counts. Label them "reported by signed-in browsers, unverified, undercounts on failure".

**Minimal instrumentation**

- **Server log line** per action and export, emitted after the RPC returns: fixed route constant, outcome class, HTTP status or RPC code from an allowlist, duration bucket. No URL, querystring, filter object, filename, reason, notes, or raw message. Unknown codes log as `unknown`, not the text.
- **Outcome classes**: validation (unticked confirm, bad request, invalid filter, unsupported formula), denial (forbidden, not authenticated, cross-workspace 404), replay (replayed true), stale (stale_version), technical (any other code, PDF build throw, client network failure).
- **Wrap `buildPdf`** in the session report route like the analytics route already does, so the failure is classified. Keep the status and the "nothing exported" body.
- **Client counters RPC**: authenticated may execute one public invoker wrapper that calls a private definer that validates a short enum of event codes and increments a row keyed by hour bucket and code. No free text, no IDs, no payload. Rate bound by making it an upsert increment, not an insert. Store in a private table with no grants.
- **Retention**: fixed number of hour buckets, trimmed by the same RPC with a `delete ... limit`-style bounded statement, or a ring of slots. No cron, no unbounded sweep.
- **Snapshot RPC**: copy the OPS01 trio exactly, statement timeout, UTC, allowlisted jsonb. Authorization is the live `platform.admins` row via `platform_actor`. No JWT claim or metadata check.
- **DB outage**: the server log line is the only record. The counter RPC fails, the client drops the event silently, the save or export result is returned unchanged.

**Do not add**

- Any freshness threshold or "expected events per hour". Traffic is unknown, so absence of events is not a finding. State this on the page.
- Any user id, workspace label, or email in logs or counters.
- Any change to return values, statuses, or revalidation order.

## Implemented code review

All nine files read, including the three export routes at `saas/src/app/w/[ws]/sessions/[id]/report/export/route.ts`, `saas/src/app/w/[ws]/analytics/export/route.ts` and `saas/src/app/w/[ws]/export/route.ts`.

**One blocker found. Everything else checks out.**

**Blocker: the shape validator's storage bound is four times too tight.** In `saas/src/lib/application-outcomes.ts:120` the per-operation total is rejected when it exceeds `actors * 24 * cap`. The real ceiling per actor per op is 24 slots times 4 outcomes times 1000, so the correct bound is `actors * 24 * 4 * cap` (or, tighter and still correct, each outcome individually at most `actors * 24 * cap`). Consequences:

- A legitimate busy day with one reporting user and more than 24,000 total outcomes for one op makes the whole panel render "Error: application outcome counts unusable".
- Worse, a single signed-in user can reach that deliberately. They can push 4,000 per hour (1,000 per outcome) by calling the RPC directly, so about seven hours of self-inflation blanks the admin view for every op. That turns the documented "can only inflate their own counts" promise into a denial of the monitoring page. Fix the constant before shipping.

**SQL aggregate queries: sound.** Window bounds, per-op left join against the static values list, filtered sums, capped-bucket count and distinct failed hours are all correct and only expose static enums, whole counts and UTC timestamps. The invoker helper called from the definer runs as the owner, so the owner-only grants work. Upsert rotation, the 1000 clamp, the clock-backwards guard and all check constraints are consistent with the PK cap of 576 rows per actor.

**Minor, not blocking:**

- `latest_reported_at > observed_at` is treated as invalid. Both come from statement timestamps, so a write committing between the snapshot's function start and its read can produce a transient "unusable" page. A refresh clears it. Consider allowing a few seconds of slack.
- The migration assumes `private.require_uid`, `private.fail`, `private.platform_actor`, the three billing roles, and authenticated USAGE on schema `private` all pre-exist. I could not verify those from the listed files.
- The page title remains "Billing operations" although the page now also shows save and export counts.

**Privacy, permissions, behavior:** The log line carries only event, server UUID, op, outcome and time. The RPC takes only two allowlisted strings. Responses, statuses and headers in all three routes are unchanged, thrown errors are rethrown untouched, the sign-in redirect stays outside observation, and the counter write is scheduled after the response with a 750 ms abort. UI copy states the unverified, user-reported nature up front and never renders zeros for missing data.

Sol follow-up: the per-outcome validator bounds were corrected by Opus before integration, with regression tests for legal multi-outcome totals. Source page title updated to Operations. The schema/role preconditions exist in prior migrations and are exercised by the complete migration harness. Timestamp anomalies continue to fail closed; no time slack added.
