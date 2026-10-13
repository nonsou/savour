# Fable internal alert foundation review

Verified actual Claude Code claude-fable-5-1 source review.

I've read all six files. Here is the design and its blockers, no edits made.

**Verdict**: the foundation is feasible as an additive migration reusing the two existing owner-only data helpers. Three blockers need owner decisions first.

**Design (smallest)**

- **Tables, schema `operations`** (already locked down, RLS on, no client grants). `alert_state`: primary key on static code plus nullable connection id, mode, and op. Columns: active boolean, episode count, first/last observed, cleared at, provenance enum (`billing_authoritative` or `app_unverified`). One row per key, updated in place, never appended. `scheduler_heartbeat`: a single row with last run at, outcome (`ok`, `billing_unavailable`, `app_unavailable`), and run count.
- **Evaluator**: `private.evaluate_operations_alerts()`, volatile, security definer, search_path empty, UTC, statement and lock timeouts, no grant to any role. It calls the existing `private.operations_snapshot()` and `private.application_outcomes_snapshot()` inside savepoints. It then upserts alert rows: a newly true condition sets active and increments the episode counter; a false condition with a trustworthy observation sets active false and cleared at; an unchanged condition touches only last observed.
- **Fail close**: if either helper raises or returns malformed JSON, the function writes the heartbeat with the failure outcome and does not touch any alert row from that source. Alerts can only clear on a successful, validated read of their own source. Missing or stale heartbeat is itself an alert-equivalent on the read side.
- **Cron**: a separate job in the operator schedule file, not a migration, every five minutes, calling only the evaluator. No pg_net, no Vault, no HTTP.
- **Read RPC**: `public.platform_operations_alerts()` invoker wrapper to a private definer that runs `private.platform_actor(false)` first, same as the two existing snapshots. Output: codes, enums, UUIDs, counts, timestamps, heartbeat. Non-admins get forbidden. The page renders heartbeat older than ten minutes or absent as "not monitored", never healthy.
- **Self-outage**: the evaluator runs inside the same database it monitors. If Postgres, pg_cron, or the evaluator itself stops, no row is written and nothing can say so. Only the stale heartbeat, read by a human or an external prober, reveals it. State this on the page as a static disclosure.

**Blockers**

1. **Threshold duplication**. The billing rule set lives only in TypeScript at `saas/src/lib/operations.ts:8` and `saas/src/lib/operations.ts:276`. The evaluator must re-express it in SQL. Without a parity test that feeds one fixture snapshot to both evaluators and diffs the findings, the two will drift. Scope for v1 should be only the two named signals, backlog age over fifteen minutes and app failure counters, to keep the SQL rule set small.
2. **App source is unverified**. Any signed-in user can inflate their own failure counters, so an `app_unverified` alert is a prompt to check hosting logs, not an incident. The sustained rule in `saas/src/lib/application-outcomes.ts:159` works on hour buckets, so the earliest a clear can happen is the next clock hour. Owner must accept that latency and the provenance label.
3. **Cron file is operator-run**. The schedule file is applied by hand by Sol, so the new job needs the same manual step and the same proof convention. A migration cannot schedule it.

**Smaller notes**: the `operations_snapshot` helper is marked stable, so it is safe to call from a volatile evaluator. `cron.job_run_details` remains uninstrumented, which is why the heartbeat row is required. Channel delivery stays out entirely; the inbox is the alert table plus the page.

Coordinator scope resolution: this is development-only internal warning groundwork, no incident certification or external delivery. Include SQL/TS threshold parity tests, clear app provenance, coarse expiry disclosure and separate operator schedule proof. Owner confirmed self as initial recipient; channel/support hours are pending human choices and no service commitment is inferred.
