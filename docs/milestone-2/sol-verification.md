# Milestone 2 independent acceptance — in progress

Development only. Opus 5.5 implementation and Fable 5.1 architecture were explicitly authorized to process development code, excluding secrets and real customer data. Branch feat/saas-milestone-2. No production app release or Firebase MVP change.

## Verified so far (11 October 2026)

- Sol ran the full final implementation suite: 164 tests passed, one optional PDF fixture writer skipped. Typecheck and lint previously passed independently. Opus reports the final isolated build, typecheck and lint passed; local QA now runs this build at 127.0.0.1:3100 and localhost:3000 with existing normal owner/guest cookies.
- Reviewed and applied four new migrations to savour-dev (ilhutasrxnbtssswmgam), in filename order. Aligned cloud migration versions to the CLI filenames. All six applied M1/M2 files are now pinned by SHA-256 and must never be edited; any fix uses a forward migration.
- Real Supabase Postgres rollback checks passed: M1 security 153; M1 guest closure 23; M2 directory 82; M2 lifecycle 158. Total 416 assertions. All fixtures in those scripts roll back.
- Before and after the M2 upgrade, m2_snapshot_pin.sql confirmed all seven saved approved QA snapshots matched their baseline hashes. Local legacy tests confirmed identical historical arithmetic and redaction; current browser renders savour-m1.1 with quality80, combined82.5 and coverage100 for the prior guest report.
- Independent directory reproductions passed after repairs (receipt identity, partial contact merge, ambiguous location); expired guest can accept a fresh invitation without reviving old scope. Mixed N/A denominators no longer receive a misleading overall percentage spread.
- Advisor after index forward fix: no missing M2 foreign-key covering indexes. The 16 pre-existing M1 foreign-key suggestions, intentional report_revisions RLS-with-no-direct-policy, password protection warning on the passwordless development setup, unused small-database indexes and Auth connection sizing remain documented development/production follow-ups; no security protections were weakened.
- Root index.html/admin.html/review.html unchanged versus 5e26088.

## Browser and concurrency evidence so far

- Owner normal sign-in survived the build switch. Added QA M2 Grills category through the UI.
- Invalid CSV gives three per-line errors (invalid type, unknown location, repeated external ID), with no import action.
- Uploaded a disposable CSV using the real file chooser: BOM, Unicode Café, quoted comma, CRLF. Preview shows two creates, explicit confirmation and disabled import until checked.
- Genuine directory-edit/import overlap: a managed SQL transaction called public.upsert_location to temporarily rename QA Lagos, retaining the directory advisory lock. The signed-in browser confirmed the prepared CSV import while this transaction remained open. The SQL harness refreshed pg_stat snapshots and observed a different backend waiting on that exact advisory lock (holder25518, waiter25519). After release the browser import recomputed the plan, rejected it because the location name changed, and a database query confirmed zero rows for M2-QA-001/M2-QA-002. Location was restored through the audited RPC. This is actual contention, not a timing guess.
- Retried valid preview/confirmation through the browser: exactly two subjects imported. Rechecking the same file reported all unchanged and no import action. An email-only update explicitly previewed the before/after contact, preserving name/phone and directory links; confirmation saved one update. Subject editor shows the saved category, external ID and usual-location checkbox.
- Preliminary two managed-connector calls returned the same import receipt with one created subject, but probes showed no overlapping wait. They are counted only as sequential idempotency evidence, not real concurrent proof. The separate disposable overlap workspace is 6fc85f30-66b0-4041-bd98-e055b36a5e27.

## Browser acceptance completed

