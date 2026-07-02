-- 0094 — attach the actual document to a compliance/insurance item.
--
-- /insurance tracked policy METADATA (carrier, number, dates) but the
-- certificate itself had nowhere to live — Erik's GL cert had no door.
-- file_url stores a path in the private "documents" bucket (same rails as
-- employee_documents: org-folder RLS from 0013, signed URLs to view).
alter table public.compliance_items
  add column if not exists file_url text;
