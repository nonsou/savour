-- SAVOUR Milestone 2 (2 of 3): subject directory.
--
-- Adds categories (a pure directory attribute: never linked to templates, criteria or report
-- denominators), subject-location links (advisory, for building rosters; assessment scope stays
-- on the session), optional private contacts, external IDs and an atomic, idempotent CSV import.
--
-- Security
-- * Contacts live in their own table readable by Owner/Admin only. The subjects SELECT policy
--   exposes rows to assigned assessors and guests, so contact data is never put on subjects.
-- * New subject columns (category_id, external_id, version) are not readable by clients at all:
--   table-level SELECT on subjects is replaced by a column grant. Owners/Admins read the full
--   directory through public.get_subject_directory.
-- * Every directory writer (legacy upsert_subject and upsert_location, save_subject, save_category,
--   save_subject_contact, commit_subject_import) takes the same per-workspace transaction lock
--   (private.lock_directory), and edits carry an expected version (null rejected).
-- * The import never trusts a client preview: commit re-plans the rows inside the lock, refuses
--   any row error, refuses a plan that differs from the one previewed (stale_preview), and
--   records the idempotency key and payload hash in the same transaction as the writes.
-- * is_sample is immutable (trigger) and a sample subject can never be imported or updated by CSV.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- Comparison key for names: Unicode NFC, trimmed, internal whitespace collapsed, lower case.
create function private.norm_name(p text) returns text
language sql immutable set search_path = '' as $$
  select pg_catalog.lower(pg_catalog.regexp_replace(
    pg_catalog.btrim(pg_catalog.normalize(coalesce(p, ''), 'NFC')), '\s+', ' ', 'g'))
$$;

-- Stored form of a free-text cell: NFC, trimmed; empty becomes null.
create function private.clean_text(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(pg_catalog.regexp_replace(pg_catalog.normalize(coalesce(p, ''), 'NFC'), '^\s+|\s+$', '', 'g'), '')
$$;

create function private.keep_sample_flag() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.is_sample is distinct from old.is_sample then
    raise exception 'immutable_record' using detail = tg_table_name || '.is_sample';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  name text not null check (length(btrim(name)) between 1 and 80),
  archived_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);
-- One category per name per workspace, archived included (restore instead of re-creating).
create unique index categories_name_uq on public.categories (workspace_id, private.norm_name(name));

alter table public.subjects
  add column category_id uuid,
  add column external_id text check (external_id is null
    or (length(external_id) between 1 and 64 and external_id = btrim(external_id) and external_id !~ '[[:cntrl:]]')),
  add column is_sample boolean not null default false,
  add column version integer not null default 1,
  add foreign key (workspace_id, category_id) references public.categories (workspace_id, id);
-- External IDs are case-insensitive and unique per workspace: the only identity used to update.
create unique index subjects_external_id_uq on public.subjects (workspace_id, lower(external_id))
  where external_id is not null;
create index subjects_name_idx on public.subjects (workspace_id, private.norm_name(name));
create index subjects_category_idx on public.subjects (category_id) where category_id is not null;

create trigger subjects_keep_sample before update on public.subjects
  for each row execute function private.keep_sample_flag();

create table public.subject_locations (
  workspace_id uuid not null,
  subject_id uuid not null,
  location_id uuid not null,
  primary key (subject_id, location_id),
  foreign key (workspace_id, subject_id) references public.subjects (workspace_id, id),
  foreign key (workspace_id, location_id) references public.locations (workspace_id, id)
);
create index subject_locations_location_idx on public.subject_locations (location_id);
create index subject_locations_ws_idx on public.subject_locations (workspace_id);

-- At most one optional contact per subject. Owner/Admin only; never in report inputs.
create table public.subject_contacts (
  workspace_id uuid not null,
  subject_id uuid primary key,
  name text check (name is null or length(name) between 1 and 120),
  phone text check (phone is null or length(phone) between 1 and 40),
  email text check (email is null or (length(email) <= 254 and email = lower(email))),
  version integer not null default 1,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  check (coalesce(name, phone, email) is not null),
  foreign key (workspace_id, subject_id) references public.subjects (workspace_id, id)
);
create index subject_contacts_ws_idx on public.subject_contacts (workspace_id);

-- Committed imports (insert-only). The key makes a confirmed import idempotent.
create table public.subject_imports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  idempotency_key uuid not null,
  payload_hash text not null,
  plan_hash text not null,
  row_count integer not null,
  result jsonb not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create trigger subject_imports_immutable before update or delete on public.subject_imports
  for each row execute function private.forbid_change();

