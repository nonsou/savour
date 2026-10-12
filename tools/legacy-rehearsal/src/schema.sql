-- LOCAL ARCHIVE REHEARSAL ONLY. Not a hosted migration and not applied to any
-- Supabase project. Separate non-exposed schema; existing operational tables
-- (public.sessions, assessments, report_revisions, memberships, ...) are not
-- referenced or touched. No typed score, attendance, roster or approval column.
-- No cascading foreign keys: rollback deletes explicitly per batch.

create schema legacy_archive;
revoke all on schema legacy_archive from public;

create table legacy_archive.batches (
  batch_fingerprint text primary key check (batch_fingerprint ~ '^[0-9a-f]{64}$'),
  target_workspace text not null check (target_workspace ~ '^synthetic-ws-[a-z0-9]{1,32}$'),
  status text not null check (status = 'LOCAL_ARCHIVE_REHEARSAL_ONLY'),
  fixture_name text not null,
  mapping_version text not null,
  -- Authoritative restore input: the exact source bytes.
  source_bytes bytea not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_byte_length integer not null,
  preflight_report_format text not null,
  preflight_state text not null check (preflight_state in ('INSPECTED_CLEAN', 'INSPECTED_WITH_EXCEPTIONS')),
  manifest jsonb not null,
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  record_count integer not null check (record_count >= 0),
  exception_count integer not null check (exception_count >= 0),
  unique (target_workspace, batch_fingerprint),
  check (encode(sha256(source_bytes), 'hex') = source_sha256),
  check (octet_length(source_bytes) = source_byte_length)
);

create table legacy_archive.records (
  target_workspace text not null,
  batch_fingerprint text not null,
  ordinal integer not null check (ordinal >= 0),
  record_kind text not null
    check (record_kind in ('category', 'reviewer', 'vendor', 'session', 'submission', 'entry')),
  -- Source tuple. Keys are original source keys; entry_index is the array position.
  json_pointer text not null,
  collection_key text,
  session_key text,
  submission_key text,
  entry_index integer,
  value_type text not null,
  byte_start integer not null check (byte_start >= 0),
  byte_end integer not null,
  -- Original bytes of this record; jsonb is a PostgreSQL-parsed projection of
  -- raw_slice and is not authoritative (jsonb normalises e.g. -0 and 1E+2).
  raw_slice bytea not null,
  raw_sha256 text not null,
  payload jsonb not null,
  primary key (batch_fingerprint, ordinal),
  unique (batch_fingerprint, json_pointer),
  check (byte_end - byte_start = octet_length(raw_slice)),
  check (encode(sha256(raw_slice), 'hex') = raw_sha256),
  foreign key (target_workspace, batch_fingerprint) references legacy_archive.batches (target_workspace, batch_fingerprint)
);

-- Preflight exceptions copied as pseudonymised codes/locations. Archived does
-- not mean resolved: every row is review-required.
create table legacy_archive.exceptions (
  target_workspace text not null,
  batch_fingerprint text not null,
  ordinal integer not null check (ordinal >= 0),
  code text not null,
  level text not null,
  location jsonb not null,
  detail jsonb,
  resolution text not null default 'UNRESOLVED_REVIEW_REQUIRED' check (resolution = 'UNRESOLVED_REVIEW_REQUIRED'),
  primary key (batch_fingerprint, ordinal),
  foreign key (target_workspace, batch_fingerprint) references legacy_archive.batches (target_workspace, batch_fingerprint)
);

revoke all on all tables in schema legacy_archive from public;
