-- SAVOUR SaaS Milestone 1: workspaces, identity, templates, sessions, scoring evidence,
-- approval/reopen and report reads.
--
-- Security model
-- * Clients (role authenticated) get SELECT only, filtered by RLS. No client INSERT/UPDATE/DELETE.
-- * Every mutation is a public SECURITY INVOKER wrapper over a private SECURITY DEFINER
--   implementation that resolves auth.uid() to a live, active membership and checks role and scope.
-- * The private schema is not exposed through the Data API.
-- * Every mutation of session evidence (submission, assignment, attendance/outcome, N/A
--   confirmation, close, approve, reopen, cancel) takes the same lock: the session row FOR UPDATE.
-- * Approved report snapshots are insert-only; sessions.current_report_id is the current pointer.
-- * Authorization never reads user_metadata; identity is auth.uid() and the verified auth.users email.

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.member_role as enum ('owner', 'admin', 'reviewer', 'assessor', 'viewer', 'guest');
create type public.member_status as enum ('active', 'revoked');
create type public.attendance_mode as enum ('off', 'presence', 'scored');
create type public.session_status as enum ('open', 'in_review', 'approved', 'cancelled');
create type public.subject_outcome as enum
  ('unknown', 'early', 'middle', 'late', 'present', 'absent', 'assessed', 'not_assessed');
create type public.subject_type as enum ('vendor', 'outlet', 'operation', 'supplier', 'service_provider');
create type public.starter_pack as enum ('food_vendors', 'restaurant_ops', 'supplier_service', 'custom');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  country text not null check (length(btrim(country)) between 2 and 56),
  timezone text not null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  user_id uuid not null,
  role public.member_role not null,
  status public.member_status not null default 'active',
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  email text not null,
  all_locations boolean not null default false,
  guest_session_id uuid,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  unique (workspace_id, user_id),
  unique (workspace_id, id),
  check ((role = 'guest') = (guest_session_id is not null))
);
create index memberships_user_idx on public.memberships (user_id);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  name text not null check (length(btrim(name)) between 1 and 120),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table public.membership_locations (
  workspace_id uuid not null,
  membership_id uuid not null,
  location_id uuid not null,
  primary key (membership_id, location_id),
  foreign key (workspace_id, membership_id) references public.memberships (workspace_id, id) on delete cascade,
  foreign key (workspace_id, location_id) references public.locations (workspace_id, id)
);

create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  name text not null check (length(btrim(name)) between 1 and 120),
  subject_type public.subject_type not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  name text not null check (length(btrim(name)) between 1 and 120),
  pack public.starter_pack not null,
  latest_version integer not null default 0,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

-- Published versions are immutable (trigger below). criteria is a validated JSON array of
-- {key, label, guidance, allow_na}. All criteria are equal-weight integer 1..5.
create table public.template_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  template_id uuid not null,
  version integer not null check (version >= 1),
  name text not null,
  attendance_mode public.attendance_mode not null,
  criteria jsonb not null,
  formula_version text not null,
  published_by uuid not null,
  published_at timestamptz not null default now(),
  unique (template_id, version),
  unique (workspace_id, id),
  foreign key (workspace_id, template_id) references public.templates (workspace_id, id)
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  location_id uuid not null,
  template_version_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 120),
  local_date date not null,
  status public.session_status not null default 'open',
  opens_at timestamptz not null default now(),
  closes_at timestamptz not null,
  expected_ready_time time,
  revision integer not null default 1,
  data_version integer not null default 1,
  current_report_id uuid,
  last_reopen_reason text,
  cancel_reason text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  check (closes_at > opens_at),
  foreign key (workspace_id, location_id) references public.locations (workspace_id, id),
  foreign key (workspace_id, template_version_id) references public.template_versions (workspace_id, id)
);

alter table public.memberships
  add foreign key (workspace_id, guest_session_id) references public.sessions (workspace_id, id);

create table public.session_reviewers (
  workspace_id uuid not null,
  session_id uuid not null,
  user_id uuid not null,
  primary key (session_id, user_id),
  foreign key (workspace_id, session_id) references public.sessions (workspace_id, id),
  foreign key (workspace_id, user_id) references public.memberships (workspace_id, user_id)
);

-- Roster with one canonical outcome per subject per session revision.
create table public.session_subjects (
  workspace_id uuid not null,
  session_id uuid not null,
  subject_id uuid not null,
  subject_name text not null,
  outcome public.subject_outcome not null default 'unknown',
  outcome_reason text,
  resolved_by uuid,
  resolved_at timestamptz,
  version integer not null default 1,
  primary key (session_id, subject_id),
  unique (workspace_id, session_id, subject_id),
  foreign key (workspace_id, session_id) references public.sessions (workspace_id, id),
  foreign key (workspace_id, subject_id) references public.subjects (workspace_id, id)
);

create table public.session_assignments (
  workspace_id uuid not null,
  session_id uuid not null,
  subject_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (session_id, subject_id, user_id),
  foreign key (workspace_id, session_id, subject_id)
    references public.session_subjects (workspace_id, session_id, subject_id),
  foreign key (workspace_id, user_id) references public.memberships (workspace_id, user_id)
);
create index session_assignments_user_idx on public.session_assignments (user_id, session_id);

-- Current assessment per (session, subject, assessor). History lives in assessment_events.
create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  session_id uuid not null,
  subject_id uuid not null,
  assessor_id uuid not null,
  assessor_name text not null,
  observed_attendance public.subject_outcome,
  answers jsonb,
  notes text check (length(notes) <= 2000),          -- quality feedback; never kept for absence
  absence_reason text check (length(absence_reason) <= 2000),  -- notice/reason for an absent observation
  state text not null check (state in ('submitted', 'cleared')),
  na_confirmed boolean not null default false,
  version integer not null default 1,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  unique (session_id, subject_id, assessor_id),
  unique (workspace_id, id),
  foreign key (workspace_id, session_id, subject_id)
    references public.session_subjects (workspace_id, session_id, subject_id)
);

create table public.assessment_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  assessment_id uuid not null,
  session_id uuid not null,
  revision integer not null,
  kind text not null check (kind in ('submit', 'amend', 'clear', 'na_confirm')),
  version integer not null,
  actor_id uuid not null,
  payload jsonb,
  payload_hash text,
  idempotency_key uuid,
  reason text,
  created_at timestamptz not null default now(),
  unique (actor_id, idempotency_key),
  foreign key (workspace_id, assessment_id) references public.assessments (workspace_id, id)
);
create index assessment_events_session_idx on public.assessment_events (session_id);

