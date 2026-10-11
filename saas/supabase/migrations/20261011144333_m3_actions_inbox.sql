-- SAVOUR Milestone 3 (1 of 3): versioned template triggers, findings, corrective actions and the
-- in-app inbox.
--
-- Security model (unchanged from M1/M2)
-- * New tables have RLS on and SELECT-only grants (notifications: no grant and no policy; read only
--   through get_inbox). Every write is a public SECURITY INVOKER wrapper over a private SECURITY
--   DEFINER function with search_path='' that resolves auth.uid() to a live membership.
-- * Every finding/action write takes private.lock_session first (the evidence lock shared with
--   approval), then locks the finding/action row FOR NO KEY UPDATE. Approval reads action state under
--   the same session lock, so an action is either frozen in a snapshot or created strictly after it.
-- * Times that matter for ordering against approval use clock_timestamp() taken AFTER the session
--   lock (now() is transaction start and can precede a lock wait).
-- * Authorization is checked before taking the lock and again after it; an unauthorized caller fails
--   before any idempotency replay lookup, so revoked users never receive a receipt.
--
-- Roles
-- * Findings: created/withdrawn by Owner/Admin or a Reviewer who can review the session (can_review).
-- * Actions: created/edited/returned/verified/cancelled/reopened by can_review. Started and submitted
--   (with resolution evidence) by the live assignee: active, unexpired staff (owner/admin/reviewer/
--   assessor) who still hold the session location. A reviewer may progress someone else's action only
--   with a recorded override reason. Nobody verifies their own resolution (assignee or resolver),
--   except Owner/Admin with a recorded override reason; Reviewers have no override.
-- * Viewer and Guest cannot read or write findings, actions, events or the inbox.
-- * An assignment grants the action and its finding only, never the session, roster or report.
--
-- Lock order (whole schema; extends the five steps documented in 20261010231001):
--   1. invitation row (acceptance only)          FOR UPDATE
--   2. session row (private.lock_session)        FOR UPDATE   -- the evidence lock
--   3. per-workspace directory advisory lock
--   4. workspace row                              FOR NO KEY UPDATE
--   5. membership / subject / category / contact  FOR NO KEY UPDATE
--   6. finding / action rows                      FOR NO KEY UPDATE (always after step 2)
-- Notification rows are locked FOR NO KEY UPDATE only by mark-read, which takes no other lock.
-- Inbox due-date sync inserts notifications that reference only actions and memberships (never the
-- session row), so it never waits on a session writer.

-- ---------------------------------------------------------------------------
-- Versioned template settings and criterion triggers
-- ---------------------------------------------------------------------------
-- Settings are frozen with each published version (template_versions stays immutable). Existing
-- versions get '{}' (no triggers), so they never generate findings.
alter table public.template_versions add column settings jsonb not null default '{}'::jsonb;

-- Diff from m1_core: each criterion may also carry "critical": true and "trigger_at_or_below": 1..4.
-- The keys are emitted only when set, so criteria without them validate to exactly the M1 output.
create or replace function private.validate_criteria(p_criteria jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  c jsonb;
  v_out jsonb := '[]';
  v_keys text[] := '{}';
  v_key text;
  v_label text;
  v_obj jsonb;
  v_trig jsonb;
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
    if c ? 'critical' and jsonb_typeof(c -> 'critical') not in ('boolean', 'null') then
      perform private.fail('invalid_criteria', 'critical must be true or false for ' || v_key);
    end if;
    v_trig := c -> 'trigger_at_or_below';
    if v_trig is not null and jsonb_typeof(v_trig) <> 'null'
       and (jsonb_typeof(v_trig) <> 'number' or v_trig::numeric not in (1, 2, 3, 4)) then
      perform private.fail('invalid_criteria', 'finding trigger for ' || v_key || ' must be a whole score from 1 to 4');
    end if;
    v_keys := v_keys || v_key;
    v_obj := jsonb_build_object(
      'key', v_key, 'label', v_label,
      'guidance', nullif(btrim(coalesce(c ->> 'guidance', '')), ''),
      'allow_na', coalesce((c ->> 'allow_na')::boolean, false));
    if coalesce((c ->> 'critical')::boolean, false) then v_obj := v_obj || jsonb_build_object('critical', true); end if;
    if jsonb_typeof(v_trig) = 'number' then
      v_obj := v_obj || jsonb_build_object('trigger_at_or_below', v_trig::numeric::integer);
    end if;
    v_out := v_out || jsonb_build_array(v_obj);
  end loop;
  return v_out;
end $$;

-- Template-level settings. Only repeat_window (how many previous compatible approved sessions the
-- repeat tag looks back over, 1..6, default 3).
create function private.validate_template_settings(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  k text;
  v_window integer := 3;
begin
  if p is null or jsonb_typeof(p) = 'null' then return jsonb_build_object('repeat_window', v_window); end if;
  if jsonb_typeof(p) <> 'object' then perform private.fail('invalid_settings', 'settings must be an object'); end if;
  for k in select jsonb_object_keys(p) loop
    if k <> 'repeat_window' then perform private.fail('invalid_settings', 'unknown setting ' || k); end if;
  end loop;
  if p ? 'repeat_window' then
    if jsonb_typeof(p -> 'repeat_window') <> 'number' or (p -> 'repeat_window')::numeric not in (1, 2, 3, 4, 5, 6) then
      perform private.fail('invalid_settings', 'repeat window must be 1 to 6 previous sessions');
    end if;
    v_window := (p -> 'repeat_window')::numeric::integer;
  end if;
  return jsonb_build_object('repeat_window', v_window);
end $$;

-- Effective finding trigger of a frozen criterion: the explicit setting, else 2 for a critical
-- criterion, else none.
create function private.criterion_trigger(c jsonb) returns integer
language sql immutable set search_path = '' as $$
  select coalesce((c ->> 'trigger_at_or_below')::integer,
    case when coalesce((c ->> 'critical')::boolean, false) then 2 end)
$$;

-- New 7-argument publish with settings. Same rules as m1_core otherwise.
create function private.publish_template(p_ws uuid, p_template_id uuid, p_name text,
  p_pack public.starter_pack, p_attendance_mode public.attendance_mode, p_criteria jsonb, p_settings jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_criteria jsonb;
  v_settings jsonb;
  v_tid uuid := p_template_id;
  v_version integer;
  v_id uuid;
begin
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then perform private.fail('invalid_name'); end if;
  v_criteria := private.validate_criteria(p_criteria);
  v_settings := private.validate_template_settings(p_settings);
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
    criteria, formula_version, published_by, settings)
  values (p_ws, v_tid, v_version, btrim(p_name), p_attendance_mode, v_criteria, 'savour-m1.1', v_uid, v_settings)
  returning id into v_id;
  perform private.audit(p_ws, 'template.published', v_id, jsonb_build_object('template_id', v_tid, 'version', v_version,
    'triggers', (select count(*) from jsonb_array_elements(v_criteria) c where private.criterion_trigger(c) is not null),
    'critical', (select count(*) from jsonb_array_elements(v_criteria) c where coalesce((c ->> 'critical')::boolean, false)),
    'settings', v_settings));
  return v_id;
end $$;

-- The M1 6-argument signature stays and delegates with default settings.
-- Diff from m1_core: body delegates to the 7-argument implementation.
create or replace function private.publish_template(p_ws uuid, p_template_id uuid, p_name text,
  p_pack public.starter_pack, p_attendance_mode public.attendance_mode, p_criteria jsonb)
returns uuid language sql security definer set search_path = '' as $$
  select private.publish_template(p_ws, p_template_id, p_name, p_pack, p_attendance_mode, p_criteria, null::jsonb)
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
-- Lets actions prove (by foreign key) that their location is the session's location.
alter table public.sessions add constraint sessions_ws_id_location_key unique (workspace_id, id, location_id);

-- A finding is evidence of a problem on one roster subject in one session revision.
-- generated: raised at approval by a versioned template trigger; append-only per approved revision
--   (unique session/subject/criterion/revision). Never updated by later revisions.
-- manual: raised by a reviewer; active until withdrawn with a reason or resolved through actions.
create table public.findings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  session_id uuid not null,
  subject_id uuid not null,
  revision integer not null check (revision >= 1),
  kind text not null check (kind in ('generated', 'manual')),
  criterion_key text check (criterion_key is null or criterion_key ~ '^[a-z][a-z0-9_]{0,39}$'),
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  title text not null check (length(btrim(title)) between 1 and 200),
  detail jsonb not null default '{}'::jsonb,
  created_by uuid not null,
  created_at timestamptz not null,
  withdrawn_at timestamptz,
  withdrawn_by uuid,
  withdraw_reason text check (length(withdraw_reason) <= 500),
  version integer not null default 1,
  idempotency_key uuid,
  payload_hash text,
  unique (workspace_id, id),
  unique (workspace_id, id, session_id, subject_id),
  unique (created_by, idempotency_key),
  check (kind = 'manual' or criterion_key is not null),
  check ((kind = 'manual') = (idempotency_key is not null and payload_hash is not null)),
  check ((withdrawn_at is null) = (withdrawn_by is null) and (withdrawn_at is null) = (withdraw_reason is null)),
  foreign key (workspace_id, session_id, subject_id)
    references public.session_subjects (workspace_id, session_id, subject_id)
);
create unique index findings_generated_uq on public.findings (session_id, subject_id, criterion_key, revision)
  where kind = 'generated';
create index findings_ws_roster_fk_idx on public.findings (workspace_id, session_id, subject_id);
create index findings_session_idx on public.findings (session_id, subject_id);

create table public.actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  finding_id uuid not null,
  session_id uuid not null,
  subject_id uuid not null,
  location_id uuid not null,
  issue text not null check (length(btrim(issue)) between 1 and 300),
  action_required text not null check (length(btrim(action_required)) between 1 and 2000),
  severity text not null check (severity in ('critical', 'high', 'medium', 'low')),
  assignee_id uuid not null,
  due_date date not null,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'ready_for_verification', 'closed', 'cancelled')),
  resolution_evidence text check (length(resolution_evidence) <= 2000),
  resolved_by uuid,
  resolved_at timestamptz,
  verified_by uuid,
  verified_at timestamptz,
  cancel_reason text check (length(cancel_reason) <= 500),
  cancelled_by uuid,
  cancelled_at timestamptz,
  reopen_count integer not null default 0,
  last_reopen_reason text check (length(last_reopen_reason) <= 500),
  version integer not null default 1,
  created_by uuid not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (workspace_id, id),
  -- State coherence is enforced by the database, not only by the RPCs.
  check ((status in ('ready_for_verification', 'closed'))
    = (resolution_evidence is not null and resolved_by is not null and resolved_at is not null)),
  check ((status = 'closed') = (verified_by is not null and verified_at is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null and cancelled_by is not null and cancel_reason is not null)),
  foreign key (workspace_id, finding_id, session_id, subject_id)
    references public.findings (workspace_id, id, session_id, subject_id),
  foreign key (workspace_id, session_id, subject_id)
    references public.session_subjects (workspace_id, session_id, subject_id),
  foreign key (workspace_id, session_id, location_id) references public.sessions (workspace_id, id, location_id),
  foreign key (workspace_id, assignee_id) references public.memberships (workspace_id, user_id)
);
create index actions_ws_finding_fk_idx on public.actions (workspace_id, finding_id, session_id, subject_id);
create index actions_ws_roster_fk_idx on public.actions (workspace_id, session_id, subject_id);
create index actions_ws_session_location_fk_idx on public.actions (workspace_id, session_id, location_id);
create index actions_ws_assignee_fk_idx on public.actions (workspace_id, assignee_id);
create index actions_assignee_status_idx on public.actions (assignee_id, status);
create index actions_ws_status_due_idx on public.actions (workspace_id, status, due_date);
create index actions_finding_idx on public.actions (finding_id);
create index actions_session_idx on public.actions (session_id);

