-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0017: supplier bills (cost side)
-- Records supplier invoices/bills against a job for job costing. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.bills (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  job_id      uuid references public.jobs(id) on delete set null,
  supplier    text not null default '',
  bill_number text,
  amount      numeric(12,2) not null default 0,
  status      text not null default 'unpaid',   -- unpaid | paid
  bill_date   date,
  notes       text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists bills_job_idx on public.bills(job_id);

drop trigger if exists touch_bills on public.bills;
create trigger touch_bills before update on public.bills
  for each row execute function public.touch_updated_at();

drop trigger if exists stamp_org_bills on public.bills;
create trigger stamp_org_bills before insert on public.bills
  for each row execute function public.set_org_id();

alter table public.bills enable row level security;
drop policy if exists bills_read on public.bills;
create policy bills_read on public.bills
  for select using (org_id = public.auth_org_id());
drop policy if exists bills_write on public.bills;
create policy bills_write on public.bills
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
