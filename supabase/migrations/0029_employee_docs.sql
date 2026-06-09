-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0029: employee documents (HR)
-- Stores per-employee documents (driver's license, I-9, W-2, certifications).
-- Files live in the private 'documents' Storage bucket. Staff-only (sensitive).
-- Run AFTER 0013 (documents bucket).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.employee_documents (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid references public.organizations(id) on delete cascade,
  profile_id   uuid references public.profiles(id) on delete cascade,
  type         text not null default 'Driver License',
  name         text not null,
  file_url     text not null,                 -- path within the 'documents' bucket
  expires_date date,
  notes        text,
  uploaded_by  uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);
create index if not exists employee_docs_idx on public.employee_documents(org_id, profile_id);

drop trigger if exists stamp_org_employee_docs on public.employee_documents;
create trigger stamp_org_employee_docs before insert on public.employee_documents
  for each row execute function public.set_org_id();

alter table public.employee_documents enable row level security;

-- Sensitive HR data → staff only for both read and write.
drop policy if exists employee_docs_read on public.employee_documents;
create policy employee_docs_read on public.employee_documents
  for select using (org_id = public.auth_org_id() and public.is_org_staff());

drop policy if exists employee_docs_write on public.employee_documents;
create policy employee_docs_write on public.employee_documents
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
