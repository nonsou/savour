-- SAVOUR Milestone 2 forward fix: covering indexes for the Milestone 2 composite foreign keys.
--
-- The Supabase advisor reports foreign keys whose columns are not the leading columns of any
-- index. For the six Milestone 2 composite foreign keys below, no existing index qualifies:
--   subjects (workspace_id, category_id)               -> categories      only subjects_category_idx (category_id) WHERE NOT NULL
--   subject_contacts (workspace_id, subject_id)        -> subjects        only pkey (subject_id) and (workspace_id)
--   subject_locations (workspace_id, subject_id)       -> subjects        only pkey (subject_id, location_id) and (workspace_id)
--   subject_locations (workspace_id, location_id)      -> locations       only (location_id) and (workspace_id)
--   correction_requests (workspace_id, session_id, subject_id) -> session_subjects
--                                                       only (session_id, status), partial unique (session_id, subject_id, assessor_id)
--   correction_requests (workspace_id, assessor_id)    -> memberships     only (assessor_id, session_id)
-- Each index below is non-partial and leads with exactly the foreign-key columns, so deletes or
-- key updates on the referenced rows (and the advisor) can use it.
--
-- Deliberately retained (no speculative removals): subject_contacts_ws_idx and
-- subject_locations_ws_idx (workspace_id) become left prefixes of the new indexes and are
-- therefore redundant for lookups; subjects_category_idx (partial, category_id) still serves
-- category-only lookups. Dropping redundant indexes can be a separate reviewed change.
-- M1 advisor notices are out of scope here. Milestone 2 tables are small in savour-dev, so plain
-- CREATE INDEX (inside the migration transaction) is used rather than CONCURRENTLY.

create index if not exists subjects_ws_category_fk_idx
  on public.subjects (workspace_id, category_id);
create index if not exists subject_contacts_ws_subject_fk_idx
  on public.subject_contacts (workspace_id, subject_id);
create index if not exists subject_locations_ws_subject_fk_idx
  on public.subject_locations (workspace_id, subject_id);
create index if not exists subject_locations_ws_location_fk_idx
  on public.subject_locations (workspace_id, location_id);
create index if not exists correction_requests_ws_roster_fk_idx
  on public.correction_requests (workspace_id, session_id, subject_id);
create index if not exists correction_requests_ws_assessor_fk_idx
  on public.correction_requests (workspace_id, assessor_id);