do $$
declare t text;
begin
  foreach t in array array['categories', 'subject_locations', 'subject_contacts'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.keep_workspace_id()',
      t || '_keep_workspace', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Locking
-- ---------------------------------------------------------------------------
-- Owner/Admin check, then the per-workspace directory lock shared by every directory writer.
-- An advisory transaction lock is used (not the workspace row) so foreign-key checks from
-- unrelated writers (sessions, audit) are never blocked by a directory edit. Row locks taken
-- after it are FOR NO KEY UPDATE: keys never change, and that mode does not conflict with the
-- FOR KEY SHARE lock a concurrent foreign-key insert (for example a roster row referencing the
-- subject) takes, so a directory edit can never wait on, or be waited on by, a session writer.
create function private.lock_directory(p_ws uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_uid();
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('savour.directory:' || p_ws::text, 0));
end $$;

-- ---------------------------------------------------------------------------
-- Legacy subject RPC (Milestone 1): same signature and behaviour, now serialized with the
-- other directory writers and bumping the subject version so an import preview goes stale.
-- Diff from 20261010202119_m1_core.sql: lock_directory replaces the bare role check;
-- "version = version + 1" on update.
-- ---------------------------------------------------------------------------
create or replace function private.upsert_subject(p_ws uuid, p_id uuid, p_name text, p_type public.subject_type, p_archived boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.lock_directory(p_ws);
  if p_id is null then
    insert into public.subjects (workspace_id, name, subject_type)
    values (p_ws, btrim(p_name), p_type) returning id into v_id;
  else
    update public.subjects set name = btrim(p_name), subject_type = p_type,
      archived_at = case when p_archived then coalesce(archived_at, now()) end, version = version + 1
    where id = p_id and workspace_id = p_ws returning id into v_id;
    if v_id is null then perform private.fail('not_found', 'subject'); end if;
  end if;
  perform private.audit(p_ws, 'subject.saved', v_id, jsonb_build_object('name', btrim(p_name), 'archived', p_archived));
  return v_id;
end $$;

-- Legacy location RPC (Milestone 1): same signature and behaviour (duplicate names are still
-- permitted; the import reports them as ambiguous). The import resolves live location names and
-- archive state, so location writes take the same directory lock: a rename or archive either
-- completes before an import plans (and is planned against) or waits until the import commits.
-- Diff from 20261010202119_m1_core.sql: lock_directory replaces the bare role check.
create or replace function private.upsert_location(p_ws uuid, p_id uuid, p_name text, p_archived boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.lock_directory(p_ws);
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

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------
create function private.save_category(p_ws uuid, p_id uuid, p_name text, p_archived boolean, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name text := private.clean_text(p_name);
  v_c public.categories;
begin
  perform private.lock_directory(p_ws);
  if v_name is null or length(v_name) > 80 or v_name ~ '[[:cntrl:]]' then perform private.fail('invalid_name'); end if;
  if exists (select 1 from public.categories c where c.workspace_id = p_ws
             and private.norm_name(c.name) = private.norm_name(v_name) and c.id is distinct from p_id) then
    perform private.fail('duplicate_name', v_name);
  end if;
  if p_id is null then
    insert into public.categories (workspace_id, name, archived_at)
    values (p_ws, v_name, case when p_archived then now() end) returning * into v_c;
  else
    select * into v_c from public.categories where id = p_id and workspace_id = p_ws for no key update;
    if not found then perform private.fail('not_found', 'category'); end if;
    if p_expected_version is null or v_c.version <> p_expected_version then perform private.fail('stale_version'); end if;
    update public.categories set name = v_name,
      archived_at = case when p_archived then coalesce(archived_at, now()) end, version = version + 1
    where id = p_id returning * into v_c;
  end if;
  perform private.audit(p_ws, 'category.saved', v_c.id, jsonb_build_object('name', v_name, 'archived', coalesce(p_archived, false)));
  return jsonb_build_object('id', v_c.id, 'version', v_c.version);
end $$;

-- ---------------------------------------------------------------------------
-- Subjects (Milestone 2 editor): category, external ID and location links, optimistic version.
-- ---------------------------------------------------------------------------
create function private.save_subject(p_ws uuid, p_id uuid, p_name text, p_type public.subject_type,
  p_category uuid, p_external_id text, p_location_ids uuid[], p_archived boolean, p_expected_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name text := private.clean_text(p_name);
  v_ext text := private.clean_text(p_external_id);
  v_locs uuid[] := array(select distinct unnest(coalesce(p_location_ids, '{}')));
  v_s public.subjects;
begin
  perform private.lock_directory(p_ws);
  if v_name is null or length(v_name) > 120 or v_name ~ '[[:cntrl:]]' then perform private.fail('invalid_name'); end if;
  if p_type is null then perform private.fail('invalid_type'); end if;
  if v_ext is not null and (length(v_ext) > 64 or v_ext ~ '[[:cntrl:]]') then perform private.fail('invalid_external_id'); end if;
  if p_id is not null then
    select * into v_s from public.subjects where id = p_id and workspace_id = p_ws for no key update;
    if not found then perform private.fail('not_found', 'subject'); end if;
    if p_expected_version is null or v_s.version <> p_expected_version then perform private.fail('stale_version'); end if;
  end if;
  if p_category is not null and not exists (select 1 from public.categories c where c.id = p_category
      and c.workspace_id = p_ws and (c.archived_at is null or c.id is not distinct from v_s.category_id)) then
    perform private.fail('not_found', 'category');
  end if;
  if (select count(*) from public.locations l where l.workspace_id = p_ws and l.id = any (v_locs)
      and (l.archived_at is null or exists (select 1 from public.subject_locations x
                                            where x.subject_id = p_id and x.location_id = l.id)))
     <> cardinality(v_locs) then
    perform private.fail('not_found', 'location');
  end if;
  if v_ext is not null and exists (select 1 from public.subjects x where x.workspace_id = p_ws
      and lower(x.external_id) = lower(v_ext) and x.id is distinct from p_id) then
    perform private.fail('duplicate_external_id', v_ext);
  end if;
  -- Never create a second subject under an existing name (legacy duplicates are left alone).
  if (p_id is null or private.norm_name(v_s.name) <> private.norm_name(v_name))
     and exists (select 1 from public.subjects x where x.workspace_id = p_ws
                 and private.norm_name(x.name) = private.norm_name(v_name) and x.id is distinct from p_id) then
    perform private.fail('duplicate_name', v_name);
  end if;

  if p_id is null then
    insert into public.subjects (workspace_id, name, subject_type, category_id, external_id, archived_at)
    values (p_ws, v_name, p_type, p_category, v_ext, case when p_archived then now() end) returning * into v_s;
  else
    update public.subjects set name = v_name, subject_type = p_type, category_id = p_category, external_id = v_ext,
      archived_at = case when p_archived then coalesce(archived_at, now()) end, version = version + 1
    where id = p_id returning * into v_s;
  end if;
  delete from public.subject_locations where subject_id = v_s.id and location_id <> all (v_locs);
  insert into public.subject_locations (workspace_id, subject_id, location_id)
  select p_ws, v_s.id, unnest(v_locs) on conflict do nothing;
  perform private.audit(p_ws, 'subject.saved', v_s.id, jsonb_build_object('name', v_name, 'archived', coalesce(p_archived, false),
    'category_id', p_category, 'external_id', v_ext, 'locations', to_jsonb(v_locs), 'version', v_s.version));
  return jsonb_build_object('id', v_s.id, 'version', v_s.version);
end $$;

-- All-blank removes the contact. Version 0 means "no contact yet".
create function private.save_subject_contact(p_ws uuid, p_subject uuid, p_name text, p_phone text, p_email text,
  p_expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_name text := private.clean_text(p_name);
  v_phone text := private.clean_text(p_phone);
  v_email text := lower(private.clean_text(p_email));
  v_c public.subject_contacts;
begin
  perform private.lock_directory(p_ws);
  if not exists (select 1 from public.subjects where id = p_subject and workspace_id = p_ws) then
    perform private.fail('not_found', 'subject');
  end if;
  select * into v_c from public.subject_contacts where subject_id = p_subject for no key update;
  if p_expected_version is null or coalesce(v_c.version, 0) <> p_expected_version then perform private.fail('stale_version'); end if;
  if length(v_name) > 120 or length(v_phone) > 40 or v_phone ~ '[[:cntrl:]]' then perform private.fail('invalid_contact'); end if;
  if v_email is not null and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254) then
    perform private.fail('invalid_email');
  end if;
  if coalesce(v_name, v_phone, v_email) is null then
    delete from public.subject_contacts where subject_id = p_subject;
    perform private.audit(p_ws, 'subject.contact_removed', p_subject);
    return 0;
  end if;
  insert into public.subject_contacts (workspace_id, subject_id, name, phone, email, updated_by)
  values (p_ws, p_subject, v_name, v_phone, v_email, (select auth.uid()))
  on conflict (subject_id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email,
    version = public.subject_contacts.version + 1, updated_by = excluded.updated_by, updated_at = now()
  returning * into v_c;
  -- Field names only: contact values are not copied into the audit trail.
  perform private.audit(p_ws, 'subject.contact_saved', p_subject, jsonb_build_object('version', v_c.version,
    'fields', to_jsonb(array_remove(array[case when v_name is not null then 'name' end,
      case when v_phone is not null then 'phone' end, case when v_email is not null then 'email' end], null))));
  return v_c.version;
end $$;

create function private.get_subject_directory(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_uid();
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  return jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'archived_at', c.archived_at,
        'version', c.version) order by private.norm_name(c.name)) from public.categories c where c.workspace_id = p_ws), '[]'),
    'subjects', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'subject_type', s.subject_type,
        'archived_at', s.archived_at, 'is_sample', s.is_sample, 'version', s.version, 'category_id', s.category_id,
        'external_id', s.external_id,
        'location_ids', coalesce((select jsonb_agg(sl.location_id order by sl.location_id) from public.subject_locations sl
                                  where sl.subject_id = s.id), '[]'),
        'contact', (select jsonb_build_object('name', c.name, 'phone', c.phone, 'email', c.email, 'version', c.version)
                    from public.subject_contacts c where c.subject_id = s.id))
      order by private.norm_name(s.name), s.id) from public.subjects s where s.workspace_id = p_ws), '[]'));
