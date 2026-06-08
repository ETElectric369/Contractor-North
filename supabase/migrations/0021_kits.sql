-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0021: kits (reusable line-item bundles)
-- A Kit is a saved bundle of materials/labor lines you drop onto a quote to
-- speed up quoting common services. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.kits (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid references public.organizations(id) on delete cascade,
  name       text not null,
  category   text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists kits_org_idx on public.kits(org_id);

create table if not exists public.kit_items (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  kit_id      uuid not null references public.kits(id) on delete cascade,
  description text not null,
  quantity    numeric(12,2) not null default 1,
  unit        text not null default 'ea',
  unit_price  numeric(12,2) not null default 0,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists kit_items_kit_idx on public.kit_items(kit_id);

drop trigger if exists touch_kits on public.kits;
create trigger touch_kits before update on public.kits
  for each row execute function public.touch_updated_at();

drop trigger if exists stamp_org_kits on public.kits;
create trigger stamp_org_kits before insert on public.kits
  for each row execute function public.set_org_id();

drop trigger if exists stamp_org_kit_items on public.kit_items;
create trigger stamp_org_kit_items before insert on public.kit_items
  for each row execute function public.set_org_id();

alter table public.kits enable row level security;
alter table public.kit_items enable row level security;

drop policy if exists kits_read on public.kits;
create policy kits_read on public.kits for select using (org_id = public.auth_org_id());
drop policy if exists kits_write on public.kits;
create policy kits_write on public.kits for all
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

drop policy if exists kit_items_read on public.kit_items;
create policy kit_items_read on public.kit_items for select using (org_id = public.auth_org_id());
drop policy if exists kit_items_write on public.kit_items;
create policy kit_items_write on public.kit_items for all
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
