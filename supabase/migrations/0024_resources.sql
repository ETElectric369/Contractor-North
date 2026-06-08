-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0024: resources / local-authority directory
-- A contact book for building departments, inspectors, utilities, suppliers,
-- engineers, and permit/records portals. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.resources (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid references public.organizations(id) on delete cascade,
  name         text not null,
  category     text not null default 'Other',
  contact_name text,
  phone        text,
  email        text,
  website      text,
  address      text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists resources_org_idx on public.resources(org_id, category);

drop trigger if exists touch_resources on public.resources;
create trigger touch_resources before update on public.resources
  for each row execute function public.touch_updated_at();

drop trigger if exists stamp_org_resources on public.resources;
create trigger stamp_org_resources before insert on public.resources
  for each row execute function public.set_org_id();

alter table public.resources enable row level security;

drop policy if exists resources_read on public.resources;
create policy resources_read on public.resources
  for select using (org_id = public.auth_org_id());

drop policy if exists resources_write on public.resources;
create policy resources_write on public.resources
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
