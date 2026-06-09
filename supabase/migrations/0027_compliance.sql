-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0027: compliance tracker
-- Tracks insurance, workers' comp, bonds, licenses, certifications, etc. with
-- renewal dates so nothing lapses. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.compliance_items (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid references public.organizations(id) on delete cascade,
  type          text not null default 'Insurance',
  name          text not null,                 -- provider / description
  policy_number text,
  amount        numeric(12,2) not null default 0,   -- annual premium / cost
  issued_date   date,
  expires_date  date,
  notes         text,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists compliance_org_idx on public.compliance_items(org_id, expires_date);

drop trigger if exists touch_compliance on public.compliance_items;
create trigger touch_compliance before update on public.compliance_items
  for each row execute function public.touch_updated_at();

drop trigger if exists stamp_org_compliance on public.compliance_items;
create trigger stamp_org_compliance before insert on public.compliance_items
  for each row execute function public.set_org_id();

alter table public.compliance_items enable row level security;

drop policy if exists compliance_read on public.compliance_items;
create policy compliance_read on public.compliance_items
  for select using (org_id = public.auth_org_id());

drop policy if exists compliance_write on public.compliance_items;
create policy compliance_write on public.compliance_items
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
