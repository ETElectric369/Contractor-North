-- 0213 — the documents bucket learns the staff boundary its own tables already enforce.
--
-- 0013 created `documents` with four policies keyed ONLY on org membership. Two later
-- migrations then put staff-only material into that same bucket and gated the ROW while
-- leaving the OBJECT open:
--   · 0029_employee_docs   — HR files ("Staff-only (sensitive)"), rows gated by is_org_staff()
--   · 0201_organize_is_staff_money — re-gated organized_items because "a tech tapping
--     Organize → Archive saw the whole company's spend"
-- Both write into `<org>/employees/...` and `<org>/organize/...`, and the object paths are
-- trivially enumerable with the anon key + any member session — so a field tech could read
-- (and delete) every co-worker's HR file and every company receipt. The app layer has always
-- agreed these are staff-only (employee-docs/page.tsx redirects non-staff; organize/actions.ts
-- is requireStaff throughout); this makes the storage layer say the same thing.
--
-- Everything a tech legitimately touches — job documents, appointment captures, ai-uploads,
-- bug screenshots — keeps the org-membership rule unchanged.

create or replace function public.docs_path_is_staff_only(p_name text)
returns boolean
language sql
immutable
as $$
  select (storage.foldername(p_name))[2] in ('employees', 'organize');
$$;

comment on function public.docs_path_is_staff_only(text) is
  'Sub-paths of the documents bucket holding staff-only material (HR files 0029, company spend 0201).';

drop policy if exists docs_read on storage.objects;
create policy docs_read on storage.objects for select
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (public.auth_org_id())::text
    and (not public.docs_path_is_staff_only(name) or public.is_org_staff())
  );

drop policy if exists docs_insert on storage.objects;
create policy docs_insert on storage.objects for insert
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (public.auth_org_id())::text
    and (not public.docs_path_is_staff_only(name) or public.is_org_staff())
  );

drop policy if exists docs_update on storage.objects;
create policy docs_update on storage.objects for update
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (public.auth_org_id())::text
    and (not public.docs_path_is_staff_only(name) or public.is_org_staff())
  );

drop policy if exists docs_delete on storage.objects;
create policy docs_delete on storage.objects for delete
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (public.auth_org_id())::text
    and (not public.docs_path_is_staff_only(name) or public.is_org_staff())
  );
