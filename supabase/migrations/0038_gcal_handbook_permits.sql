-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0038: Google Calendar sync + permit portals
-- calendar_connections stores per-org Google OAuth tokens (server-side only);
-- jobs.google_event_id lets schedule pushes update events instead of
-- duplicating them; permits.portal_url gives each permit a one-tap "check
-- with city" link. Run AFTER 0022.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.calendar_connections (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid references public.organizations(id) on delete cascade,
  provider      text not null default 'google',
  access_token  text not null,
  refresh_token text,
  expires_at    timestamptz,
  calendar_id   text not null default 'primary',
  connected_by  uuid references public.profiles(id),
  connected_at  timestamptz not null default now()
);
create unique index if not exists calendar_connections_org_key
  on public.calendar_connections(org_id, provider);

drop trigger if exists stamp_org_calendar_connections on public.calendar_connections;
create trigger stamp_org_calendar_connections before insert on public.calendar_connections
  for each row execute function public.set_org_id();

alter table public.calendar_connections enable row level security;

-- Staff only — tokens are sensitive.
drop policy if exists calendar_connections_rw on public.calendar_connections;
create policy calendar_connections_rw on public.calendar_connections
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

alter table public.jobs add column if not exists google_event_id text;
alter table public.permits add column if not exists portal_url text;