end $$;

-- ---------------------------------------------------------------------------
-- CSV import
-- ---------------------------------------------------------------------------
-- p_rows: [{"line": <source line>, "cells": {"name", "type", "external_id", "category", "locations",
-- "contact_name", "contact_phone", "contact_email"}}] as parsed by the server from the uploaded file.
-- Nothing here trusts that parse: shape, sizes and every value are validated again.
-- Returns {"rows": [...], "counts": {...}, "valid": bool, "plan_hash": text}. Row actions:
-- create, update (by external ID only), unchanged, error. A name match without a matching
-- external ID is an error, never a merge. Blank optional cells leave existing values unchanged.
create function private.plan_subject_import(p_ws uuid, p_rows jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c_keys constant text[] := array['name', 'type', 'external_id', 'category', 'locations',
    'contact_name', 'contact_phone', 'contact_email'];
  e jsonb;
  k text;
  r record;
  v_rows jsonb := '[]';
  v_errors text[];
  v_type public.subject_type;
  v_type_text text;
  v_cat public.categories;
  v_loc_ids uuid[];
  v_loc_names text[];
  v_part text;
  v_loc public.locations;
  v_active_matches integer;
  v_all_matches integer;
  v_existing public.subjects;
  v_clash public.subjects;
  v_contact public.subject_contacts;
  v_new_contact jsonb;
  v_changes text[];
  v_action text;
  v_cur_locs uuid[];
  v_counts jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then perform private.fail('invalid_import', 'rows must be a list'); end if;
  if jsonb_array_length(p_rows) = 0 then perform private.fail('import_empty'); end if;
  if jsonb_array_length(p_rows) > 500 then perform private.fail('import_too_large'); end if;
  for e in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'line') <> 'number' or jsonb_typeof(e -> 'cells') <> 'object' then
      perform private.fail('invalid_import', 'each row needs a line number and cells');
    end if;
    for k in select jsonb_object_keys(e -> 'cells') loop
      if not k = any (c_keys) then perform private.fail('invalid_import', 'unknown column ' || k); end if;
      if jsonb_typeof(e -> 'cells' -> k) not in ('string', 'null') or length(e -> 'cells' ->> k) > 1000 then
        perform private.fail('invalid_import', 'invalid cell ' || k);
      end if;
    end loop;
  end loop;
  if (select count(distinct (x ->> 'line')) from jsonb_array_elements(p_rows) x) <> jsonb_array_length(p_rows) then
    perform private.fail('invalid_import', 'duplicate line numbers');
  end if;

  for r in
    with src as (
      select (x ->> 'line')::integer as line,
        private.clean_text(x -> 'cells' ->> 'name') as name,
        private.clean_text(x -> 'cells' ->> 'type') as type_text,
        private.clean_text(x -> 'cells' ->> 'external_id') as ext,
        private.clean_text(x -> 'cells' ->> 'category') as category,
        private.clean_text(x -> 'cells' ->> 'locations') as locations,
        private.clean_text(x -> 'cells' ->> 'contact_name') as contact_name,
        private.clean_text(x -> 'cells' ->> 'contact_phone') as contact_phone,
        lower(private.clean_text(x -> 'cells' ->> 'contact_email')) as contact_email
      from jsonb_array_elements(p_rows) x)
    select s.*,
      -- Every occurrence of a repeated external ID or name is an error (order-independent).
      case when s.ext is null then null else
        (select array_agg(o.line order by o.line) from src o where lower(o.ext) = lower(s.ext)) end as ext_lines,
      case when s.name is null then null else
        (select array_agg(o.line order by o.line) from src o where private.norm_name(o.name) = private.norm_name(s.name)) end as name_lines
    from src s order by s.line
  loop
    v_errors := '{}'; v_changes := '{}'; v_type := null; v_cat := null; v_existing := null; v_contact := null;
    v_loc_ids := null; v_loc_names := null; v_new_contact := null;

    if r.name is null then v_errors := v_errors || 'Name is required.'::text;
    elsif length(r.name) > 120 then v_errors := v_errors || 'Name is longer than 120 characters.'::text;
    elsif r.name ~ '[[:cntrl:]]' then v_errors := v_errors || 'Name cannot contain line breaks or tabs.'::text;
    end if;
    v_type_text := replace(lower(coalesce(r.type_text, '')), ' ', '_');
    if r.type_text is null then
      v_errors := v_errors || 'Type is required.'::text;
    elsif v_type_text not in (select e2::text from unnest(enum_range(null::public.subject_type)) e2) then
      v_errors := v_errors || 'Type must be vendor, outlet, operation, supplier or service_provider.'::text;
    else
      v_type := v_type_text::public.subject_type;
    end if;
    if r.ext is not null and (length(r.ext) > 64 or r.ext ~ '[[:cntrl:]]') then
      v_errors := v_errors || 'External ID must be at most 64 characters.'::text;
    end if;
    if cardinality(r.ext_lines) > 1 then
      v_errors := v_errors || format('External ID "%s" appears on lines %s.', r.ext, array_to_string(r.ext_lines, ', '));
    end if;
    if cardinality(r.name_lines) > 1 then
      v_errors := v_errors || format('Name "%s" appears on lines %s.', r.name, array_to_string(r.name_lines, ', '));
    end if;

    if r.category is not null then
      select * into v_cat from public.categories c where c.workspace_id = p_ws and private.norm_name(c.name) = private.norm_name(r.category);
      if v_cat.id is null then v_errors := v_errors || format('Unknown category "%s".', r.category);
      elsif v_cat.archived_at is not null then v_errors := v_errors || format('Category "%s" is archived.', r.category);
      end if;
    end if;

    if r.locations is not null then
      v_loc_ids := '{}'; v_loc_names := '{}';
      foreach v_part in array string_to_array(r.locations, ';') loop
        v_part := private.clean_text(v_part);
        continue when v_part is null;
        -- Locations may share a name (M1 permits it). Link only when exactly one ACTIVE location
        -- has the name; several active matches are an explicit error, never an arbitrary pick.
        v_loc := null;
        select count(*) filter (where l.archived_at is null), count(*) into v_active_matches, v_all_matches
        from public.locations l where l.workspace_id = p_ws and private.norm_name(l.name) = private.norm_name(v_part);
        if v_active_matches = 1 then
          select * into v_loc from public.locations l where l.workspace_id = p_ws and l.archived_at is null
            and private.norm_name(l.name) = private.norm_name(v_part);
        end if;
        if v_active_matches > 1 then
          v_errors := v_errors || format('Location "%s" matches %s active locations. Rename them so each name is unique, then import again.', v_part, v_active_matches);
        elsif v_all_matches = 0 then v_errors := v_errors || format('Unknown location "%s".', v_part);
        elsif v_active_matches = 0 then v_errors := v_errors || format('Location "%s" is archived.', v_part);
        elsif not v_loc.id = any (v_loc_ids) then v_loc_ids := v_loc_ids || v_loc.id; v_loc_names := v_loc_names || v_loc.name;
        end if;
      end loop;
      select array_agg(x order by x) into v_loc_ids from unnest(v_loc_ids) x;
      v_loc_ids := coalesce(v_loc_ids, '{}');
    end if;

    if length(r.contact_name) > 120 then v_errors := v_errors || 'Contact name is longer than 120 characters.'::text; end if;
    if length(r.contact_phone) > 40 or r.contact_phone ~ '[[:cntrl:]]' then
      v_errors := v_errors || 'Contact phone must be at most 40 characters.'::text;
    end if;
    if r.contact_email is not null and (r.contact_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(r.contact_email) > 254) then
      v_errors := v_errors || 'Contact email is not a valid address.'::text;
    end if;

    if r.ext is not null then
      select * into v_existing from public.subjects s where s.workspace_id = p_ws and lower(s.external_id) = lower(r.ext);
    end if;
    if v_existing.id is not null then
      if v_existing.is_sample then v_errors := v_errors || 'External ID belongs to a sample subject.'::text;
      elsif v_existing.archived_at is not null then
        v_errors := v_errors || format('External ID "%s" belongs to archived subject "%s". Restore it first.', r.ext, v_existing.name);
      end if;
      if r.name is not null then
        select * into v_clash from public.subjects s where s.workspace_id = p_ws and s.id <> v_existing.id
          and private.norm_name(s.name) = private.norm_name(r.name) limit 1;
        if v_clash.id is not null then v_errors := v_errors || format('Another subject is already named "%s".', v_clash.name); end if;
        v_clash := null;
      end if;
      if r.name is not null and r.name <> v_existing.name then v_changes := v_changes || 'name'::text; end if;
      if v_type is not null and v_type <> v_existing.subject_type then v_changes := v_changes || 'type'::text; end if;
      if v_cat.id is not null and v_cat.id is distinct from v_existing.category_id then v_changes := v_changes || 'category'::text; end if;
      if v_loc_ids is not null then
        select coalesce(array_agg(sl.location_id order by sl.location_id), '{}') into v_cur_locs
        from public.subject_locations sl where sl.subject_id = v_existing.id;
        if v_cur_locs <> v_loc_ids then v_changes := v_changes || 'locations'::text; end if;
      end if;
      -- Contact cells merge field by field: a blank cell keeps the stored value, so an email-only
      -- row never wipes an existing name or phone. The preview shows before and after.
      select * into v_contact from public.subject_contacts c where c.subject_id = v_existing.id;
      if coalesce(r.contact_name, r.contact_phone, r.contact_email) is not null then
        v_new_contact := jsonb_build_object('name', coalesce(r.contact_name, v_contact.name),
          'phone', coalesce(r.contact_phone, v_contact.phone), 'email', coalesce(r.contact_email, v_contact.email));
        if v_contact.subject_id is null or (v_new_contact ->> 'name') is distinct from v_contact.name
           or (v_new_contact ->> 'phone') is distinct from v_contact.phone or (v_new_contact ->> 'email') is distinct from v_contact.email then
          v_changes := v_changes || 'contact'::text;
        end if;
      end if;
      v_action := case when cardinality(v_errors) > 0 then 'error' when cardinality(v_changes) = 0 then 'unchanged' else 'update' end;
    else
      if r.name is not null then
        select * into v_clash from public.subjects s where s.workspace_id = p_ws
          and private.norm_name(s.name) = private.norm_name(r.name) order by s.archived_at nulls first limit 1;
        if v_clash.id is not null then
          v_errors := v_errors || case when v_clash.external_id is null
            then format('A subject named "%s" already exists. It is not merged: give it an external ID first, or rename this row.', v_clash.name)
            else format('A subject named "%s" already exists with external ID "%s". Use that ID to update it.', v_clash.name, v_clash.external_id) end;
        end if;
        v_clash := null;
      end if;
      if coalesce(r.contact_name, r.contact_phone, r.contact_email) is not null then
        v_new_contact := jsonb_build_object('name', r.contact_name, 'phone', r.contact_phone, 'email', r.contact_email);
      end if;
      v_action := case when cardinality(v_errors) > 0 then 'error' else 'create' end;
    end if;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'line', r.line, 'action', v_action, 'errors', to_jsonb(v_errors),
      'subject_id', v_existing.id, 'expected_version', v_existing.version,
      'contact_version', case when v_existing.id is not null then coalesce(v_contact.version, 0) end,
      'name', r.name, 'type', v_type, 'external_id', r.ext,
      'category_id', v_cat.id, 'category', v_cat.name,
      'location_ids', to_jsonb(v_loc_ids), 'locations', to_jsonb(v_loc_names),
      'contact', v_new_contact, 'changes', to_jsonb(v_changes),
      'before', case when v_action = 'update' then jsonb_build_object('name', v_existing.name, 'type', v_existing.subject_type,
        'category', (select c.name from public.categories c where c.id = v_existing.category_id),
        'locations', (select coalesce(jsonb_agg(l.name order by l.name), '[]') from public.subject_locations sl
                      join public.locations l on l.id = sl.location_id where sl.subject_id = v_existing.id),
        'contact', case when v_contact.subject_id is not null then jsonb_build_object('name', v_contact.name,
          'phone', v_contact.phone, 'email', v_contact.email) end) end));
  end loop;

  select jsonb_build_object(
    'create', count(*) filter (where x ->> 'action' = 'create'),
    'update', count(*) filter (where x ->> 'action' = 'update'),
    'unchanged', count(*) filter (where x ->> 'action' = 'unchanged'),
    'error', count(*) filter (where x ->> 'action' = 'error'))
  into v_counts from jsonb_array_elements(v_rows) x;
  return jsonb_build_object('rows', v_rows, 'counts', v_counts, 'valid', (v_counts ->> 'error')::integer = 0,
    'plan_hash', private.sha256_hex(v_rows::text));