-- Insert-only audit trail of every action change, with before/after state and the idempotency key.
create table public.action_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  action_id uuid not null,
  kind text not null check (kind in ('create', 'update', 'start', 'submit', 'return', 'verify', 'cancel', 'reopen')),
  from_status text,
  to_status text not null,
  before jsonb,
  after jsonb not null,
  actor_id uuid not null,
  reason text check (length(reason) <= 500),
  override boolean not null default false,
  idempotency_key uuid not null,
  payload_hash text not null,
  created_at timestamptz not null,
  unique (actor_id, idempotency_key),
  unique (workspace_id, id),
  foreign key (workspace_id, action_id) references public.actions (workspace_id, id)
);
create index action_events_ws_action_fk_idx on public.action_events (workspace_id, action_id, created_at);

-- In-app inbox. Rows hold identifiers and minimal metadata only; titles, names and links are built at
-- read time after a live access check, so a stale row can never expose a payload or link.
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  recipient_id uuid not null,
  kind text not null check (kind in ('correction_requested', 'action_assigned', 'action_ready', 'action_returned',
    'action_verified', 'action_cancelled', 'action_reopened', 'action_due_today', 'action_overdue', 'session_approved')),
  action_id uuid,
  session_id uuid,
  correction_id uuid,
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  read_at timestamptz,
  unique (workspace_id, recipient_id, dedupe_key),
  check (num_nonnulls(action_id, session_id, correction_id) >= 1),
  foreign key (workspace_id, recipient_id) references public.memberships (workspace_id, user_id),
  foreign key (workspace_id, action_id) references public.actions (workspace_id, id),
  foreign key (workspace_id, session_id) references public.sessions (workspace_id, id),
  foreign key (workspace_id, correction_id) references public.correction_requests (workspace_id, id)
);
create index notifications_ws_recipient_idx on public.notifications (workspace_id, recipient_id, created_at desc);
create index notifications_ws_action_fk_idx on public.notifications (workspace_id, action_id);
create index notifications_ws_session_fk_idx on public.notifications (workspace_id, session_id);
create index notifications_ws_correction_fk_idx on public.notifications (workspace_id, correction_id);

create trigger action_events_immutable before update or delete on public.action_events
  for each row execute function private.forbid_change();

-- Only read_at may change on a notification.
create function private.notification_read_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' or (to_jsonb(new) - 'read_at') is distinct from (to_jsonb(old) - 'read_at') then
    raise exception 'immutable_record' using detail = tg_table_name;
  end if;
  return new;
end $$;
create trigger notifications_read_only before update or delete on public.notifications
  for each row execute function private.notification_read_only();

