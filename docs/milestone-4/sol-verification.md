# Sol independent verification — 12 October 2026

Status: development implementation and database verification completed; external sandbox and founder demonstration remain pending. Actual Opus 5.5 implementation and Fable 5.1 architecture review were used, excluding credentials and real customer data.

- Independent final local suite: 310 passed, one optional PDF fixture skipped. Earlier checkpoints were 292 and 302. Independent platform counterexamples all failed before repair and now pass unchanged.
- All seven Edge entrypoints passed Deno 2.9.6 type-check with the pinned official packages resolved. Opus also completed final lint/typecheck and isolated Next build; Sol final lint/typecheck completed separately.
- Frozen worker-repair draft (SHA-256 2307fee44fb583d147ee81a55e0bdb888bd02ad815135ad512ace3d50ff53e11): 257 real Postgres/Vault assertions passed in an explicit rollback-only preflight. This evidence did not include the later admin fixes.
- Final SQL SHA-256: 60d7161ee9a63110aa72f8e7815e4cbfb867ff00e76f86910cfcc3d63e5980e0. Applied only to savour-dev ilhutasrxnbtssswmgam as history version 20261012090945, name m4_billing. Local filename aligned to that exact history version without changing SQL content.
- Applied final migration: 263 real Postgres/Vault assertions passed (257 base plus 6 independent rotation/stale-account/revoked-admin checks). Every disposable fixture rolled back. Provider connections, paid periods and platform admins were zero after tests.
- All 25 existing approved snapshot body/hash/formula pins verified before and after the database work. The nine earlier migration seals and root Firebase MVP files remain unchanged.
- Backfill: 3 development workspaces, 19 consumed assessments and 1 outstanding reservation. No provider connection or price activated; no real charge occurred.
- Founder QA identity 6496c972-df76-4e5a-985a-057170b20e32 enrolled afterwards as a sandbox platform administrator, after matching its confirmed founder email. Workspace roles alone still confer no platform access; sensitive writes require aal2.
- Security advisor: no new WARN/ERROR in billing/schema permissions. Deliberate deny-all RLS/no-policy INFO on private billing/platform tables; existing leaked-password-protection WARN remains.

The first large preflight request failed with connector request-state expiry. A proposed exception-based rollback was rejected by automatic approval review; the explicit BEGIN/ROLLBACK alternative was accepted and verified. PostgreSQL required owner-only temporary SET ROLE grants inside the rollback test transaction. A private source-staging table contaminated the test's secret-shaped-constant scan, so it was removed inside the rollback transaction before the scan. It was subsequently cleaned up permanently and confirmed absent. No workaround weakened application privileges.

Remaining: scoped runtime credential setup (Supabase CLI currently signed out; human sign-in requested), Edge deployment and real authorization smoke tests, cron evidence, two-connection contention, protected Preview/mobile browser verification, actual Bachs sandbox lifecycle including account-specific NGN recurring evidence, and founder demo. Bachs adapter is implemented but externally unverified; Paystack and Stripe remain pending adapters. No main merge, Production placeholder change, Firebase MVP change or extra spending.

## Delivery checkpoint

Implementation commit 88b1e08 pushed to origin/feat/saas-milestone-4. GitHub push protection flagged two synthetic fixture strings; shortened explicitly fake values retained all 14 affected tests, and the unpublished commit was amended before the successful push. Applied migration content is unchanged. Seven development Edge Functions deployed ACTIVE, with JWT verification on the five user-facing handlers and custom authentication on webhook/worker. Runtime configuration remains pending Supabase CLI sign-in. Vercel CLI Preview failed Not authorized; the connector also returned 403 for the verified nonsous-projects scope, so no M4 Preview is claimed. Both normal CLI sign-ins requested from the founder; no token retrieval or protection weakening. Notion PRD/SOP updated with actual evidence and remaining gates.


## 12 October 2026: protected Preview, runtime setup and sandbox key-format repair

CLI authentication is restored. Protected Preview https://savour-6faosz1wn-nonsous-projects.vercel.app is READY, target preview, deployment dpl_6NenF6DGKgv28gDbDNPTEVSizFup. Production placeholder/protection remain unchanged. Exact callback added while preserving seven existing URLs; owner sign-in and MFA verified. Draft Bachs QA connection created at aal2, with no credential or price activated.

Three function-only runtime roles connect through the observed EU shared pooler; each denied direct table access. Runtime URLs and job token configured via owner-only files into Supabase secrets/Vault, not source. Four cron schedules enabled. Manual worker and cron HTTP responses succeeded with zero connections; this does not prove provider lifecycle or per-connection processing.

