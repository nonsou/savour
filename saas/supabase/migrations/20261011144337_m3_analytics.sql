-- SAVOUR Milestone 3 (3 of 3): reproducible analytics source.
--
-- public.get_analytics returns the authorized dataset that the shared TypeScript aggregator
-- (src/lib/analytics.ts) turns into the Overview, subject history, location and category
-- comparisons and Needs attention. The page, CSV and PDF all call this RPC with the same filters and
-- the same aggregator, so they cannot disagree.
--
-- * Roles: Owner/Admin/Reviewer/Viewer. Assessor and Guest: forbidden.
-- * approved mode (default): current approved revisions only (sessions.current_report_id),
--   in scope (can_review or viewer_can_see), never samples (SQL, not a filter option).
-- * provisional mode: reviewers only (Viewer forbidden); live inputs of open/in-review sessions the
--   caller reviews, never samples, labelled mode = provisional. Never mixed with approved records
--   (the aggregator refuses a mixed dataset).
-- * Inputs are always redacted (no assessor identities) for every role, and repeat-rule source
--   sessions outside the caller's live scope are withheld (private.scrub_inputs). Live findings and unfinished
--   actions (for Needs attention) are returned only to Owner/Admin/Reviewer for sessions they review,
--   without assignee identities.
-- * Session-level filters (period, location, pack, template version) are applied here; subject-level
--   filters (category, subject, subject type) select subject rows and are applied by the aggregator.
--   Every filter is validated here and recorded in the export audit row.
-- * Location filter uses sessions.location_id (immutable once opened). Pack comes from the template
--   row (never changed by any RPC). Names stay as frozen in each snapshot; current names are returned
--   separately, for annotation only.

