-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0013: job receipts & documents
-- A private Storage bucket for receipts/bills/photos/plans attached to jobs,
-- plus a user-facing category on the documents table. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.documents
  add column if not exists category text,
  add column if not exists size_bytes bigint;

-- Private bucket (receipts can contain pricing) — accessed via signed URLs.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- Files live at documents/<org_id>/<job_id>/<file>. Org members manage only
-- their own org's files; nothing is publicly readable.
drop policy if exists docs_read on storage.objects;
create policy docs_read on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = public.auth_org_id()::text);

drop policy if exists docs_insert on storage.objects;
create policy docs_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = public.auth_org_id()::text);

drop policy if exists docs_update on storage.objects;
create policy docs_update on storage.objects
  for update to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = public.auth_org_id()::text);

drop policy if exists docs_delete on storage.objects;
create policy docs_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = public.auth_org_id()::text);

-- Allow any active org member (incl. field techs) to add/manage job documents,
-- not just office staff — techs snap receipts in the field.
drop policy if exists documents_write on public.documents;
create policy documents_write on public.documents
  for all
  using (org_id = public.auth_org_id() and public.is_member())
  with check (org_id = public.auth_org_id() and public.is_member());
