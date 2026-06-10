-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0035: "Organize My" hub
-- User snaps a photo of a receipt / handwritten note / job document; Claude
-- reads it, classifies it, extracts the details, and files it. Each processed
-- upload gets a row here (the image itself lives in the documents bucket and,
-- when job-matched, a documents row so it shows on the job page).
-- Run AFTER 0013. (documents.job_id is already nullable.)
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.organized_items (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid references public.organizations(id) on delete cascade,
  kind         text not null default 'receipt',   -- receipt | note | job_document
  title        text not null,
  summary      text,                               -- extracted text / cleaned-up note
  vendor       text,                               -- receipts
  amount       numeric(12,2),                      -- receipts
  item_date    date,                               -- date on the receipt/doc
  category     text,                               -- documents category it was filed under
  confidence   text default 'medium',              -- low | medium | high (AI's own rating)
  job_id       uuid references public.jobs(id) on delete set null,
  document_id  uuid references public.documents(id) on delete set null,
  file_url     text not null,                      -- storage path in 'documents' bucket
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);
create index if not exists organized_items_org_idx on public.organized_items(org_id, created_at desc);
create index if not exists organized_items_kind_idx on public.organized_items(org_id, kind);

drop trigger if exists stamp_org_organized_items on public.organized_items;
create trigger stamp_org_organized_items before insert on public.organized_items
  for each row execute function public.set_org_id();

alter table public.organized_items enable row level security;

drop policy if exists organized_items_read on public.organized_items;
create policy organized_items_read on public.organized_items
  for select using (org_id = public.auth_org_id());

drop policy if exists organized_items_write on public.organized_items;
create policy organized_items_write on public.organized_items
  for all using (org_id = public.auth_org_id())
  with check (org_id = public.auth_org_id());
