# Automatic owner alert: hosted verification

Verified 28 October 2026 against savour-dev only, project ilhutasrxnbtssswmgam, protected development Preview. No application source change was required.

## Outcome

The owner enabled automatic email at 12:55:51 UTC (13:55:51 Africa/Lagos). The scheduled operations-mailer job sent a synthetic dashboard CSV failure warning at 13:00:03 UTC (14:00:03 Africa/Lagos). Resend accepted it on the first attempt and the owner explicitly confirmed the test email arrived in nonsou@gmail.com. The Resend dashboard was signed out, so this run's delivery evidence is owner confirmation, not an inspected provider Delivered event.

- Ledger: 88a8788e-0a20-4635-af6b-3e21dfc0e4fa.
- Provider message: 01a18298-a0a1-7679-9b47-7faec82b7098.
- Warning: APP_FAILURES_REPORTED:dashboard_csv, episode 1.
- One accepted row, one attempt, one of five automatic attempts used for the UTC day.
- A manual second worker invocation while the warning remained active returned HTTP 200 / ok, zero claims and zero sends. Subsequent scheduled runs through 13:45 UTC also left one record and one attempt. The initial send was scheduled, not manually triggered.

## Fixture and cleanup

A dedicated disposable auth user and one synthetic application_outcome_counts row were created for dashboard_csv / failed. This verifies the counter → evaluator → warning → outbox → scheduled worker → Resend → owner inbox path. It is not an injected real export failure, and does not prove real hosting logs reported an incident. No real inspection, vendor or customer data entered the message.

Only that fixture's user and counter were removed, and the evaluator marked its warning inactive. Its accepted mail ledger and warning history remain as test evidence. Two connector cleanup calls failed with invalid request state; a read confirmed neither had applied, and the scoped CLI cleanup succeeded. Read-back confirmed zero fixture users/counters and inactive warning.

All 25 approved report revisions retain whole-row fingerprint 92ffc939a313f530e7b4814b54deae46. Existing billing jobs, the production placeholder and Firebase MVP are unchanged. Automatic email remains enabled for the fixed development owner address. No customer outreach, live payment or additional spending occurred.

## Verification limits and next work

The final authenticated desktop page showed on, key present, active schedule, one accepted email and no pending/unknown/review work. The 390 × 844 attempt could not synchronize with the browser and the temporary viewport was reset; the new email cards' mobile check remains unverified. No current code change was made, so the previous 875-test full-suite result and final 65-test affected suite are historical evidence, not newly rerun counts.

Support hours and escalation cover remain undecided; no on-call or response-time promise. External outage monitoring, remaining telemetry, operational restore/migration, pilot onboarding and release gates stay open. Deferred billing lifecycle/NGN checks and Paystack/Stripe integrations remain pending. This result closes the development automatic-alert delivery test, not OPS01, Milestone 4, Milestone 5 or public release.
