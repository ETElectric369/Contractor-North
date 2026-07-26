-- Migration 0159: leave EVIDENCE that a scrub happened.
--
-- The offboarding audit's other half: even once deactivation actually revokes (0158),
-- there was no record that it ever occurred. auth.audit_log_entries is EMPTY on this
-- project (verified live — no retention), profiles carried no deactivated_at, and
-- collaborator revocation is a hard DELETE that erases the fact the grant existed.
-- "Prove Jill is gone" had no answer beyond "the row isn't there", which is also what
-- a grant that was never created looks like.
--
-- Two small additions, both write-once facts rather than a new subsystem:
--   • profiles.deactivated_at / deactivated_by — when, and by whom.
--   • site_collaborator_revocations — a tombstone written when a grant is revoked, so
--     the org can show WHO had access, from when to when, and who cut it.

alter table public.profiles
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by uuid references public.profiles(id) on delete set null;

comment on column public.profiles.deactivated_at is
  'When this member was deactivated (null = active). Written by setMemberActive; cleared on reactivation (0159).';
comment on column public.profiles.deactivated_by is
  'Who deactivated them (0159).';

-- Tombstone for a revoked website collaborator (the Jill case). The grant row itself is
-- still hard-deleted — that is what makes revocation instant and total — so this records
-- that it EXISTED and was cut, which is the part an audit needs.
create table if not exists public.site_collaborator_revocations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  email        text not null,
  user_id      uuid,                 -- may be null: an invite revoked before it was claimed
  granted_at   timestamptz,
  revoked_at   timestamptz not null default now(),
  revoked_by   uuid references public.profiles(id) on delete set null
);

create index if not exists site_collab_revocations_org_idx
  on public.site_collaborator_revocations(org_id, revoked_at desc);

alter table public.site_collaborator_revocations enable row level security;

-- Staff of the org read their own revocation history; nobody edits it from the app
-- (inserts come from the revoke action running as the staff user).
drop policy if exists site_collab_revocations_read on public.site_collaborator_revocations;
create policy site_collab_revocations_read on public.site_collaborator_revocations
  for select using (org_id = public.auth_org_id() and public.is_org_staff());

drop policy if exists site_collab_revocations_insert on public.site_collaborator_revocations;
create policy site_collab_revocations_insert on public.site_collaborator_revocations
  for insert with check (org_id = public.auth_org_id() and public.is_org_staff());

-- No update/delete policy: a tombstone that can be edited or removed proves nothing.

comment on table public.site_collaborator_revocations is
  'Write-once record that an outside website collaborator''s grant existed and was revoked '
  '— the evidence a hard DELETE would otherwise erase (0159).';
