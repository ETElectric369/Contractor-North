-- Restrict an external collaborator's branding uploads to IMAGE files, so they can't host
-- arbitrary HTML/SVG/JS on the public storage origin under a portfolio-* name. Staff are
-- unaffected (they manage the logo + all branding). Insert/update only — delete needs no filter.

drop policy if exists branding_insert on storage.objects;
create policy branding_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'branding' and (
      (storage.foldername(name))[1] = public.auth_org_id()::text
      or ((storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
          and public.is_site_collaborator(((storage.foldername(name))[1])::uuid)
          and name like '%/portfolio-%'
          and name ~* '\.(jpe?g|png|webp|gif|avif)$')
    )
  );

drop policy if exists branding_update on storage.objects;
create policy branding_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'branding' and (
      (storage.foldername(name))[1] = public.auth_org_id()::text
      or ((storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
          and public.is_site_collaborator(((storage.foldername(name))[1])::uuid)
          and name like '%/portfolio-%'
          and name ~* '\.(jpe?g|png|webp|gif|avif)$')
    )
  );