create function private.get_analytics(p_ws uuid, p_mode text, p_filters jsonb, p_purpose text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c_limit constant integer := 1000;
  v_role public.member_role;
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  k text;
  v_from date;
  v_to date;
  v_loc uuid;
  v_pack public.starter_pack;
  v_tv uuid;
  v_review boolean;
  v_today date;
  v_auth jsonb;
  v_records jsonb;
  v_total integer;
  v_findings jsonb := '[]';
  v_actions jsonb := '[]';
begin
  perform private.require_uid();
  v_role := private.member_role(p_ws);
  if v_role is null then perform private.fail('not_found', 'workspace'); end if;
  if v_role not in ('owner', 'admin', 'reviewer', 'viewer') then perform private.fail('forbidden'); end if;
  if p_mode is null or p_mode not in ('approved', 'provisional') then perform private.fail('invalid_mode'); end if;
  if p_mode = 'provisional' and v_role = 'viewer' then perform private.fail('forbidden'); end if;
  if p_purpose is null or p_purpose not in ('view', 'csv', 'pdf') then perform private.fail('invalid_purpose'); end if;
  v_review := v_role in ('owner', 'admin', 'reviewer');

  if jsonb_typeof(v_f) <> 'object' then perform private.fail('invalid_filter'); end if;
  for k in select jsonb_object_keys(v_f) loop
    if k not in ('from', 'to', 'location_id', 'pack', 'template_version_id', 'category_id', 'subject_id', 'subject_type') then
      perform private.fail('invalid_filter', k);
    end if;
    if jsonb_typeof(v_f -> k) <> 'string' then perform private.fail('invalid_filter', k); end if;
  end loop;
  begin
    v_from := (v_f ->> 'from')::date;
    v_to := (v_f ->> 'to')::date;
    v_loc := (v_f ->> 'location_id')::uuid;
    v_pack := (v_f ->> 'pack')::public.starter_pack;
    v_tv := (v_f ->> 'template_version_id')::uuid;
    -- Subject-level filters are validated here; 'none' selects legacy rows without a recorded category.
    if v_f ? 'category_id' and v_f ->> 'category_id' not in ('none', 'not_recorded') then perform (v_f ->> 'category_id')::uuid; end if;
    if v_f ? 'subject_id' then perform (v_f ->> 'subject_id')::uuid; end if;
    if v_f ? 'subject_type' and v_f ->> 'subject_type' <> 'not_recorded' then perform (v_f ->> 'subject_type')::public.subject_type; end if;
  exception when others then
    perform private.fail('invalid_filter');
  end;
  if v_from is not null and v_to is not null and v_from > v_to then perform private.fail('invalid_filter', 'from after to'); end if;
  v_today := private.workspace_today(p_ws);

  -- Authorized session set (before filters): drives filter options.
  if p_mode = 'approved' then
    select coalesce(jsonb_agg(jsonb_build_object('session_id', s.id, 'local_date', s.local_date, 'location_id', s.location_id,
        'location_now', l.name, 'template_version_id', s.template_version_id, 'template_name', tv.name, 'template_version', tv.version,
        'pack', t.pack, 'revision', r.revision, 'approved_at', r.approved_at) order by s.local_date, r.approved_at, s.id), '[]'::jsonb)
    into v_auth
    from public.sessions s
    join public.report_revisions r on r.id = s.current_report_id
    join public.template_versions tv on tv.id = s.template_version_id
    join public.templates t on t.id = tv.template_id
    join public.locations l on l.id = s.location_id
    where s.workspace_id = p_ws and s.status = 'approved' and not s.is_sample
      and (private.can_review(s.id) or private.viewer_can_see(s.id));
  else
    select coalesce(jsonb_agg(jsonb_build_object('session_id', s.id, 'local_date', s.local_date, 'location_id', s.location_id,
        'location_now', l.name, 'template_version_id', s.template_version_id, 'template_name', tv.name, 'template_version', tv.version,
        'pack', t.pack, 'revision', s.revision, 'approved_at', null) order by s.local_date, s.created_at, s.id), '[]'::jsonb)
    into v_auth
    from public.sessions s
    join public.template_versions tv on tv.id = s.template_version_id
    join public.templates t on t.id = tv.template_id
    join public.locations l on l.id = s.location_id
    where s.workspace_id = p_ws and s.status in ('open', 'in_review') and not s.is_sample and private.can_review(s.id);
  end if;

  -- Filtered records with redacted inputs (latest c_limit when larger, returned oldest first).
  select count(*) into v_total from jsonb_array_elements(v_auth) a
  where (v_from is null or (a ->> 'local_date')::date >= v_from) and (v_to is null or (a ->> 'local_date')::date <= v_to)
    and (v_loc is null or (a ->> 'location_id')::uuid = v_loc) and (v_pack is null or a ->> 'pack' = v_pack::text)
    and (v_tv is null or (a ->> 'template_version_id')::uuid = v_tv);
  select coalesce(jsonb_agg(x.rec order by x.ord), '[]'::jsonb) into v_records
  from (
    select a || jsonb_build_object('mode', p_mode, 'inputs', private.scrub_inputs(private.redact_inputs(case when p_mode = 'approved'
        then (select r.inputs from public.report_revisions r join public.sessions s on s.current_report_id = r.id
              where s.id = (a ->> 'session_id')::uuid)
        else private.build_inputs((a ->> 'session_id')::uuid) end))) as rec, o.ord
    from jsonb_array_elements(v_auth) with ordinality o (a, ord)
    where (v_from is null or (a ->> 'local_date')::date >= v_from) and (v_to is null or (a ->> 'local_date')::date <= v_to)
      and (v_loc is null or (a ->> 'location_id')::uuid = v_loc) and (v_pack is null or a ->> 'pack' = v_pack::text)
      and (v_tv is null or (a ->> 'template_version_id')::uuid = v_tv)
    order by o.ord desc
    limit c_limit) x;

  -- Live findings and unfinished actions for Needs attention (reviewers only, approved mode only,
  -- same session-level filters, sessions the caller reviews, never samples).
  if v_review and p_mode = 'approved' then
    select coalesce(jsonb_agg(jsonb_build_object('finding_id', f.id, 'session_id', f.session_id, 'session_name', s.name,
        'local_date', s.local_date, 'session_status', s.status, 'session_revision', s.revision,
        'subject_id', f.subject_id, 'subject_name', ss.subject_name, 'kind', f.kind, 'criterion_key', f.criterion_key,
        'severity', f.severity, 'title', f.title, 'revision', f.revision, 'state', private.finding_state(f.id),
        'current', f.kind = 'manual' or (s.status = 'approved' and f.revision = s.revision),
        'rule', f.detail ->> 'rule', 'repeat', private.scrub_finding_detail(f.detail) -> 'repeat', 'created_at', f.created_at)
        order by f.created_at, f.id), '[]'::jsonb)
    into v_findings
    from public.findings f
    join public.sessions s on s.id = f.session_id
    join public.templates t on t.id = (select tv.template_id from public.template_versions tv where tv.id = s.template_version_id)
    join public.session_subjects ss on ss.session_id = f.session_id and ss.subject_id = f.subject_id
    where f.workspace_id = p_ws and f.withdrawn_at is null and not s.is_sample and s.status in ('open', 'in_review', 'approved')
      and private.can_review(s.id) and private.finding_state(f.id) = 'open'
      and (v_from is null or s.local_date >= v_from) and (v_to is null or s.local_date <= v_to)
      and (v_loc is null or s.location_id = v_loc) and (v_pack is null or t.pack = v_pack)
      and (v_tv is null or s.template_version_id = v_tv);

    select coalesce(jsonb_agg(jsonb_build_object('action_id', a.id, 'finding_id', a.finding_id, 'session_id', a.session_id,
        'session_name', s.name, 'local_date', s.local_date, 'subject_id', a.subject_id, 'subject_name', ss.subject_name,
        'issue', a.issue, 'severity', a.severity, 'status', a.status, 'due_date', a.due_date,
        'due_state', private.due_state(a.status, a.due_date, v_today)) order by a.due_date, a.id), '[]'::jsonb)
    into v_actions
    from public.actions a
    join public.sessions s on s.id = a.session_id
    join public.templates t on t.id = (select tv.template_id from public.template_versions tv where tv.id = s.template_version_id)
    join public.session_subjects ss on ss.session_id = a.session_id and ss.subject_id = a.subject_id
    where a.workspace_id = p_ws and a.status in ('open', 'in_progress', 'ready_for_verification')
      and private.can_review(a.session_id)
      and (v_from is null or s.local_date >= v_from) and (v_to is null or s.local_date <= v_to)
      and (v_loc is null or s.location_id = v_loc) and (v_pack is null or t.pack = v_pack)
      and (v_tv is null or s.template_version_id = v_tv);
  end if;

  if p_purpose <> 'view' then
    perform private.audit(p_ws, 'analytics.exported', null, jsonb_build_object('format', p_purpose, 'mode', p_mode,
      'filters', v_f, 'records', jsonb_array_length(v_records), 'truncated', v_total > c_limit));
  end if;

  return jsonb_build_object(
    'mode', p_mode, 'role', v_role, 'filters', v_f, 'today', v_today,
    'timezone', (select timezone from public.workspaces where id = p_ws),
    'workspace_name', (select name from public.workspaces where id = p_ws),
    'generated_at', pg_catalog.clock_timestamp(),
    'total', v_total, 'truncated', v_total > c_limit,
    'live_flags_visible', v_review and p_mode = 'approved',
    'records', v_records,
    'findings', v_findings,
    'actions', v_actions,
    'options', jsonb_build_object(
      'locations', coalesce((select jsonb_agg(distinct jsonb_build_object('id', a ->> 'location_id', 'name', a ->> 'location_now'))
                             from jsonb_array_elements(v_auth) a), '[]'::jsonb),
      'template_versions', coalesce((select jsonb_agg(distinct jsonb_build_object('id', a ->> 'template_version_id',
                               'name', a ->> 'template_name', 'version', (a ->> 'template_version')::integer, 'pack', a ->> 'pack'))
                             from jsonb_array_elements(v_auth) a), '[]'::jsonb),
      'packs', coalesce((select jsonb_agg(distinct a ->> 'pack') from jsonb_array_elements(v_auth) a), '[]'::jsonb),
      'first_date', (select min(a ->> 'local_date') from jsonb_array_elements(v_auth) a),
      'last_date', (select max(a ->> 'local_date') from jsonb_array_elements(v_auth) a)),
    -- Current directory names for annotation only ("now called ...", "archived"); grouping always uses
    -- the values frozen in each snapshot.
    'categories_now', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'archived', c.archived_at is not null))
      from public.categories c where c.workspace_id = p_ws and c.id::text in (
        select x ->> 'category_id' from jsonb_array_elements(v_records) r, jsonb_array_elements(r -> 'inputs' -> 'subjects') x)), '[]'::jsonb),
    'subjects_now', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'archived', s.archived_at is not null))
      from public.subjects s where s.workspace_id = p_ws and s.id::text in (
        select x ->> 'subject_id' from jsonb_array_elements(v_records) r, jsonb_array_elements(r -> 'inputs' -> 'subjects') x)), '[]'::jsonb));
end $$;

create function public.get_analytics(p_ws uuid, p_mode text, p_filters jsonb, p_purpose text) returns jsonb
language sql security invoker set search_path = '' as $$ select private.get_analytics(p_ws, p_mode, p_filters, p_purpose) $$;

revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon;
grant execute on function private.get_analytics(uuid, text, jsonb, text) to authenticated;
grant execute on function public.get_analytics(uuid, text, jsonb, text) to authenticated;