-- Immutable approved snapshots (insert-only). inputs are the exact validated inputs used by
-- the shared calculation module (formula_version).
create table public.report_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  session_id uuid not null,
  revision integer not null,
  inputs jsonb not null,
  inputs_hash text not null,
  formula_version text not null,
  approved_by uuid not null,
  approver_name text not null,
  approved_at timestamptz not null default now(),
  unique (session_id, revision),
  unique (workspace_id, session_id, id),
  foreign key (workspace_id, session_id) references public.sessions (workspace_id, id)
);

alter table public.sessions
  add foreign key (workspace_id, id, current_report_id)
  references public.report_revisions (workspace_id, session_id, id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  email text not null check (email = lower(btrim(email))),
  role public.member_role not null check (role <> 'owner'),
  all_locations boolean not null default false,
  location_ids uuid[] not null default '{}',
  session_id uuid,
  subject_ids uuid[] not null default '{}',  -- guest only: the permitted roster subjects
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid,
  check ((role = 'guest') = (session_id is not null)),
  check ((role = 'guest') = (cardinality(subject_ids) > 0)),
  foreign key (workspace_id, session_id) references public.sessions (workspace_id, id)
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id),
  actor_id uuid,
  action text not null,
  entity_id uuid,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_events_ws_idx on public.audit_events (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------
create function private.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'immutable_record' using detail = tg_table_name;
end $$;

create trigger template_versions_immutable before update or delete on public.template_versions
  for each row execute function private.forbid_change();
create trigger report_revisions_immutable before update or delete on public.report_revisions
  for each row execute function private.forbid_change();
create trigger assessment_events_immutable before update or delete on public.assessment_events
  for each row execute function private.forbid_change();
create trigger audit_events_immutable before update or delete on public.audit_events
  for each row execute function private.forbid_change();

create function private.keep_workspace_id() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'immutable_workspace' using detail = tg_table_name;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['memberships', 'locations', 'subjects', 'templates', 'sessions',
    'session_subjects', 'session_assignments', 'assessments', 'invitations', 'membership_locations',
    'session_reviewers']
  loop
    execute format('create trigger %I before update on public.%I for each row execute function private.keep_workspace_id()',
      t || '_keep_workspace', t);
  end loop;
end $$;

create function private.protect_last_owner() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.role = 'owner' and old.status = 'active'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.status <> 'active')
     and not exists (
       select 1 from public.memberships m
       where m.workspace_id = old.workspace_id and m.id <> old.id
         and m.role = 'owner' and m.status = 'active')
  then
    raise exception 'last_owner';
  end if;
  return coalesce(new, old);
end $$;

create trigger memberships_last_owner before update or delete on public.memberships
  for each row execute function private.protect_last_owner();

-- ---------------------------------------------------------------------------
-- Authorization helpers (private, SECURITY DEFINER so policies never recurse through RLS)
-- ---------------------------------------------------------------------------
create function private.fail(p_code text, p_detail text default null) returns void
language plpgsql set search_path = '' as $$
begin
  raise exception '%', p_code using detail = coalesce(p_detail, '');
end $$;

create function private.active_membership(p_ws uuid) returns public.memberships
language sql stable security definer set search_path = '' as $$
  select m.* from public.memberships m
  where m.workspace_id = p_ws and m.user_id = (select auth.uid())
    and m.status = 'active' and (m.expires_at is null or m.expires_at > now())
$$;

create function private.member_role(p_ws uuid) returns public.member_role
language sql stable security definer set search_path = '' as $$
  select (private.active_membership(p_ws)).role
$$;

create function private.has_role(p_ws uuid, p_roles public.member_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.member_role(p_ws) = any (p_roles), false)
$$;

-- Does a given user (default: caller) hold this location through an active membership?
create function private.user_in_location(p_ws uuid, p_user uuid, p_location uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.workspace_id = p_ws and m.user_id = p_user and m.status = 'active'
      and (m.expires_at is null or m.expires_at > now())
      and (m.role in ('owner', 'admin')
        or (m.role in ('reviewer', 'assessor', 'viewer')
          and (m.all_locations or exists (
            select 1 from public.membership_locations ml
            where ml.membership_id = m.id and ml.location_id = p_location)))))
$$;

create function private.in_location(p_ws uuid, p_location uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.user_in_location(p_ws, (select auth.uid()), p_location)
$$;

-- Owner/Admin, or a Reviewer who is location-scoped AND assigned to the session.
create function private.can_review(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sessions s
    where s.id = p_session
      and (private.has_role(s.workspace_id, '{owner,admin}')
        or (private.has_role(s.workspace_id, '{reviewer}')
          and private.in_location(s.workspace_id, s.location_id)
          and exists (select 1 from public.session_reviewers r
                      where r.session_id = s.id and r.user_id = (select auth.uid())))))
$$;

-- Can this user act on this assignment right now? Requires an active, unexpired membership and
-- current scope: staff must hold the session location; guests must be bound to this session.
create function private.assignment_in_scope(p_session uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sessions s
    join public.memberships m on m.workspace_id = s.workspace_id and m.user_id = p_user
    where s.id = p_session and m.status = 'active' and (m.expires_at is null or m.expires_at > now())
      and ((m.role = 'guest' and m.guest_session_id = s.id)
        or (m.role in ('owner', 'admin', 'reviewer', 'assessor')
          and private.user_in_location(s.workspace_id, p_user, s.location_id))))
$$;

create function private.is_assigned(p_session uuid, p_subject uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.session_assignments a
    where a.session_id = p_session and a.user_id = (select auth.uid())
      and (p_subject is null or a.subject_id = p_subject))
    and private.assignment_in_scope(p_session, (select auth.uid()))
$$;

create function private.viewer_can_see(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sessions s
    where s.id = p_session and s.current_report_id is not null
      and private.has_role(s.workspace_id, '{viewer}')
      and private.in_location(s.workspace_id, s.location_id))
$$;

create function private.uses_assigned_template(p_version uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sessions s
    where s.template_version_id = p_version and private.is_assigned(s.id))
$$;

-- Subject directory exposure is limited to subjects on rosters the caller may currently act on.
create function private.assigned_subject(p_subject uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.session_assignments a
    where a.subject_id = p_subject and a.user_id = (select auth.uid())
      and private.assignment_in_scope(a.session_id, a.user_id))
  or exists (
    select 1 from public.session_subjects ss
    where ss.subject_id = p_subject and private.can_review(ss.session_id))
$$;

create function private.audit(p_ws uuid, p_action text, p_entity uuid, p_detail jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_events (workspace_id, actor_id, action, entity_id, detail)
  values (p_ws, (select auth.uid()), p_action, p_entity, coalesce(p_detail, '{}'))
$$;

create function private.sha256_hex(p text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p, 'UTF8')), 'hex')
$$;

