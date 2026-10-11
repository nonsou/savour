-- SAVOUR Milestone 2 (3 of 3): session lifecycle, waivers, correction requests, samples.
--
-- (Fable proposed separate lifecycle and waiver/correction migrations. They are combined so
-- that shared functions -- build_inputs, approve_session, submit_assessment -- are replaced
-- once, not twice.)
--
-- Window timing and closure predicates (all instants UTC; whole hours; DST is display-only)
-- * collecting  <=>  status = 'open' AND opens_at <= now() < closes_at.
-- * draft: never collecting. opens_at/closes_at are placeholders; planned_window_hours holds the
--   window. open_session sets opens_at = now(), closes_at = now() + planned hours, opened_at.
-- * opens_at never changes after opening. closes_at changes only through:
--     update_session_window  (while collecting; new close = now() + hours; reason required)
--     reopen_collection      (from in_review with no current approved report, or from open
--                             after scheduled expiry; new close = now() + hours; reason required)
--   close_collection moves open -> in_review without touching closes_at.
-- * Report revision reopen (reopen_session) only creates an in_review revision: no collection,
--   no guest access. Collection reopen is a separate, explicit, reasoned Owner/Admin action that
--   never touches report_revisions.
-- * Guest grants follow the window only while still live: a guest membership that is active,
--   unexpired, bound to the session, scheduled to expire exactly at the old close and still
--   assigned to an active roster subject moves with the new close. Expired or revoked guest
--   memberships are never revived (a new email-bound invitation is required), and consumed
--   invitations are never altered.
--
-- Evidence rules
-- * Every new mutation of session scope or evidence takes private.lock_session, requires a
--   non-null expected data_version and writes its audit row in the same transaction.
-- * Roster removal after opening is soft (removed_at): assessments and history stay; removed
--   subjects leave report inputs, approval and every assessor/guest read and write path, and
--   are disclosed in new snapshots (removed_subjects). Restoring re-activates the same row and
--   is audited with the number of retained responses. A draft has no evidence: removal deletes.
-- * A waiver resolves an approval requirement, never the missing response: required counts
--   stay, coverage stays incomplete and the subject gets no quality/combined headline.
--   Unknown outcomes cannot be waived. Reviewers cannot waive their own work; Owner/Admin can,
--   with a reason. A later complete submission clears the waiver (audited).
-- * Correction requests need live collection, target a submitted assignment of someone else,
--   are visible only to reviewers in scope and the named assessor while assigned, are resolved
--   by resubmission or reviewer amendment, and block approval while open.
-- * Snapshots: build_inputs stamps 'savour-m2.1' (same arithmetic as m1.1; adds waivers,
--   removed_subjects and session.is_sample). Existing m1.1 snapshots are never rewritten;
--   redact_inputs yields byte-identical output for inputs without waivers.
-- * Samples: sessions.is_sample is immutable; sample and real subjects never mix; samples never
--   take guests; get_dashboard and get_setup_progress exclude samples in SQL.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
alter table public.sessions
  add column is_sample boolean not null default false,
  add column opened_at timestamptz,
  add column planned_window_hours integer check (planned_window_hours between 1 and 168),
  add column collection_reopens integer not null default 0,
  add column last_collection_reopen_reason text;
update public.sessions set opened_at = opens_at where opened_at is null;
create index sessions_ws_sample_idx on public.sessions (workspace_id, is_sample, status);

create trigger sessions_keep_sample before update on public.sessions
  for each row execute function private.keep_sample_flag();

alter table public.session_subjects
  add column removed_at timestamptz,
  add column removed_by uuid,
  add column removal_reason text check (length(removal_reason) <= 500),
  add column restored_at timestamptz,
  add column restored_by uuid,
  add column restore_reason text check (length(restore_reason) <= 500),
  add check ((removed_at is null) = (removed_by is null));

alter table public.session_assignments
  add column waived_at timestamptz,
  add column waived_by uuid,
  add column waiver_reason text check (length(waiver_reason) <= 500),
  add check ((waived_at is null) = (waiver_reason is null) and (waived_at is null) = (waived_by is null));
create index session_assignments_subject_idx on public.session_assignments (subject_id, user_id);

create table public.correction_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  session_id uuid not null,
  subject_id uuid not null,
  assessor_id uuid not null,
  revision integer not null,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  requested_by uuid not null,
  requester_name text not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'withdrawn')),
  resolution text check (resolution in ('resubmitted', 'amended', 'withdrawn', 'outcome_changed')),
  resolution_reason text check (length(resolution_reason) <= 500),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  check ((status = 'open') = (resolved_at is null)),
  foreign key (workspace_id, session_id, subject_id)
    references public.session_subjects (workspace_id, session_id, subject_id),
  foreign key (workspace_id, assessor_id) references public.memberships (workspace_id, user_id)
);
create unique index correction_requests_one_open on public.correction_requests (session_id, subject_id, assessor_id)
  where status = 'open';
create index correction_requests_assessor_idx on public.correction_requests (assessor_id, session_id);
create index correction_requests_session_idx on public.correction_requests (session_id, status);

create trigger correction_requests_keep_workspace before update on public.correction_requests
  for each row execute function private.keep_workspace_id();

-- ---------------------------------------------------------------------------
-- Read helpers (replaced: removed roster rows and drafts grant nothing)
-- ---------------------------------------------------------------------------
-- Diff from 20261010224854: the assignment must be on an ACTIVE roster row and the session must
-- not be a draft. is_assigned(session, null) therefore needs at least one active assignment.
create or replace function private.is_assigned(p_session uuid, p_subject uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.session_assignments a
    join public.session_subjects ss on ss.session_id = a.session_id and ss.subject_id = a.subject_id
      and ss.removed_at is null
    where a.session_id = p_session and a.user_id = (select auth.uid())
      and (p_subject is null or a.subject_id = p_subject))
    and exists (select 1 from public.sessions s where s.id = p_session and s.status <> 'draft')
    and private.assignment_in_scope(p_session, (select auth.uid()))
    and private.guest_collection_live(p_session)
$$;

create or replace function private.assigned_subject(p_subject uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.session_assignments a
    join public.session_subjects ss on ss.session_id = a.session_id and ss.subject_id = a.subject_id
      and ss.removed_at is null
    join public.sessions s on s.id = a.session_id and s.status <> 'draft'
    where a.subject_id = p_subject and a.user_id = (select auth.uid())
      and private.assignment_in_scope(a.session_id, a.user_id)
      and private.guest_collection_live(a.session_id))
  or exists (
    select 1 from public.session_subjects ss
    where ss.subject_id = p_subject and private.can_review(ss.session_id))
$$;

create function private.session_collecting(v public.sessions) returns boolean
language sql stable set search_path = '' as $$
  select v.status = 'open' and now() >= v.opens_at and now() < v.closes_at
$$;

create function private.require_version(v public.sessions, p_expected integer) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_expected is null or v.data_version <> p_expected then perform private.fail('stale_version'); end if;
end $$;

