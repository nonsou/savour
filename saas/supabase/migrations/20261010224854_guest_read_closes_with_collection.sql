-- Guest read access ends when collection ends.
--
-- Defect: a guest's read scope (private.is_assigned / private.assigned_subject) only checked the
-- guest binding and membership expires_at (the originally scheduled close). After a manual close,
-- approval or cancellation the guest could still read the session, roster subject, template and
-- their own assessment on the next request, even though saving was refused.
--
-- Fix (read paths only): a guest may read a session's data only while that session is collecting:
-- status 'open' and now() within [opens_at, closes_at). Manual close (in_review), approval,
-- reopen (stays in_review), cancellation and scheduled expiry all end guest reads.
--
-- Deliberately unchanged:
--   * private.assignment_in_scope: still used by set_assignment to validate assignees.
--   * Evidence and approval: build_inputs, approve_session and get_session_report read
--     session_assignments/assessments directly or via can_review, so guest responses, required
--     assessor counts, snapshots and history remain visible to owners/admins/assigned reviewers.
--   * Non-guest roles: the new check is true for every caller who is not a guest in the session's
--     workspace, so staff permissions are identical to before.
-- CREATE OR REPLACE keeps the function identities, so existing RLS policies and grants still apply.

create function private.guest_collection_live(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
      select 1 from public.sessions s
      join public.memberships m on m.workspace_id = s.workspace_id and m.user_id = (select auth.uid())
      where s.id = p_session and m.role = 'guest')
    or exists (
      select 1 from public.sessions s
      where s.id = p_session and s.status = 'open' and now() >= s.opens_at and now() < s.closes_at)
$$;
-- Only called from other SECURITY DEFINER helpers (which run as the owner); no client grant.
revoke all on function private.guest_collection_live(uuid) from public, anon, authenticated;

create or replace function private.is_assigned(p_session uuid, p_subject uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.session_assignments a
    where a.session_id = p_session and a.user_id = (select auth.uid())
      and (p_subject is null or a.subject_id = p_subject))
    and private.assignment_in_scope(p_session, (select auth.uid()))
    and private.guest_collection_live(p_session)
$$;

-- Subject directory exposure is limited to subjects on rosters the caller may currently act on.
create or replace function private.assigned_subject(p_subject uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.session_assignments a
    where a.subject_id = p_subject and a.user_id = (select auth.uid())
      and private.assignment_in_scope(a.session_id, a.user_id)
      and private.guest_collection_live(a.session_id))
  or exists (
    select 1 from public.session_subjects ss
    where ss.subject_id = p_subject and private.can_review(ss.session_id))
$$;
