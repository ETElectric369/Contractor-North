-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0025: pricing levels (customer pricing tiers)
-- Each level carries a markup % applied to price-list items on quotes. Customers
-- are assigned a level; the default applies to everyone else. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.pricing_levels (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid references public.organizations(id) on delete cascade,
  name       text not null,
  markup_pct numeric(7,2) not null default 0,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pricing_levels_org_idx on public.pricing_levels(org_id);

alter table public.customers
  add column if not exists pricing_level_id uuid
    references public.pricing_levels(id) on delete set null;

drop trigger if exists touch_pricing_levels on public.pricing_levels;
create trigger touch_pricing_levels before update on public.pricing_levels
  for each row execute function public.touch_updated_at();

drop trigger if exists stamp_org_pricing_levels on public.pricing_levels;
create trigger stamp_org_pricing_levels before insert on public.pricing_levels
  for each row execute function public.set_org_id();

alter table public.pricing_levels enable row level security;

drop policy if exists pricing_levels_read on public.pricing_levels;
create policy pricing_levels_read on public.pricing_levels
  for select using (org_id = public.auth_org_id());

drop policy if exists pricing_levels_write on public.pricing_levels;
create policy pricing_levels_write on public.pricing_levels
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
