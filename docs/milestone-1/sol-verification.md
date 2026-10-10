# Milestone 1 independent verification — 10 October 2026

Status: preview candidate, not milestone acceptance or production approval.

## Passed
- Final Next.js production build: 20 routes, no errors.
- Final automated suite: 93 tests passed; one optional PDF fixture-writing test skipped in the ordinary suite and run separately to generate the inspection sample.
- Separate savour-dev database: initial migration applied; 153 transactional security/integrity assertions passed and fixture data rolled back.
- Independent location-revocation and null-version reproducers now deny the bypasses.
- Anonymous local requests redirect workspaces to login; dashboard/session exports return 401 with private, no-store caching.
- Local sign-in at 390 × 844: no horizontal overflow and all visible input controls have labels.
- Both pages of the final PDF sample rendered with Poppler and visually inspected: Nigerian names preserved, absence has no quality/combined score, long unbroken text wraps across pages without clipping. The initial font-subsetting render failed and was fixed before this inspection.
- Applied migration hash unchanged. Legacy index.html, admin.html, review.html unchanged from MVP commit 5e26088.

## Pending acceptance
- Real email sign-in and confirmation, invitation acceptance, guest identity and MFA enrollment.
- Authenticated desktop/mobile workflow from workspace creation through assessment, approval, reopen/reapprove and downloads.
- True two-connection approval-versus-submission race test; sequential transaction/version tests already pass.
- Deployed preview verification.

The owner supplied an inbox for the development sign-in test. The Supabase dashboard needs an interactive sign-in before the coordinator can verify redirect URLs. No confirmation email has been sent yet. Production and Firebase remain outside this work.

## Deployment boundary and guard
Vercel twice assigned a first deployment to Production, including with an explicit Preview flag. Both attempts were removed; zero deployments were verified before proceeding. The owner then explicitly approved a protected static placeholder in savour-dev. That placeholder (dpl_GsAftswtQAZtJ2Y5kdiL5Ff8iLgx) is READY and contains only the agreed development-setup text, verified through authenticated HTTP. It contains no application or database configuration. The existing Firebase/GitHub Pages MVP remains unchanged.

Opus added a fail-closed SaaS build guard in npm build and next.config: only local/Preview builds are permitted. Sol independently verified a simulated production build exits before compilation and reran the expanded suite: 109 tests passed, one optional artifact test skipped. Application Preview verification remains pending.

## Application Preview result
Deployment dpl_DddGTKky9MnJnZ3he7d6cPrzkDy7 is READY as Preview at https://savour-3ycv82af7-nonsous-projects.vercel.app (no production URL). It includes commit fdd31c8 and the production-target guard. Authenticated Vercel HTTP checks returned 200 for the expected login form and application 401 / private, no-store for an anonymous workspace export. This verifies hosting and unauthenticated boundaries, not the signed-in workflow. Canonical Notion SOP and PRD were updated with the tested/pending split.

## Development Auth initiation
The owner signed in to the savour-dev Supabase dashboard. Site URL is now the protected application Preview, and the callback allow-list contains only that exact preview host plus local 127.0.0.1:3100 and localhost:3000 callback paths (including callback query parameters). Changes were verified in the dashboard.

The normal SAVOUR login form successfully initiated email sign-in to the owner-authorized inbox and displayed “Email sent”. This is evidence of email initiation only. The owner must open the link in the originating Codex browser to complete the PKCE flow. Signed-in workflow, invitation acceptance and MFA tests are still pending. No direct Auth account seeding was used.

## Authenticated browser acceptance — 10 October 2026

