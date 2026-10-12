Read-only source inspection by Sol of tested MVP at index.html:221-228,249,694-714,735-742; review.html:662-672; admin.html session/category/vendor writers. Full Firebase export root contains sessions, vendors, categories, reviewers maps (null collections permitted); each sessions[key].submissions is map; submission.vendors array, entries vendorId/vendorName/businessName/categoryName/att, assessmentVersion=2, criteriaSnapshot keys taste/aroma/appear/hygiene/environ/storage/safety booleans plus attendance boolean, optional attendance number. Attendance stored mapping Early5 Middle3 Late1 Absent0. Scored presence clears qualityscores on att=Absent; absence notice/reason allowed. Presence-only legacy behavior is not zero quality. Historic entries may lack version and snapshot. Session status approved has approvedBy and approvedAt Unix milliseconds Date.now; unknown old approval semantics must be exceptioned, not invented. Submission time/timestamp fields and actions array may exist. Root/category/vendor deleted:true is soft deletion; do not invent rosters or reinterpret current criteria as historic snapshots. No actual export supplied. These notes contain field names, not customer records.

## Source facts from Sol's independent review (2026-10-12)

These are field names and enum constants read from MVP code. They are not customer values. The legacy preflight tool (`tools/legacy-preflight`) encodes exactly these.

### Session (admin.html writer)

- **Fields:** `date`, `name`, `notes`, `activeFrom`, `activeUntil`, `reviewerCode`, `status`, `submissions`, plus the approval stamp `approvedBy` and `approvedAt`.
- **Status values:** `pending` and `approved` are known. Reopening sets `pending` and deletes `approvedBy` and `approvedAt` (Firebase null deletion). `pending` without a stamp is unapproved.
- **`reviewerCode`:** a value that must never be output or copied into SaaS identities.

### Submission (index.html 731-737)

`taster`, `role`, `time`, `timestamp`, `vendors`, `actions`.

### Vendor entry (index.html 694-714)

- **Fields:** `vendorId`, `vendorName`, `businessName`, `categoryName`, `att`, `assessmentVersion` (2), boolean `criteriaSnapshot`, and optional `attendance`.
- **Food scores:** stored under the seven dbKeys `taste`, `aroma`, `appear`, `hygiene`, `environ`, `storage`, `safety` as `entry[dbKey] = Number(input)`.
- **Absent entries** may carry `notice` and `absenceReason`.
- **Present entries** may carry `sample`, `cust`, `obs`, `fu`, `pi`.

### Attendance: `att` versus `attendance`

- **`att` is a text label,** written as `attendanceValue(i) || "—"`.
  - Scored attendance uses `Early`, `Middle`, `Late`, `Absent`.
  - Presence-only uses `Present` and `Absent`.
  - `"—"` is the writer's fallback when nothing was chosen.
- **`attendance` is a number of stored points:** Early 5, Middle 3, Late 1, Absent 0. It is written only when `criteriaSnapshot.attendance` is true.
- **Presence-only entries** (`criteriaSnapshot.attendance` false) carry `Present` or `Absent` and no `attendance` field.
- **Scored Absent** clears food scores, so an Absent entry missing food scores is valid.

### Category settings

Current category settings must not be re-evaluated against old snapshots.

## Not established by any source fact (treated as unverified)

- **Status values** other than `pending` and `approved` are not established, and neither is a session with no `status` at all.
- **Value formats** of `date`, `activeFrom`, `activeUntil`, `time`, `notice`, `absenceReason`, `sample`, `cust`, `obs`, `fu` and `pi` are unknown.
- **Timestamps:** the type and clock of submission `timestamp`, and whether `approvedAt` was always `Date.now()` milliseconds rather than seconds, are unknown.
- **Food score range** is unknown.
- **Field names on `vendors`, `categories` and `reviewers` records** are not established, apart from `deleted`.
- **Historic entries without `assessmentVersion` or `criteriaSnapshot`:** whether their `att`, food score and absence semantics match v2 is not established.
- **Missing `attendance`** on a scored entry whose label is Early, Middle, Late or Absent: whether this can legitimately occur is not established.
