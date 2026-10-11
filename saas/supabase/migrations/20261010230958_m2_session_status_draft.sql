-- SAVOUR Milestone 2 (1 of 3): draft session status.
--
-- Kept alone in its own migration because a new enum value cannot be used in the same
-- transaction that adds it. The lifecycle migration that follows uses 'draft'.
-- A draft session is never collecting: assessors and guests cannot see it, nothing can be
-- submitted, and guest invitations still require status 'open'.

alter type public.session_status add value if not exists 'draft' before 'open';