create function private.require_uid() returns uuid
language plpgsql stable set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then perform private.fail('not_authenticated'); end if;
  return v;
end $$;

-- Lock a session row (the single serialization boundary for evidence) and require membership.
create function private.lock_session(p_session uuid) returns public.sessions
language plpgsql security definer set search_path = '' as $$
declare v public.sessions;
begin
  perform private.require_uid();
  select * into v from public.sessions where id = p_session for update;
  if not found or private.member_role(v.workspace_id) is null then
    perform private.fail('not_found', 'session');
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Validation
-- ---------------------------------------------------------------------------
create function private.validate_criteria(p_criteria jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  c jsonb;
  v_out jsonb := '[]';
  v_keys text[] := '{}';
  v_key text;
  v_label text;
begin
  if p_criteria is null or jsonb_typeof(p_criteria) <> 'array' then
    perform private.fail('invalid_criteria', 'criteria must be an array');
  end if;
  if jsonb_array_length(p_criteria) > 25 then
    perform private.fail('invalid_criteria', 'at most 25 criteria');
  end if;
  for c in select * from jsonb_array_elements(p_criteria) loop
    v_key := c ->> 'key';
    v_label := btrim(coalesce(c ->> 'label', ''));
    if jsonb_typeof(c) <> 'object' or v_key is null or v_key !~ '^[a-z][a-z0-9_]{0,39}$' then
      perform private.fail('invalid_criteria', 'criterion key must be lowercase letters, digits or _');
    end if;
    if v_key = any (v_keys) then perform private.fail('invalid_criteria', 'duplicate key ' || v_key); end if;
    if length(v_label) not between 1 and 80 then
      perform private.fail('invalid_criteria', 'label required for ' || v_key);
    end if;
    if length(coalesce(c ->> 'guidance', '')) > 300 then
      perform private.fail('invalid_criteria', 'guidance too long for ' || v_key);
    end if;
    if c ? 'allow_na' and jsonb_typeof(c -> 'allow_na') <> 'boolean' then
      perform private.fail('invalid_criteria', 'allow_na must be boolean');
    end if;
    v_keys := v_keys || v_key;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'key', v_key, 'label', v_label,
      'guidance', nullif(btrim(coalesce(c ->> 'guidance', '')), ''),
      'allow_na', coalesce((c ->> 'allow_na')::boolean, false)));
  end loop;
  return v_out;
end $$;

-- Validates a complete answer set against frozen criteria and returns the normalized answers.
-- Each criterion needs an integer 1..5, or {"na": reason} when the criterion allows N/A.
create function private.validate_answers(p_criteria jsonb, p_answers jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  c jsonb;
  v jsonb;
  k text;
  n numeric;
  v_out jsonb := '{}';
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    perform private.fail('invalid_answers', 'answers must be an object');
  end if;
  for k in select jsonb_object_keys(p_answers) loop
    if not exists (select 1 from jsonb_array_elements(p_criteria) x where x ->> 'key' = k) then
      perform private.fail('unknown_criterion', k);
    end if;
  end loop;
  for c in select * from jsonb_array_elements(p_criteria) loop
    k := c ->> 'key';
    v := p_answers -> k;
    if v is null or jsonb_typeof(v) = 'null' then
      perform private.fail('missing_criterion', k);
    elsif jsonb_typeof(v) = 'number' then
      n := v::numeric;
      if n <> trunc(n) or n < 1 or n > 5 then perform private.fail('invalid_score', k); end if;
      v_out := v_out || jsonb_build_object(k, n::integer);
    elsif jsonb_typeof(v) = 'object' then
      if not coalesce((c ->> 'allow_na')::boolean, false) then
        perform private.fail('na_not_allowed', k);
      end if;
      if (select count(*) from jsonb_object_keys(v)) <> 1 or jsonb_typeof(v -> 'na') is distinct from 'string'
         or length(btrim(v ->> 'na')) = 0 or length(v ->> 'na') > 500 then
        perform private.fail('na_reason_required', k);
      end if;
      v_out := v_out || jsonb_build_object(k, jsonb_build_object('na', btrim(v ->> 'na')));
    else
      perform private.fail('invalid_score', k);
    end if;
  end loop;
  return v_out;
end $$;

create function private.has_na(p_answers jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(exists (select 1 from jsonb_each(p_answers) e where jsonb_typeof(e.value) = 'object'), false)
$$;

create function private.outcome_allowed(p_mode public.attendance_mode, p_outcome public.subject_outcome)
returns boolean language sql immutable set search_path = '' as $$
  select case p_mode
    when 'scored' then p_outcome in ('unknown', 'early', 'middle', 'late', 'absent')
    when 'presence' then p_outcome in ('unknown', 'present', 'absent')
    else p_outcome in ('unknown', 'assessed', 'not_assessed') end
$$;

-- ---------------------------------------------------------------------------
-- Report inputs (shared by provisional view and approval snapshot) and redaction
-- ---------------------------------------------------------------------------
create function private.build_inputs(p_session uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'formula_version', tv.formula_version,
    'workspace', jsonb_build_object('name', w.name, 'timezone', w.timezone),
    'session', jsonb_build_object('id', s.id, 'name', s.name, 'local_date', s.local_date,
      'location', l.name, 'revision', s.revision, 'opens_at', s.opens_at, 'closes_at', s.closes_at,
      'expected_ready_time', s.expected_ready_time),
    'template', jsonb_build_object('id', tv.template_id, 'version_id', tv.id, 'name', tv.name,
      'version', tv.version, 'attendance_mode', tv.attendance_mode, 'criteria', tv.criteria),
    'subjects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'subject_id', ss.subject_id, 'name', ss.subject_name,
        'outcome', ss.outcome, 'outcome_reason', ss.outcome_reason,
        'required_assessors', (select count(*) from public.session_assignments sa
                               where sa.session_id = s.id and sa.subject_id = ss.subject_id),
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
      from public.session_subjects ss where ss.session_id = s.id), '[]'))
  from public.sessions s
  join public.workspaces w on w.id = s.workspace_id
  join public.locations l on l.id = s.location_id
  join public.template_versions tv on tv.id = s.template_version_id
  where s.id = p_session
$$;

