# Fable 5.1 operations review

**Verdict:** Ship it as specified. The slice is real work, not theater, on two conditions. Every alert code must map to a named runbook action, and the page must state that detection latency equals the manual check cadence. Without external delivery this slice shortens time-to-diagnose, not time-to-detect, and the page should say so in the same box as the uninstrumented telemetry list.

## Pitfalls that would make it wrong

- **Worker-required predicate drift.** The snapshot's "connections that should have runs" must come from the same SQL the cron uses to select connections. Duplicating the predicate (enabled, or disabled with pinned subscription) in the RPC is the most likely way to show green for a connection the cron actually skips. Factor it into one function or view and test both callers against the same fixtures.
- **Run outcome is underdefined.** Define success in SQL, not in the UI. Suggested rule: finished_at set and error_code null is success, finished with error_code is failure, failed items above zero with null error_code is a distinct "partial" code. Order by finished_at then id so ties are deterministic. Report three separate facts per connection and mode: latest finished run outcome, latest successful finished_at, and oldest unfinished started_at. That is what makes "failure hidden by earlier success or new unfinished" impossible.
- **Stuck versus stale are different actions.** A processing row whose lease_until has passed, or an unfinished run older than a few minutes, means a crashed or orphaned worker. A missing recent run means the cron is not firing. Give them different codes.
- **Free text must not reach the client.** Use an explicit column allowlist in the RPC, never a whole-row cast. If error_code is free text today, collapse it in SQL to a small enum with an "other" bucket. Validate provider, environment, and status against known enums in TypeScript, and render anything unknown as "unknown" with the page in error state, never raw. Messages stay static strings.
- **Clock source.** Compute every age in the evaluator against the snapshot's observed_at, never the browser clock. Negative ages clamp to zero and raise an error code rather than silently passing. The "snapshot age" shown to the operator is the only client-clock value and should be labeled approximate.
- **"Collision" has no definition in what you described.** If it is not an existing column or enum value, drop it from this slice rather than invent a classification.
- **Query cost.** Counts over webhook_inbox need partial indexes on nonterminal statuses with received_at, and worker_runs needs an index on connection, mode, finished_at. Set a statement_timeout on the function so a slow query becomes a visible error state instead of a hung page.
- **Grants.** The private function gets no grant to authenticated. The public wrapper is the only entry point, checks the actor before calling through, and is tested for denial as an error, not an empty result. Add the RPC denial itself to the "not instrumented" list.
- **Feature flag.** Skip it. The page is already gated by the admin registry, the migration is additive, and a flag adds a dormant path with its own test burden. Rollback is a normal deploy revert. The function can stay in place harmlessly.
- **Runbook honesty.** Owner, hours, escalation, and restore drill stay as visible unassigned placeholders. The triage runbook will need the free text the page hides, so it must document the aal2 database path for reading it.

## Acceptance requirements

1. Migration test on local Postgres: anon denied, authenticated non-admin denied, revoked admin denied, enrolled admin at aal1 and aal2 succeeds, private function not callable by authenticated, search_path empty, all references schema-qualified.
2. RPC returns only the allowlisted shape. A test asserts no key outside the allowlist and no string field other than the enums and UUIDs.
3. Predicate parity test: cron selection and snapshot "required" set agree on fixtures covering enabled, disabled with pinned subscription, and disabled without.
4. Evaluator boundary tests: exactly at and one millisecond past each threshold, null oldest, zero required connections, expired lease, future next_attempt still counted, failed latest after earlier success, unfinished run after failed run, required connection with no runs ever gives not-measured, runs on a non-required connection never shows healthy, global null-connection review count, resolved rows excluded, unknown enum value gives error state, schema validation failure gives error state.
5. Overall status precedence is error, then attention, then not measured, then healthy. Healthy requires every required connection measured and green.
6. Page is server-rendered with no-store caching, refresh is a full reload, no polling, no write path exists.
7. The uninstrumented list, the manual-check cadence, and "billing green does not mean platform healthy" render on every load, including error state.
8. Dev snapshot read and preview deploy stay within the existing authorization. No recipients, integrations, provider calls, or cron changes in the diff.

## Final security refinement

The initial public-definer recommendation was superseded after the existing repository security contract rejected public privileged functions. The final design uses a public invoker wrapper, a guarded private definer entry and an owner-only private data helper. Fable re-reviewed that refinement:

Verdict: safe and consistent with the existing architecture. The pattern is the standard one for this constraint: public surface stays INVOKER, privilege elevation lives only in the private DEFINER entry, and the admin gate runs before any read regardless of which entry the caller hits. The guarded private entry being directly reachable by authenticated is acceptable because it enforces the same registry and verified-sub check first, so the public wrapper is a convenience, not a security boundary.

Must-fix items:

- **Explicit REVOKE in the same migration** for all three functions, including the owner-only helper. Postgres grants EXECUTE to PUBLIC on creation by default, so "not granted" is not enough. With authenticated holding USAGE on the private schema, an un-revoked helper is directly callable by anyone.
- **Fully schema-qualify every reference** inside the DEFINER body and the helper, including auth functions and any types. With an empty search_path, an unqualified name fails at runtime, and the failure path must not be reachable only after a partial read.
- **Uniform denial error** from the DEFINER entry for non-admins, matching the existing guarded functions. A distinct message or a different error on the direct private path leaks the function's existence and behavior.
- **Identical signatures and volatility** between the public wrapper and the private entry, both STABLE with no side effects. Any drift makes the two entries behave differently and defeats the parity claim.

Worth confirming, not blocking: that the owning role of the DEFINER function is the same role used by the existing private definers, so RLS bypass semantics on the underlying tables match the established pattern rather than widening it.
