-- SAVOUR Milestone 3 (2 of 3): frozen action snapshots, generated findings at approval and the
-- separately dated current-actions appendix.
--
-- * build_inputs stamps 'savour-m3.1'. The arithmetic is identical to m1.1/m2.1; the label only
--   records the disclosures added at approval:
--     session.location_id, template.pack, template.settings,
--     per subject category_id / category_name / subject_type (directory values AT APPROVAL; null
--       category_id means uncategorised at approval -- legacy snapshots lack the keys entirely,
--       which analytics shows as "Not recorded at approval", never backfilled from today's directory),
--     findings[] (current evidence at approval) and actions[] (action state at approval).
--   Existing m1.1/m2.1 snapshots are never rewritten.
-- * redact_inputs: unchanged for inputs without an "actions" key (every m1.1/m2.1 snapshot redacts
--   byte-identically); with actions, assignee identities become "Assignee N".
-- * approve_session takes clock_timestamp() after the session lock and uses it for approved_at and
--   for generated findings, generates findings from the frozen evidence and the template version's
--   own trigger settings (never from averages), freezes findings and actions in the snapshot and
--   notifies reviewers. The session lock is the inclusion boundary: an action is in actions[] iff it
--   was committed before approval acquired the lock.
-- * get_session_report adds meta.actions_snapshot (frozen | not_recorded | provisional) and an
--   actions_appendix dated with the server clock, comparing live actions to the frozen IDs/versions
--   of the viewed revision. The appendix is never part of the frozen evidence.

-- ---------------------------------------------------------------------------
-- Report inputs (formula savour-m3.1)
-- ---------------------------------------------------------------------------
-- Diff from 20261010231001: formula 'savour-m3.1'; session.location_id; template.pack and
-- template.settings; per subject category_id, category_name, subject_type; top-level findings[] and
-- actions[]. Arithmetic inputs (criteria, outcomes, assignments, assessments, waivers) unchanged.
create or replace function private.build_inputs(p_session uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'formula_version', 'savour-m3.1',
    'workspace', jsonb_build_object('name', w.name, 'timezone', w.timezone),
    'session', jsonb_build_object('id', s.id, 'name', s.name, 'local_date', s.local_date,
      'location', l.name, 'location_id', s.location_id, 'revision', s.revision, 'opens_at', s.opens_at,
      'closes_at', s.closes_at, 'expected_ready_time', s.expected_ready_time, 'is_sample', s.is_sample),
    'template', jsonb_build_object('id', tv.template_id, 'version_id', tv.id, 'name', tv.name,
      'version', tv.version, 'attendance_mode', tv.attendance_mode, 'criteria', tv.criteria,
      'pack', t.pack, 'settings', tv.settings),
    'subjects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'subject_id', ss.subject_id, 'name', ss.subject_name,
        'category_id', x.category_id, 'category_name', c.name, 'subject_type', x.subject_type,
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
      from public.session_subjects ss
      join public.subjects x on x.id = ss.subject_id
      left join public.categories c on c.id = x.category_id
      where ss.session_id = s.id and ss.removed_at is null), '[]'),
    'removed_subjects', coalesce((
      select jsonb_agg(jsonb_build_object('subject_id', ss.subject_id, 'name', ss.subject_name,
        'removed_at', ss.removed_at, 'reason', ss.removal_reason,
        'retained_responses', (select count(*) from public.assessments a where a.session_id = s.id
                               and a.subject_id = ss.subject_id and a.state = 'submitted'))
        order by ss.subject_name, ss.subject_id)
      from public.session_subjects ss where ss.session_id = s.id and ss.removed_at is not null), '[]'),
    -- Current findings: active manual findings, this revision's generated findings, and any finding an
    -- action of this session refers to (so every frozen action's finding is in the same snapshot).
    'findings', coalesce((
      select jsonb_agg(jsonb_build_object('finding_id', f.id, 'subject_id', f.subject_id, 'kind', f.kind,
        'criterion_key', f.criterion_key, 'severity', f.severity, 'title', f.title, 'detail', f.detail,
        'revision', f.revision, 'withdrawn', f.withdrawn_at is not null, 'created_at', f.created_at)
        order by f.created_at, f.id)
      from public.findings f
      where f.session_id = s.id and ((f.withdrawn_at is null and (f.kind = 'manual' or f.revision = s.revision))
        or exists (select 1 from public.actions a where a.finding_id = f.id))), '[]'),
    'actions', coalesce((
      select jsonb_agg(jsonb_build_object('action_id', a.id, 'finding_id', a.finding_id, 'subject_id', a.subject_id,
        'severity', a.severity, 'status', a.status, 'issue', a.issue, 'action_required', a.action_required,
        'due_date', a.due_date, 'assignee_id', a.assignee_id, 'assignee_label', coalesce(m.display_name, 'Former member'),
        'resolution_evidence', a.resolution_evidence, 'resolved_at', a.resolved_at, 'verified_at', a.verified_at,
        'cancel_reason', a.cancel_reason, 'reopen_count', a.reopen_count, 'created_at', a.created_at,
        'updated_at', a.updated_at, 'version', a.version)
        order by a.created_at, a.id)
      from public.actions a
      left join public.memberships m on m.workspace_id = a.workspace_id and m.user_id = a.assignee_id
      where a.session_id = s.id), '[]'))
  from public.sessions s
  join public.workspaces w on w.id = s.workspace_id
  join public.locations l on l.id = s.location_id
  join public.template_versions tv on tv.id = s.template_version_id
  join public.templates t on t.id = tv.template_id
  where s.id = p_session