end $$;

-- Read-only preview. Writes nothing.
create function private.preview_subject_import(p_ws uuid, p_rows jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_uid();
  if not private.has_role(p_ws, '{owner,admin}') then perform private.fail('forbidden'); end if;
  return private.plan_subject_import(p_ws, p_rows);
end $$;

-- Explicit confirmation. All rows or nothing.
create function private.commit_subject_import(p_ws uuid, p_idempotency_key uuid, p_rows jsonb, p_expected_plan_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := private.require_uid();
  v_payload_hash text := private.sha256_hex(coalesce(p_rows, 'null'::jsonb)::text);
  v_prior public.subject_imports;
  v_plan jsonb;
  r jsonb;
  v_id uuid;
  v_import_id uuid;
  v_created uuid[] := '{}';
  v_updated uuid[] := '{}';
  v_result jsonb;
  v_n integer;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  perform private.lock_directory(p_ws);

  select * into v_prior from public.subject_imports where workspace_id = p_ws and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.payload_hash <> v_payload_hash then perform private.fail('idempotency_conflict'); end if;
    return v_prior.result || jsonb_build_object('replayed', true);
  end if;

  v_plan := private.plan_subject_import(p_ws, p_rows);
  if not (v_plan ->> 'valid')::boolean then
    perform private.fail('import_invalid', (v_plan -> 'counts' ->> 'error') || ' row(s) have errors');
  end if;
  if p_expected_plan_hash is null or p_expected_plan_hash <> v_plan ->> 'plan_hash' then
    perform private.fail('stale_preview');
  end if;

  for r in select * from jsonb_array_elements(v_plan -> 'rows') loop
    continue when r ->> 'action' = 'unchanged';
    if r ->> 'action' = 'create' then
      insert into public.subjects (workspace_id, name, subject_type, category_id, external_id)
      values (p_ws, r ->> 'name', (r ->> 'type')::public.subject_type, (r ->> 'category_id')::uuid, r ->> 'external_id')
      returning id into v_id;
      v_created := v_created || v_id;
    else
      v_id := (r ->> 'subject_id')::uuid;
      update public.subjects set
        name = coalesce(r ->> 'name', name),
        subject_type = coalesce((r ->> 'type')::public.subject_type, subject_type),
        category_id = coalesce((r ->> 'category_id')::uuid, category_id),
        version = version + 1
      where id = v_id and workspace_id = p_ws and version = (r ->> 'expected_version')::integer
        and archived_at is null and not is_sample;
      get diagnostics v_n = row_count;
      if v_n <> 1 then perform private.fail('stale_preview'); end if;
      v_updated := v_updated || v_id;
    end if;
    if jsonb_typeof(r -> 'location_ids') = 'array' then
      delete from public.subject_locations where subject_id = v_id
        and location_id not in (select (x #>> '{}')::uuid from jsonb_array_elements(r -> 'location_ids') x);
      insert into public.subject_locations (workspace_id, subject_id, location_id)
      select p_ws, v_id, (x #>> '{}')::uuid from jsonb_array_elements(r -> 'location_ids') x on conflict do nothing;
    end if;
    if jsonb_typeof(r -> 'contact') = 'object' then
      insert into public.subject_contacts (workspace_id, subject_id, name, phone, email, updated_by)
      values (p_ws, v_id, r -> 'contact' ->> 'name', r -> 'contact' ->> 'phone', r -> 'contact' ->> 'email', v_uid)
      on conflict (subject_id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email,
        version = public.subject_contacts.version + 1, updated_by = excluded.updated_by, updated_at = now();
    end if;
  end loop;

  -- The stored receipt is complete (including its own ID), so a replay returns exactly the
  -- original receipt apart from "replayed".
  v_import_id := gen_random_uuid();
  v_result := jsonb_build_object('import_id', v_import_id, 'created', cardinality(v_created), 'updated', cardinality(v_updated),
    'unchanged', (v_plan -> 'counts' ->> 'unchanged')::integer, 'rows', jsonb_array_length(v_plan -> 'rows'),
    'created_ids', to_jsonb(v_created), 'updated_ids', to_jsonb(v_updated));
  insert into public.subject_imports (id, workspace_id, idempotency_key, payload_hash, plan_hash, row_count, result, created_by)
  values (v_import_id, p_ws, p_idempotency_key, v_payload_hash, v_plan ->> 'plan_hash', jsonb_array_length(v_plan -> 'rows'), v_result, v_uid);
  perform private.audit(p_ws, 'subjects.imported', v_import_id, jsonb_build_object('created', cardinality(v_created),
    'updated', cardinality(v_updated), 'unchanged', v_result -> 'unchanged', 'plan_hash', v_plan ->> 'plan_hash'));
  return v_result || jsonb_build_object('replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- Public SECURITY INVOKER wrappers
-- ---------------------------------------------------------------------------
create function public.save_category(p_ws uuid, p_id uuid, p_name text, p_archived boolean, p_expected_version integer)
returns jsonb language sql security invoker set search_path = '' as
$$ select private.save_category(p_ws, p_id, p_name, p_archived, p_expected_version) $$;
create function public.save_subject(p_ws uuid, p_id uuid, p_name text, p_type public.subject_type, p_category uuid,
  p_external_id text, p_location_ids uuid[], p_archived boolean, p_expected_version integer)
returns jsonb language sql security invoker set search_path = '' as
$$ select private.save_subject(p_ws, p_id, p_name, p_type, p_category, p_external_id, p_location_ids, p_archived, p_expected_version) $$;
create function public.save_subject_contact(p_ws uuid, p_subject uuid, p_name text, p_phone text, p_email text,
  p_expected_version integer) returns integer language sql security invoker set search_path = '' as
$$ select private.save_subject_contact(p_ws, p_subject, p_name, p_phone, p_email, p_expected_version) $$;
create function public.get_subject_directory(p_ws uuid) returns jsonb language sql stable security invoker set search_path = '' as
$$ select private.get_subject_directory(p_ws) $$;
create function public.preview_subject_import(p_ws uuid, p_rows jsonb) returns jsonb
language sql stable security invoker set search_path = '' as $$ select private.preview_subject_import(p_ws, p_rows) $$;
create function public.commit_subject_import(p_ws uuid, p_idempotency_key uuid, p_rows jsonb, p_expected_plan_hash text)
returns jsonb language sql security invoker set search_path = '' as
$$ select private.commit_subject_import(p_ws, p_idempotency_key, p_rows, p_expected_plan_hash) $$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
alter table public.categories enable row level security;
alter table public.subject_locations enable row level security;
alter table public.subject_contacts enable row level security;
alter table public.subject_imports enable row level security;

create policy categories_read on public.categories for select to authenticated
  using (private.has_role(workspace_id, '{owner,admin}'));
create policy subject_locations_read on public.subject_locations for select to authenticated
  using (private.has_role(workspace_id, '{owner,admin}'));
create policy subject_contacts_read on public.subject_contacts for select to authenticated
  using (private.has_role(workspace_id, '{owner,admin}'));
create policy subject_imports_read on public.subject_imports for select to authenticated
  using (private.has_role(workspace_id, '{owner,admin}'));

-- ---------------------------------------------------------------------------
-- Grants (explicit). PostgreSQL's global default gives PUBLIC execute on every new function and
-- per-schema default revokes cannot remove that, so new objects are revoked explicitly here.
-- ---------------------------------------------------------------------------
revoke all on table public.categories, public.subject_locations, public.subject_contacts, public.subject_imports
  from public, anon, authenticated;
grant select on public.categories, public.subject_locations, public.subject_contacts, public.subject_imports to authenticated;
-- Subjects: the M1 table-level SELECT also covered the new columns; restrict to the M1 columns
-- plus the sample label. category_id, external_id and version come only from get_subject_directory.
revoke select on public.subjects from authenticated;
grant select (id, workspace_id, name, subject_type, archived_at, created_at, is_sample) on public.subjects to authenticated;

revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon;
-- Internal helpers: only called from SECURITY DEFINER functions (which run as the owner).
revoke all on function private.norm_name(text), private.clean_text(text), private.keep_sample_flag(),
  private.lock_directory(uuid), private.plan_subject_import(uuid, jsonb) from authenticated;
grant execute on function
  private.save_category(uuid, uuid, text, boolean, integer),
  private.save_subject(uuid, uuid, text, public.subject_type, uuid, text, uuid[], boolean, integer),
  private.save_subject_contact(uuid, uuid, text, text, text, integer),
  private.get_subject_directory(uuid),
  private.preview_subject_import(uuid, jsonb),
  private.commit_subject_import(uuid, uuid, jsonb, text)
to authenticated;
grant execute on function
  public.save_category(uuid, uuid, text, boolean, integer),
  public.save_subject(uuid, uuid, text, public.subject_type, uuid, text, uuid[], boolean, integer),
  public.save_subject_contact(uuid, uuid, text, text, text, integer),
  public.get_subject_directory(uuid),
  public.preview_subject_import(uuid, jsonb),
  public.commit_subject_import(uuid, uuid, jsonb, text)
to authenticated;
