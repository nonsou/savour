# Fable 5.1 pilot preparation review

**Verdict:** the offline preflight/audit tool is the right first slice. It builds nothing that exists already, touches no schema or provider, and produces the evidence MIG01 needs before any mapping or import work. Keep it, with the scope tightened below.

**Minimum scope**
- A standalone CLI under its own package, not inside the Next app or edge functions, with no Firebase SDK dependency. Input is a local JSON file path only.
- Compute a SHA-256 of the raw file bytes before parsing and print it in the report.
- Walk sessions, submissions, and the vendors array. Assign every vendor entry a source key tuple of session key, submission key, array index, and vendorId. Array index is the only identity for entries, so flag duplicate vendorIds within a submission as exceptions rather than resolving them.
- Inventory counts per level, plus a schema profile: assessmentVersion present or absent, criteriaSnapshot present or absent, attendance as boolean versus number versus missing, approval triple complete versus partial, unknown criteria keys.
- Every anomaly becomes an exception record with the source key and a reason code. No defaults, no invented attendance, no recomputed totals. Original score fields pass through untouched.
- The report carries one of three states: UNKNOWN_SCHEMA, INSPECTED_WITH_EXCEPTIONS, or INSPECTED_CLEAN. There is no "signed off" state. The tool must print that signoff is a human step.

**Acceptance tests**
- Synthetic fixtures: complete version 2 entries, historic entries lacking version and snapshot, mixed attendance types, unknown criteria key, approved and unapproved sessions, duplicate vendorId, empty vendors array, malformed JSON.
- Determinism: the same fixture yields byte-identical report and checksum across two runs.
- No network: the test stubs fetch and the Firebase module and fails if either is invoked.
- No PII in logs: a fixture containing a recognisable email and name must not appear in stdout or log output. Only counts, states, and hashed or structural keys appear.
- No recomputation: the report never contains a totals field, and original score values round-trip byte-for-byte in the preserved-originals output.

**Rollout constraints**
- Do not run against a real export until the owner supplies an authorized one. Record that gate in Notion alongside the deferred Bachs tests.
- Reports and inputs stay outside the repo and outside CI artifacts.
- The original MVP HTML is read-only reference. The tool must not import or modify it.
- Do not describe fixture performance as representative of the later load target.

**Deliberately out of this slice**
Field mapping to the SaaS model, restore and rollback rehearsal, the pilot operations runbook, and OPS01 telemetry. Each is its own slice and the audit report is their input. The one adjacent artifact worth producing now is a draft field-level mapping table as a document, derived from the schema profile, so Sol can verify the schema investigation independently of the code.