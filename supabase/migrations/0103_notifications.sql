-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0103: in-app notifications (the always-works bell)
-- The canonical event log BOTH the in-app bell and web-push read from, so "did it
-- notify?" no longer depends on invisible push-permission state. One row per
-- recipient (read_at is per-user). Written by the server (service role) on events
-- like a quote acceptance, a scheduled job, or a question pushed to the crew.
-- Run AFTER 0004 (needs auth.uid()/auth_org_id()).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade, -- the recipient
  type       text not null default 'general', -- quote_accepted | job_scheduled | question | briefing | …
  title      text not null,
  body       text,
  url        text,                             -- deep link acted on when tapped
  read_at    timestamptz,                      -- null = unread
  created_at timestamptz not null default now()
);
-- Hot path: a user's unread, newest-first.
create index if not exists notifications_user_idx
  on public.notifications(user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications(user_id) where read_at is null;

alter table public.notifications enable row level security;

-- A user sees ONLY their own notifications (scoped to their org for defense in depth).
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications
  for select using (user_id = auth.uid() and org_id = public.auth_org_id());

-- A user can mark their own read/unread; they cannot reassign or cross orgs.
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No INSERT/DELETE policy on purpose: only the server (service role, which bypasses
-- RLS) writes notifications, so a client can never fabricate one for anyone.