- All three labelled SAMPLE packs completed assessment, review and approval. Food vendor A scored80/combined82.5; vendor B had a reasoned missing-response waiver, giving50% coverage and null quality/combined for B. Restaurant scores80/100 gave90 mean; supplier N/A required explicit reviewer confirmation before approval. All samples remained excluded from the four original approved-business totals.
- Downloaded sample CSV/PDF matched reduced coverage, waived missing response, null headline and reason. Rendered the one-page PDF and checked layout visually: clear SAMPLE warning, no clipping or broken glyphs. Mobile report and food/restaurant assessment widths were390 with scrollWidth390.
- Real disposable food session dcdd34e1-b8dc-43e1-8934-b011ce6ddd49: draft window edit saved; explicit opening worked; mobile scores saved v1; reasoned removal/restoration retained scores and exposed the restoration warning; removing the last reviewer was blocked; reasoned close extension saved; approval yielded80 quality/82.5 combined/50% attendance, absent supplier unscored.
- QA found a retained assignment producing an unnamed Edit row after soft roster removal. Opus filtered the assessor panel and its visibility predicate to active roster membership. Evidence remains in history/reports. Typecheck/lint passed and Sol rebuilt in a separate directory.
- Attendance-only session327f5ca7-f240-42cf-8690-f0487da15229 coexists on the same11October date/location. Assessment had no quality criteria; middle attendance approved3/5 with quality not applicable and no combined headline.
- Legacy guest session040f4861-24b2-4869-9da1-e75d68086880: revision reopen alone denied the guest; explicit collection reopen restored its existing unexpired grant; named correction request blocked approval; guest Taste5 resubmission saved v2 and resolved the request; approved r2 quality82.9/combined85, then fresh guest access denied. r1 still renders savour-m1.1 quality80/combined82.5. Database pin check after browser work checked12 snapshots with all seven original baselines unchanged.

## Remaining before demonstration

Final rebuilt UI regression, protected Preview, commit/push and Notion evidence update. True directory writer/import overlap is proven above. Same-key import concurrency and the invite/roster lock-order overlap have structural SQL coverage and sequential idempotency evidence but have not yet been observed through two overlapping live sessions; do not describe them as live concurrency tests. No production-readiness claim.

### Final local gate

Independent final suite:164 passed,1 optional fixture writer skipped. Final separate build compiled successfully. Independent lint caught an unescaped JSX apostrophe in draft help copy; corrected typographically and lint passed. Final rebuilt browser confirms removed subjects no longer appear as unnamed assessment rows, and restoration/reapproval succeeds. Seven legacy snapshot baselines remain pinned. No root MVP byte changes or environment files staged.

## Hosted development checkpoint

Source5ad0021, protected Preview https://savour-1b1hl27e4-nonsous-projects.vercel.app, dpl_D4gUhJp7tXwUqyeREa9DTjQhXhYJ. Vercel inspect confirms READY/preview. Remote Next build passed with Production guard explicitly confirming Preview. Upload manifest excludes environment files and QA outputs. Login200; anonymous session CSV401 with private,no-store. Supabase exact callback/SiteURL saved and reload-verified. The approved static Production deployment remains dpl_GsAftswtQAZtJ2Y5kdiL5Ff8iLgx unchanged.

Owner’s normal sign-in email sent; founder email-link opening is pending. Full local signed-in QA is complete; hosted authenticated verification and founder demonstration are pending. Both canonical Notion documents were appended and refetched to confirm this checkpoint. Main/Firebase remain unchanged.

## Hosted sign-in and demonstration handoff

Founder completed normal owner email sign-in. Hosted workspace/dashboard verified:6 current approved non-sample sessions and3 sample approvals excluded. Hosted approved food report matched80/82.5/50; authenticated CSV and PDF downloaded. Rendered hosted PDF visually inspected: one page, Unicode intact, clear absence/restoration evidence, no clipping. Browser download operation took several minutes despite its timeout setting; this was tool latency, not an application timeout result.

Created hosted UI draft03c655dd-8d3d-4d24-a8ed-69a93b4e1f66, Restaurant operations v1, one disposable QA subject, owner assessor/reviewer.24hour draft window save persisted after reload. Draft remains unopened for founder demo and does not count in analytics. Both Notion documents appended with final handoff. M2 ready for founder demonstration; founder acceptance pending. Hosted owner smoke does not claim all local role/edge checks were replayed remotely.
