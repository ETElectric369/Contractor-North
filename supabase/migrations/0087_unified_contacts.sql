-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0087: unified contacts + sublinking
-- (1) Subcontractors join the contact book (a new customer_type).
-- (2) A many-to-many `job_contacts` links ANY contact (sub / supplier / inspector)
--     to MULTIPLE jobs — distinct from jobs.customer_id (the one client).
-- ═══════════════════════════════════════════════════════════════════════════

-- (1) New contact type. ADD VALUE is fine in a PG15 tx as long as we don't USE the
--     value in this same migration (we don't).
alter type public.customer_type add value if not exists 'subcontractor';

-- (2) The link table.
create table if not exists public.job_contacts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  job_id      uuid not null references public.jobs(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  role        text not null default 'Subcontractor',
  notes       text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  unique (job_id, customer_id, role)
);
create index if not exists job_contacts_job_idx on public.job_contacts(job_id);
create index if not exists job_contacts_cust_idx on public.job_contacts(customer_id);

drop trigger if exists stamp_org_job_contacts on public.job_contacts;
create trigger stamp_org_job_contacts before insert on public.job_contacts
  for each row execute function public.set_org_id();

alter table public.job_contacts enable row level security;

drop policy if exists job_contacts_read on public.job_contacts;
create policy job_contacts_read on public.job_contacts
  for select using (org_id = public.auth_org_id());

drop policy if exists job_contacts_write on public.job_contacts;
create policy job_contacts_write on public.job_contacts
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