- Normal email sign-in confirmed for owner nonsou@gmail.com; no direct Auth seeding.
- UI created disposable business 4153190b-54b3-42c5-8ba5-7679002fa122, QA Lagos, four vendor subjects, Food vendors v1 and session 06d9614b-e5ae-47dd-a012-0ba960db27cf.
- Early/middle/late assessments saved version 1 with seven criteria at 4/5. Reviewer confirmation produced attendance 5/3/1; absent attendance 0 with null quality and combined. Quality80%; combined82.5/77.5/72.5; aggregate combined77.5%; attendance75%.
- Missing outcomes blocked approval. Revision1 approved and appeared once in analytics.
- Reopen created revision2; dashboard showed zero approved and one under revision. Changed late to middle, approved revision2; dashboard restored one session (r2), combined79.2%. Preserved r1 still shows late1/5, combined72.5%, mean77.5%.
- Authenticated r1 PDF and CSV downloaded successfully through the documented browser direct-download API. CSV and extracted PDF match report metadata, attendance/quality/combined/coverage; absent quality/combined blank. PDF rendered with pypdfium2 and visually inspected: legible, unclipped single page. Files in founder Downloads: savour-QA-Attendance-and-approval-2026-10-10-r1.pdf/.csv. Initial download-event wait stalled; not counted as a successful download.
- Normal staff sign-in nonsou+staff@gmail.com and email-bound Assessor invitation accepted. QA Staff assessor limited to QA Lagos; no sessions before assignment. Assigned session170bfaf7-2cf2-42ee-ab61-ee9564458f6b appeared, staff saved quality assessmentv1. Direct Team and report access denied. Removing their subject assignment immediately denied the next assessment request.
- Owner authorized nonsou+guest@gmail.com. Guest invitation prepared, but normal sign-in email returned429 before delivery. Built-in Supabase provider has2emails/hour/project; no rate limit, SMTP or verification protections weakened. App message corrected to avoid false one-minute retry promise. Guest acceptance pending.
- Mobile live app390x844: first dashboard headings were excessively compressed. Opus fixed scoped table CSS and review Response class. Coordinator verified real authenticated dashboard/document width390, tables356px with contained scroll728/496; report page390 with contained356/682; review page390 with contained324/528. Readability improved without page overflow. Screenshots /tmp/savour-qa/mobile-overview-fixed.jpg and mobile-review-fixed.jpg.
- Opus ran109tests (one optional PDF sample skipped), lint, typecheck and isolated build after CSS fix; coordinator rebuilt actual local app and verified mobile screens. Subsequent one-line email copy fix passed lint/typecheck.
- Owner authenticator enrollment handed off; user must enter new authentication credential themselves. Guest acceptance, additional role/tenant browser flows and true concurrent approval/submission test remain pending. No final M1 acceptance or production readiness claim.
- Main and Firebase MVP files remain unchanged. Feature-branch commits/pushes and Preview only are authorized; no application Production deployment.

## Authenticator and real overlapping database requests

- Founder completed authenticator enrollment himself. Browser confirms enrolled and verified at aal2; no QR/seed/code read or recorded by Sol. Proof: /tmp/savour-qa/security-confirmed.jpg.
- Verified both overlap orders using one test transaction through the managed SQL connector and a simultaneous application RPC through the signed-in browser. The SQL harness executes the existing public RPCs under authenticated test-owner/assessor claims, against the disposable QA session only; no authentication users were seeded.
- Submission-first: reviewer amendment created assessmentv3 while holding the shared session lock. The harness repeatedly refreshed pg_stat_activity and asserted that another backend was blocked by its own pg_backend_pid via pg_blocking_pids. Once it committed, the browser approval refused its stale snapshot with the explicit reload message. The session stayed in review.
- Approval-first: approval created revision3 snapshot and held the lock. The harness again asserted an independently blocked backend. After approval committed, the staged browser amendment failed with “This session is approved or cancelled and cannot be changed. Nothing was saved.”
- Final database check: approved revision3, data_version12, assessmentversion3, Taste4 (the rejected amendment attempted Taste5), three preserved approved snapshots. This verifies the attempted edit did not modify the approved result. Proof: /tmp/savour-qa/concurrent-edit-refused.jpg.
- Preliminary timing trials did not prove overlap and were not counted. Their harness mutations rolled back when the assertion failed. One preliminary pair proved stale_version sequentially but is not reported as concurrency evidence. Refreshing the statistics snapshot was required to observe newly active waiters accurately.
- Guest sign-in remains pending the built-in email allowance; original guest invitation belongs to a now-closed test session and will be replaced with a fresh open-session invitation for guest acceptance.

## Isolation and updated Preview verification

- Owner UI created second disposable business 53784ce1-1357-44a2-a99c-7beffda8882a. Signed-in staff at localhost was denied its overview and setup pages. Proof: /tmp/savour-qa/tenant-isolation-denied.jpg.
- Fresh open guest inspection 040f4861-24b2-4869-9da1-e75d68086880 includes Early and Middle subjects; its email-bound guest invitation permits Early only. No invitation token recorded here. Normal guest sign-in remains pending.
- Updated deployment dpl_3wK2R3wpvkWYF4mU3gUY5mgksNR7 is READY / Preview at https://savour-3aywezgyu-nonsous-projects.vercel.app, from ae0149f. Protected login returned200 and browser showed expected forms. Anonymous session CSV returned401 with private,no-store caching through Vercel authenticated transport (no application identity).
- Supabase development Site URL now points to the new exact Preview. Added its exact callback host/path; retained prior Preview and both local callbacks. Reload verified four entries. No broad host wildcard, SMTP or rate-limit change.
- Owner MFA is enrolled and verified, but enforcement is still a production launch gate. Milestone acceptance remains open until guest normal sign-in/scoped submission and access-ending checks are complete.

## Guest sender blocker at handoff

One guest retry at 22:21:15 UTC still returned429 / over_email_send_rate_limit, confirmed in Supabase Auth logs. No guest email delivery is claimed. Logs show successful owner/staff requests at21:20:22 and21:54:15 UTC, with rejected guest requests at21:56:32 and22:21:15. The sending allowance did not reset one hour after the first success, so no exact retry time is promised. No additional retries, direct Auth seeding, verification bypass or SMTP changes were made. Guest confirmation/scoped submission/access-ending acceptance remains pending.
