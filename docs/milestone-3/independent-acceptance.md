# Milestone 3 independent acceptance plan

Baseline:164 passing tests,1 optional PDF fixture skipped;15 approved dev snapshots pinned before changes. Baseline sourceb76b400; branchfeat/saas-milestone-3. Results pending, this document is not test evidence.

## Permission and integrity tests

Use two disposable tenants and owner/admin/scoped reviewer/assessor/viewer/guest identities. Verify direct SELECT/RPC/action/history/export/inbox/analytics permissions, not merely hidden navigation. Subject/session/location/member/notification IDs from tenantB fail fromA. Assignee membership/location revocation immediately denies fresh read/save. Reviewer session revocation denies actions/findings and inbox payloads. Guest denied modules regardless of active invited collection. Viewer receives only approved in-scope and server-redacted identities. Action reassignment cannot let old assignee mutate new work or leak evidence. Manager-owned action can finish through explicit reasoned override; Reviewer self-verification blocked.

## Transactions and retries

Create with same key/same payload twice creates one action/receipt/event; changed payload conflicts. State/metadata edits require non-null expected version, allowed transition, appropriate actor and evidence/reason; stale saves never overwrite. Two real overlapping connections prove action update vs verification and action snapshot vs approval ordering. Use live backend/lock evidence; timed scripts alone are not concurrency proof. No invalid command partly writes events/inbox/snapshot.

## Historical reports

Compare all15 baseline rows by inputs_hash AND computed content hash before/after migrations, transitions/reassignments and exports. Existing formulas retain exact arithmetic. New approvals capture action snapshot under session-first lock. Later action edits do not alter snapshot. Historical exports label original action snapshot vs current appendix, with time and approval context; no mixing rows from another revision or sample into business totals. Contacts stay private; CSV user text formula guards; PDF metadata/assignee redaction verified with long/Unicode notes.

## Analytics

Freeze source fixtures and expected dataset:0/null,attendanceOff,attendanceOnly,early/middle/late/absent,unknown,Notassessed,missing/waived,compatible/incompatibleN/A; old/newversions and formulas; multiple assessors/session; categories renamed/archived/reassigned; stable subject rename; real/sample. Six comparable subject-sessions produce exact decline thresholds. Fewer6 showsInsufficientdata. Repeat-late rule needs3 eligible sessions; unknown accounted clearly. Actions inClosed/Cancelled never overdue; due today counted correctly inworkspaceTZ, DST/weekboundary. Critical finding independent of highmean. Filteredtables/PDF/CSV showmatchingfilters, denominators, provisionalseparation,revision andsourcecounts. No silent averaging unknownformulas or differentapplicabilitypatterns.

## Inbox

Creation is transactional with business event or durable retry job. Unique event/recipient keys prevent doubletap/retry duplication; due-date changes create correct reminder generation while obsolete reminders hidden/invalid. Markread cannot target anotherrecipient; notificationID cannot exposeanotherworkspace. Removeactor/recipient scope: staleentry never yields oldpayload/link. Assignment,correction,verification,approval andduedate paths tested. No externalemail/SMS/WhatsApp duringM3.

## Browser / release

Normal authenticated owner/staff/guest cookies, desktop and390x844. Actions create/progress/evidence/verify/reopen/cancel; errorstates/stalesave; frozenreport/liveappendix; filteranalytics andsourceflags; inboxmarkread andscopeending. User receivesclearstepsforrequiredemail/MFA. Requiredmigrationreview,emptyreplay,realrollbackSQL,advisors,typecheck/lint/build,isolatedlocaloutput,credential/artifactmanifestcheck,featurepush,protectedPreview andexactcallback. RootFirebaseHTML byteunchanged;Productionplaceholder unchanged. Founder demonstrates actionclosure/reportanalysis beforeacceptance. No productionreadinessclaim.