do $$
declare t text;
begin
  foreach t in array array['findings', 'actions'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.keep_workspace_id()',
      t || '_keep_workspace', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Workspace-local calendar date at this instant (server clock, workspace timezone). Due state is
-- always derived from this, never from a client clock.
create function private.workspace_today(p_ws uuid) returns date
language sql security definer set search_path = '' as $$
  select (pg_catalog.clock_timestamp() at time zone w.timezone)::date from public.workspaces w where w.id = p_ws
$$;

-- An unfinished action (including ready_for_verification) is overdue once its local due date has
-- ended in the workspace timezone; closed and cancelled actions are never overdue.
create function private.due_state(p_status text, p_due date, p_today date) returns text
language sql immutable set search_path = '' as $$
  select case when p_status in ('closed', 'cancelled') then 'done'
    when p_due < p_today then 'overdue'
    when p_due = p_today then 'due_today'
    else 'upcoming' end
$$;

-- Could this user own an action at this location right now? Active, unexpired staff holding it.
create function private.can_be_assignee(p_ws uuid, p_user uuid, p_location uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.workspace_id = p_ws and m.user_id = p_user
      and m.status = 'active' and (m.expires_at is null or m.expires_at > now())
      and m.role in ('owner', 'admin', 'reviewer', 'assessor'))
    and private.user_in_location(p_ws, p_user, p_location)
$$;

-- Is the caller the live assignee of this action?
create function private.is_live_assignee(p_action uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.actions a where a.id = p_action and a.assignee_id = (select auth.uid())
    and private.can_be_assignee(a.workspace_id, a.assignee_id, a.location_id))
$$;

create function private.can_see_action(p_action uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.actions a where a.id = p_action
    and (private.can_review(a.session_id) or private.is_live_assignee(a.id)))
$$;

-- A finding is visible to reviewers of its session and to live assignees of an action linked to it.
create function private.can_see_finding(p_finding uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.findings f where f.id = p_finding and private.can_review(f.session_id))
    or exists (select 1 from public.actions a where a.finding_id = p_finding and private.is_live_assignee(a.id))
$$;

-- withdrawn | open | resolved. Resolved only when at least one linked action is closed and none is
-- still active; with no actions (or only cancelled ones) the finding stays open.
create function private.finding_state(p_finding uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when f.withdrawn_at is not null then 'withdrawn'
    when exists (select 1 from public.actions a where a.finding_id = f.id
                 and a.status in ('open', 'in_progress', 'ready_for_verification')) then 'open'
    when exists (select 1 from public.actions a where a.finding_id = f.id and a.status = 'closed') then 'resolved'
    else 'open' end
  from public.findings f where f.id = p_finding
$$;

-- Generated finding detail records which prior inspections the repeat rule examined. Outgoing
-- envelopes keep only the session IDs the caller can currently open (can_review or viewer_can_see)
-- and say how many were withheld; the frozen result (status, counts) is never altered and stored
-- snapshots are never rewritten.
create function private.scrub_finding_detail(d jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r jsonb;
  v_prior jsonb;
  v_with jsonb;
begin
  if d is null or jsonb_typeof(d -> 'repeat') is distinct from 'object' then return d; end if;
  r := d -> 'repeat';
  select coalesce(jsonb_agg(x order by o), '[]'::jsonb) into v_prior
  from jsonb_array_elements(coalesce(r -> 'prior_sessions', '[]'::jsonb)) with ordinality e (x, o)
  where private.can_review((x #>> '{}')::uuid) or private.viewer_can_see((x #>> '{}')::uuid);
  select coalesce(jsonb_agg(x order by o), '[]'::jsonb) into v_with
  from jsonb_array_elements(coalesce(r -> 'sessions_with_finding', '[]'::jsonb)) with ordinality e (x, o)
  where private.can_review((x #>> '{}')::uuid) or private.viewer_can_see((x #>> '{}')::uuid);
  return d || jsonb_build_object('repeat', r || jsonb_build_object('prior_sessions', v_prior, 'sessions_with_finding', v_with,
    'sources_withheld', jsonb_array_length(coalesce(r -> 'prior_sessions', '[]'::jsonb)) - jsonb_array_length(v_prior)));
end $$;

-- Applies scrub_finding_detail to every finding of a report-inputs body. Inputs without findings
-- (all m1.1/m2.1 snapshots) are returned unchanged.
create function private.scrub_inputs(p jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when jsonb_typeof(p -> 'findings') = 'array' then p || jsonb_build_object('findings', coalesce((
      select jsonb_agg(f || jsonb_build_object('detail', private.scrub_finding_detail(f -> 'detail')) order by o)
      from jsonb_array_elements(p -> 'findings') with ordinality e (f, o)), '[]'::jsonb))
    else p end
$$;

create function private.member_label(p_ws uuid, p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select m.display_name from public.memberships m where m.workspace_id = p_ws and m.user_id = p_user),
    'Former member')
$$;

create function private.action_state(a public.actions) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('status', a.status, 'issue', a.issue, 'action_required', a.action_required,
    'severity', a.severity, 'assignee_id', a.assignee_id, 'due_date', a.due_date,
    'resolution_evidence', a.resolution_evidence, 'resolved_by', a.resolved_by, 'resolved_at', a.resolved_at,
    'verified_by', a.verified_by, 'verified_at', a.verified_at, 'cancel_reason', a.cancel_reason,
    'reopen_count', a.reopen_count, 'version', a.version)
$$;

-- Event-driven notification for one recipient. Never notifies the actor; skipped for recipients
-- without an active membership; a repeated dedupe key is a no-op (retry-safe).
create function private.notify(p_ws uuid, p_recipient uuid, p_kind text, p_dedupe text,
  p_action uuid, p_session uuid, p_correction uuid, p_meta jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.notifications (workspace_id, recipient_id, kind, action_id, session_id, correction_id,
    dedupe_key, meta, created_at)
  select p_ws, p_recipient, p_kind, p_action, p_session, p_correction, p_dedupe, coalesce(p_meta, '{}'::jsonb),
    pg_catalog.clock_timestamp()
  where p_recipient is not null and p_recipient is distinct from (select auth.uid())
    and exists (select 1 from public.memberships m where m.workspace_id = p_ws and m.user_id = p_recipient
                and m.status = 'active')
  on conflict (workspace_id, recipient_id, dedupe_key) do nothing
$$;

create function private.require_severity(p text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or p not in ('critical', 'high', 'medium', 'low') then perform private.fail('invalid_severity'); end if;
  return p;
end $$;

-- Due dates are workspace-local calendar days from today up to two years ahead.
create function private.require_due_date(p_ws uuid, p date) returns date
language plpgsql security definer set search_path = '' as $$
declare v_today date := private.workspace_today(p_ws);
begin
  if p is null or p < v_today or p > v_today + 731 then
    perform private.fail('invalid_due_date', 'today (' || v_today || ') or later, within two years');
  end if;
  return p;
end $$;

-- Membership-aware not_found/forbidden for a session the caller cannot review.
create function private.deny_session(p_session uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.sessions s where s.id = p_session and private.member_role(s.workspace_id) is not null) then
    perform private.fail('forbidden');
  end if;
  perform private.fail('not_found', 'session');
end $$;

-- ---------------------------------------------------------------------------
-- Findings
-- ---------------------------------------------------------------------------
create function private.create_finding(p_session uuid, p_subject uuid, p_severity text, p_title text,
  p_note text, p_criterion_key text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_s public.sessions;
  v_tv public.template_versions;
  v_prior public.findings;
  v_hash text;
  v_label text;
  v_id uuid;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  if not private.can_review(p_session) then perform private.deny_session(p_session); end if;
  v_s := private.lock_session(p_session);
  if not private.can_review(p_session) then perform private.fail('forbidden'); end if;
  v_hash := private.sha256_hex(jsonb_build_object('session', p_session, 'subject', p_subject, 'severity', p_severity,
    'title', p_title, 'note', p_note, 'criterion', p_criterion_key)::text);
  select * into v_prior from public.findings where created_by = v_uid and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.payload_hash <> v_hash then perform private.fail('idempotency_conflict'); end if;
    -- The original create receipt (version 1), even if the finding was withdrawn since.
    return jsonb_build_object('finding_id', v_prior.id, 'version', 1, 'replayed', true);
  end if;

  if v_s.is_sample then perform private.fail('sample_not_allowed'); end if;
  if v_s.status not in ('open', 'in_review', 'approved') then perform private.fail('invalid_state'); end if;
  perform private.require_active_roster(p_session, p_subject);
  perform private.require_severity(p_severity);
  if length(btrim(coalesce(p_title, ''))) not between 1 and 200 then perform private.fail('invalid_title'); end if;
  if length(coalesce(p_note, '')) > 2000 then perform private.fail('notes_too_long'); end if;
  if p_criterion_key is not null then
    select * into v_tv from public.template_versions where id = v_s.template_version_id;
    select c ->> 'label' into v_label from jsonb_array_elements(v_tv.criteria) c where c ->> 'key' = p_criterion_key;
    if v_label is null then perform private.fail('unknown_criterion', p_criterion_key); end if;
  end if;
  insert into public.findings (workspace_id, session_id, subject_id, revision, kind, criterion_key, severity, title,
    detail, created_by, created_at, idempotency_key, payload_hash)
  values (v_s.workspace_id, p_session, p_subject, v_s.revision, 'manual', p_criterion_key, p_severity, btrim(p_title),
    jsonb_strip_nulls(jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), ''), 'criterion_label', v_label,
      'rule', 'Raised manually by a reviewer.')),
    v_uid, pg_catalog.clock_timestamp(), p_idempotency_key, v_hash)
  returning id into v_id;
  perform private.audit(v_s.workspace_id, 'finding.created', v_id, jsonb_build_object('session_id', p_session,
    'subject_id', p_subject, 'severity', p_severity, 'kind', 'manual', 'revision', v_s.revision));
  return jsonb_build_object('finding_id', v_id, 'version', 1, 'replayed', false);
end $$;

create function private.withdraw_finding(p_finding uuid, p_reason text, p_expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_f public.findings;
  v_s public.sessions;
  v_reason text;
begin
  select * into v_f from public.findings where id = p_finding;
  if not found then perform private.fail('not_found', 'finding'); end if;
  if not private.can_review(v_f.session_id) then
    if private.member_role(v_f.workspace_id) is null then perform private.fail('not_found', 'finding'); end if;
    perform private.fail('forbidden');
  end if;
  v_s := private.lock_session(v_f.session_id);
  if not private.can_review(v_f.session_id) then perform private.fail('forbidden'); end if;
  select * into v_f from public.findings where id = p_finding for no key update;
  if p_expected_version is null or v_f.version <> p_expected_version then perform private.fail('stale_version'); end if;
  if v_f.withdrawn_at is not null then perform private.fail('invalid_state'); end if;
  v_reason := private.require_reason(p_reason);
  if exists (select 1 from public.actions a where a.finding_id = p_finding and a.status <> 'cancelled') then
    perform private.fail('finding_has_actions');
  end if;
  update public.findings set withdrawn_at = pg_catalog.clock_timestamp(), withdrawn_by = v_uid, withdraw_reason = v_reason,
    version = version + 1
  where id = p_finding;
  perform private.audit(v_s.workspace_id, 'finding.withdrawn', p_finding, jsonb_build_object('session_id', v_s.id,
    'reason', v_reason, 'kind', v_f.kind, 'revision', v_f.revision));
  return v_f.version + 1;
end $$;

-- Findings of one session for its reviewers, with live state and linked action counts.
create function private.get_findings(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_s public.sessions;
begin
  perform private.require_uid();
  if not private.can_review(p_session) then perform private.deny_session(p_session); end if;
  select * into v_s from public.sessions where id = p_session;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', f.id, 'subject_id', f.subject_id, 'subject_name', ss.subject_name,
      'revision', f.revision, 'kind', f.kind, 'criterion_key', f.criterion_key, 'severity', f.severity, 'title', f.title,
      'detail', private.scrub_finding_detail(f.detail), 'created_at', f.created_at,
      'created_by_label', private.member_label(f.workspace_id, f.created_by),
      'withdrawn_at', f.withdrawn_at, 'withdraw_reason', f.withdraw_reason, 'version', f.version,
      'state', private.finding_state(f.id),
      -- Generated evidence is current only for the session's current approved revision; earlier
      -- revisions' generated findings are historical. Manual findings are current until withdrawn.
      'current', f.withdrawn_at is null and (f.kind = 'manual'
        or (v_s.status = 'approved' and f.revision = v_s.revision)),
      'actions', (select count(*) from public.actions a where a.finding_id = f.id),
      'active_actions', (select count(*) from public.actions a where a.finding_id = f.id
                         and a.status in ('open', 'in_progress', 'ready_for_verification')))
      order by f.revision desc, f.created_at, f.id)
    from public.findings f
    join public.session_subjects ss on ss.session_id = f.session_id and ss.subject_id = f.subject_id
    where f.session_id = p_session), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Actions
-- ---------------------------------------------------------------------------
create function private.create_action(p_finding uuid, p_issue text, p_action_required text, p_severity text,
  p_assignee uuid, p_due_date date, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_f public.findings;
  v_s public.sessions;
  v_a public.actions;
  v_prior public.action_events;
  v_hash text;
  v_now timestamptz;
  v_event uuid;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  select * into v_f from public.findings where id = p_finding;
  if not found then perform private.fail('not_found', 'finding'); end if;
  if not private.can_review(v_f.session_id) then
    if private.member_role(v_f.workspace_id) is null then perform private.fail('not_found', 'finding'); end if;
    perform private.fail('forbidden');
  end if;
  v_s := private.lock_session(v_f.session_id);
  if not private.can_review(v_f.session_id) then perform private.fail('forbidden'); end if;
  v_hash := private.sha256_hex(jsonb_build_object('finding', p_finding, 'issue', p_issue, 'action_required', p_action_required,
    'severity', p_severity, 'assignee', p_assignee, 'due_date', p_due_date)::text);
  select * into v_prior from public.action_events where actor_id = v_uid and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.kind <> 'create' or v_prior.payload_hash <> v_hash then perform private.fail('idempotency_conflict'); end if;
    return jsonb_build_object('action_id', v_prior.action_id, 'version', (v_prior.after ->> 'version')::integer,
      'status', v_prior.to_status, 'replayed', true);
  end if;

  select * into v_f from public.findings where id = p_finding for no key update;
  if v_f.withdrawn_at is not null then perform private.fail('finding_withdrawn'); end if;
  if v_s.is_sample then perform private.fail('sample_not_allowed'); end if;
  if v_s.status not in ('open', 'in_review', 'approved') then perform private.fail('invalid_state'); end if;
  perform private.require_active_roster(v_f.session_id, v_f.subject_id);
  if length(btrim(coalesce(p_issue, ''))) not between 1 and 300 then perform private.fail('invalid_issue'); end if;
  if length(btrim(coalesce(p_action_required, ''))) not between 1 and 2000 then perform private.fail('invalid_action_required'); end if;
  perform private.require_severity(p_severity);
  perform private.require_due_date(v_s.workspace_id, p_due_date);
  if p_assignee is null or not private.can_be_assignee(v_s.workspace_id, p_assignee, v_s.location_id) then
    perform private.fail('invalid_assignee');
  end if;

  v_now := pg_catalog.clock_timestamp();
  insert into public.actions (workspace_id, finding_id, session_id, subject_id, location_id, issue, action_required,
    severity, assignee_id, due_date, created_by, created_at, updated_at)
  values (v_s.workspace_id, v_f.id, v_f.session_id, v_f.subject_id, v_s.location_id, btrim(p_issue), btrim(p_action_required),
    p_severity, p_assignee, p_due_date, v_uid, v_now, v_now)
  returning * into v_a;
  insert into public.action_events (workspace_id, action_id, kind, from_status, to_status, before, after, actor_id,
    idempotency_key, payload_hash, created_at)
  values (v_s.workspace_id, v_a.id, 'create', null, 'open', null, private.action_state(v_a), v_uid,
    p_idempotency_key, v_hash, v_now)
  returning id into v_event;
  perform private.notify(v_s.workspace_id, p_assignee, 'action_assigned', 'assigned:' || v_event, v_a.id, null, null,
    jsonb_build_object('due_date', p_due_date));
  perform private.audit(v_s.workspace_id, 'action.created', v_a.id, jsonb_build_object('finding_id', v_f.id,
    'session_id', v_f.session_id, 'subject_id', v_f.subject_id, 'severity', p_severity, 'assignee_id', p_assignee,
    'due_date', p_due_date));
  return jsonb_build_object('action_id', v_a.id, 'version', v_a.version, 'status', v_a.status, 'replayed', false);
end $$;

-- Reviewer edit of an unfinished action: issue, action required, severity, due date, assignee.
-- Null arguments keep the current value. Reassignment notifies the new assignee; the old assignee's
-- notifications fail their live check from now on.
create function private.update_action(p_action uuid, p_expected_version integer, p_issue text, p_action_required text,
  p_severity text, p_assignee uuid, p_due_date date, p_reason text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_a public.actions;
  v_new public.actions;
  v_s public.sessions;
  v_prior public.action_events;
  v_hash text;
  v_now timestamptz;
  v_event uuid;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  select * into v_a from public.actions where id = p_action;
  if not found or private.member_role(v_a.workspace_id) is null then perform private.fail('not_found', 'action'); end if;
  if not private.can_review(v_a.session_id) then perform private.fail('forbidden'); end if;
  v_s := private.lock_session(v_a.session_id);
  if not private.can_review(v_a.session_id) then perform private.fail('forbidden'); end if;
  select * into v_a from public.actions where id = p_action for no key update;
  v_hash := private.sha256_hex(jsonb_build_object('action', p_action, 'command', 'update', 'expected_version', p_expected_version,
    'issue', p_issue, 'action_required', p_action_required, 'severity', p_severity, 'assignee', p_assignee,
    'due_date', p_due_date, 'reason', p_reason)::text);
  select * into v_prior from public.action_events where actor_id = v_uid and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.action_id <> p_action or v_prior.kind <> 'update' or v_prior.payload_hash <> v_hash then
      perform private.fail('idempotency_conflict');
    end if;
    return jsonb_build_object('action_id', v_prior.action_id, 'version', (v_prior.after ->> 'version')::integer,
      'status', v_prior.to_status, 'replayed', true);
  end if;
  if p_expected_version is null or v_a.version <> p_expected_version then perform private.fail('stale_version'); end if;
  if v_a.status not in ('open', 'in_progress', 'ready_for_verification') then perform private.fail('invalid_state'); end if;
  if length(coalesce(btrim(p_reason), '')) > 500 then perform private.fail('reason_too_long'); end if;

  v_new := v_a;
  if p_issue is not null then
    if length(btrim(p_issue)) not between 1 and 300 then perform private.fail('invalid_issue'); end if;
    v_new.issue := btrim(p_issue);
  end if;
  if p_action_required is not null then
    if length(btrim(p_action_required)) not between 1 and 2000 then perform private.fail('invalid_action_required'); end if;
    v_new.action_required := btrim(p_action_required);
  end if;
  if p_severity is not null then v_new.severity := private.require_severity(p_severity); end if;
  if p_due_date is not null and p_due_date <> v_a.due_date then
    v_new.due_date := private.require_due_date(v_a.workspace_id, p_due_date);
  end if;
  if p_assignee is not null and p_assignee <> v_a.assignee_id then
    if not private.can_be_assignee(v_a.workspace_id, p_assignee, v_a.location_id) then perform private.fail('invalid_assignee'); end if;
    v_new.assignee_id := p_assignee;
  end if;
  if private.action_state(v_new) = private.action_state(v_a) then perform private.fail('no_change'); end if;
  -- Submitted evidence answers the work as it was. While it awaits verification only the due date
  -- may change; changing the work or its owner first needs a reasoned return (which clears the
  -- resolution), so old evidence can never close different work.
  if v_a.status = 'ready_for_verification' and (v_new.issue <> v_a.issue or v_new.action_required <> v_a.action_required
      or v_new.severity <> v_a.severity or v_new.assignee_id <> v_a.assignee_id) then
    perform private.fail('return_required', 'return the action for more work before changing the work, severity or assignee');
  end if;

  v_now := pg_catalog.clock_timestamp();
  update public.actions set issue = v_new.issue, action_required = v_new.action_required, severity = v_new.severity,
    due_date = v_new.due_date, assignee_id = v_new.assignee_id, version = version + 1, updated_at = v_now
  where id = p_action returning * into v_new;
  insert into public.action_events (workspace_id, action_id, kind, from_status, to_status, before, after, actor_id, reason,
    idempotency_key, payload_hash, created_at)
  values (v_a.workspace_id, p_action, 'update', v_a.status, v_new.status, private.action_state(v_a), private.action_state(v_new),
    v_uid, nullif(btrim(coalesce(p_reason, '')), ''), p_idempotency_key, v_hash, v_now)
  returning id into v_event;
  if v_new.assignee_id <> v_a.assignee_id then
    perform private.notify(v_a.workspace_id, v_new.assignee_id, 'action_assigned', 'assigned:' || v_event, p_action, null, null,
      jsonb_build_object('due_date', v_new.due_date));
  end if;
  perform private.audit(v_a.workspace_id, case when v_new.assignee_id <> v_a.assignee_id then 'action.reassigned' else 'action.updated' end,
    p_action, jsonb_build_object('before', private.action_state(v_a), 'after', private.action_state(v_new),
      'reason', nullif(btrim(coalesce(p_reason, '')), '')));
  return jsonb_build_object('action_id', p_action, 'version', v_new.version, 'status', v_new.status, 'replayed', false);
end $$;

-- State transitions. Strictly linear, no skipping:
--   start  : open -> in_progress                     assignee, or reviewer with override reason
--   submit : in_progress -> ready_for_verification   assignee, or reviewer with override reason; evidence required
--   return : ready_for_verification -> in_progress   reviewer; reason required (resolution cleared, kept in history)
--   verify : ready_for_verification -> closed        reviewer who is neither assignee nor resolver;
--                                                    Owner/Admin may self-verify with an override reason
--   cancel : open | in_progress | ready -> cancelled reviewer; reason required
--   reopen : closed | cancelled -> open              reviewer; reason required (resolution cleared)
create function private.transition_action(p_action uuid, p_command text, p_expected_version integer, p_evidence text,
  p_reason text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_a public.actions;
  v_new public.actions;
  v_s public.sessions;
  v_prior public.action_events;
  v_review boolean;
  v_assignee boolean;
  v_override boolean := false;
  v_self boolean;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_evidence text := nullif(btrim(coalesce(p_evidence, '')), '');
  v_to text;
  v_hash text;
  v_now timestamptz;
  v_event uuid;
  r record;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  if p_command is null or p_command not in ('start', 'submit', 'return', 'verify', 'cancel', 'reopen') then
    perform private.fail('invalid_command');
  end if;
  select * into v_a from public.actions where id = p_action;
  if not found or private.member_role(v_a.workspace_id) is null then perform private.fail('not_found', 'action'); end if;
  -- Authorization before the lock (no unauthorized lock waits) and again after it.
  for i in 1 .. 2 loop
    if private.has_role(v_a.workspace_id, '{viewer,guest}') then perform private.fail('forbidden'); end if;
    v_review := private.can_review(v_a.session_id);
    v_assignee := private.is_live_assignee(p_action);
    if p_command in ('start', 'submit') then
      if not v_review and not v_assignee then perform private.fail('not_assigned'); end if;
    elsif not v_review then
      perform private.fail('forbidden');
    end if;
    exit when i = 2;
    v_s := private.lock_session(v_a.session_id);
    select * into v_a from public.actions where id = p_action for no key update;
  end loop;

  v_hash := private.sha256_hex(jsonb_build_object('action', p_action, 'command', p_command,
    'expected_version', p_expected_version, 'evidence', p_evidence, 'reason', p_reason)::text);
  select * into v_prior from public.action_events where actor_id = v_uid and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.action_id <> p_action or v_prior.kind <> p_command or v_prior.payload_hash <> v_hash then
      perform private.fail('idempotency_conflict');
    end if;
    return jsonb_build_object('action_id', v_prior.action_id, 'version', (v_prior.after ->> 'version')::integer,
      'status', v_prior.to_status, 'replayed', true);
  end if;
  if p_expected_version is null or v_a.version <> p_expected_version then perform private.fail('stale_version'); end if;

  v_to := case p_command
    when 'start' then case when v_a.status = 'open' then 'in_progress' end
    when 'submit' then case when v_a.status = 'in_progress' then 'ready_for_verification' end
    when 'return' then case when v_a.status = 'ready_for_verification' then 'in_progress' end
    when 'verify' then case when v_a.status = 'ready_for_verification' then 'closed' end
    when 'cancel' then case when v_a.status in ('open', 'in_progress', 'ready_for_verification') then 'cancelled' end
    when 'reopen' then case when v_a.status in ('closed', 'cancelled') then 'open' end end;
  if v_to is null then perform private.fail('invalid_transition', v_a.status || ' -> ' || p_command); end if;
  if v_reason is not null and length(v_reason) > 500 then perform private.fail('reason_too_long'); end if;

  if p_command in ('start', 'submit') and not v_assignee then
    -- A reviewer progressing someone else's work: documented override.
    if v_reason is null then perform private.fail('override_reason_required'); end if;
    v_override := true;
  end if;
  if p_command = 'submit' then
    if v_evidence is null then perform private.fail('evidence_required'); end if;
    if length(v_evidence) > 2000 then perform private.fail('evidence_too_long'); end if;
  end if;
  if p_command in ('return', 'cancel', 'reopen') then v_reason := private.require_reason(p_reason); end if;
  if p_command = 'verify' then
    v_self := v_uid = v_a.assignee_id or v_uid = v_a.resolved_by;
    if v_self then
      if not private.has_role(v_a.workspace_id, '{owner,admin}') then
        perform private.fail('own_verification_forbidden', 'a different reviewer must verify this resolution');
      end if;
      if v_reason is null then
        perform private.fail('own_verification_forbidden', 'owners and admins may verify their own resolution only with an override reason');
      end if;
      v_override := true;
    end if;
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_new := v_a;
  v_new.status := v_to;
  if p_command = 'submit' then
    v_new.resolution_evidence := v_evidence; v_new.resolved_by := v_uid; v_new.resolved_at := v_now;
  elsif p_command = 'return' or p_command = 'reopen' then
    v_new.resolution_evidence := null; v_new.resolved_by := null; v_new.resolved_at := null;
    v_new.verified_by := null; v_new.verified_at := null;
    v_new.cancel_reason := null; v_new.cancelled_by := null; v_new.cancelled_at := null;
  elsif p_command = 'verify' then
    v_new.verified_by := v_uid; v_new.verified_at := v_now;
  elsif p_command = 'cancel' then
    -- A cancelled action has no current resolution (any submitted evidence stays in the history).
    v_new.resolution_evidence := null; v_new.resolved_by := null; v_new.resolved_at := null;
    v_new.cancel_reason := v_reason; v_new.cancelled_by := v_uid; v_new.cancelled_at := v_now;
  end if;
  if p_command = 'reopen' then
    v_new.reopen_count := v_a.reopen_count + 1; v_new.last_reopen_reason := v_reason;
  end if;
  update public.actions set status = v_new.status, resolution_evidence = v_new.resolution_evidence,
    resolved_by = v_new.resolved_by, resolved_at = v_new.resolved_at, verified_by = v_new.verified_by,
    verified_at = v_new.verified_at, cancel_reason = v_new.cancel_reason, cancelled_by = v_new.cancelled_by,
    cancelled_at = v_new.cancelled_at, reopen_count = v_new.reopen_count, last_reopen_reason = v_new.last_reopen_reason,
    version = version + 1, updated_at = v_now
  where id = p_action returning * into v_new;
  insert into public.action_events (workspace_id, action_id, kind, from_status, to_status, before, after, actor_id, reason,
    override, idempotency_key, payload_hash, created_at)
  values (v_a.workspace_id, p_action, p_command, v_a.status, v_to, private.action_state(v_a), private.action_state(v_new),
    v_uid, v_reason, v_override, p_idempotency_key, v_hash, v_now)
  returning id into v_event;

  if p_command = 'submit' then
    for r in
      select sr.user_id from public.session_reviewers sr where sr.session_id = v_a.session_id
      union select v_a.created_by
    loop
      perform private.notify(v_a.workspace_id, r.user_id, 'action_ready', 'event:' || v_event, p_action, null, null, '{}'::jsonb);
    end loop;
  elsif p_command in ('return', 'verify', 'cancel', 'reopen') then
    for r in select v_a.assignee_id as user_id union select v_a.resolved_by where p_command = 'verify' loop
      perform private.notify(v_a.workspace_id, r.user_id, case p_command when 'return' then 'action_returned'
        when 'verify' then 'action_verified' when 'cancel' then 'action_cancelled' else 'action_reopened' end,
        'event:' || v_event, p_action, null, null, '{}'::jsonb);
    end loop;
  end if;
  perform private.audit(v_a.workspace_id, 'action.' || p_command, p_action, jsonb_build_object('from', v_a.status, 'to', v_to,
    'reason', v_reason, 'override', v_override, 'version', v_new.version));
  if v_override and p_command = 'verify' then
    perform private.audit(v_a.workspace_id, 'action.self_verified', p_action, jsonb_build_object('reason', v_reason));
  elsif v_override then
    perform private.audit(v_a.workspace_id, 'action.progress_override', p_action, jsonb_build_object('command', p_command,
      'reason', v_reason, 'assignee_id', v_a.assignee_id));
  end if;
  return jsonb_build_object('action_id', p_action, 'version', v_new.version, 'status', v_new.status, 'replayed', false);
end $$;

-- One action as JSON for list/detail reads (caller already authorized).
create function private.action_json(a public.actions, p_today date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', a.id, 'workspace_id', a.workspace_id, 'finding_id', a.finding_id, 'session_id', a.session_id,
    'subject_id', a.subject_id,
    'session_name', s.name, 'session_date', s.local_date, 'session_status', s.status, 'subject_name', ss.subject_name,
    'location_name', l.name, 'issue', a.issue, 'action_required', a.action_required, 'severity', a.severity,
    'status', a.status, 'due_date', a.due_date, 'due_state', private.due_state(a.status, a.due_date, p_today),
    'assignee_id', a.assignee_id, 'assignee_label', private.member_label(a.workspace_id, a.assignee_id),
    'assignee_in_scope', private.can_be_assignee(a.workspace_id, a.assignee_id, a.location_id),
    'is_mine', a.assignee_id = (select auth.uid()), 'can_review', private.can_review(a.session_id),
    'resolution_evidence', a.resolution_evidence, 'resolved_by', a.resolved_by,
    'resolved_by_label', case when a.resolved_by is not null then private.member_label(a.workspace_id, a.resolved_by) end,
    'resolved_at', a.resolved_at, 'verified_at', a.verified_at,
    'verified_by_label', case when a.verified_by is not null then private.member_label(a.workspace_id, a.verified_by) end,
    'cancel_reason', a.cancel_reason, 'cancelled_at', a.cancelled_at, 'reopen_count', a.reopen_count,
    'last_reopen_reason', a.last_reopen_reason, 'version', a.version, 'created_by', a.created_by,
    'created_by_label', private.member_label(a.workspace_id, a.created_by), 'created_at', a.created_at, 'updated_at', a.updated_at)
  from public.sessions s
  join public.session_subjects ss on ss.session_id = a.session_id and ss.subject_id = a.subject_id
  join public.locations l on l.id = a.location_id
  where s.id = a.session_id
$$;

-- Actions the caller may see: Owner/Admin all, Reviewer those on sessions they review, any staff
-- member their own live assignments. Viewer and Guest are refused.
create function private.get_actions(p_ws uuid, p_session uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role public.member_role;
  v_today date;
begin
  perform private.require_uid();
  v_role := private.member_role(p_ws);
  if v_role is null then perform private.fail('not_found', 'workspace'); end if;
  if v_role not in ('owner', 'admin', 'reviewer', 'assessor') then perform private.fail('forbidden'); end if;
  v_today := private.workspace_today(p_ws);
  return jsonb_build_object('today', v_today,
    'timezone', (select timezone from public.workspaces where id = p_ws),
    'actions', coalesce((
      select jsonb_agg(private.action_json(a, v_today)
        order by a.status in ('closed', 'cancelled'), a.due_date, a.created_at, a.id)
      from public.actions a
      where a.workspace_id = p_ws and (p_session is null or a.session_id = p_session)
        and (private.can_review(a.session_id) or private.is_live_assignee(a.id))), '[]'::jsonb));
end $$;

-- One action with its finding and full history. Assignees see the action and its finding only.
create function private.get_action(p_action uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_a public.actions;
  v_f public.findings;
  v_today date;
  v_review boolean;
  v_self boolean;
begin
  perform private.require_uid();
  select * into v_a from public.actions where id = p_action;
  if not found or not private.can_see_action(p_action) or private.has_role(v_a.workspace_id, '{viewer,guest}') then
    perform private.fail('not_found', 'action');
  end if;
  select * into v_f from public.findings where id = v_a.finding_id;
  v_today := private.workspace_today(v_a.workspace_id);
  v_review := private.can_review(v_a.session_id);
  v_self := (select auth.uid()) in (v_a.assignee_id, coalesce(v_a.resolved_by, v_a.assignee_id));
  return jsonb_build_object('today', v_today, 'timezone', (select timezone from public.workspaces where id = v_a.workspace_id),
    'action', private.action_json(v_a, v_today),
    'finding', jsonb_build_object('id', v_f.id, 'kind', v_f.kind, 'severity', v_f.severity, 'title', v_f.title,
      'detail', private.scrub_finding_detail(v_f.detail), 'revision', v_f.revision, 'criterion_key', v_f.criterion_key, 'created_at', v_f.created_at,
      'state', private.finding_state(v_f.id), 'withdrawn_at', v_f.withdrawn_at),
    'permissions', jsonb_build_object('review', v_review, 'assignee', private.is_live_assignee(p_action),
      'manager', private.has_role(v_a.workspace_id, '{owner,admin}'), 'self_verification', v_self),
    'events', coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'from_status', e.from_status,
        'to_status', e.to_status, 'actor_label', private.member_label(e.workspace_id, e.actor_id), 'reason', e.reason,
        'override', e.override, 'created_at', e.created_at,
        'changes', case when e.kind = 'update' then (
          select coalesce(jsonb_object_agg(k.key, jsonb_build_object('from', e.before -> k.key, 'to', e.after -> k.key)), '{}'::jsonb)
          from jsonb_each(e.after) k where k.key <> 'version' and (e.before -> k.key) is distinct from k.value) end,
        'evidence', case when e.kind = 'submit' then e.after ->> 'resolution_evidence' end)
      order by e.created_at, e.id) from public.action_events e where e.action_id = p_action), '[]'::jsonb));
end $$;

-- Eligible assignees for actions on a session (its reviewers only): active staff holding the location.
create function private.get_action_assignees(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_s public.sessions;
begin
  perform private.require_uid();
  if not private.can_review(p_session) then perform private.deny_session(p_session); end if;
  select * into v_s from public.sessions where id = p_session;
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'display_name', m.display_name, 'role', m.role)
      order by m.display_name, m.user_id)
    from public.memberships m
    where m.workspace_id = v_s.workspace_id and private.can_be_assignee(v_s.workspace_id, m.user_id, v_s.location_id)), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Inbox
-- ---------------------------------------------------------------------------
-- Display form of one notification for its recipient (the caller), or null when the live condition
-- no longer holds (access removed, reassigned, correction closed, due date changed, action finished).
create function private.render_notification(n public.notifications) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_a public.actions;
  v_s public.sessions;
  v_cr public.correction_requests;
  v_subject text;
  v_base text := '/w/' || n.workspace_id;
begin
  if n.recipient_id is distinct from v_uid then return null; end if;
  if n.kind = 'correction_requested' then
    select * into v_cr from public.correction_requests where id = n.correction_id;
    if not found or v_cr.status <> 'open' or v_cr.assessor_id <> v_uid
       or not private.is_assigned(v_cr.session_id, v_cr.subject_id) then
      return null;
    end if;
    select * into v_s from public.sessions where id = v_cr.session_id;
    select subject_name into v_subject from public.session_subjects where session_id = v_cr.session_id and subject_id = v_cr.subject_id;
    return jsonb_build_object('title', 'Correction requested', 'body', v_subject || ' — ' || v_s.name,
      'link', v_base || '/sessions/' || v_s.id || '/assess/' || v_cr.subject_id);
  elsif n.kind = 'session_approved' then
    if not private.can_review(n.session_id) then return null; end if;
    select * into v_s from public.sessions where id = n.session_id;
    return jsonb_build_object('title', 'Session approved', 'body', v_s.name || ' — revision ' || coalesce(n.meta ->> 'revision', '?'),
      'link', v_base || '/sessions/' || v_s.id || '/report?revision=' || coalesce(n.meta ->> 'revision', ''));
  end if;
  select * into v_a from public.actions where id = n.action_id;
  if not found or not (private.can_review(v_a.session_id) or private.is_live_assignee(v_a.id)) then return null; end if;
  if n.kind = 'action_assigned' and not private.is_live_assignee(v_a.id) then return null; end if;
  -- A due reminder is live only while its own condition holds today (workspace-local date): a
  -- due-today notice goes stale once the day has ended, an overdue notice once finished.
  if n.kind in ('action_due_today', 'action_overdue') and (v_a.status in ('closed', 'cancelled')
      or v_a.due_date::text is distinct from n.meta ->> 'due_date'
      or private.due_state(v_a.status, v_a.due_date, private.workspace_today(v_a.workspace_id))
         <> case n.kind when 'action_due_today' then 'due_today' else 'overdue' end
      or not ((v_a.assignee_id = v_uid and private.is_live_assignee(v_a.id))
              or (v_a.created_by = v_uid and private.can_review(v_a.session_id)))) then
    return null;
  end if;
  select subject_name into v_subject from public.session_subjects where session_id = v_a.session_id and subject_id = v_a.subject_id;
  return jsonb_build_object('title', case n.kind
      when 'action_assigned' then 'Action assigned to you' when 'action_ready' then 'Action ready for verification'
      when 'action_returned' then 'Action returned for more work' when 'action_verified' then 'Action verified and closed'
      when 'action_cancelled' then 'Action cancelled' when 'action_reopened' then 'Action reopened'
      when 'action_due_today' then 'Action due today' else 'Action overdue' end,
    'body', left(v_a.issue, 120) || ' — ' || v_subject || ' · due ' || v_a.due_date,
    'status', v_a.status, 'link', v_base || '/actions/' || v_a.id);
end $$;

-- Reads the caller's inbox. First runs an idempotent due-date sync for the caller's own unfinished
-- actions (assigned to them, or created by them while they still review the session): one
-- "due today" and one "overdue" reminder per action and due date. This lazy sync runs only when an
-- inbox is opened (no background job, no email/SMS/WhatsApp); a scheduler calling the same insert
-- can be added later without changing the dedupe keys.
create function private.get_inbox(p_ws uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_role public.member_role := private.member_role(p_ws);
  v_today date;
  v_synced integer;
begin
  if v_role is null then perform private.fail('not_found', 'workspace'); end if;
  if v_role not in ('owner', 'admin', 'reviewer', 'assessor') then perform private.fail('forbidden'); end if;
  v_today := private.workspace_today(p_ws);
  insert into public.notifications (workspace_id, recipient_id, kind, action_id, dedupe_key, meta, created_at)
  select a.workspace_id, v_uid, k.kind, a.id, k.kind || ':' || a.id || ':' || a.due_date,
    jsonb_build_object('due_date', a.due_date), pg_catalog.clock_timestamp()
  from public.actions a
  cross join lateral (select case when a.due_date < v_today then 'action_overdue' else 'action_due_today' end as kind) k
  where a.workspace_id = p_ws and a.status in ('open', 'in_progress', 'ready_for_verification') and a.due_date <= v_today
    and ((a.assignee_id = v_uid and private.is_live_assignee(a.id))
      or (a.created_by = v_uid and private.can_review(a.session_id)))
  on conflict (workspace_id, recipient_id, dedupe_key) do nothing;
  get diagnostics v_synced = row_count;
  return jsonb_build_object('today', v_today, 'synced_at', pg_catalog.clock_timestamp(), 'reminders_created', v_synced,
    'timezone', (select timezone from public.workspaces where id = p_ws),
    'unread', (select count(*) from public.notifications n where n.workspace_id = p_ws and n.recipient_id = v_uid
               and n.read_at is null and private.render_notification(n) is not null),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'created_at', x.created_at,
        'read_at', x.read_at, 'stale', x.r is null, 'title', x.r ->> 'title', 'body', x.r ->> 'body',
        'status', x.r ->> 'status', 'link', x.r ->> 'link') order by x.created_at desc, x.id)
      from (select n.*, private.render_notification(n) as r from public.notifications n
            where n.workspace_id = p_ws and n.recipient_id = v_uid order by n.created_at desc, n.id limit 100) x), '[]'::jsonb));
end $$;

-- Recipient-only, within the business named by the caller (the inbox being viewed). Marking a stale
-- entry read is allowed (it reveals nothing).
create function private.mark_notification_read(p_ws uuid, p_notification uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_n public.notifications;
begin
  select * into v_n from public.notifications where id = p_notification and recipient_id = v_uid and workspace_id = p_ws
  for no key update;
  if not found or private.member_role(v_n.workspace_id) is null then perform private.fail('not_found', 'notification'); end if;
  update public.notifications set read_at = coalesce(read_at, pg_catalog.clock_timestamp()) where id = p_notification;
end $$;

create function private.mark_all_notifications_read(p_ws uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_n integer;
begin
  if private.member_role(p_ws) is null then perform private.fail('not_found', 'workspace'); end if;
  update public.notifications set read_at = pg_catalog.clock_timestamp()
  where workspace_id = p_ws and recipient_id = v_uid and read_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Correction requests notify the named assessor.
-- Diff from 20261010231001_m2_session_lifecycle.sql: one private.notify call after the audit row.
-- ---------------------------------------------------------------------------
create or replace function private.request_correction(p_session uuid, p_subject uuid, p_assessor uuid, p_reason text,
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
  perform private.notify(v_s.workspace_id, p_assessor, 'correction_requested', 'correction:' || v_id, null, p_session, v_id,
    '{}'::jsonb);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Public SECURITY INVOKER wrappers
-- ---------------------------------------------------------------------------
create function public.publish_template(p_ws uuid, p_template_id uuid, p_name text, p_pack public.starter_pack,
  p_attendance_mode public.attendance_mode, p_criteria jsonb, p_settings jsonb) returns uuid
language sql security invoker set search_path = '' as
$$ select private.publish_template(p_ws, p_template_id, p_name, p_pack, p_attendance_mode, p_criteria, p_settings) $$;
create function public.create_finding(p_session uuid, p_subject uuid, p_severity text, p_title text, p_note text,
  p_criterion_key text, p_idempotency_key uuid) returns jsonb language sql security invoker set search_path = '' as
$$ select private.create_finding(p_session, p_subject, p_severity, p_title, p_note, p_criterion_key, p_idempotency_key) $$;
create function public.withdraw_finding(p_finding uuid, p_reason text, p_expected_version integer) returns integer
language sql security invoker set search_path = '' as $$ select private.withdraw_finding(p_finding, p_reason, p_expected_version) $$;
create function public.get_findings(p_session uuid) returns jsonb language sql stable security invoker set search_path = '' as
$$ select private.get_findings(p_session) $$;
create function public.create_action(p_finding uuid, p_issue text, p_action_required text, p_severity text, p_assignee uuid,
  p_due_date date, p_idempotency_key uuid) returns jsonb language sql security invoker set search_path = '' as
$$ select private.create_action(p_finding, p_issue, p_action_required, p_severity, p_assignee, p_due_date, p_idempotency_key) $$;
create function public.update_action(p_action uuid, p_expected_version integer, p_issue text, p_action_required text,
  p_severity text, p_assignee uuid, p_due_date date, p_reason text, p_idempotency_key uuid) returns jsonb
language sql security invoker set search_path = '' as
$$ select private.update_action(p_action, p_expected_version, p_issue, p_action_required, p_severity, p_assignee, p_due_date,
  p_reason, p_idempotency_key) $$;
create function public.transition_action(p_action uuid, p_command text, p_expected_version integer, p_evidence text,
  p_reason text, p_idempotency_key uuid) returns jsonb language sql security invoker set search_path = '' as
$$ select private.transition_action(p_action, p_command, p_expected_version, p_evidence, p_reason, p_idempotency_key) $$;
create function public.get_actions(p_ws uuid, p_session uuid) returns jsonb language sql security invoker set search_path = '' as
$$ select private.get_actions(p_ws, p_session) $$;
create function public.get_action(p_action uuid) returns jsonb language sql security invoker set search_path = '' as
$$ select private.get_action(p_action) $$;
create function public.get_action_assignees(p_session uuid) returns jsonb language sql stable security invoker set search_path = '' as
$$ select private.get_action_assignees(p_session) $$;
create function public.get_inbox(p_ws uuid) returns jsonb language sql security invoker set search_path = '' as
$$ select private.get_inbox(p_ws) $$;
create function public.mark_notification_read(p_ws uuid, p_notification uuid) returns void
language sql security invoker set search_path = '' as $$ select private.mark_notification_read(p_ws, p_notification) $$;
create function public.mark_all_notifications_read(p_ws uuid) returns integer language sql security invoker set search_path = '' as
$$ select private.mark_all_notifications_read(p_ws) $$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.findings enable row level security;
alter table public.actions enable row level security;
alter table public.action_events enable row level security;
alter table public.notifications enable row level security;  -- no policy: read only through get_inbox

create policy findings_read on public.findings for select to authenticated
  using (private.can_see_finding(id));
create policy actions_read on public.actions for select to authenticated
  using (private.can_review(session_id) or private.is_live_assignee(id));
create policy action_events_read on public.action_events for select to authenticated
  using (private.can_see_action(action_id));

-- ---------------------------------------------------------------------------
-- Grants (explicit; PostgreSQL's global default would otherwise give PUBLIC execute)
-- ---------------------------------------------------------------------------
revoke all on table public.findings, public.actions, public.action_events, public.notifications
  from public, anon, authenticated;
-- findings.detail is not directly selectable: it can name prior inspections outside the reader's
-- scope, so it is read only through RPCs that scrub it (get_findings, get_action, reports, analytics).
grant select (id, workspace_id, session_id, subject_id, revision, kind, criterion_key, severity, title, created_by,
  created_at, withdrawn_at, withdrawn_by, withdraw_reason, version) on public.findings to authenticated;
grant select on public.actions to authenticated;
grant select (id, workspace_id, action_id, kind, from_status, to_status, before, after, actor_id, reason, override, created_at)
  on public.action_events to authenticated;

revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon;
-- Internal helpers: only called from SECURITY DEFINER functions.
revoke all on function private.validate_template_settings(jsonb), private.criterion_trigger(jsonb),
  private.notification_read_only(), private.workspace_today(uuid), private.due_state(text, date, date),
  private.can_be_assignee(uuid, uuid, uuid), private.finding_state(uuid), private.member_label(uuid, uuid),
  private.action_state(public.actions), private.notify(uuid, uuid, text, text, uuid, uuid, uuid, jsonb),
  private.require_severity(text), private.require_due_date(uuid, date), private.deny_session(uuid),
  private.action_json(public.actions, date), private.render_notification(public.notifications),
  private.scrub_finding_detail(jsonb), private.scrub_inputs(jsonb) from authenticated;
-- RLS policy helpers (evaluated as the caller).
grant execute on function private.is_live_assignee(uuid), private.can_see_action(uuid), private.can_see_finding(uuid)
  to authenticated;
grant execute on function
  private.publish_template(uuid, uuid, text, public.starter_pack, public.attendance_mode, jsonb, jsonb),
  private.create_finding(uuid, uuid, text, text, text, text, uuid),
  private.withdraw_finding(uuid, text, integer),
  private.get_findings(uuid),
  private.create_action(uuid, text, text, text, uuid, date, uuid),
  private.update_action(uuid, integer, text, text, text, uuid, date, text, uuid),
  private.transition_action(uuid, text, integer, text, text, uuid),
  private.get_actions(uuid, uuid), private.get_action(uuid), private.get_action_assignees(uuid),
  private.get_inbox(uuid), private.mark_notification_read(uuid, uuid), private.mark_all_notifications_read(uuid)
to authenticated;
grant execute on function
  public.publish_template(uuid, uuid, text, public.starter_pack, public.attendance_mode, jsonb, jsonb),
  public.create_finding(uuid, uuid, text, text, text, text, uuid),
  public.withdraw_finding(uuid, text, integer),
  public.get_findings(uuid),
  public.create_action(uuid, text, text, text, uuid, date, uuid),
  public.update_action(uuid, integer, text, text, text, uuid, date, text, uuid),
  public.transition_action(uuid, text, integer, text, text, uuid),
  public.get_actions(uuid, uuid), public.get_action(uuid), public.get_action_assignees(uuid),
  public.get_inbox(uuid), public.mark_notification_read(uuid, uuid), public.mark_all_notifications_read(uuid)
to authenticated;