$$;

-- Diff from 20261010231001: a final branch, only when the input has an "actions" key, replaces
-- assignee identities with "Assignee N" (numbered by assignee ID within the report). Inputs without
-- "actions" (all m1.1 and m2.1 snapshots) produce exactly the previous output.
create or replace function private.redact_inputs(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  with ids as (
    select a ->> 'assessor_id' as id
    from jsonb_array_elements(p -> 'subjects') s, jsonb_array_elements(s -> 'assessments') a
    union
    select w ->> 'assessor_id'
    from jsonb_array_elements(p -> 'subjects') s, jsonb_array_elements(coalesce(s -> 'waivers', '[]')) w),
  m as (select id, row_number() over (order by id) as n from ids),
  aids as (select distinct a ->> 'assignee_id' as id from jsonb_array_elements(coalesce(p -> 'actions', '[]')) a),
  am as (select id, row_number() over (order by id) as n from aids)
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
  || case when p ? 'actions' then jsonb_build_object('actions', coalesce((
      select jsonb_agg((a - 'assignee_id' - 'assignee_label') || jsonb_build_object('assignee_label', 'Assignee ' || am.n)
        order by ord)
      from jsonb_array_elements(p -> 'actions') with ordinality x (a, ord) left join am on am.id = a ->> 'assignee_id'), '[]'))
    else '{}'::jsonb end
$$;

-- ---------------------------------------------------------------------------
-- Generated findings (called only from approve_session, under the session lock)
-- ---------------------------------------------------------------------------
-- For each criterion with an effective trigger in the session's frozen template version, and each
-- active, assessed roster subject: one generated finding when any complete submitted score from an
-- assigned assessor is at or below the trigger. Severity critical for a critical criterion, else
-- high. Append-only per revision; a repeated call for the same revision inserts nothing. Repeat tag:
-- same subject and criterion generated a finding in one of the previous repeat_window approved,
-- non-sample sessions of the SAME template version (compatible evidence); fewer compatible prior
-- sessions than the window and no repeat is "insufficient".
create function private.generate_findings(p_session uuid, p_actor uuid, p_now timestamptz) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions;
  v_tv public.template_versions;
  v_window integer;
  c jsonb;
  v_key text;
  v_trig integer;
  v_critical boolean;
  r record;
  v_prior_sessions jsonb;
  v_with_finding jsonb;
  v_repeat text;
  v_prev uuid;
  v_n integer := 0;
  v_added integer;
begin
  select * into v_s from public.sessions where id = p_session;
  if v_s.is_sample then return 0; end if;
  select * into v_tv from public.template_versions where id = v_s.template_version_id;
  v_window := coalesce((v_tv.settings ->> 'repeat_window')::integer, 3);
  for c in select * from jsonb_array_elements(v_tv.criteria) loop
    v_trig := private.criterion_trigger(c);
    continue when v_trig is null;
    v_key := c ->> 'key';
    v_critical := coalesce((c ->> 'critical')::boolean, false);
    for r in
      select q.subject_id, min(q.score) as min_score, count(*) filter (where q.score <= v_trig) as below,
        count(q.score) as scored
      from (
        select ss.subject_id,
          case when jsonb_typeof(a.answers -> v_key) = 'number' then (a.answers ->> v_key)::numeric::integer end as score
        from public.session_subjects ss
        join public.session_assignments sa on sa.session_id = ss.session_id and sa.subject_id = ss.subject_id
        join public.assessments a on a.session_id = sa.session_id and a.subject_id = sa.subject_id and a.assessor_id = sa.user_id
        where ss.session_id = p_session and ss.removed_at is null and ss.outcome not in ('absent', 'not_assessed', 'unknown')
          and a.state = 'submitted' and a.answers is not null) q
      group by q.subject_id
      having count(*) filter (where q.score <= v_trig) > 0
      order by q.subject_id
    loop
      select coalesce(jsonb_agg(p.session_id order by p.local_date desc, p.approved_at desc), '[]'::jsonb),
        coalesce(jsonb_agg(p.session_id order by p.local_date desc, p.approved_at desc) filter (where p.had_finding), '[]'::jsonb)
      into v_prior_sessions, v_with_finding
      from (
        select s2.id as session_id, s2.local_date, r2.approved_at,
          exists (select 1 from public.findings f2 where f2.session_id = s2.id and f2.subject_id = r.subject_id
                  and f2.kind = 'generated' and f2.criterion_key = v_key and f2.revision = r2.revision) as had_finding
        from public.sessions s2
        join public.report_revisions r2 on r2.id = s2.current_report_id
        where s2.workspace_id = v_s.workspace_id and s2.template_version_id = v_s.template_version_id
          and s2.id <> p_session and s2.status = 'approved' and not s2.is_sample
          and (s2.local_date < v_s.local_date or (s2.local_date = v_s.local_date and r2.approved_at < p_now))
          and exists (select 1 from jsonb_array_elements(r2.inputs -> 'subjects') x where x ->> 'subject_id' = r.subject_id::text)
        order by s2.local_date desc, r2.approved_at desc
        limit v_window) p;
      v_repeat := case when jsonb_array_length(v_with_finding) > 0 then 'repeat'
        when jsonb_array_length(v_prior_sessions) < v_window then 'insufficient_data' else 'not_repeat' end;
      select f.id into v_prev from public.findings f where f.session_id = p_session and f.subject_id = r.subject_id
        and f.kind = 'generated' and f.criterion_key = v_key and f.revision < v_s.revision order by f.revision desc limit 1;
      insert into public.findings (workspace_id, session_id, subject_id, revision, kind, criterion_key, severity, title,
        detail, created_by, created_at)
      values (v_s.workspace_id, p_session, r.subject_id, v_s.revision, 'generated', v_key,
        case when v_critical then 'critical' else 'high' end,
        left(format('%s scored %s (at or below %s)', c ->> 'label', r.min_score, v_trig), 200),
        jsonb_build_object(
          'rule', format('A finding is raised when any submitted score for "%s" is at or below %s (setting of template "%s" v%s%s). '
            || 'It is independent of averages and is not a certification or penalty.',
            c ->> 'label', v_trig, v_tv.name, v_tv.version,
            case when v_critical and not (c ? 'trigger_at_or_below') then '; critical criterion default' else '' end),
          'criterion_label', c ->> 'label', 'critical', v_critical, 'trigger_at_or_below', v_trig,
          'min_score', r.min_score, 'assessors_below', r.below, 'assessors_scored', r.scored,
          'template_version_id', v_tv.id, 'template_version', v_tv.version,
          'repeat', jsonb_build_object('status', v_repeat, 'window', v_window,
            'prior_sessions_checked', jsonb_array_length(v_prior_sessions), 'prior_sessions', v_prior_sessions,
            'sessions_with_finding', v_with_finding,
            'rule', format('Repeat when the same subject had a generated "%s" finding in any of the previous %s approved sessions '
              || 'using this same template version; fewer than %s such sessions without a repeat is insufficient data.',
              c ->> 'label', v_window, v_window)),
          'previous_revision_finding_id', v_prev),
        p_actor, p_now)
      on conflict (session_id, subject_id, criterion_key, revision) where kind = 'generated' do nothing;
      get diagnostics v_added = row_count;
      v_n := v_n + v_added;
      v_prev := null;
    end loop;
  end loop;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Approval
-- ---------------------------------------------------------------------------
-- Diff from 20261010231001: after the unchanged validation, v_now := clock_timestamp() (taken after
-- the session lock), generated findings from the frozen evidence, snapshot approved_at = v_now,
-- session_approved notifications to session reviewers and the session creator (not the approver),
-- findings_generated in the audit row.
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
  v_now timestamptz;
  v_generated integer;
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

  v_now := pg_catalog.clock_timestamp();
  v_generated := private.generate_findings(p_session, v_uid, v_now);
  v_inputs := private.build_inputs(p_session);
  select display_name into v_name from public.memberships
  where workspace_id = v_s.workspace_id and user_id = v_uid;
  insert into public.report_revisions (workspace_id, session_id, revision, inputs, inputs_hash,
    formula_version, approved_by, approver_name, approved_at)
  values (v_s.workspace_id, p_session, v_s.revision, v_inputs, private.sha256_hex(v_inputs::text),
    v_inputs ->> 'formula_version', v_uid, v_name, v_now)
  returning id into v_id;
  update public.sessions set status = 'approved', current_report_id = v_id, data_version = data_version + 1
  where id = p_session;
  for r in select sr.user_id from public.session_reviewers sr where sr.session_id = p_session union select v_s.created_by loop
    perform private.notify(v_s.workspace_id, r.user_id, 'session_approved', 'approved:' || v_id, null, p_session, null,
      jsonb_build_object('revision', v_s.revision));
  end loop;
  perform private.audit(v_s.workspace_id, 'session.approved', p_session,
    jsonb_build_object('revision', v_s.revision, 'report_id', v_id, 'waived', (
      select count(*) from public.session_assignments where session_id = p_session and waived_at is not null),
      'findings_generated', v_generated, 'actions_frozen', jsonb_array_length(v_inputs -> 'actions')));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Report read with the dated current-actions appendix
-- ---------------------------------------------------------------------------
-- Appendix entry for one live action, compared with the frozen actions[] of the viewed revision.
create function private.appendix_action(a public.actions, p_frozen jsonb, p_approved_at timestamptz, p_today date,
  p_redact boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('action_id', a.id, 'finding_id', a.finding_id, 'subject_id', a.subject_id,
    'subject_name', (select ss.subject_name from public.session_subjects ss where ss.session_id = a.session_id
                     and ss.subject_id = a.subject_id),
    'severity', a.severity, 'status', a.status, 'issue', a.issue, 'action_required', a.action_required,
    'due_date', a.due_date, 'due_state', private.due_state(a.status, a.due_date, p_today),
    'assignee_label', case when p_redact then 'Assigned staff member'
                           else private.member_label(a.workspace_id, a.assignee_id) end,
    'resolution_evidence', a.resolution_evidence, 'resolved_at', a.resolved_at, 'verified_at', a.verified_at,
    'cancel_reason', a.cancel_reason, 'reopen_count', a.reopen_count, 'created_at', a.created_at,
    'updated_at', a.updated_at, 'version', a.version,
    'in_snapshot', case when p_frozen is null then null else f.x is not null end,
    'snapshot_status', f.x ->> 'status',
    'changed_since_snapshot', case when p_frozen is null or f.x is null then null
                                   else (f.x ->> 'version')::integer <> a.version end,
    'created_after_snapshot', case when p_approved_at is null then null
                                   else f.x is null and a.created_at > p_approved_at end)
  from (select (select e from jsonb_array_elements(coalesce(p_frozen, '[]'::jsonb)) e
                where e ->> 'action_id' = a.id::text) as x) f
$$;

-- Diff from m1_core: meta.actions_snapshot and meta.workspace_id (route business check); actions_appendix (server-dated live actions and
-- findings of this session, redacted under the same flag as the body); repeat-rule source IDs
-- outside the caller's live scope withheld (private.scrub_inputs). Authorization, revision
-- selection, redaction of the body and export audit are unchanged.
create or replace function private.get_session_report(p_session uuid, p_revision integer, p_redact boolean, p_purpose text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_s public.sessions;
  v_reviewer boolean;
  v_redact boolean := coalesce(p_redact, false);
  v_rr public.report_revisions;
  v_inputs jsonb;
  v_meta jsonb;
  v_snapshot text;
  v_frozen jsonb;
  v_today date;
  v_appendix jsonb;
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
    v_snapshot := case when v_rr.inputs ? 'actions' then 'frozen' else 'not_recorded' end;
    v_frozen := case when v_snapshot = 'frozen' then v_rr.inputs -> 'actions' end;
  else
    v_inputs := private.build_inputs(p_session);
    v_meta := jsonb_build_object('status', 'provisional', 'revision', v_s.revision,
      'formula_version', v_inputs ->> 'formula_version', 'is_current', true);
    v_snapshot := 'provisional';
  end if;
  if v_redact then v_inputs := private.redact_inputs(v_inputs); end if;
  -- Repeat-rule sources outside the caller's live scope are withheld from the envelope (stored
  -- snapshots are unchanged; inputs without findings are returned as they are).
  v_inputs := private.scrub_inputs(v_inputs);

  v_today := private.workspace_today(v_s.workspace_id);
  v_appendix := jsonb_build_object('as_of', pg_catalog.clock_timestamp(), 'today', v_today,
    'snapshot', v_snapshot, 'snapshot_approved_at', v_rr.approved_at, 'snapshot_revision', v_rr.revision,
    'redacted', v_redact,
    'actions', coalesce((select jsonb_agg(private.appendix_action(a, v_frozen, v_rr.approved_at, v_today, v_redact)
        order by a.created_at, a.id) from public.actions a where a.session_id = p_session), '[]'::jsonb),
    'findings', coalesce((select jsonb_agg(jsonb_build_object('finding_id', f.id, 'subject_id', f.subject_id,
        'subject_name', ss.subject_name, 'kind', f.kind, 'severity', f.severity, 'title', f.title, 'revision', f.revision,
        'state', private.finding_state(f.id), 'withdrawn_at', f.withdrawn_at, 'created_at', f.created_at,
        'in_snapshot', case when v_snapshot = 'frozen' then exists (select 1 from jsonb_array_elements(v_rr.inputs -> 'findings') e
                                                                    where e ->> 'finding_id' = f.id::text) end)
        order by f.created_at, f.id)
      from public.findings f
      join public.session_subjects ss on ss.session_id = f.session_id and ss.subject_id = f.subject_id
      where f.session_id = p_session), '[]'::jsonb));

  if p_purpose <> 'view' then
    perform private.audit(v_s.workspace_id, 'report.exported', p_session, jsonb_build_object(
      'format', p_purpose, 'revision', v_meta -> 'revision', 'status', v_meta -> 'status', 'redacted', v_redact,
      'actions_snapshot', v_snapshot, 'appendix_actions', jsonb_array_length(v_appendix -> 'actions')));
  end if;

  return jsonb_build_object('meta', v_meta || jsonb_build_object('redacted', v_redact,
      'session_status', v_s.status, 'session_revision', v_s.revision, 'reopen_reason', v_s.last_reopen_reason,
      'actions_snapshot', v_snapshot, 'workspace_id', v_s.workspace_id),
    'inputs', v_inputs,
    'actions_appendix', v_appendix,
    'revisions', coalesce((select jsonb_agg(jsonb_build_object('revision', r.revision,
      'approved_at', r.approved_at, 'approver_name', r.approver_name) order by r.revision)
      from public.report_revisions r where r.session_id = p_session), '[]'));
end $$;

-- ---------------------------------------------------------------------------
-- Dashboard: approved snapshot bodies may now carry generated-finding repeat sources.
-- Diff from 20261010231001: inputs pass through private.scrub_inputs after redaction (identity
-- for m1.1/m2.1 bodies, which have no findings).
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
        'approved_at', r.approved_at, 'inputs', private.scrub_inputs(private.redact_inputs(r.inputs)))
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
-- Grants
-- ---------------------------------------------------------------------------
revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon;
revoke all on function private.generate_findings(uuid, uuid, timestamptz),
  private.appendix_action(public.actions, jsonb, timestamptz, date, boolean) from authenticated;
