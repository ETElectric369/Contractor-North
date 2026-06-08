-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0019: org settings bag + named tax rates
-- Adds a flexible JSONB `settings` column for org-wide preferences (currency,
-- timezone, document terms, working hours, payment methods, etc.) and a
-- `tax_rates` table for multiple named tax rates. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.organizations
  add column if not exists settings jsonb not null default '{}'::jsonb;

create table if not exists public.tax_rates (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid references public.organizations(id) on delete cascade,
  name       text not null,
  rate       numeric(7,4) not null default 0,   -- percent, e.g. 9.0000 = 9%
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tax_rates_org_idx on public.tax_rates(org_id);

drop trigger if exists touch_tax_rates on public.tax_rates;
create trigger touch_tax_rates before update on public.tax_rates
  for each row execute function public.touch_updated_at();

drop trigger if exists stamp_org_tax_rates on public.tax_rates;
create trigger stamp_org_tax_rates before insert on public.tax_rates
  for each row execute function public.set_org_id();

alter table public.tax_rates enable row level security;

drop policy if exists tax_rates_read on public.tax_rates;
create policy tax_rates_read on public.tax_rates
  for select using (org_id = public.auth_org_id());

drop policy if exists tax_rates_write on public.tax_rates;
create policy tax_rates_write on public.tax_rates
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
