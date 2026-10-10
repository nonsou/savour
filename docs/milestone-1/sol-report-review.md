# Sol report review — resolved locally; browser acceptance pending

1. scoreSubject currently calculates mixed applicable-set quality and combined averages even when comparable=false. summarizeSession excludes mixed quality but still includes mixed combined, and rollupByTemplate also includes mixed combined. This silently pools unlike N/A sets in a headline metric despite the PRD and coordinator direction. Fix by grouping comparable sets explicitly, or returning null for subject quality/combined when sets differ while keeping per-assessor detail and a clear explanation. Exclude incomparable combined from all session/dashboard totals. Add a regression with one assessor using all criteria and another excluding a criterion.
2. Coverage currently counts every subject with any quality result as complete, even when requiredAssessors=2 and only one response exists (status=incomplete). Coverage must not claim complete in that case. Exclude incomplete/unknown outcomes from completed coverage and approved-style summary inclusion; provisional detail may show available responses with clear labels.
3. PDF replaces unsupported characters in names with ?. This can alter Nigerian/customer names (e.g. Ọlá). Embed a suitable Unicode font and test expected local names, or otherwise preserve the original text without silent loss. Wrap long unbroken words/notes so text cannot overflow the page; test a 2000-character note.

Remote DB update: m1_core has been applied to savour-dev and passed 153 actual transactional assertions. Do not modify the initial migration anymore; generate subsequent migrations using the CLI if needed. No client workspaces or fixture users remained after rollback. See /tmp/savour-coordinator-status.md.

Authentication testing: automatic review rejected direct creation of four Auth accounts because plaintext passwords appeared in tool arguments. No such accounts were created. Normal signup using example.invalid was rejected by Auth as invalid email. Sol asked owner for an inbox they control to test normal signup. Do not seed Auth users or expose credentials. SQL transaction fixtures already passed and rolled back.

4. Auth redirect validation: safeNext accepts a slash + TAB/newline + slash + external host. URL parsing strips controls, converting it to a protocol-relative external URL in auth/callback or auth/confirm. Reject control characters/backslashes and verify parsed destination origin against a fixed base. Add tests for slash-tab-slash, slash-newline-slash, slash-backslash, ordinary /w paths and encoded query parameters.
5. Verify .gitignore covers node_modules, .next, .vercel and all secret env files before committing; the current bootstrap initially ignored only .env.local.


Resolution: Opus addressed findings 1–5 and the subsequent form-state review. Sol reran the 93-test suite and production build and visually inspected both final PDF pages. See sol-verification.md for the exact tested/pending split.
