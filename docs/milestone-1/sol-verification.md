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
