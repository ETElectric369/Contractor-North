-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0046: web push notifications
-- Per-device push subscriptions + per-user notification toggles. Sending is
-- done server-side (service role) from the actions that create the underlying
-- records (job/appointment assigned, new inquiry, quote accepted, invoice paid).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists push_subs_profile_idx on public.push_subscriptions(profile_id);
create index if not exists push_subs_org_idx on public.push_subscriptions(org_id);

drop trigger if exists stamp_org_push_subs on public.push_subscriptions;
create trigger stamp_org_push_subs before insert on public.push_subscriptions
  for each row execute function public.set_org_id();

alter table public.push_subscriptions enable row level security;

-- Users manage only their own device subscriptions. (Sending reads across
-- users via the service role, which bypasses RLS.)
drop policy if exists push_subs_own on public.push_subscriptions;
create policy push_subs_own on public.push_subscriptions
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- Per-user notification toggles, e.g. {"assigned":true,"invoice_paid":false}.
-- An absent key falls back to the trigger's default (see lib/push.ts).
alter table public.profiles add column if not exists push_prefs jsonb not null default '{}'::jsonb;
