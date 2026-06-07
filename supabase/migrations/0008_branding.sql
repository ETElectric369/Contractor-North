-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0008: branding (logo upload + per-doc templates)
-- Run AFTER 0004/0007. Adds a per-document-type template map and a public
-- Storage bucket for company logos, scoped per organization.
-- ═══════════════════════════════════════════════════════════════════════════

-- Per-document-type template choice, e.g. {"quote":"modern","invoice":"classic"}.
alter table public.organizations
  add column if not exists doc_templates jsonb not null default '{}'::jsonb;

-- ── Storage bucket for logos (public read) ──────────────────────────────────
insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do update set public = true;

-- Files live at branding/<org_id>/<file>. Members manage only their org's files.
drop policy if exists branding_read on storage.objects;
create policy branding_read on storage.objects
  for select using (bucket_id = 'branding');

drop policy if exists branding_insert on storage.objects;
create policy branding_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = public.auth_org_id()::text
  );

drop policy if exists branding_update on storage.objects;
create policy branding_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = public.auth_org_id()::text
  );

drop policy if exists branding_delete on storage.objects;
create policy branding_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = public.auth_org_id()::text
  );
