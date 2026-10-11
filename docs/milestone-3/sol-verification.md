# SAVOUR Milestone 3 — Sol independent verification

Status: development verification in progress on 11 October 2026. Milestone demonstration and acceptance are pending. Production/Firebase MVP/root HTML unchanged; no main merge, billing or new spending.

## Reviewed implementation and development database

Actual Claude Fable5.1 architecture and Opus5.5 implementation. Sol's eight pre-application findings were repaired; independent regressions run unchanged: SQL invariants4, historical snapshots2, analytics6, actual server-action business context6 =18 passing. The complete initial independent gate passed230 tests, with one optional fixture writer skipped; typecheck/lint clean. Opus built in isolated .next-m3-opuscheck.

Applied only to savour-dev ilhutasrxnbtssswmgam, in order: m3_actions_inbox, m3_report_snapshot, m3_analytics. Cloud versions aligned to CLI filenames; statements unchanged. All nine migration files sealed; M3 hashes are in sol-m3-seal.test.ts. The 15 original approvals passed content/hash/formula pins before application, after each migration and after rollback tests. Outgoing pre-M3 redaction remained byte-identical in independent local fixtures.

Real PostgreSQL transactional scripts (rollback): M1 security153, guest closure23, M2 directory82, lifecycle158, M3 actions205, analytics36 =657 assertions. Populated development data exposed pre-existing global test-fixture counts: lifecycle audit counts/sample-subject counts and M3 audit helpers included unrelated businesses. Sol scoped assertions to their fixture businesses, retaining exact expected counts and all application behavior. All scripts then passed. No migration or application logic was changed for those harness fixes.

Advisors: new M3 foreign keys have covering indexes, no M3 missing-index warning. Notifications and report_revisions intentionally have RLS with no direct policies/grants (RPC-only). Existing Auth leaked-password-protection warning remains (passwordless login used);16 older M1 missing-FK-index notices remain outside M3. Unused-index notices on tiny QA data are informational; no index removed. Do not claim all advisors clean or production readiness.

## Genuine concurrency

Preliminary pairs of managed SQL calls produced stale_version but no observed overlapping wait; these count only as sequential/stale-save evidence. An initial browser probe used a nonprivileged statistics observer and timed out; it is not an acceptance result.

A real signed-in owner browser then competed with a managed SQL transaction using a privileged observer inside the holder, refreshing pg_stat snapshots. Observer prints only fixture backend IDs/wait type/blocker IDs, never unrelated SQL or credentials. It commits once the second connection is observed waiting.

- Return versus verification: holder91187 returned the Ready v11 action for work; browser waiter91183 waited on transactionid, blocking_pids[91187]. Final action In progress v12, no verification event from the loser. Found a frontend defect: Next refreshed available steps and removed the losing Verify form, also hiding its error. Opus repaired persistent save feedback with a stable page-level result region. Final real repeat: holder92698 returned Ready v13; browser waiter92702 waited on transactionid with blocking_pids[92698]. Browser visibly retained “Verify and close: not saved”, “Nothing was saved by this attempt”, In progress v14, and no longer offered Verify. Proof image /tmp/savour-m3-qa/persistent-save-result.png.
- Approval first versus action creation: holder91289 approved session546e8dcf-8a7a-4c84-9ccd-4a2c59f6af12 while browser waiter91293 waited on transactionid, blocking_pids[91289]. Later action9c95e06e-ddad-48d6-b3d6-23c62fa07e6d v1 created15:51:48Z after approval15:51:39Z, absent from frozen actions by ID/version. Browser shows action assigned and approved session; later action belongs only in dated current appendix.
- Creation first versus approval: holder91312 created actionc6bbe828-7fbe-4195-ad64-5f2cfb591808 v1 while browser approval waiter91303 waited on transactionid, blocking_pids[91312]. Created15:52:53Z, approved15:53:04Z. Frozen actions contains exactly that ID/version. Both orderings are supported by actual lock observations and frozen identity, not timestamps alone.

M2 same-key import/invite overlaps still remain unobserved follow-ups; do not claim them covered here.

## Disposable demonstration data

Business4153190b-54b3-42c5-8ba5-7679002fa122, QA Lagos; subjectb3087541-cab9-466a-870f-02a09644dc22 (QA M3 Café – disposable). Six comparable approved inspections under TV121043e5-b2ff-4716-afc9-101bc7741f16 give quality80,80,80,70,70,70 and two late outcomes among the last three. Separate critical-hygiene TV3eef8bf7-9afb-469f-9875-b78a3200bf05 generated a finding independent of the average; founder session102e1f0f-2a64-4156-a590-3c0f79ee3b07. These are explicitly disposable examples, not business evidence or standards.

## Remaining

Normal Assessor workflow/sign-in, final closed-action report exports/privacy, hosted-font checks and multi-business wrong-context 404 remain. Protected Preview/exact callback, canonical Notion checkpoint and founder demonstration pending. The requested 390×844 browser override did not take effect: measured widths remained827/1280; no390px mobile pass is claimed. No milestone acceptance or production release claimed.

## Final local gate and browser checks (before Preview)

Sol independently reran the final suite:249 passed,1 optional fixture skipped, typecheck/lint exit0. Opus isolated build .next-m3-releasecheck passed; generated config unchanged.9 migration checksums sealed; root MVP HTML unchanged relative to accepted M2.25 approval snapshots checked, all15 original baseline pins unchanged after the races, transitions and exports.

Normal Owner browser completed evidence override with required reason, own-resolution verification with required override reason, closed v16, reasoned reopen v17 and cancel v18. Notices mark-one and mark-all exercised. Guest normal signed-in browser is denied Actions, Analytics, Inbox and private report; navigation exposes only My sessions. Staff magic-link handoff is pending.

Analytics filter by comparable TV:6 sessions,6 scored subject-sessions,coverage100%,attendance100%,quality75%,combined74.4%; decline80% to70% and2late in last3. Final CSV/PDF match. All2 PDF pages visually rendered without clipping/overlap; generated decline copy now uses plain “to” and no unsupported-glyph warning; actor names absent. Frozen founder report contains its critical finding and no action; newly assigned staff action7780ecbc-be6d-4633-9525-bf0d02c35e30 appears only in dated current appendix as Created after this approval.

Vercel project/team verified prj_m7bHTgABv1pAmt7eb5FuJgvh0ELA/team_fZk4mi31yb336suO56X26CZG. Source upload dry run140 files2675696 bytes, fonts included, .env.local, all .next builds, node_modules, Supabase temp and tsbuildinfo excluded; no credentials in upload.