Founder reported a sandbox key with the documented sk_sandbox_ prefix and one ASCII hyphen; no key value was requested or read. Actual Opus 5.5 session 6703a4d8-b30b-4c17-b380-9ca548cdb7f8 proposed the bounded character-class repair from non-secret source only. Sol applied it to credential intake, Bachs client and key redaction. An additive migration changes only the Bachs registry pattern atomically, restoring its identical immutability trigger; original migration stays sealed. Migration applied to savour-dev as 20261012111434_bachs_sandbox_key_hyphen. Live SQL confirms hyphen accepted, live/dot/space rejected, registry trigger enabled.

Synthetic fixtures reproduced the old storage/client/redaction failures. Complete suite after repair: 312 passed, one optional fixture skipped; typecheck and lint clean. Synthetic hyphenated key traverses storeSecret, SQL/Vault, connection test, mock-provider checkout and worker; a separate test confirms the registry still refuses updates. These mock-provider tests do not prove the real key is valid. Seven Edge functions redeployed ACTIVE with existing authentication flags preserved. No frontend rebuild needed; same Preview URL. Founder must now retry write-only key storage. Real Bachs credential/account/currency capability, payment lifecycle, per-connection cron, concurrency, mobile checks and milestone demo remain pending. Firebase MVP/main/Production placeholder unchanged.


## 12 October 2026: real Bachs credential/account test and JSON driver repair

Founder entered the sandbox key directly into the write-only admin form; only its fingerprint/status were inspected. The sandbox account ID was read from Bachs Account Details and pinned through the authenticated admin form. Adaptive pricing switched off in sandbox; real account GET later independently confirmed it. First actual provider test began but failed recording invalid_checks. This was not an MFA failure: the current frontend error message is misleading for non-MFA errors.

Scoped real Postgres driver probe reproduced that postgres.js3.4.5 serializes a pre-serialized JSON string as a JSON string rather than object. Actual Opus 5.5 session 9a02730e-380f-4fa9-a296-09ea1f1797cf proposed a shared argument adapter. Sol improved it to explicitly bind JSON text as PostgreSQL text OID25 before server ::jsonb casting, avoiding numeric rounding or JSON-null/scalar ambiguity. Applies to every scoped billing JSON parameter; no SQL grant/function changes. Live-driver probes passed object, array, string, boolean, number, JSON null, and exact integer9007199254740993. No provider key or runtime credential printed or transmitted to Claude.

Full regression suite315 passed, one optional fixture skipped; typecheck/lint clean; all seven Deno entrypoints checked and redeployed. Browser then reported real connection test passed at11:28UTC: account ok, organization matched, active yes, adaptive_pricing off. Pending key promoted to credential version1; connection status tested. This is real credential/account evidence, not subscription or webhook lifecycle evidence. No price, webhook, default or live payment activated. Bachs webhook form prepared with exact development endpoint and17 relevant checkout/collection/subscription/invoice/refund/dispute events. Founder handoff required for final webhook creation and signing-secret storage; never read the resulting secret popup.


## 12 October 2026: webhook stored and stored-credential UX Preview

Database confirms both secrets stored, no pending key; Bachs sandbox webhook list shows SAVOUR M4 sandbox webhook, Success,17events. This is endpoint-registration evidence only, not signed-delivery/payment-lifecycle proof.

Founder requested visible saved-key/code status. Actual Opus5.5 sessiond1a1ce1f-95ea-4661-ae49-5007a2b7872b supplied focused edits; Sol applied/reviewed them and added immediate stored placeholders/feedback plus MFA automatic refresh and code clearing on error. No secret/OTP is restored in an input. Saved-only pending keys no longer claim not stored; stored credentials show Replace buttons; credential/test success refreshes metadata/version; non-MFA failures no longer claim authentication is necessarily at fault.

Typecheck/lint and six relevant existing UI tests pass. Applicationcommite034498 pushed. New protected Preview READY https://savour-cx6anbc2p-nonsous-projects.vercel.app, dpl_4bvd4LaTfhH8h4ogrAKhCEEh6zxM, targetPreview, hosted build35seconds. Added exact callback preserving eight prior URLs; unchanged SiteURL. Billing allowed browser origin now newPreview. Owner sign-in email sent, authenticated browser/mobile UX verification pending. No credential re-entry required. Production placeholder/main/Firebase unchanged.
