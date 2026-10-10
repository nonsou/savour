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