create function private.require_reason(p text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if length(btrim(coalesce(p, ''))) = 0 then perform private.fail('reason_required'); end if;
  if length(btrim(p)) > 500 then perform private.fail('reason_too_long'); end if;
  return btrim(p);
end $$;

create function private.require_active_roster(p_session uuid, p_subject uuid) returns public.session_subjects
language plpgsql stable security definer set search_path = '' as $$
declare v public.session_subjects;
begin
  select * into v from public.session_subjects where session_id = p_session and subject_id = p_subject;
  if not found then perform private.fail('not_found', 'roster subject'); end if;
  if v.removed_at is not null then perform private.fail('subject_removed'); end if;
  return v;
end $$;

-- Moves live guest grants with the collection window (see header). Returns the count moved.
create function private.move_guest_grants(p_session uuid, p_old_close timestamptz, p_new_close timestamptz) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  update public.memberships m set expires_at = p_new_close
  where m.role = 'guest' and m.guest_session_id = p_session and m.status = 'active'
    and m.expires_at is not null and m.expires_at > now() and m.expires_at = p_old_close
    and exists (select 1 from public.session_assignments a
                join public.session_subjects ss on ss.session_id = a.session_id and ss.subject_id = a.subject_id
                  and ss.removed_at is null
                where a.session_id = p_session and a.user_id = m.user_id);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Validates scope people for a session location. Returns problems (empty when valid).
create function private.scope_problems(p_session uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select array_remove(array[
    case when exists (select 1 from public.session_assignments a
        join public.session_subjects ss on ss.session_id = a.session_id and ss.subject_id = a.subject_id and ss.removed_at is null
        where a.session_id = p_session and not private.assignment_in_scope(p_session, a.user_id))
      then 'every assessor must be active and hold the session location' end,
    case when not exists (select 1 from public.session_reviewers r where r.session_id = p_session)
      then 'at least one reviewer is required' end,
    case when exists (select 1 from public.session_reviewers r join public.sessions s on s.id = r.session_id
        where r.session_id = p_session and not exists (
          select 1 from public.memberships m where m.workspace_id = s.workspace_id and m.user_id = r.user_id
            and m.status = 'active' and m.role in ('owner', 'admin', 'reviewer')
            and private.user_in_location(s.workspace_id, r.user_id, s.location_id)))
      then 'every reviewer must be active and hold the session location' end], null)
$$;

-- ---------------------------------------------------------------------------
-- Report inputs (formula savour-m2.1) and redaction
-- ---------------------------------------------------------------------------
-- Diff from m1_core: formula stamped 'savour-m2.1' (the label describes the calculation applied
-- at approval, not the template's publish label); session.is_sample; only active roster rows in
-- subjects; per subject waived_assessors, waivers[] and restored; top-level removed_subjects.
-- required_assessors keeps its M1 meaning (every assignment on the subject).
create or replace function private.build_inputs(p_session uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'formula_version', 'savour-m2.1',
    'workspace', jsonb_build_object('name', w.name, 'timezone', w.timezone),
    'session', jsonb_build_object('id', s.id, 'name', s.name, 'local_date', s.local_date,
      'location', l.name, 'revision', s.revision, 'opens_at', s.opens_at, 'closes_at', s.closes_at,
      'expected_ready_time', s.expected_ready_time, 'is_sample', s.is_sample),
    'template', jsonb_build_object('id', tv.template_id, 'version_id', tv.id, 'name', tv.name,
      'version', tv.version, 'attendance_mode', tv.attendance_mode, 'criteria', tv.criteria),
    'subjects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'subject_id', ss.subject_id, 'name', ss.subject_name,
        'outcome', ss.outcome, 'outcome_reason', ss.outcome_reason,
        'required_assessors', (select count(*) from public.session_assignments sa
                               where sa.session_id = s.id and sa.subject_id = ss.subject_id),
        'waived_assessors', (select count(*) from public.session_assignments sa
                             left join public.assessments a on a.session_id = sa.session_id
                               and a.subject_id = sa.subject_id and a.assessor_id = sa.user_id
                             where sa.session_id = s.id and sa.subject_id = ss.subject_id and sa.waived_at is not null
                               and not (coalesce(a.state = 'submitted', false) and a.answers is not null)),
        'waivers', coalesce((
          select jsonb_agg(jsonb_build_object('assessor_id', sa.user_id,
            'assessor_label', coalesce(m.display_name, 'Former member'), 'reason', sa.waiver_reason,
            'waived_at', sa.waived_at, 'waived_by_label', coalesce(wb.display_name, 'Former member'))
            order by sa.user_id)
          from public.session_assignments sa
          left join public.memberships m on m.workspace_id = sa.workspace_id and m.user_id = sa.user_id
          left join public.memberships wb on wb.workspace_id = sa.workspace_id and wb.user_id = sa.waived_by
          where sa.session_id = s.id and sa.subject_id = ss.subject_id and sa.waived_at is not null), '[]'),
        'restored', case when ss.restored_at is not null then jsonb_build_object('restored_at', ss.restored_at,
          'reason', ss.restore_reason) end,
        'assessments', coalesce((
          select jsonb_agg(jsonb_build_object(
            'assessor_id', a.assessor_id, 'assessor_label', a.assessor_name,
            'observed_attendance', a.observed_attendance, 'answers', a.answers,
            'notes', a.notes, 'absence_reason', a.absence_reason, 'na_confirmed', a.na_confirmed,
            'version', a.version)
            order by a.assessor_id)
          from public.assessments a
          join public.session_assignments sa
            on sa.session_id = a.session_id and sa.subject_id = a.subject_id and sa.user_id = a.assessor_id
          where a.session_id = s.id and a.subject_id = ss.subject_id and a.state = 'submitted'), '[]'))
        order by ss.subject_name, ss.subject_id)
      from public.session_subjects ss where ss.session_id = s.id and ss.removed_at is null), '[]'),
    'removed_subjects', coalesce((
      select jsonb_agg(jsonb_build_object('subject_id', ss.subject_id, 'name', ss.subject_name,
        'removed_at', ss.removed_at, 'reason', ss.removal_reason,
        'retained_responses', (select count(*) from public.assessments a where a.session_id = s.id
                               and a.subject_id = ss.subject_id and a.state = 'submitted'))
        order by ss.subject_name, ss.subject_id)
      from public.session_subjects ss where ss.session_id = s.id and ss.removed_at is not null), '[]'))
  from public.sessions s
  join public.workspaces w on w.id = s.workspace_id
  join public.locations l on l.id = s.location_id
  join public.template_versions tv on tv.id = s.template_version_id
  where s.id = p_session
$$;