-- Replaces assessor identities with stable pseudonyms (Assessor 1..n per report).
create function private.redact_inputs(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  with ids as (
    select distinct a ->> 'assessor_id' as id
    from jsonb_array_elements(p -> 'subjects') s, jsonb_array_elements(s -> 'assessments') a),
  m as (select id, row_number() over (order by id) as n from ids)
  select p || jsonb_build_object('redacted', true, 'subjects', coalesce((
    select jsonb_agg(s || jsonb_build_object('assessments', coalesce((
      select jsonb_agg((a - 'assessor_id' - 'assessor_label') || jsonb_build_object('assessor_label', 'Assessor ' || m.n)
        order by m.n)
      from jsonb_array_elements(s -> 'assessments') a join m on m.id = a ->> 'assessor_id'), '[]')) order by ord)
    from jsonb_array_elements(p -> 'subjects') with ordinality x (s, ord)), '[]'))
$$;

-- ---------------------------------------------------------------------------
-- Commands (private implementations)
-- ---------------------------------------------------------------------------
create function private.create_workspace(p_name text, p_country text, p_timezone text, p_display_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_email text;
  v_ws uuid;
begin
  select u.email into v_email from auth.users u where u.id = v_uid and u.email_confirmed_at is not null;
  if v_email is null then perform private.fail('email_not_verified'); end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    perform private.fail('invalid_timezone', p_timezone);
  end if;
  insert into public.workspaces (name, country, timezone, created_by)
  values (btrim(p_name), btrim(p_country), p_timezone, v_uid) returning id into v_ws;
  insert into public.memberships (workspace_id, user_id, role, display_name, email, all_locations)
  values (v_ws, v_uid, 'owner', btrim(p_display_name), lower(v_email), true);
  perform private.audit(v_ws, 'workspace.created', v_ws, jsonb_build_object('name', btrim(p_name)));
  return v_ws;
end $$;

create function private.workspace_context(p_ws uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'workspace', jsonb_build_object('id', w.id, 'name', w.name, 'country', w.country, 'timezone', w.timezone),
    'role', m.role, 'display_name', m.display_name, 'all_locations', m.all_locations,
    'guest_session_id', m.guest_session_id,
    'location_ids', coalesce((select jsonb_agg(ml.location_id) from public.membership_locations ml
                              where ml.membership_id = m.id), '[]'),
    'aal', coalesce((select auth.jwt()) ->> 'aal', 'aal1'))
  from public.workspaces w
  join lateral (select * from private.active_membership(p_ws)) m on m.id is not null
  where w.id = p_ws
$$;

create function private.upsert_location(p_ws uuid, p_id uuid, p_name text, p_archived boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_uid();
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if p_id is null then
    insert into public.locations (workspace_id, name) values (p_ws, btrim(p_name)) returning id into v_id;
  else
    update public.locations set name = btrim(p_name),
      archived_at = case when p_archived then coalesce(archived_at, now()) end
    where id = p_id and workspace_id = p_ws returning id into v_id;
    if v_id is null then perform private.fail('not_found', 'location'); end if;
  end if;
  perform private.audit(p_ws, 'location.saved', v_id, jsonb_build_object('name', btrim(p_name), 'archived', p_archived));
  return v_id;
end $$;

create function private.upsert_subject(p_ws uuid, p_id uuid, p_name text, p_type public.subject_type, p_archived boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_uid();
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if p_id is null then
    insert into public.subjects (workspace_id, name, subject_type)
    values (p_ws, btrim(p_name), p_type) returning id into v_id;
  else
    update public.subjects set name = btrim(p_name), subject_type = p_type,
      archived_at = case when p_archived then coalesce(archived_at, now()) end
    where id = p_id and workspace_id = p_ws returning id into v_id;
    if v_id is null then perform private.fail('not_found', 'subject'); end if;
  end if;
  perform private.audit(p_ws, 'subject.saved', v_id, jsonb_build_object('name', btrim(p_name), 'archived', p_archived));
  return v_id;
end $$;

create function private.publish_template(p_ws uuid, p_template_id uuid, p_name text,
  p_pack public.starter_pack, p_attendance_mode public.attendance_mode, p_criteria jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_criteria jsonb;
  v_tid uuid := p_template_id;
  v_version integer;
  v_id uuid;
begin
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then perform private.fail('invalid_name'); end if;
  v_criteria := private.validate_criteria(p_criteria);
  if jsonb_array_length(v_criteria) = 0 and p_attendance_mode <> 'scored' then
    perform private.fail('template_needs_criteria');
  end if;
  if v_tid is null then
    insert into public.templates (workspace_id, name, pack) values (p_ws, btrim(p_name), p_pack)
    returning id into v_tid;
  end if;
  update public.templates set latest_version = latest_version + 1, name = btrim(p_name)
  where id = v_tid and workspace_id = p_ws returning latest_version into v_version;
  if v_version is null then perform private.fail('not_found', 'template'); end if;
  insert into public.template_versions (workspace_id, template_id, version, name, attendance_mode,
    criteria, formula_version, published_by)
  values (p_ws, v_tid, v_version, btrim(p_name), p_attendance_mode, v_criteria, 'savour-m1.1', v_uid)
  returning id into v_id;
  perform private.audit(p_ws, 'template.published', v_id, jsonb_build_object('template_id', v_tid, 'version', v_version));
  return v_id;
end $$;

create function private.create_session(p_ws uuid, p_location uuid, p_template_version uuid, p_name text,
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
  if (select count(*) from public.subjects where workspace_id = p_ws and archived_at is null
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

  insert into public.sessions (workspace_id, location_id, template_version_id, name, local_date,
    opens_at, closes_at, expected_ready_time, created_by)
  values (p_ws, p_location, p_template_version, btrim(p_name), p_local_date,
    now(), now() + make_interval(hours => v_hours), p_ready_time, v_uid)
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

create function private.set_assignment(p_session uuid, p_subject uuid, p_user uuid, p_assigned boolean,
  p_expected_data_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_s public.sessions := private.lock_session(p_session);
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status not in ('open', 'in_review') then perform private.fail('session_locked'); end if;
  if p_expected_data_version is null or v_s.data_version <> p_expected_data_version then perform private.fail('stale_version'); end if;
  if not exists (select 1 from public.session_subjects where session_id = p_session and subject_id = p_subject) then
    perform private.fail('not_found', 'roster subject');
  end if;
  if p_assigned then
    if not exists (select 1 from public.memberships m where m.workspace_id = v_s.workspace_id
        and m.user_id = p_user and m.status = 'active'
        and m.role in ('owner', 'admin', 'reviewer', 'assessor', 'guest')) then
      perform private.fail('invalid_assessor');
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
    p_session, jsonb_build_object('subject_id', p_subject, 'user_id', p_user));
  return v_s.data_version + 1;
end $$;

-- Submit (assessor, within window) or amend (reviewer in scope, with reason) one assessment.
-- A reviewer correcting their OWN assessment uses the amend path by supplying a reason.
-- With an absent observation, p_notes is stored as the absence reason, never as quality feedback.
create function private.submit_assessment(p_session uuid, p_subject uuid, p_assessor uuid,
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

  if v_s.status in ('approved', 'cancelled') then perform private.fail('session_locked'); end if;
  if v_amend then
    if length(btrim(coalesce(p_reason, ''))) = 0 then perform private.fail('reason_required'); end if;
    if not exists (select 1 from public.session_assignments where session_id = p_session
                   and subject_id = p_subject and user_id = p_assessor) then
      perform private.fail('not_assigned');
    end if;
  elsif v_s.status <> 'open' or now() < v_s.opens_at or now() >= v_s.closes_at then
    perform private.fail('window_closed');
  end if;

  select * into v_tv from public.template_versions where id = v_s.template_version_id;
  select * into v_ss from public.session_subjects where session_id = p_session and subject_id = p_subject;

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
  update public.sessions set data_version = data_version + 1 where id = p_session;
  return jsonb_build_object('assessment_id', v_a.id, 'version', v_version, 'replayed', false);
end $$;

create function private.confirm_na(p_session uuid, p_subject uuid, p_assessor uuid, p_expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions := private.lock_session(p_session);
  v_a public.assessments;
begin
  if not private.can_review(p_session) then perform private.fail('forbidden'); end if;
  if v_s.status not in ('open', 'in_review') then perform private.fail('session_locked'); end if;
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

-- One canonical outcome per roster subject. Absent / Not assessed clears current quality responses.
create function private.resolve_outcome(p_session uuid, p_subject uuid, p_outcome public.subject_outcome,
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

create function private.close_collection(p_session uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_s public.sessions := private.lock_session(p_session);
begin
  if not private.can_review(p_session) then perform private.fail('forbidden'); end if;
  if v_s.status <> 'open' then perform private.fail('invalid_state'); end if;
  update public.sessions set status = 'in_review', data_version = data_version + 1 where id = p_session;
  perform private.audit(v_s.workspace_id, 'session.collection_closed', p_session);
end $$;

create function private.approve_session(p_session uuid, p_expected_data_version integer)
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

  for r in
    select ss.subject_name, ss.outcome,
      (select count(*) from public.session_assignments sa
        where sa.session_id = ss.session_id and sa.subject_id = ss.subject_id) as required,
      (select count(*) from public.session_assignments sa
        join public.assessments a on a.session_id = sa.session_id and a.subject_id = sa.subject_id
          and a.assessor_id = sa.user_id
        where sa.session_id = ss.session_id and sa.subject_id = ss.subject_id
          and a.state = 'submitted' and a.answers is not null) as complete,
      (select count(*) from public.session_assignments sa
        join public.assessments a on a.session_id = sa.session_id and a.subject_id = sa.subject_id
          and a.assessor_id = sa.user_id
        where sa.session_id = ss.session_id and sa.subject_id = ss.subject_id
          and a.state = 'submitted' and private.has_na(a.answers) and not a.na_confirmed) as unconfirmed_na
    from public.session_subjects ss where ss.session_id = p_session
  loop
    if r.outcome = 'unknown' then
      v_problems := v_problems || (r.subject_name || ': outcome not recorded');
    elsif r.outcome in ('absent', 'not_assessed') or jsonb_array_length(v_tv.criteria) = 0 then
      continue;
    elsif r.required = 0 then
      v_problems := v_problems || (r.subject_name || ': no assessor assigned');
    elsif r.complete < r.required then
      v_problems := v_problems || (r.subject_name || ': ' || (r.required - r.complete) || ' required response(s) missing');
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
    jsonb_build_object('revision', v_s.revision, 'report_id', v_id));
  return v_id;
end $$;

create function private.reopen_session(p_session uuid, p_reason text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_s public.sessions := private.lock_session(p_session);
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status <> 'approved' then perform private.fail('invalid_state'); end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then perform private.fail('reason_required'); end if;
  update public.sessions set status = 'in_review', revision = revision + 1, current_report_id = null,
    last_reopen_reason = btrim(p_reason), data_version = data_version + 1
  where id = p_session;
  perform private.audit(v_s.workspace_id, 'session.reopened', p_session, jsonb_build_object(
    'from_revision', v_s.revision, 'to_revision', v_s.revision + 1, 'reason', btrim(p_reason)));
  return v_s.revision + 1;
end $$;

create function private.cancel_session(p_session uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_s public.sessions := private.lock_session(p_session);
begin
  if not private.has_role(v_s.workspace_id, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if v_s.status not in ('open', 'in_review') then perform private.fail('invalid_state'); end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then perform private.fail('reason_required'); end if;
  update public.sessions set status = 'cancelled', cancel_reason = btrim(p_reason), data_version = data_version + 1
  where id = p_session;
  perform private.audit(v_s.workspace_id, 'session.cancelled', p_session, jsonb_build_object('reason', btrim(p_reason)));
end $$;

-- Report read: Owner/Admin/assigned Reviewer may see provisional and identities (optionally redacted).
-- Viewers get approved revisions only, always redacted. Assessors and guests get nothing.
create function private.get_session_report(p_session uuid, p_revision integer, p_redact boolean, p_purpose text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions;
  v_reviewer boolean;
  v_redact boolean := coalesce(p_redact, false);
  v_rr public.report_revisions;
  v_inputs jsonb;
  v_meta jsonb;
begin
  perform private.require_uid();
  select * into v_s from public.sessions where id = p_session;
  if not found or private.member_role(v_s.workspace_id) is null then perform private.fail('not_found', 'session'); end if;
  v_reviewer := private.can_review(p_session);
  if not v_reviewer then
    if not (private.has_role(v_s.workspace_id, '{viewer}') and private.in_location(v_s.workspace_id, v_s.location_id)) then
      perform private.fail('forbidden');
    end if;
    v_redact := true;
  end if;
  if p_purpose is null or p_purpose not in ('view', 'pdf', 'csv') then perform private.fail('invalid_purpose'); end if;

  if p_revision is not null then
    select * into v_rr from public.report_revisions where session_id = p_session and revision = p_revision;
    if not found then perform private.fail('not_found', 'revision'); end if;
  elsif v_s.current_report_id is not null then
    select * into v_rr from public.report_revisions where id = v_s.current_report_id;
  elsif not v_reviewer then
    perform private.fail('not_found', 'approved report');
  end if;

  if v_rr.id is not null then
    v_inputs := v_rr.inputs;
    v_meta := jsonb_build_object('status', 'approved', 'revision', v_rr.revision, 'report_id', v_rr.id,
      'approved_at', v_rr.approved_at, 'approver_name', v_rr.approver_name,
      'formula_version', v_rr.formula_version, 'inputs_hash', v_rr.inputs_hash,
      'is_current', v_rr.id = v_s.current_report_id);
  else
    v_inputs := private.build_inputs(p_session);
    v_meta := jsonb_build_object('status', 'provisional', 'revision', v_s.revision,
      'formula_version', v_inputs ->> 'formula_version', 'is_current', true);
  end if;
  if v_redact then v_inputs := private.redact_inputs(v_inputs); end if;

  if p_purpose <> 'view' then
    perform private.audit(v_s.workspace_id, 'report.exported', p_session, jsonb_build_object(
      'format', p_purpose, 'revision', v_meta -> 'revision', 'status', v_meta -> 'status', 'redacted', v_redact));
  end if;

  return jsonb_build_object('meta', v_meta || jsonb_build_object('redacted', v_redact,
      'session_status', v_s.status, 'session_revision', v_s.revision, 'reopen_reason', v_s.last_reopen_reason),
    'inputs', v_inputs,
    'revisions', coalesce((select jsonb_agg(jsonb_build_object('revision', r.revision,
      'approved_at', r.approved_at, 'approver_name', r.approver_name) order by r.revision)
      from public.report_revisions r where r.session_id = p_session), '[]'));
end $$;

-- Approved current revisions in the caller's scope (redacted inputs) plus sessions under revision.
create function private.get_dashboard(p_ws uuid) returns jsonb
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
      where s.workspace_id = p_ws and s.status = 'approved'
        and (private.can_review(s.id) or private.viewer_can_see(s.id))), '[]'),
    'under_revision', coalesce((
      select jsonb_agg(jsonb_build_object('session_id', s.id, 'name', s.name, 'local_date', s.local_date,
        'revision', s.revision, 'reason', s.last_reopen_reason) order by s.local_date desc)
      from public.sessions s
      where s.workspace_id = p_ws and s.status = 'in_review' and s.revision > 1
        and (private.can_review(s.id)
          or (v_role = 'viewer' and private.in_location(p_ws, s.location_id)))), '[]'));
end $$;

-- ---------------------------------------------------------------------------
-- Membership and invitations
-- ---------------------------------------------------------------------------
create function private.create_invitation(p_ws uuid, p_email text, p_role public.member_role,
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
        and workspace_id = p_ws and status = 'open' and closes_at > now()) then
      perform private.fail('not_found', 'open session');
    end if;
    if cardinality(v_subjects) = 0 then perform private.fail('subjects_required'); end if;
    if (select count(*) from public.session_subjects where session_id = p_session
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

create function private.revoke_invitation(p_invitation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_inv public.invitations;
begin
  perform private.require_uid();
  select * into v_inv from public.invitations where id = p_invitation for update;
  if not found or not private.has_role(v_inv.workspace_id, '{owner,admin}') then
    perform private.fail('not_found', 'invitation');
  end if;
  if v_inv.accepted_at is not null then perform private.fail('invitation_used'); end if;
  update public.invitations set revoked_at = coalesce(revoked_at, now()) where id = p_invitation;
  perform private.audit(v_inv.workspace_id, 'invitation.revoked', p_invitation);
end $$;

create function private.invitation_status(v_inv public.invitations, p_email text, p_confirmed boolean)
returns text language sql stable set search_path = '' as $$
  select case
    when v_inv.revoked_at is not null then 'invitation_revoked'
    when v_inv.accepted_at is not null then 'invitation_used'
    when v_inv.expires_at <= now() then 'invitation_expired'
    when not coalesce(p_confirmed, false) or lower(p_email) is distinct from v_inv.email then 'invitation_wrong_account'
    else 'valid' end
$$;

create function private.peek_invitation(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_inv public.invitations;
  v_user record;
begin
  select * into v_inv from public.invitations where token_hash = private.sha256_hex(coalesce(p_token, ''));
  if not found then return jsonb_build_object('status', 'invitation_invalid'); end if;
  select email, email_confirmed_at is not null as confirmed into v_user from auth.users where id = v_uid;
  return jsonb_build_object(
    'status', private.invitation_status(v_inv, v_user.email, v_user.confirmed),
    'workspace_name', (select name from public.workspaces where id = v_inv.workspace_id),
    'role', v_inv.role, 'expires_at', v_inv.expires_at);
end $$;

create function private.accept_invitation(p_token text, p_display_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_inv public.invitations;
  v_user record;
  v_status text;
  v_m public.memberships;
  v_s public.sessions;
  v_name text := btrim(coalesce(p_display_name, ''));
begin
  if length(v_name) not between 1 and 80 then perform private.fail('invalid_name'); end if;
  select * into v_inv from public.invitations where token_hash = private.sha256_hex(coalesce(p_token, '')) for update;
  if not found then perform private.fail('invitation_invalid'); end if;
  select email, email_confirmed_at is not null as confirmed into v_user from auth.users where id = v_uid;
  v_status := private.invitation_status(v_inv, v_user.email, v_user.confirmed);
  if v_status <> 'valid' then perform private.fail(v_status); end if;

  perform 1 from public.workspaces where id = v_inv.workspace_id for update;  -- serialize membership changes
  if v_inv.role = 'guest' then
    select * into v_s from public.sessions where id = v_inv.session_id for update;
    if v_s.status <> 'open' or v_s.closes_at <= now() then perform private.fail('session_closed'); end if;
  end if;
  select * into v_m from public.memberships where workspace_id = v_inv.workspace_id and user_id = v_uid for update;
  if found and v_m.status = 'active' then perform private.fail('already_member'); end if;

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
    where ss.session_id = v_inv.session_id and ss.subject_id = any (v_inv.subject_ids)
    on conflict do nothing;
    update public.sessions set data_version = data_version + 1 where id = v_inv.session_id;
  end if;
  update public.invitations set accepted_at = now(), accepted_by = v_uid where id = v_inv.id;
  perform private.audit(v_inv.workspace_id, 'invitation.accepted', v_inv.id, jsonb_build_object('role', v_inv.role));
  return v_inv.workspace_id;
end $$;

create function private.update_member(p_ws uuid, p_user uuid, p_role public.member_role,
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
  perform 1 from public.workspaces where id = p_ws for update;
  select * into v_m from public.memberships where workspace_id = p_ws and user_id = p_user and status = 'active' for update;
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

create function private.revoke_member(p_ws uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_role public.member_role := private.member_role(p_ws);
  v_m public.memberships;
begin
  if v_role is null then perform private.fail('not_found', 'workspace'); end if;
  if p_user <> v_uid and v_role not in ('owner', 'admin') then perform private.fail('forbidden'); end if;
  perform 1 from public.workspaces where id = p_ws for update;
  select * into v_m from public.memberships where workspace_id = p_ws and user_id = p_user and status = 'active' for update;
  if not found then perform private.fail('not_found', 'member'); end if;
  if p_user <> v_uid and v_role = 'admin' and v_m.role in ('owner', 'admin') then perform private.fail('forbidden'); end if;
  update public.memberships set status = 'revoked', revoked_at = now(), revoked_by = v_uid where id = v_m.id;
  perform private.audit(p_ws, 'member.revoked', v_m.id, jsonb_build_object('user_id', p_user, 'role', v_m.role));
end $$;

-- ---------------------------------------------------------------------------
-- Public SECURITY INVOKER wrappers (the only callable API surface)
-- ---------------------------------------------------------------------------
create function public.create_workspace(p_name text, p_country text, p_timezone text, p_display_name text)
returns uuid language sql security invoker set search_path = '' as
$$ select private.create_workspace(p_name, p_country, p_timezone, p_display_name) $$;
create function public.workspace_context(p_ws uuid) returns jsonb language sql stable security invoker set search_path = '' as
$$ select private.workspace_context(p_ws) $$;
create function public.upsert_location(p_ws uuid, p_id uuid, p_name text, p_archived boolean) returns uuid
language sql security invoker set search_path = '' as $$ select private.upsert_location(p_ws, p_id, p_name, p_archived) $$;
create function public.upsert_subject(p_ws uuid, p_id uuid, p_name text, p_type public.subject_type, p_archived boolean)
returns uuid language sql security invoker set search_path = '' as
$$ select private.upsert_subject(p_ws, p_id, p_name, p_type, p_archived) $$;
create function public.publish_template(p_ws uuid, p_template_id uuid, p_name text, p_pack public.starter_pack,
  p_attendance_mode public.attendance_mode, p_criteria jsonb) returns uuid
language sql security invoker set search_path = '' as
$$ select private.publish_template(p_ws, p_template_id, p_name, p_pack, p_attendance_mode, p_criteria) $$;
create function public.create_session(p_ws uuid, p_location uuid, p_template_version uuid, p_name text,
  p_local_date date, p_subject_ids uuid[], p_assessor_ids uuid[], p_reviewer_ids uuid[],
  p_window_hours integer, p_ready_time time) returns uuid
language sql security invoker set search_path = '' as
$$ select private.create_session(p_ws, p_location, p_template_version, p_name, p_local_date, p_subject_ids,
  p_assessor_ids, p_reviewer_ids, p_window_hours, p_ready_time) $$;
create function public.set_assignment(p_session uuid, p_subject uuid, p_user uuid, p_assigned boolean,
  p_expected_data_version integer) returns integer language sql security invoker set search_path = '' as
$$ select private.set_assignment(p_session, p_subject, p_user, p_assigned, p_expected_data_version) $$;
create function public.submit_assessment(p_session uuid, p_subject uuid, p_assessor uuid,
  p_observed public.subject_outcome, p_answers jsonb, p_notes text, p_expected_version integer,
  p_idempotency_key uuid, p_reason text) returns jsonb language sql security invoker set search_path = '' as
$$ select private.submit_assessment(p_session, p_subject, p_assessor, p_observed, p_answers, p_notes,
  p_expected_version, p_idempotency_key, p_reason) $$;
create function public.confirm_na(p_session uuid, p_subject uuid, p_assessor uuid, p_expected_version integer)
returns integer language sql security invoker set search_path = '' as
$$ select private.confirm_na(p_session, p_subject, p_assessor, p_expected_version) $$;
create function public.resolve_outcome(p_session uuid, p_subject uuid, p_outcome public.subject_outcome,
  p_reason text, p_expected_version integer) returns integer language sql security invoker set search_path = '' as
$$ select private.resolve_outcome(p_session, p_subject, p_outcome, p_reason, p_expected_version) $$;
create function public.close_collection(p_session uuid) returns void language sql security invoker set search_path = '' as
$$ select private.close_collection(p_session) $$;
create function public.approve_session(p_session uuid, p_expected_data_version integer) returns uuid
language sql security invoker set search_path = '' as $$ select private.approve_session(p_session, p_expected_data_version) $$;
create function public.reopen_session(p_session uuid, p_reason text) returns integer
language sql security invoker set search_path = '' as $$ select private.reopen_session(p_session, p_reason) $$;
create function public.cancel_session(p_session uuid, p_reason text) returns void
language sql security invoker set search_path = '' as $$ select private.cancel_session(p_session, p_reason) $$;
create function public.get_session_report(p_session uuid, p_revision integer, p_redact boolean, p_purpose text)
returns jsonb language sql security invoker set search_path = '' as
$$ select private.get_session_report(p_session, p_revision, p_redact, p_purpose) $$;
create function public.get_dashboard(p_ws uuid) returns jsonb language sql stable security invoker set search_path = '' as
$$ select private.get_dashboard(p_ws) $$;
create function public.create_invitation(p_ws uuid, p_email text, p_role public.member_role, p_all_locations boolean,
  p_location_ids uuid[], p_session uuid, p_subject_ids uuid[]) returns jsonb
language sql security invoker set search_path = '' as
$$ select private.create_invitation(p_ws, p_email, p_role, p_all_locations, p_location_ids, p_session, p_subject_ids) $$;
create function public.revoke_invitation(p_invitation uuid) returns void language sql security invoker set search_path = '' as
$$ select private.revoke_invitation(p_invitation) $$;
create function public.peek_invitation(p_token text) returns jsonb language sql stable security invoker set search_path = '' as
$$ select private.peek_invitation(p_token) $$;
create function public.accept_invitation(p_token text, p_display_name text) returns uuid
language sql security invoker set search_path = '' as $$ select private.accept_invitation(p_token, p_display_name) $$;
create function public.update_member(p_ws uuid, p_user uuid, p_role public.member_role, p_all_locations boolean,
  p_location_ids uuid[]) returns void language sql security invoker set search_path = '' as
$$ select private.update_member(p_ws, p_user, p_role, p_all_locations, p_location_ids) $$;
create function public.revoke_member(p_ws uuid, p_user uuid) returns void
language sql security invoker set search_path = '' as $$ select private.revoke_member(p_ws, p_user) $$;

-- ---------------------------------------------------------------------------
-- Row level security (SELECT only for clients)
-- ---------------------------------------------------------------------------
alter table public.workspaces enable row level security;
alter table public.memberships enable row level security;
alter table public.membership_locations enable row level security;
alter table public.locations enable row level security;
alter table public.subjects enable row level security;
alter table public.templates enable row level security;
alter table public.template_versions enable row level security;
alter table public.sessions enable row level security;
alter table public.session_reviewers enable row level security;
alter table public.session_subjects enable row level security;
alter table public.session_assignments enable row level security;
alter table public.assessments enable row level security;
alter table public.assessment_events enable row level security;
alter table public.report_revisions enable row level security;  -- no policy: read via get_session_report
alter table public.invitations enable row level security;
alter table public.audit_events enable row level security;

create policy workspaces_read on public.workspaces for select to authenticated
  using (private.member_role(id) is not null);
create policy memberships_read on public.memberships for select to authenticated
  using ((user_id = (select auth.uid()) and status = 'active') or private.has_role(workspace_id, '{owner,admin}'));
create policy membership_locations_read on public.membership_locations for select to authenticated
  using (private.has_role(workspace_id, '{owner,admin}')
    or exists (select 1 from public.memberships m where m.id = membership_id
               and m.user_id = (select auth.uid()) and m.status = 'active'));
create policy locations_read on public.locations for select to authenticated
  using (private.in_location(workspace_id, id));
create policy subjects_read on public.subjects for select to authenticated
  using (private.has_role(workspace_id, '{owner,admin}') or private.assigned_subject(id));
create policy templates_read on public.templates for select to authenticated
  using (private.has_role(workspace_id, '{owner,admin,reviewer}'));
create policy template_versions_read on public.template_versions for select to authenticated
  using (private.has_role(workspace_id, '{owner,admin,reviewer}') or private.uses_assigned_template(id));
create policy sessions_read on public.sessions for select to authenticated
  using (private.can_review(id) or private.is_assigned(id) or private.viewer_can_see(id));
create policy session_reviewers_read on public.session_reviewers for select to authenticated
  using (private.can_review(session_id));
create policy session_subjects_read on public.session_subjects for select to authenticated
  using (private.can_review(session_id) or private.is_assigned(session_id, subject_id));
create policy session_assignments_read on public.session_assignments for select to authenticated
  using (private.can_review(session_id) or (user_id = (select auth.uid()) and private.is_assigned(session_id, subject_id)));
create policy assessments_read on public.assessments for select to authenticated
  using (private.can_review(session_id)
    or (assessor_id = (select auth.uid()) and private.is_assigned(session_id, subject_id)));
create policy assessment_events_read on public.assessment_events for select to authenticated
  using (private.can_review(session_id));
create policy invitations_read on public.invitations for select to authenticated
  using (private.has_role(workspace_id, '{owner,admin}'));
create policy audit_events_read on public.audit_events for select to authenticated
  using (private.has_role(workspace_id, '{owner,admin}'));

-- ---------------------------------------------------------------------------
-- Grants: explicit and minimal
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

grant usage on schema private to authenticated;
grant select on public.workspaces, public.memberships, public.membership_locations, public.locations,
  public.subjects, public.templates, public.template_versions, public.sessions, public.session_reviewers,
  public.session_subjects, public.session_assignments, public.assessments, public.assessment_events,
  public.invitations, public.audit_events to authenticated;
-- token_hash is never readable by clients.
revoke select on public.invitations from authenticated;
grant select (id, workspace_id, email, role, all_locations, location_ids, session_id, subject_ids, expires_at,
  created_by, created_at, revoked_at, accepted_at, accepted_by) on public.invitations to authenticated;

grant execute on function
  private.active_membership(uuid), private.member_role(uuid), private.has_role(uuid, public.member_role[]),
  private.user_in_location(uuid, uuid, uuid), private.in_location(uuid, uuid), private.can_review(uuid),
  private.is_assigned(uuid, uuid), private.assignment_in_scope(uuid, uuid), private.viewer_can_see(uuid), private.uses_assigned_template(uuid),
  private.assigned_subject(uuid),
  private.create_workspace(text, text, text, text), private.workspace_context(uuid),
  private.upsert_location(uuid, uuid, text, boolean),
  private.upsert_subject(uuid, uuid, text, public.subject_type, boolean),
  private.publish_template(uuid, uuid, text, public.starter_pack, public.attendance_mode, jsonb),
  private.create_session(uuid, uuid, uuid, text, date, uuid[], uuid[], uuid[], integer, time),
  private.set_assignment(uuid, uuid, uuid, boolean, integer),
  private.submit_assessment(uuid, uuid, uuid, public.subject_outcome, jsonb, text, integer, uuid, text),
  private.confirm_na(uuid, uuid, uuid, integer),
  private.resolve_outcome(uuid, uuid, public.subject_outcome, text, integer),
  private.close_collection(uuid), private.approve_session(uuid, integer), private.reopen_session(uuid, text),
  private.cancel_session(uuid, text), private.get_session_report(uuid, integer, boolean, text),
  private.get_dashboard(uuid),
  private.create_invitation(uuid, text, public.member_role, boolean, uuid[], uuid, uuid[]),
  private.revoke_invitation(uuid), private.peek_invitation(text), private.accept_invitation(text, text),
  private.update_member(uuid, uuid, public.member_role, boolean, uuid[]), private.revoke_member(uuid, uuid)
to authenticated;

grant execute on function
  public.create_workspace(text, text, text, text), public.workspace_context(uuid),
  public.upsert_location(uuid, uuid, text, boolean),
  public.upsert_subject(uuid, uuid, text, public.subject_type, boolean),
  public.publish_template(uuid, uuid, text, public.starter_pack, public.attendance_mode, jsonb),
  public.create_session(uuid, uuid, uuid, text, date, uuid[], uuid[], uuid[], integer, time),
  public.set_assignment(uuid, uuid, uuid, boolean, integer),
  public.submit_assessment(uuid, uuid, uuid, public.subject_outcome, jsonb, text, integer, uuid, text),
  public.confirm_na(uuid, uuid, uuid, integer),
  public.resolve_outcome(uuid, uuid, public.subject_outcome, text, integer),
  public.close_collection(uuid), public.approve_session(uuid, integer), public.reopen_session(uuid, text),
  public.cancel_session(uuid, text), public.get_session_report(uuid, integer, boolean, text),
  public.get_dashboard(uuid),
  public.create_invitation(uuid, text, public.member_role, boolean, uuid[], uuid, uuid[]),
  public.revoke_invitation(uuid), public.peek_invitation(text), public.accept_invitation(text, text),
  public.update_member(uuid, uuid, public.member_role, boolean, uuid[]), public.revoke_member(uuid, uuid)
to authenticated;

-- Future objects in these schemas must be granted explicitly.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
alter default privileges in schema private revoke all on functions from public, anon, authenticated;
