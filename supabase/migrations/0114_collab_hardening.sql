-- Final-review hardening of the site-collaborator seat (the escalation + whitelist + isolation
-- already verified; these close two remaining medium/low findings).

-- (1) update_site_content: VALIDATE the type of each whitelisted value before merging, so a
--     collaborator can't store a malformed shape (e.g. a string where the public site expects an
--     array) that would 500 the homepage. Wrong-typed keys are skipped, not stored.
create or replace function public.update_site_content(target_org uuid, patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  text_keys text[] := array[
    'splash_headline','splash_tagline','splash_bg_url','splash_bullets','splash_credentials',
    'specialty_headline','specialty_blurb','service_area','social_instagram','google_business_url'
  ];
  array_keys text[] := array['portfolio','reviews'];
  cur jsonb;
  merged jsonb;
  k text;
begin
  if not (
    (public.auth_org_id() = target_org and public.is_org_staff())
    or public.is_site_collaborator(target_org)
  ) then
    raise exception 'not authorized for this site';
  end if;

  select coalesce(settings, '{}'::jsonb) into cur from public.organizations where id = target_org;
  if cur is null then raise exception 'org not found'; end if;
  merged := cur;

  foreach k in array text_keys loop
    if patch ? k and jsonb_typeof(patch -> k) = 'string' then
      merged := jsonb_set(merged, array[k], patch -> k, true);
    end if;
  end loop;
  foreach k in array array_keys loop
    if patch ? k and jsonb_typeof(patch -> k) = 'array' then
      merged := jsonb_set(merged, array[k], patch -> k, true);
    end if;
  end loop;
  -- site_theme: a fixed enum.
  if patch ? 'site_theme' and (patch ->> 'site_theme') in ('classic','bold','minimal') then
    merged := jsonb_set(merged, array['site_theme'], patch -> 'site_theme', true);
  end if;

  update public.organizations set settings = merged where id = target_org;
end $$;

-- (2) Scope the collaborator's `branding` write grant to PORTFOLIO photos only (name like
--     '<org>/portfolio-…', exactly what PortfolioManager uploads). Staff keep full folder access;
--     a collaborator can no longer overwrite/delete the org LOGO (which shows on invoices,
--     quotes, contracts, and app chrome) or any non-portfolio branding file.
drop policy if exists branding_insert on storage.objects;
create policy branding_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'branding' and (
      (storage.foldername(name))[1] = public.auth_org_id()::text
      or ((storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
          and public.is_site_collaborator(((storage.foldername(name))[1])::uuid)
          and name like '%/portfolio-%')
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
          and name like '%/portfolio-%')
    )
  );

drop policy if exists branding_delete on storage.objects;
create policy branding_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'branding' and (
      (storage.foldername(name))[1] = public.auth_org_id()::text
      or ((storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
          and public.is_site_collaborator(((storage.foldername(name))[1])::uuid)
          and name like '%/portfolio-%')
    )
  );