-- Diff from m1_core: pseudonyms also cover waived assessors (who have no assessment), and
-- waivers lose identities (assessor_id, waived_by_label). Subjects without a "waivers" key
-- (every m1.1 snapshot) are transformed exactly as before, so their redacted output is unchanged.
create or replace function private.redact_inputs(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  with ids as (
    select a ->> 'assessor_id' as id
    from jsonb_array_elements(p -> 'subjects') s, jsonb_array_elements(s -> 'assessments') a
    union
    select w ->> 'assessor_id'
    from jsonb_array_elements(p -> 'subjects') s, jsonb_array_elements(coalesce(s -> 'waivers', '[]')) w),
  m as (select id, row_number() over (order by id) as n from ids)
  select p || jsonb_build_object('redacted', true, 'subjects', coalesce((
    select jsonb_agg(s || jsonb_build_object('assessments', coalesce((
      select jsonb_agg((a - 'assessor_id' - 'assessor_label') || jsonb_build_object('assessor_label', 'Assessor ' || m.n)
        order by m.n)
      from jsonb_array_elements(s -> 'assessments') a join m on m.id = a ->> 'assessor_id'), '[]'))
      || case when s ? 'waivers' then jsonb_build_object('waivers', coalesce((
        select jsonb_agg((w - 'assessor_id' - 'assessor_label' - 'waived_by_label')
          || jsonb_build_object('assessor_label', 'Assessor ' || m.n) order by m.n)
        from jsonb_array_elements(s -> 'waivers') w join m on m.id = w ->> 'assessor_id'), '[]')) else '{}'::jsonb end
      order by ord)
    from jsonb_array_elements(p -> 'subjects') with ordinality x (s, ord)), '[]'))
$$;

-- ---------------------------------------------------------------------------
-- Session creation
-- ---------------------------------------------------------------------------
-- Legacy M1 create-and-open. Diff from m1_core: sample subjects refused (a real session cannot
-- take sample subjects), at least one reviewer required (same rule as open_session), opened_at set.
create or replace function private.create_session(p_ws uuid, p_location uuid, p_template_version uuid, p_name text,
  p_local_date date, p_subject_ids uuid[], p_assessor_ids uuid[], p_reviewer_ids uuid[],
  p_window_hours integer, p_ready_time time)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_id uuid;
  v_subjects uuid[] := array(select distinct unnest(coalesce(p_subject_ids, '{}')));
  v_assessors uuid[] := array(select distinct unnest(coalesce(p_assessor_ids, '{}')));
  v_reviewers uuid[] := array(select distinct unnest(coalesce(p_reviewer_ids, '{}')));
  v_hours integer := coalesce(p_window_hours, 48);
begin
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if not exists (select 1 from public.locations where id = p_location and workspace_id = p_ws and archived_at is null) then
    perform private.fail('not_found', 'location');
  end if;
  if not exists (select 1 from public.template_versions where id = p_template_version and workspace_id = p_ws) then
    perform private.fail('not_found', 'template version');
  end if;
  if v_hours not between 1 and 168 then perform private.fail('invalid_window'); end if;
  if p_ready_time is null and (select attendance_mode from public.template_versions
                               where id = p_template_version) = 'scored' then
    perform private.fail('ready_time_required');
  end if;
  if p_local_date is null then perform private.fail('invalid_date'); end if;
  if cardinality(v_subjects) = 0 then perform private.fail('roster_required'); end if;
  if (select count(*) from public.subjects where workspace_id = p_ws and archived_at is null and not is_sample
      and id = any (v_subjects)) <> cardinality(v_subjects) then
    perform private.fail('not_found', 'subject');
  end if;
  if (select count(*) from public.memberships where workspace_id = p_ws and status = 'active'
      and role in ('owner', 'admin', 'reviewer', 'assessor') and user_id = any (v_assessors)
      and private.user_in_location(p_ws, user_id, p_location)) <> cardinality(v_assessors) then
    perform private.fail('invalid_assessor', 'assessors must be active staff holding the session location');
  end if;
  if (select count(*) from public.memberships where workspace_id = p_ws and status = 'active'
      and role in ('owner', 'admin', 'reviewer') and user_id = any (v_reviewers)
      and private.user_in_location(p_ws, user_id, p_location)) <> cardinality(v_reviewers) then
    perform private.fail('invalid_reviewer', 'reviewers must be active and hold the session location');
  end if;
  if cardinality(v_reviewers) = 0 then perform private.fail('reviewer_required'); end if;

  insert into public.sessions (workspace_id, location_id, template_version_id, name, local_date,
    opens_at, closes_at, expected_ready_time, created_by, opened_at, planned_window_hours)
  values (p_ws, p_location, p_template_version, btrim(p_name), p_local_date,
    now(), now() + make_interval(hours => v_hours), p_ready_time, v_uid, now(), v_hours)
  returning id into v_id;
  insert into public.session_subjects (workspace_id, session_id, subject_id, subject_name)
  select p_ws, v_id, s.id, s.name from public.subjects s where s.id = any (v_subjects);
  insert into public.session_assignments (workspace_id, session_id, subject_id, user_id)
  select p_ws, v_id, s, a from unnest(v_subjects) s, unnest(v_assessors) a;
  insert into public.session_reviewers (workspace_id, session_id, user_id)
  select p_ws, v_id, r from unnest(v_reviewers) r;
  perform private.audit(p_ws, 'session.created', v_id, jsonb_build_object(
    'subjects', cardinality(v_subjects), 'assessors', cardinality(v_assessors), 'window_hours', v_hours));
  return v_id;
end $$;

-- New default: a draft. Roster, assessors and reviewers may be incomplete until opening.
create function private.create_session_draft(p_ws uuid, p_location uuid, p_template_version uuid, p_name text,
  p_local_date date, p_subject_ids uuid[], p_assessor_ids uuid[], p_reviewer_ids uuid[],
  p_window_hours integer, p_ready_time time)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_id uuid;
  v_subjects uuid[] := array(select distinct unnest(coalesce(p_subject_ids, '{}')));
  v_assessors uuid[] := array(select distinct unnest(coalesce(p_assessor_ids, '{}')));
  v_reviewers uuid[] := array(select distinct unnest(coalesce(p_reviewer_ids, '{}')));
  v_hours integer := coalesce(p_window_hours, 48);
begin
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then perform private.fail('invalid_name'); end if;
  if not exists (select 1 from public.locations where id = p_location and workspace_id = p_ws and archived_at is null) then
    perform private.fail('not_found', 'location');
  end if;
  if not exists (select 1 from public.template_versions where id = p_template_version and workspace_id = p_ws) then
    perform private.fail('not_found', 'template version');
  end if;
  if v_hours not between 1 and 168 then perform private.fail('invalid_window'); end if;
  if p_local_date is null then perform private.fail('invalid_date'); end if;
  if (select count(*) from public.subjects where workspace_id = p_ws and archived_at is null and not is_sample
      and id = any (v_subjects)) <> cardinality(v_subjects) then
    perform private.fail('not_found', 'subject');
  end if;
  if (select count(*) from public.memberships where workspace_id = p_ws and status = 'active'
      and role in ('owner', 'admin', 'reviewer', 'assessor') and user_id = any (v_assessors)
      and private.user_in_location(p_ws, user_id, p_location)) <> cardinality(v_assessors) then
    perform private.fail('invalid_assessor', 'assessors must be active staff holding the session location');
  end if;
  if (select count(*) from public.memberships where workspace_id = p_ws and status = 'active'
      and role in ('owner', 'admin', 'reviewer') and user_id = any (v_reviewers)
      and private.user_in_location(p_ws, user_id, p_location)) <> cardinality(v_reviewers) then
    perform private.fail('invalid_reviewer', 'reviewers must be active and hold the session location');
  end if;
  insert into public.sessions (workspace_id, location_id, template_version_id, name, local_date, status,
    opens_at, closes_at, expected_ready_time, created_by, planned_window_hours)
  values (p_ws, p_location, p_template_version, btrim(p_name), p_local_date, 'draft',
    now(), now() + make_interval(hours => v_hours), p_ready_time, v_uid, v_hours)
  returning id into v_id;
  insert into public.session_subjects (workspace_id, session_id, subject_id, subject_name)
  select p_ws, v_id, s.id, s.name from public.subjects s where s.id = any (v_subjects);
  insert into public.session_assignments (workspace_id, session_id, subject_id, user_id)
  select p_ws, v_id, s, a from unnest(v_subjects) s, unnest(v_assessors) a;
  insert into public.session_reviewers (workspace_id, session_id, user_id)
  select p_ws, v_id, r from unnest(v_reviewers) r;
  perform private.audit(p_ws, 'session.draft_created', v_id, jsonb_build_object(
    'subjects', cardinality(v_subjects), 'assessors', cardinality(v_assessors), 'reviewers', cardinality(v_reviewers),
    'window_hours', v_hours));
  return v_id;
end $$;

create function private.update_session_draft(p_session uuid, p_name text, p_local_date date, p_location uuid,
  p_template_version uuid, p_window_hours integer, p_ready_time time, p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_s public.sessions := private.lock_session(p_session);
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status <> 'draft' then perform private.fail('invalid_state'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then perform private.fail('invalid_name'); end if;
  if p_local_date is null then perform private.fail('invalid_date'); end if;
  if coalesce(p_window_hours, 0) not between 1 and 168 then perform private.fail('invalid_window'); end if;
  if not exists (select 1 from public.locations where id = p_location and workspace_id = v_s.workspace_id and archived_at is null) then
    perform private.fail('not_found', 'location');
  end if;
  if not exists (select 1 from public.template_versions where id = p_template_version and workspace_id = v_s.workspace_id) then
    perform private.fail('not_found', 'template version');
  end if;
  update public.sessions set name = btrim(p_name), local_date = p_local_date, location_id = p_location,
    template_version_id = p_template_version, planned_window_hours = p_window_hours, expected_ready_time = p_ready_time,
    opens_at = now(), closes_at = now() + make_interval(hours => p_window_hours), data_version = data_version + 1
  where id = p_session;
  perform private.audit(v_s.workspace_id, 'session.draft_updated', p_session, jsonb_build_object(
    'name', btrim(p_name), 'local_date', p_local_date, 'location_id', p_location, 'template_version_id', p_template_version,
    'window_hours', p_window_hours));
  return v_s.data_version + 1;
end $$;

-- Explicit opening. Validates full scope; collection starts now.
create function private.open_session(p_session uuid, p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_problems text[] := '{}';
  v_hours integer;
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status <> 'draft' then perform private.fail('invalid_state'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  v_hours := coalesce(v_s.planned_window_hours, 48);
  if not exists (select 1 from public.locations where id = v_s.location_id and archived_at is null) then
    v_problems := v_problems || 'the location is archived'::text;
  end if;
  if v_s.expected_ready_time is null and (select attendance_mode from public.template_versions
      where id = v_s.template_version_id) = 'scored' then
    v_problems := v_problems || 'scored readiness needs an expected ready time'::text;
  end if;
  if not exists (select 1 from public.session_subjects where session_id = p_session and removed_at is null) then
    v_problems := v_problems || 'the roster is empty'::text;
  end if;
  if exists (select 1 from public.session_subjects ss join public.subjects x on x.id = ss.subject_id
             where ss.session_id = p_session and ss.removed_at is null and (x.archived_at is not null or x.is_sample <> v_s.is_sample)) then
    v_problems := v_problems || 'the roster contains an archived subject'::text;
  end if;
  if exists (select 1 from public.session_assignments a join public.memberships m
               on m.workspace_id = a.workspace_id and m.user_id = a.user_id
             where a.session_id = p_session and m.role = 'guest') then
    v_problems := v_problems || 'guests are invited after opening'::text;
  end if;
  v_problems := v_problems || private.scope_problems(p_session);
  if cardinality(v_problems) > 0 then perform private.fail('open_blocked', array_to_string(v_problems, '; ')); end if;
  update public.sessions set status = 'open', opens_at = now(), closes_at = now() + make_interval(hours => v_hours),
    opened_at = now(), planned_window_hours = v_hours, data_version = data_version + 1
  where id = p_session;
  perform private.audit(v_s.workspace_id, 'session.opened', p_session, jsonb_build_object('window_hours', v_hours,
    'closes_at', now() + make_interval(hours => v_hours)));
  return v_s.data_version + 1;
end $$;

-- ---------------------------------------------------------------------------
-- Scope edits (Owner/Admin; reason required once opened)
-- ---------------------------------------------------------------------------
create function private.set_roster_subject(p_session uuid, p_subject uuid, p_on boolean, p_reason text,
  p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_ss public.session_subjects;
  v_reason text;
  v_retained integer;
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status not in ('draft', 'open', 'in_review') then perform private.fail('session_locked'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  v_reason := case when v_s.status = 'draft' then nullif(btrim(coalesce(p_reason, '')), '') else private.require_reason(p_reason) end;
  select * into v_ss from public.session_subjects where session_id = p_session and subject_id = p_subject for update;
  select count(*) into v_retained from public.assessments a
  where a.session_id = p_session and a.subject_id = p_subject and a.state = 'submitted';

  if coalesce(p_on, false) then
    if not exists (select 1 from public.subjects x where x.id = p_subject and x.workspace_id = v_s.workspace_id
                   and x.archived_at is null and x.is_sample = v_s.is_sample) then
      perform private.fail('not_found', 'subject');
    end if;
    if v_ss.subject_id is not null and v_ss.removed_at is null then perform private.fail('already_on_roster'); end if;
    if v_ss.subject_id is null then
      insert into public.session_subjects (workspace_id, session_id, subject_id, subject_name)
      select v_s.workspace_id, p_session, x.id, x.name from public.subjects x where x.id = p_subject;
      perform private.audit(v_s.workspace_id, 'roster.added', p_session, jsonb_build_object(
        'subject_id', p_subject, 'reason', v_reason, 'status', v_s.status));
    else
      -- Same row, same label and outcome; retained responses become current again (disclosed).
      update public.session_subjects set removed_at = null, removed_by = null, removal_reason = null,
        restored_at = now(), restored_by = (select auth.uid()), restore_reason = v_reason
      where session_id = p_session and subject_id = p_subject;
      perform private.audit(v_s.workspace_id, 'roster.restored', p_session, jsonb_build_object(
        'subject_id', p_subject, 'reason', v_reason, 'retained_responses', v_retained));
    end if;
  else
    if v_ss.subject_id is null or v_ss.removed_at is not null then perform private.fail('not_found', 'roster subject'); end if;
    if v_s.status = 'draft' then
      delete from public.session_assignments where session_id = p_session and subject_id = p_subject;
      delete from public.session_subjects where session_id = p_session and subject_id = p_subject;
    else
      update public.session_subjects set removed_at = now(), removed_by = (select auth.uid()), removal_reason = v_reason
      where session_id = p_session and subject_id = p_subject;
    end if;
    perform private.audit(v_s.workspace_id, 'roster.removed', p_session, jsonb_build_object(
      'subject_id', p_subject, 'reason', v_reason, 'status', v_s.status, 'retained_responses', v_retained));
  end if;
  update public.sessions set data_version = data_version + 1 where id = p_session;
  return v_s.data_version + 1;
end $$;

create function private.set_session_reviewer(p_session uuid, p_user uuid, p_on boolean, p_reason text,
  p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_reason text;
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status not in ('draft', 'open', 'in_review') then perform private.fail('session_locked'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  v_reason := case when v_s.status = 'draft' then nullif(btrim(coalesce(p_reason, '')), '') else private.require_reason(p_reason) end;
  if coalesce(p_on, false) then
    if not exists (select 1 from public.memberships m where m.workspace_id = v_s.workspace_id and m.user_id = p_user
        and m.status = 'active' and (m.expires_at is null or m.expires_at > now()) and m.role in ('owner', 'admin', 'reviewer')
        and private.user_in_location(v_s.workspace_id, p_user, v_s.location_id)) then
      perform private.fail('invalid_reviewer', 'reviewers must be active and hold the session location');
    end if;
    insert into public.session_reviewers (workspace_id, session_id, user_id) values (v_s.workspace_id, p_session, p_user)
    on conflict do nothing;
  else
    delete from public.session_reviewers where session_id = p_session and user_id = p_user;
    if not found then perform private.fail('not_found', 'reviewer'); end if;
    if v_s.status <> 'draft' and not exists (select 1 from public.session_reviewers where session_id = p_session) then
      perform private.fail('reviewer_required');
    end if;
  end if;
  update public.sessions set data_version = data_version + 1 where id = p_session;
  perform private.audit(v_s.workspace_id, case when p_on then 'reviewer.added' else 'reviewer.removed' end, p_session,
    jsonb_build_object('user_id', p_user, 'reason', v_reason, 'status', v_s.status));
  return v_s.data_version + 1;
end $$;

-- Draft: sets the planned window. Collecting: moves the close to now() + hours (extend or
-- shorten), reason required. After scheduled expiry or manual close use reopen_collection.
create function private.update_session_window(p_session uuid, p_hours integer, p_reason text, p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_reason text;
  v_close timestamptz;
  v_moved integer := 0;
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  if coalesce(p_hours, 0) not between 1 and 168 then perform private.fail('invalid_window'); end if;
  if v_s.status = 'draft' then
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    update public.sessions set planned_window_hours = p_hours, closes_at = opens_at + make_interval(hours => p_hours),
      data_version = data_version + 1 where id = p_session;
  elsif private.session_collecting(v_s) then
    v_reason := private.require_reason(p_reason);
    v_close := now() + make_interval(hours => p_hours);
    update public.sessions set closes_at = v_close, data_version = data_version + 1 where id = p_session;
    v_moved := private.move_guest_grants(p_session, v_s.closes_at, v_close);
  else
    perform private.fail('invalid_state');
  end if;
  perform private.audit(v_s.workspace_id, 'session.window_changed', p_session, jsonb_build_object(
    'hours', p_hours, 'reason', v_reason, 'from_closes_at', v_s.closes_at, 'to_closes_at', v_close,
    'guest_grants_moved', v_moved, 'status', v_s.status));
  return v_s.data_version + 1;
end $$;

-- Explicit collection reopen (separate from report revision reopen). Never touches snapshots.
create function private.reopen_collection(p_session uuid, p_hours integer, p_reason text, p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_reason text;
  v_close timestamptz;
  v_moved integer;
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status = 'approved' then perform private.fail('reopen_report_first'); end if;
  if not ((v_s.status = 'in_review' and v_s.current_report_id is null)
          or (v_s.status = 'open' and now() >= v_s.closes_at)) then
    perform private.fail('invalid_state');
  end if;
  perform private.require_version(v_s, p_expected_data_version);
  v_reason := private.require_reason(p_reason);
  if coalesce(p_hours, 0) not between 1 and 168 then perform private.fail('invalid_window'); end if;
  v_close := now() + make_interval(hours => p_hours);
  update public.sessions set status = 'open', closes_at = v_close, collection_reopens = collection_reopens + 1,
    last_collection_reopen_reason = v_reason, data_version = data_version + 1
  where id = p_session;
  v_moved := private.move_guest_grants(p_session, v_s.closes_at, v_close);
  perform private.audit(v_s.workspace_id, 'session.collection_reopened', p_session, jsonb_build_object(
    'reason', v_reason, 'hours', p_hours, 'from_status', v_s.status, 'revision', v_s.revision,
    'from_closes_at', v_s.closes_at, 'to_closes_at', v_close, 'guest_grants_moved', v_moved));
  return v_s.data_version + 1;
end $$;

-- ---------------------------------------------------------------------------
-- Assignment (M1 RPC): Diff from m1_core: drafts allowed; removed roster subjects refused;
-- sample sessions take no guests; optional reason recorded (new 6-argument overload). The
-- 5-argument M1 signature remains and behaves as before (assignments were never reason-gated).
-- ---------------------------------------------------------------------------
create function private.set_assignment(p_session uuid, p_subject uuid, p_user uuid, p_assigned boolean,
  p_expected_data_version integer, p_reason text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_role public.member_role;
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status not in ('draft', 'open', 'in_review') then perform private.fail('session_locked'); end if;
  if p_expected_data_version is null or v_s.data_version <> p_expected_data_version then perform private.fail('stale_version'); end if;
  if not exists (select 1 from public.session_subjects where session_id = p_session and subject_id = p_subject) then
    perform private.fail('not_found', 'roster subject');
  end if;
  if p_assigned then
    perform private.require_active_roster(p_session, p_subject);
    select m.role into v_role from public.memberships m where m.workspace_id = v_s.workspace_id
      and m.user_id = p_user and m.status = 'active' and m.role in ('owner', 'admin', 'reviewer', 'assessor', 'guest');
    if v_role is null then perform private.fail('invalid_assessor'); end if;
    if v_role = 'guest' and (v_s.is_sample or v_s.status = 'draft') then
      perform private.fail('invalid_assessor', 'guests cannot be assigned to samples or drafts');
    end if;
    if not private.assignment_in_scope(p_session, p_user) then
      perform private.fail('invalid_assessor', 'assignee must hold the session location (guests: this session)');
    end if;
    insert into public.session_assignments (workspace_id, session_id, subject_id, user_id)
    values (v_s.workspace_id, p_session, p_subject, p_user) on conflict do nothing;
  else
    delete from public.session_assignments
    where session_id = p_session and subject_id = p_subject and user_id = p_user;
  end if;
  update public.sessions set data_version = data_version + 1 where id = p_session;
  perform private.audit(v_s.workspace_id, case when p_assigned then 'assignment.added' else 'assignment.removed' end,
    p_session, jsonb_build_object('subject_id', p_subject, 'user_id', p_user,
      'reason', nullif(btrim(coalesce(p_reason, '')), ''), 'status', v_s.status));
  return v_s.data_version + 1;
end $$;

create or replace function private.set_assignment(p_session uuid, p_subject uuid, p_user uuid, p_assigned boolean,
  p_expected_data_version integer)
returns integer language sql security definer set search_path = '' as $$
  select private.set_assignment(p_session, p_subject, p_user, p_assigned, p_expected_data_version, null::text)
$$;

-- ---------------------------------------------------------------------------
-- Evidence writes (replaced)
-- ---------------------------------------------------------------------------
-- Diff from m1_core: only open/in_review sessions (drafts refused); removed roster subjects
-- refused on both paths; a complete submission clears a waiver on that assignment and resolves
-- an open correction request (resubmitted / amended), each audited in the same transaction.
create or replace function private.submit_assessment(p_session uuid, p_subject uuid, p_assessor uuid,
  p_observed public.subject_outcome, p_answers jsonb, p_notes text, p_expected_version integer,
  p_idempotency_key uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_s public.sessions := private.lock_session(p_session);
  v_tv public.template_versions;
  v_ss public.session_subjects;
  v_a public.assessments;
  v_prior public.assessment_events;
  v_amend boolean := p_assessor is distinct from v_uid
    or (length(btrim(coalesce(p_reason, ''))) > 0 and private.can_review(p_session));
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_hash text;
  v_answers jsonb;
  v_name text;
  v_version integer;
  v_cr uuid;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  v_hash := private.sha256_hex(jsonb_build_object('session', p_session, 'subject', p_subject,
    'assessor', p_assessor, 'observed', p_observed, 'answers', p_answers, 'notes', p_notes,
    'expected_version', p_expected_version, 'reason', p_reason)::text);

  -- Authorization first (revoked/unassigned callers never get a receipt).
  if v_amend then
    if not private.can_review(p_session) then perform private.fail('forbidden'); end if;
  elsif not private.is_assigned(p_session, p_subject) then
    perform private.fail('not_assigned');
  end if;

  -- Idempotent replay: same key + same payload returns the original receipt.
  select * into v_prior from public.assessment_events
  where actor_id = v_uid and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.payload_hash <> v_hash then perform private.fail('idempotency_conflict'); end if;
    return jsonb_build_object('assessment_id', v_prior.assessment_id, 'version', v_prior.version, 'replayed', true);
  end if;

  if v_s.status not in ('open', 'in_review') then perform private.fail('session_locked'); end if;
  v_ss := private.require_active_roster(p_session, p_subject);
  if v_amend then
    if length(btrim(coalesce(p_reason, ''))) = 0 then perform private.fail('reason_required'); end if;
    if not exists (select 1 from public.session_assignments where session_id = p_session
                   and subject_id = p_subject and user_id = p_assessor) then
      perform private.fail('not_assigned');
    end if;
  elsif not private.session_collecting(v_s) then
    perform private.fail('window_closed');
  end if;

  select * into v_tv from public.template_versions where id = v_s.template_version_id;

  if p_observed is not null and (p_observed = 'unknown' or v_tv.attendance_mode = 'off'
      or not private.outcome_allowed(v_tv.attendance_mode, p_observed)) then
    perform private.fail('invalid_attendance');
  end if;
  if p_observed = 'absent' then
    if p_answers is not null and p_answers <> '{}'::jsonb then
      perform private.fail('absent_clears_scores');
    end if;
    v_answers := null;
  else
    if v_ss.outcome in ('absent', 'not_assessed') then perform private.fail('subject_not_assessable'); end if;
    v_answers := private.validate_answers(v_tv.criteria, coalesce(p_answers, '{}'));
  end if;
  if length(coalesce(p_notes, '')) > 2000 then perform private.fail('notes_too_long'); end if;

  select * into v_a from public.assessments
  where session_id = p_session and subject_id = p_subject and assessor_id = p_assessor for update;
  if p_expected_version is null or coalesce(v_a.version, 0) <> p_expected_version then
    perform private.fail('stale_version');
  end if;

  select display_name into v_name from public.memberships
  where workspace_id = v_s.workspace_id and user_id = p_assessor;

  if v_a.id is null then
    insert into public.assessments (workspace_id, session_id, subject_id, assessor_id, assessor_name,
      observed_attendance, answers, notes, absence_reason, state, na_confirmed, version, updated_by)
    values (v_s.workspace_id, p_session, p_subject, p_assessor, v_name, p_observed, v_answers,
      case when p_observed = 'absent' then null else v_notes end,
      case when p_observed = 'absent' then v_notes end, 'submitted',
      v_amend or not private.has_na(v_answers), 1, v_uid)
    returning * into v_a;
  else
    update public.assessments set observed_attendance = p_observed, answers = v_answers,
      notes = case when p_observed = 'absent' then null else v_notes end,
      absence_reason = case when p_observed = 'absent' then v_notes end, state = 'submitted',
      na_confirmed = v_amend or not private.has_na(v_answers),
      version = version + 1, updated_by = v_uid, updated_at = now()
    where id = v_a.id returning * into v_a;
  end if;
  v_version := v_a.version;

  insert into public.assessment_events (workspace_id, assessment_id, session_id, revision, kind, version,
    actor_id, payload, payload_hash, idempotency_key, reason)
  values (v_s.workspace_id, v_a.id, p_session, v_s.revision, case when v_amend then 'amend' else 'submit' end,
    v_version, v_uid, jsonb_build_object('observed', p_observed, 'answers', v_answers, 'notes', v_a.notes,
      'absence_reason', v_a.absence_reason),
    v_hash, p_idempotency_key, nullif(btrim(coalesce(p_reason, '')), ''));

  if v_answers is not null then
    update public.session_assignments set waived_at = null, waived_by = null, waiver_reason = null
    where session_id = p_session and subject_id = p_subject and user_id = p_assessor and waived_at is not null;
    if found then
      perform private.audit(v_s.workspace_id, 'assignment.waiver_cleared', p_session, jsonb_build_object(
        'subject_id', p_subject, 'user_id', p_assessor, 'by', 'submission', 'version', v_version));
    end if;
  end if;
  update public.correction_requests set status = 'resolved', resolution = case when v_amend then 'amended' else 'resubmitted' end,
    resolved_by = v_uid, resolved_at = now()
  where session_id = p_session and subject_id = p_subject and assessor_id = p_assessor and status = 'open'
  returning id into v_cr;
  if v_cr is not null then
    perform private.audit(v_s.workspace_id, 'correction.resolved', v_cr, jsonb_build_object(
      'session_id', p_session, 'resolution', case when v_amend then 'amended' else 'resubmitted' end, 'version', v_version));
  end if;
  update public.sessions set data_version = data_version + 1 where id = p_session;
  return jsonb_build_object('assessment_id', v_a.id, 'version', v_version, 'replayed', false);
end $$;

-- Diff from m1_core: removed roster subjects refused.
create or replace function private.confirm_na(p_session uuid, p_subject uuid, p_assessor uuid, p_expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_a public.assessments;
begin
  if not private.can_review(p_session) then perform private.fail('forbidden'); end if;
  if v_s.status not in ('open', 'in_review') then perform private.fail('session_locked'); end if;
  perform private.require_active_roster(p_session, p_subject);
  select * into v_a from public.assessments
  where session_id = p_session and subject_id = p_subject and assessor_id = p_assessor for update;
  if not found then perform private.fail('not_found', 'assessment'); end if;
  if p_expected_version is null or v_a.version <> p_expected_version then perform private.fail('stale_version'); end if;
  update public.assessments set na_confirmed = true, version = version + 1,
    updated_by = (select auth.uid()), updated_at = now()
  where id = v_a.id;
  insert into public.assessment_events (workspace_id, assessment_id, session_id, revision, kind, version, actor_id)
  values (v_s.workspace_id, v_a.id, p_session, v_s.revision, 'na_confirm', v_a.version + 1, (select auth.uid()));
  update public.sessions set data_version = data_version + 1 where id = p_session;
  return v_a.version + 1;
end $$;

-- Diff from m1_core: removed roster subjects refused; an absent/not-assessed outcome closes any
-- open correction request on the subject (nothing left to correct), audited.
create or replace function private.resolve_outcome(p_session uuid, p_subject uuid, p_outcome public.subject_outcome,
  p_reason text, p_expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_mode public.attendance_mode;
  v_ss public.session_subjects;
  v_a record;
begin
  if not private.can_review(p_session) then perform private.fail('forbidden'); end if;
  if v_s.status not in ('open', 'in_review') then perform private.fail('session_locked'); end if;
  select attendance_mode into v_mode from public.template_versions where id = v_s.template_version_id;
  if p_outcome is null or not private.outcome_allowed(v_mode, p_outcome) then
    perform private.fail('invalid_outcome');
  end if;
  if p_outcome = 'not_assessed' and length(btrim(coalesce(p_reason, ''))) = 0 then
    perform private.fail('reason_required');
  end if;
  select * into v_ss from public.session_subjects where session_id = p_session and subject_id = p_subject for update;
  if not found then perform private.fail('not_found', 'roster subject'); end if;
  if v_ss.removed_at is not null then perform private.fail('subject_removed'); end if;
  if p_expected_version is null or v_ss.version <> p_expected_version then perform private.fail('stale_version'); end if;

  if p_outcome in ('absent', 'not_assessed') then
    for v_a in
      update public.assessments set answers = null, notes = null, state = 'cleared', na_confirmed = false,
        version = version + 1, updated_by = (select auth.uid()), updated_at = now()
      where session_id = p_session and subject_id = p_subject and state = 'submitted'
      returning id, version
    loop
      insert into public.assessment_events (workspace_id, assessment_id, session_id, revision, kind, version, actor_id, reason)
      values (v_s.workspace_id, v_a.id, p_session, v_s.revision, 'clear', v_a.version, (select auth.uid()),
        'subject outcome ' || p_outcome);
    end loop;
    for v_a in
      update public.correction_requests set status = 'withdrawn', resolution = 'outcome_changed',
        resolved_by = (select auth.uid()), resolved_at = now()
      where session_id = p_session and subject_id = p_subject and status = 'open' returning id
    loop
      perform private.audit(v_s.workspace_id, 'correction.withdrawn', v_a.id, jsonb_build_object(
        'session_id', p_session, 'resolution', 'outcome_changed'));
    end loop;
  end if;

  update public.session_subjects set outcome = p_outcome,
    outcome_reason = nullif(btrim(coalesce(p_reason, '')), ''),
    resolved_by = (select auth.uid()), resolved_at = now(), version = version + 1
  where session_id = p_session and subject_id = p_subject;
  update public.sessions set data_version = data_version + 1 where id = p_session;
  perform private.audit(v_s.workspace_id, 'outcome.resolved', p_session, jsonb_build_object(
    'subject_id', p_subject, 'before', v_ss.outcome, 'after', p_outcome, 'revision', v_s.revision));
  return v_ss.version + 1;
end $$;

-- ---------------------------------------------------------------------------
-- Waivers
-- ---------------------------------------------------------------------------
create function private.set_waiver(p_session uuid, p_subject uuid, p_assessor uuid, p_waive boolean, p_reason text,
  p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_s public.sessions := private.lock_session(p_session);
  v_ss public.session_subjects;
  v_sa public.session_assignments;
  v_reason text;
begin
  if not private.can_review(p_session) then perform private.fail('forbidden'); end if;
  if v_s.status not in ('open', 'in_review') then perform private.fail('session_locked'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  v_ss := private.require_active_roster(p_session, p_subject);
  select * into v_sa from public.session_assignments
  where session_id = p_session and subject_id = p_subject and user_id = p_assessor for update;
  if not found then perform private.fail('not_assigned'); end if;
  if coalesce(p_waive, false) then
    v_reason := private.require_reason(p_reason);
    if p_assessor = v_uid and not private.has_role(v_s.workspace_id, '{owner,admin}') then
      perform private.fail('own_waiver_forbidden');
    end if;
    if v_sa.waived_at is not null then perform private.fail('already_waived'); end if;
    if v_ss.outcome = 'unknown' then perform private.fail('outcome_required'); end if;
    if v_ss.outcome in ('absent', 'not_assessed')
       or jsonb_array_length((select criteria from public.template_versions where id = v_s.template_version_id)) = 0 then
      perform private.fail('waiver_not_needed');
    end if;
    if exists (select 1 from public.assessments a where a.session_id = p_session and a.subject_id = p_subject
               and a.assessor_id = p_assessor and a.state = 'submitted' and a.answers is not null) then
      perform private.fail('response_present');
    end if;
    update public.session_assignments set waived_at = now(), waived_by = v_uid, waiver_reason = v_reason
    where session_id = p_session and subject_id = p_subject and user_id = p_assessor;
  else
    if v_sa.waived_at is null then perform private.fail('not_found', 'waiver'); end if;
    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    update public.session_assignments set waived_at = null, waived_by = null, waiver_reason = null
    where session_id = p_session and subject_id = p_subject and user_id = p_assessor;
  end if;
  update public.sessions set data_version = data_version + 1 where id = p_session;
  perform private.audit(v_s.workspace_id, case when p_waive then 'assignment.waived' else 'assignment.waiver_cleared' end,
    p_session, jsonb_build_object('subject_id', p_subject, 'user_id', p_assessor, 'reason', v_reason,
      'own', p_assessor = v_uid, 'revision', v_s.revision));
  return v_s.data_version + 1;
end $$;

-- ---------------------------------------------------------------------------
-- Correction requests
-- ---------------------------------------------------------------------------
create function private.request_correction(p_session uuid, p_subject uuid, p_assessor uuid, p_reason text,
  p_expected_data_version integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_s public.sessions := private.lock_session(p_session);
  v_ss public.session_subjects;
  v_reason text;
  v_id uuid;
begin
  if not private.can_review(p_session) then perform private.fail('forbidden'); end if;
  if not private.session_collecting(v_s) then perform private.fail('collection_closed'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  v_reason := private.require_reason(p_reason);
  v_ss := private.require_active_roster(p_session, p_subject);
  if v_ss.outcome in ('absent', 'not_assessed') then perform private.fail('subject_not_assessable'); end if;
  if p_assessor = v_uid then perform private.fail('invalid_target'); end if;
  if not exists (select 1 from public.session_assignments where session_id = p_session and subject_id = p_subject
                 and user_id = p_assessor) or not private.assignment_in_scope(p_session, p_assessor) then
    perform private.fail('not_assigned');
  end if;
  if not exists (select 1 from public.assessments a where a.session_id = p_session and a.subject_id = p_subject
                 and a.assessor_id = p_assessor and a.state = 'submitted') then
    perform private.fail('nothing_to_correct');
  end if;
  if exists (select 1 from public.correction_requests where session_id = p_session and subject_id = p_subject
             and assessor_id = p_assessor and status = 'open') then
    perform private.fail('correction_open');
  end if;
  insert into public.correction_requests (workspace_id, session_id, subject_id, assessor_id, revision, reason,
    requested_by, requester_name)
  values (v_s.workspace_id, p_session, p_subject, p_assessor, v_s.revision, v_reason, v_uid,
    coalesce((select display_name from public.memberships where workspace_id = v_s.workspace_id and user_id = v_uid), 'Reviewer'))
  returning id into v_id;
  update public.sessions set data_version = data_version + 1 where id = p_session;
  perform private.audit(v_s.workspace_id, 'correction.requested', v_id, jsonb_build_object(
    'session_id', p_session, 'subject_id', p_subject, 'assessor_id', p_assessor, 'reason', v_reason));
  return v_id;
end $$;

create function private.withdraw_correction(p_request uuid, p_reason text, p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_cr public.correction_requests;
  v_s public.sessions;
begin
  perform private.require_uid();
  select * into v_cr from public.correction_requests where id = p_request;
  if not found then perform private.fail('not_found', 'correction request'); end if;
  v_s := private.lock_session(v_cr.session_id);
  if not private.can_review(v_cr.session_id) then perform private.fail('forbidden'); end if;
  if v_s.status not in ('open', 'in_review') then perform private.fail('session_locked'); end if;
  perform private.require_version(v_s, p_expected_data_version);
  select * into v_cr from public.correction_requests where id = p_request for update;
  if v_cr.status <> 'open' then perform private.fail('invalid_state'); end if;
  update public.correction_requests set status = 'withdrawn', resolution = 'withdrawn',
    resolution_reason = private.require_reason(p_reason), resolved_by = (select auth.uid()), resolved_at = now()
  where id = p_request;
  update public.sessions set data_version = data_version + 1 where id = v_s.id;
  perform private.audit(v_s.workspace_id, 'correction.withdrawn', p_request, jsonb_build_object(
    'session_id', v_s.id, 'reason', btrim(p_reason)));
  return v_s.data_version + 1;
end $$;

-- ---------------------------------------------------------------------------
-- Approval, cancellation (replaced)
-- ---------------------------------------------------------------------------
-- Diff from m1_core: only active roster rows; an explicit waiver satisfies a missing required
-- response for approval (the snapshot still reports it missing); open correction requests block;
-- an empty active roster blocks.
create or replace function private.approve_session(p_session uuid, p_expected_data_version integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_s public.sessions := private.lock_session(p_session);
  v_tv public.template_versions;
  v_problems text[] := '{}';
  r record;
  v_inputs jsonb;
  v_name text;
  v_id uuid;
begin
  if not private.can_review(p_session) then perform private.fail('forbidden'); end if;
  if v_s.status not in ('open', 'in_review') then perform private.fail('invalid_state'); end if;
  if p_expected_data_version is null or v_s.data_version <> p_expected_data_version then perform private.fail('stale_version'); end if;
  select * into v_tv from public.template_versions where id = v_s.template_version_id;
  if not exists (select 1 from public.session_subjects where session_id = p_session and removed_at is null) then
    v_problems := v_problems || 'no active roster subjects'::text;
  end if;

  for r in
    select ss.subject_name, ss.outcome,
      count(sa.user_id) as required,
      count(sa.user_id) filter (where a.state = 'submitted' and a.answers is not null) as complete,
      count(sa.user_id) filter (where sa.waived_at is not null
        and not (coalesce(a.state = 'submitted', false) and a.answers is not null)) as waived,
      count(sa.user_id) filter (where a.state = 'submitted' and private.has_na(a.answers) and not a.na_confirmed) as unconfirmed_na,
      (select count(*) from public.correction_requests cr where cr.session_id = ss.session_id
        and cr.subject_id = ss.subject_id and cr.status = 'open') as open_corrections
    from public.session_subjects ss
    left join public.session_assignments sa on sa.session_id = ss.session_id and sa.subject_id = ss.subject_id
    left join public.assessments a on a.session_id = sa.session_id and a.subject_id = sa.subject_id
      and a.assessor_id = sa.user_id
    where ss.session_id = p_session and ss.removed_at is null
    group by ss.session_id, ss.subject_id, ss.subject_name, ss.outcome
    order by ss.subject_name
  loop
    if r.outcome = 'unknown' then
      v_problems := v_problems || (r.subject_name || ': outcome not recorded');
    elsif r.open_corrections > 0 then
      v_problems := v_problems || (r.subject_name || ': correction requested and not yet resolved');
    elsif r.outcome in ('absent', 'not_assessed') or jsonb_array_length(v_tv.criteria) = 0 then
      continue;
    elsif r.required = 0 then
      v_problems := v_problems || (r.subject_name || ': no assessor assigned');
    elsif r.complete + r.waived < r.required then
      v_problems := v_problems || (r.subject_name || ': ' || (r.required - r.complete - r.waived) || ' required response(s) missing');
    elsif r.unconfirmed_na > 0 then
      v_problems := v_problems || (r.subject_name || ': N/A answers need reviewer confirmation');
    end if;
  end loop;
  if cardinality(v_problems) > 0 then
    perform private.fail('approval_blocked', array_to_string(v_problems, '; '));
  end if;

  v_inputs := private.build_inputs(p_session);
  select display_name into v_name from public.memberships
  where workspace_id = v_s.workspace_id and user_id = v_uid;
  insert into public.report_revisions (workspace_id, session_id, revision, inputs, inputs_hash,
    formula_version, approved_by, approver_name)
  values (v_s.workspace_id, p_session, v_s.revision, v_inputs, private.sha256_hex(v_inputs::text),
    v_inputs ->> 'formula_version', v_uid, v_name)
  returning id into v_id;
  update public.sessions set status = 'approved', current_report_id = v_id, data_version = data_version + 1
  where id = p_session;
  perform private.audit(v_s.workspace_id, 'session.approved', p_session,
    jsonb_build_object('revision', v_s.revision, 'report_id', v_id, 'waived', (
      select count(*) from public.session_assignments where session_id = p_session and waived_at is not null)));
  return v_id;
end $$;

-- Diff from m1_core: drafts can be cancelled.
create or replace function private.cancel_session(p_session uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_s public.sessions := private.lock_session(p_session);
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status not in ('draft', 'open', 'in_review') then perform private.fail('invalid_state'); end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then perform private.fail('reason_required'); end if;
  update public.sessions set status = 'cancelled', cancel_reason = btrim(p_reason), data_version = data_version + 1
  where id = p_session;
  perform private.audit(v_s.workspace_id, 'session.cancelled', p_session, jsonb_build_object('reason', btrim(p_reason)));
end $$;

-- ---------------------------------------------------------------------------
-- Dashboard (replaced): samples excluded in SQL; "under revision" also covers a revision whose
-- collection was explicitly reopened (status open, revision > 1).
-- ---------------------------------------------------------------------------
create or replace function private.get_dashboard(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_role public.member_role := private.member_role(p_ws);
begin
  perform private.require_uid();
  if v_role is null then perform private.fail('not_found', 'workspace'); end if;
  if v_role not in ('owner', 'admin', 'reviewer', 'viewer') then perform private.fail('forbidden'); end if;
  return jsonb_build_object(
    'approved', coalesce((
      select jsonb_agg(jsonb_build_object('session_id', s.id, 'revision', r.revision,
        'approved_at', r.approved_at, 'inputs', private.redact_inputs(r.inputs))
        order by s.local_date desc, s.created_at desc)
      from public.sessions s join public.report_revisions r on r.id = s.current_report_id
      where s.workspace_id = p_ws and s.status = 'approved' and not s.is_sample
        and (private.can_review(s.id) or private.viewer_can_see(s.id))), '[]'),
    'under_revision', coalesce((
      select jsonb_agg(jsonb_build_object('session_id', s.id, 'name', s.name, 'local_date', s.local_date,
        'revision', s.revision, 'reason', s.last_reopen_reason, 'status', s.status) order by s.local_date desc)
      from public.sessions s
      where s.workspace_id = p_ws and s.status in ('in_review', 'open') and s.revision > 1 and not s.is_sample
        and (private.can_review(s.id)
          or (v_role = 'viewer' and private.in_location(p_ws, s.location_id)))), '[]'));
end $$;

-- ---------------------------------------------------------------------------
-- Invitations (replaced): guests only for real, open, collecting sessions and active roster rows.
-- ---------------------------------------------------------------------------
-- Diff from m1_core: sample sessions and removed roster subjects refused for guest invitations.
create or replace function private.create_invitation(p_ws uuid, p_email text, p_role public.member_role,
  p_all_locations boolean, p_location_ids uuid[], p_session uuid, p_subject_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_role public.member_role := private.member_role(p_ws);
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_locs uuid[] := array(select distinct unnest(coalesce(p_location_ids, '{}')));
  v_all boolean := coalesce(p_all_locations, false);
  v_subjects uuid[] := array(select distinct unnest(coalesce(p_subject_ids, '{}')));
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_id uuid;
  v_expires timestamptz := now() + interval '7 days';
begin
  if v_role is null or v_role not in ('owner', 'admin') then perform private.fail('forbidden'); end if;
  if p_role is null or p_role = 'owner' then perform private.fail('role_not_invitable'); end if;
  if v_role = 'admin' and p_role = 'admin' then perform private.fail('role_not_invitable'); end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then perform private.fail('invalid_email'); end if;
  if p_role = 'guest' then
    if p_session is null or not exists (select 1 from public.sessions where id = p_session
        and workspace_id = p_ws and status = 'open' and closes_at > now() and not is_sample) then
      perform private.fail('not_found', 'open session');
    end if;
    if cardinality(v_subjects) = 0 then perform private.fail('subjects_required'); end if;
    if (select count(*) from public.session_subjects where session_id = p_session and removed_at is null
        and subject_id = any (v_subjects)) <> cardinality(v_subjects) then
      perform private.fail('not_found', 'roster subject');
    end if;
    v_all := false; v_locs := '{}';
  else
    if p_session is not null or cardinality(v_subjects) > 0 then perform private.fail('invalid_scope'); end if;
    if p_role = 'admin' then v_all := true; v_locs := '{}'; end if;
    if (select count(*) from public.locations where workspace_id = p_ws and archived_at is null
        and id = any (v_locs)) <> cardinality(v_locs) then
      perform private.fail('not_found', 'location');
    end if;
    if not v_all and cardinality(v_locs) = 0 then perform private.fail('locations_required'); end if;
  end if;
  insert into public.invitations (workspace_id, email, role, all_locations, location_ids, session_id,
    subject_ids, token_hash, expires_at, created_by)
  values (p_ws, v_email, p_role, v_all, v_locs, case when p_role = 'guest' then p_session end, v_subjects,
    private.sha256_hex(v_token), v_expires, v_uid)
  returning id into v_id;
  perform private.audit(p_ws, 'invitation.created', v_id, jsonb_build_object('email', v_email, 'role', p_role));
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_expires);
end $$;

-- Lock order (whole schema). Every path that takes more than one of these takes them in this
-- order, so no wait cycle can form:
--   1. invitation row (acceptance only)          FOR UPDATE
--   2. session row (private.lock_session)        FOR UPDATE   -- the evidence lock
--   3. per-workspace directory advisory lock      (directory writers, sample creation)
--   4. workspace row (membership serialization)   FOR NO KEY UPDATE
--   5. membership / subject / category / contact  FOR NO KEY UPDATE
-- FOR NO KEY UPDATE never conflicts with the FOR KEY SHARE that foreign-key inserts take on the
-- referenced row, so audit rows, roster rows and assignments referencing a workspace, subject or
-- membership never wait on these locks. Only session rows keep FOR UPDATE (M1 behaviour).
--
-- Diff from m1_core:
-- * guest acceptance locks the session BEFORE the workspace (same order as every session
--   writer), and requires live collection on a real (non-sample) session;
-- * the workspace and membership rows are locked FOR NO KEY UPDATE instead of FOR UPDATE;
-- * already_member only for an ACTIVE and UNEXPIRED membership. An expired (or revoked)
--   membership is replaced by the new invitation's scope: role, binding, expiry and locations
--   come only from the new invitation. For a guest, earlier assignments in the invited session
--   outside the new subject list are removed when they carry no evidence; if one carries a
--   response or a waiver, acceptance stops with invitation_scope_conflict instead of silently
--   reviving or dropping it. Assignments in other sessions stay inert (the guest binding moves).
-- * only subjects still on the active roster are assigned.
create or replace function private.accept_invitation(p_token text, p_display_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_inv public.invitations;
  v_user record;
  v_status text;
  v_m public.memberships;
  v_s public.sessions;
  v_name text := btrim(coalesce(p_display_name, ''));
  v_conflict text;
  v_dropped integer := 0;
  v_replaced boolean;
begin
  if length(v_name) not between 1 and 80 then perform private.fail('invalid_name'); end if;
  select * into v_inv from public.invitations where token_hash = private.sha256_hex(coalesce(p_token, '')) for update;
  if not found then perform private.fail('invitation_invalid'); end if;
  select email, email_confirmed_at is not null as confirmed into v_user from auth.users where id = v_uid;
  v_status := private.invitation_status(v_inv, v_user.email, v_user.confirmed);
  if v_status <> 'valid' then perform private.fail(v_status); end if;

  if v_inv.role = 'guest' then
    select * into v_s from public.sessions where id = v_inv.session_id for update;
    if not private.session_collecting(v_s) or v_s.is_sample then perform private.fail('session_closed'); end if;
  end if;
  perform 1 from public.workspaces where id = v_inv.workspace_id for no key update;  -- serialize membership changes
  select * into v_m from public.memberships where workspace_id = v_inv.workspace_id and user_id = v_uid for no key update;
  if found and v_m.status = 'active' and (v_m.expires_at is null or v_m.expires_at > now()) then
    perform private.fail('already_member');
  end if;

  v_replaced := v_m.id is not null;
  if v_replaced and v_inv.role = 'guest' then
    select string_agg(ss.subject_name, ', ' order by ss.subject_name) into v_conflict
    from public.session_assignments a
    join public.session_subjects ss on ss.session_id = a.session_id and ss.subject_id = a.subject_id
    where a.session_id = v_inv.session_id and a.user_id = v_uid and not (a.subject_id = any (v_inv.subject_ids))
      and (a.waived_at is not null or exists (select 1 from public.assessments x where x.session_id = a.session_id
             and x.subject_id = a.subject_id and x.assessor_id = a.user_id));
    if v_conflict is not null then perform private.fail('invitation_scope_conflict', v_conflict); end if;
    delete from public.session_assignments a
    where a.session_id = v_inv.session_id and a.user_id = v_uid and not (a.subject_id = any (v_inv.subject_ids));
    get diagnostics v_dropped = row_count;
  end if;

  if v_m.id is null then
    insert into public.memberships (workspace_id, user_id, role, display_name, email, all_locations,
      guest_session_id, expires_at)
    values (v_inv.workspace_id, v_uid, v_inv.role, v_name, lower(v_user.email), v_inv.all_locations,
      v_inv.session_id, v_s.closes_at)
    returning * into v_m;
  else
    update public.memberships set role = v_inv.role, status = 'active', display_name = v_name,
      all_locations = v_inv.all_locations, guest_session_id = v_inv.session_id, expires_at = v_s.closes_at,
      revoked_at = null, revoked_by = null
    where id = v_m.id returning * into v_m;
    delete from public.membership_locations where membership_id = v_m.id;
  end if;
  insert into public.membership_locations (workspace_id, membership_id, location_id)
  select v_inv.workspace_id, v_m.id, l.id from public.locations l
  where l.workspace_id = v_inv.workspace_id and l.id = any (v_inv.location_ids);

  if v_inv.role = 'guest' then
    insert into public.session_assignments (workspace_id, session_id, subject_id, user_id)
    select v_inv.workspace_id, v_inv.session_id, ss.subject_id, v_uid
    from public.session_subjects ss
    where ss.session_id = v_inv.session_id and ss.subject_id = any (v_inv.subject_ids) and ss.removed_at is null
    on conflict do nothing;
    update public.sessions set data_version = data_version + 1 where id = v_inv.session_id;
  end if;
  update public.invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  perform private.audit(v_inv.workspace_id, 'invitation.accepted', v_inv.id, jsonb_build_object('role', v_inv.role,
    'replaced_membership', v_replaced, 'dropped_assignments', v_dropped));
  return v_inv.workspace_id;
end $$;

-- Diff from m1_core: workspace and membership rows locked FOR NO KEY UPDATE (see lock order).
create or replace function private.update_member(p_ws uuid, p_user uuid, p_role public.member_role,
  p_all_locations boolean, p_location_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_role public.member_role := private.member_role(p_ws);
  v_m public.memberships;
  v_locs uuid[] := array(select distinct unnest(coalesce(p_location_ids, '{}')));
begin
  if v_role is null or v_role not in ('owner', 'admin') then perform private.fail('forbidden'); end if;
  if p_user = v_uid then perform private.fail('cannot_change_own_role'); end if;
  perform 1 from public.workspaces where id = p_ws for no key update;
  select * into v_m from public.memberships where workspace_id = p_ws and user_id = p_user and status = 'active' for no key update;
  if not found then perform private.fail('not_found', 'member'); end if;
  if p_role is null or p_role = 'owner' then perform private.fail('role_not_grantable'); end if;
  if v_m.role = 'guest' or p_role = 'guest' then perform private.fail('role_not_grantable'); end if;
  if v_role = 'admin' and (v_m.role in ('owner', 'admin') or p_role = 'admin') then perform private.fail('forbidden'); end if;
  if (select count(*) from public.locations where workspace_id = p_ws and id = any (v_locs)) <> cardinality(v_locs) then
    perform private.fail('not_found', 'location');
  end if;
  update public.memberships set role = p_role, all_locations = (p_role = 'admin' or coalesce(p_all_locations, false))
  where id = v_m.id;  -- last-owner trigger protects demotion of the final owner
  delete from public.membership_locations where membership_id = v_m.id;
  insert into public.membership_locations (workspace_id, membership_id, location_id)
  select p_ws, v_m.id, unnest(v_locs);
  perform private.audit(p_ws, 'member.updated', v_m.id, jsonb_build_object(
    'user_id', p_user, 'before', v_m.role, 'after', p_role, 'locations', to_jsonb(v_locs)));
end $$;

-- Diff from m1_core: workspace and membership rows locked FOR NO KEY UPDATE (see lock order).
create or replace function private.revoke_member(p_ws uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_role public.member_role := private.member_role(p_ws);
  v_m public.memberships;
begin
  if v_role is null then perform private.fail('not_found', 'workspace'); end if;
  if p_user <> v_uid and v_role not in ('owner', 'admin') then perform private.fail('forbidden'); end if;
  perform 1 from public.workspaces where id = p_ws for no key update;
  select * into v_m from public.memberships where workspace_id = p_ws and user_id = p_user and status = 'active' for no key update;
  if not found then perform private.fail('not_found', 'member'); end if;
  if p_user <> v_uid and v_role = 'admin' and v_m.role in ('owner', 'admin') then perform private.fail('forbidden'); end if;
  update public.memberships set status = 'revoked', revoked_at = now(), revoked_by = v_uid where id = v_m.id;
  perform private.audit(p_ws, 'member.revoked', v_m.id, jsonb_build_object('user_id', p_user, 'role', v_m.role));
end $$;

-- ---------------------------------------------------------------------------
-- Labelled sample inspection
-- ---------------------------------------------------------------------------
-- Uses an existing active location and published template version. Reuses (or creates) two
-- clearly named SAMPLE subjects suited to the template's starter pack (vendors for food
-- vendors, an outlet and a kitchen operation for restaurant operations, a supplier and a service
-- provider for supplier/service quality). The caller is assessor and reviewer; no guests. Opens now.
create function private.sample_subjects_for(p_pack public.starter_pack) returns table (name text, subject_type public.subject_type)
language sql immutable set search_path = '' as $$
  select x.name, x.subject_type::public.subject_type from (values
    ('food_vendors', 'SAMPLE - Practice vendor A', 'vendor'), ('food_vendors', 'SAMPLE - Practice vendor B', 'vendor'),
    ('restaurant_ops', 'SAMPLE - Practice outlet', 'outlet'), ('restaurant_ops', 'SAMPLE - Practice kitchen operation', 'operation'),
    ('supplier_service', 'SAMPLE - Practice supplier', 'supplier'),
    ('supplier_service', 'SAMPLE - Practice service provider', 'service_provider'),
    ('custom', 'SAMPLE - Practice subject A', 'operation'), ('custom', 'SAMPLE - Practice subject B', 'operation')
  ) as x (pack, name, subject_type)
  where x.pack = p_pack::text
$$;

create function private.create_sample_session(p_ws uuid, p_location uuid, p_template_version uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_id uuid;
  v_subjects uuid[] := '{}';
  v_mode public.attendance_mode;
  v_pack public.starter_pack;
  v_sid uuid;
  r record;
begin
  perform private.lock_directory(p_ws);
  if not exists (select 1 from public.locations where id = p_location and workspace_id = p_ws and archived_at is null) then
    perform private.fail('not_found', 'location');
  end if;
  select tv.attendance_mode, t.pack into v_mode, v_pack from public.template_versions tv
  join public.templates t on t.id = tv.template_id
  where tv.id = p_template_version and tv.workspace_id = p_ws;
  if v_mode is null then perform private.fail('not_found', 'template version'); end if;
  for r in select * from private.sample_subjects_for(v_pack) order by name loop
    v_sid := null;
    select id into v_sid from public.subjects where workspace_id = p_ws and is_sample and archived_at is null
      and name = r.name and subject_type = r.subject_type;
    if v_sid is null then
      if exists (select 1 from public.subjects where workspace_id = p_ws and private.norm_name(name) = private.norm_name(r.name)) then
        perform private.fail('duplicate_name', r.name);
      end if;
      insert into public.subjects (workspace_id, name, subject_type, is_sample) values (p_ws, r.name, r.subject_type, true)
      returning id into v_sid;
    end if;
    v_subjects := v_subjects || v_sid;
  end loop;
  insert into public.sessions (workspace_id, location_id, template_version_id, name, local_date, opens_at, closes_at,
    expected_ready_time, created_by, is_sample, opened_at, planned_window_hours)
  values (p_ws, p_location, p_template_version, 'SAMPLE - Practice inspection',
    (now() at time zone (select timezone from public.workspaces where id = p_ws))::date, now(), now() + interval '48 hours',
    case when v_mode = 'scored' then time '09:00' end, v_uid, true, now(), 48)
  returning id into v_id;
  insert into public.session_subjects (workspace_id, session_id, subject_id, subject_name)
  select p_ws, v_id, s.id, s.name from public.subjects s where s.id = any (v_subjects);
  insert into public.session_assignments (workspace_id, session_id, subject_id, user_id)
  select p_ws, v_id, s, v_uid from unnest(v_subjects) s;
  insert into public.session_reviewers (workspace_id, session_id, user_id) values (p_ws, v_id, v_uid);
  perform private.audit(p_ws, 'session.sample_created', v_id, jsonb_build_object('subjects', cardinality(v_subjects),
    'pack', v_pack));
  return v_id;
end $$;

-- Setup checklist source. Every count excludes samples in SQL.
create function private.get_setup_progress(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_uid();
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  return jsonb_build_object(
    'locations', (select count(*) from public.locations where workspace_id = p_ws and archived_at is null),
    'categories', (select count(*) from public.categories where workspace_id = p_ws and archived_at is null),
    'subjects', (select count(*) from public.subjects where workspace_id = p_ws and archived_at is null and not is_sample),
    'templates', (select count(*) from public.templates where workspace_id = p_ws),
    'reviewers', (select count(*) from public.memberships where workspace_id = p_ws and status = 'active' and role = 'reviewer'),
    'sessions', (select count(*) from public.sessions where workspace_id = p_ws and not is_sample and status <> 'cancelled'),
    'opened', (select count(*) from public.sessions where workspace_id = p_ws and not is_sample and opened_at is not null),
    'approved', (select count(*) from public.sessions where workspace_id = p_ws and not is_sample and current_report_id is not null),
    'samples', (select jsonb_build_object('sessions', count(*), 'approved', count(*) filter (where s.current_report_id is not null),
                  'latest_session_id', (array_agg(s.id order by s.created_at desc, s.id))[1])
                from public.sessions s where s.workspace_id = p_ws and s.is_sample and s.status <> 'cancelled'));
end $$;

-- ---------------------------------------------------------------------------
-- Public SECURITY INVOKER wrappers
-- ---------------------------------------------------------------------------
create function public.create_session_draft(p_ws uuid, p_location uuid, p_template_version uuid, p_name text,
  p_local_date date, p_subject_ids uuid[], p_assessor_ids uuid[], p_reviewer_ids uuid[],
  p_window_hours integer, p_ready_time time) returns uuid
language sql security invoker set search_path = '' as
$$ select private.create_session_draft(p_ws, p_location, p_template_version, p_name, p_local_date, p_subject_ids,
  p_assessor_ids, p_reviewer_ids, p_window_hours, p_ready_time) $$;
create function public.update_session_draft(p_session uuid, p_name text, p_local_date date, p_location uuid,
  p_template_version uuid, p_window_hours integer, p_ready_time time, p_expected_data_version integer) returns integer
language sql security invoker set search_path = '' as
$$ select private.update_session_draft(p_session, p_name, p_local_date, p_location, p_template_version, p_window_hours,
  p_ready_time, p_expected_data_version) $$;
create function public.open_session(p_session uuid, p_expected_data_version integer) returns integer
language sql security invoker set search_path = '' as $$ select private.open_session(p_session, p_expected_data_version) $$;
create function public.set_roster_subject(p_session uuid, p_subject uuid, p_on boolean, p_reason text,
  p_expected_data_version integer) returns integer language sql security invoker set search_path = '' as
$$ select private.set_roster_subject(p_session, p_subject, p_on, p_reason, p_expected_data_version) $$;
create function public.set_session_reviewer(p_session uuid, p_user uuid, p_on boolean, p_reason text,
  p_expected_data_version integer) returns integer language sql security invoker set search_path = '' as
$$ select private.set_session_reviewer(p_session, p_user, p_on, p_reason, p_expected_data_version) $$;
create function public.update_session_window(p_session uuid, p_hours integer, p_reason text, p_expected_data_version integer)
returns integer language sql security invoker set search_path = '' as
$$ select private.update_session_window(p_session, p_hours, p_reason, p_expected_data_version) $$;
create function public.reopen_collection(p_session uuid, p_hours integer, p_reason text, p_expected_data_version integer)
returns integer language sql security invoker set search_path = '' as
$$ select private.reopen_collection(p_session, p_hours, p_reason, p_expected_data_version) $$;
create function public.set_assignment(p_session uuid, p_subject uuid, p_user uuid, p_assigned boolean,
  p_expected_data_version integer, p_reason text) returns integer language sql security invoker set search_path = '' as
$$ select private.set_assignment(p_session, p_subject, p_user, p_assigned, p_expected_data_version, p_reason) $$;
create function public.set_waiver(p_session uuid, p_subject uuid, p_assessor uuid, p_waive boolean, p_reason text,
  p_expected_data_version integer) returns integer language sql security invoker set search_path = '' as
$$ select private.set_waiver(p_session, p_subject, p_assessor, p_waive, p_reason, p_expected_data_version) $$;
create function public.request_correction(p_session uuid, p_subject uuid, p_assessor uuid, p_reason text,
  p_expected_data_version integer) returns uuid language sql security invoker set search_path = '' as
$$ select private.request_correction(p_session, p_subject, p_assessor, p_reason, p_expected_data_version) $$;
create function public.withdraw_correction(p_request uuid, p_reason text, p_expected_data_version integer) returns integer
language sql security invoker set search_path = '' as $$ select private.withdraw_correction(p_request, p_reason, p_expected_data_version) $$;
create function public.create_sample_session(p_ws uuid, p_location uuid, p_template_version uuid) returns uuid
language sql security invoker set search_path = '' as $$ select private.create_sample_session(p_ws, p_location, p_template_version) $$;
create function public.get_setup_progress(p_ws uuid) returns jsonb language sql stable security invoker set search_path = '' as
$$ select private.get_setup_progress(p_ws) $$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.correction_requests enable row level security;
create policy correction_requests_read on public.correction_requests for select to authenticated
  using (private.can_review(session_id)
    or (assessor_id = (select auth.uid()) and private.is_assigned(session_id, subject_id)));

-- ---------------------------------------------------------------------------
-- Grants (explicit; see the directory migration for why new objects are revoked here)
-- ---------------------------------------------------------------------------
revoke all on table public.correction_requests from public, anon, authenticated;
grant select on public.correction_requests to authenticated;

revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon;
-- Internal helpers: only called from SECURITY DEFINER functions.
revoke all on function private.sample_subjects_for(public.starter_pack),
  private.session_collecting(public.sessions), private.require_version(public.sessions, integer),
  private.require_reason(text), private.require_active_roster(uuid, uuid),
  private.move_guest_grants(uuid, timestamptz, timestamptz), private.scope_problems(uuid) from authenticated;
grant execute on function
  private.create_session_draft(uuid, uuid, uuid, text, date, uuid[], uuid[], uuid[], integer, time),
  private.update_session_draft(uuid, text, date, uuid, uuid, integer, time, integer),
  private.open_session(uuid, integer),
  private.set_roster_subject(uuid, uuid, boolean, text, integer),
  private.set_session_reviewer(uuid, uuid, boolean, text, integer),
  private.update_session_window(uuid, integer, text, integer),
  private.reopen_collection(uuid, integer, text, integer),
  private.set_assignment(uuid, uuid, uuid, boolean, integer, text),
  private.set_waiver(uuid, uuid, uuid, boolean, text, integer),
  private.request_correction(uuid, uuid, uuid, text, integer),
  private.withdraw_correction(uuid, text, integer),
  private.create_sample_session(uuid, uuid, uuid),
  private.get_setup_progress(uuid)
to authenticated;
grant execute on function
  public.create_session_draft(uuid, uuid, uuid, text, date, uuid[], uuid[], uuid[], integer, time),
  public.update_session_draft(uuid, text, date, uuid, uuid, integer, time, integer),
  public.open_session(uuid, integer),
  public.set_roster_subject(uuid, uuid, boolean, text, integer),
  public.set_session_reviewer(uuid, uuid, boolean, text, integer),
  public.update_session_window(uuid, integer, text, integer),
  public.reopen_collection(uuid, integer, text, integer),
  public.set_assignment(uuid, uuid, uuid, boolean, integer, text),
  public.set_waiver(uuid, uuid, uuid, boolean, text, integer),
  public.request_correction(uuid, uuid, uuid, text, integer),
  public.withdraw_correction(uuid, text, integer),
  public.create_sample_session(uuid, uuid, uuid),
  public.get_setup_progress(uuid)
to authenticated;
