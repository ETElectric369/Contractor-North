-- Expand the site-collaborator seat from articles to the full ON-PAGE SEO / marketing surface.
-- A collaborator can't read or write the organizations row (org_id NULL → RLS denies it), and the
-- marketing copy lives in the SAME settings jsonb as business config (pricing, lead-inbound secret,
-- estimating mode, thresholds). So edits go through this SECURITY DEFINER function, which re-checks
-- the grant AND merges ONLY a hardcoded whitelist of marketing keys — every other key in the patch
-- is physically ignored. Business config can never be reached even with a crafted patch.

create or replace function public.update_site_content(target_org uuid, patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  allowed text[] := array[
    'splash_headline','splash_tagline','splash_bg_url','splash_bullets','splash_credentials',
    'portfolio','specialty_headline','specialty_blurb','service_area','site_theme',
    'social_instagram','google_business_url','reviews'
  ];
  cur jsonb;
  merged jsonb;
  k text;
begin
  -- Authorize: org staff of THIS org, or a granted external collaborator of THIS org.
  if not (
    (public.auth_org_id() = target_org and public.is_org_staff())
    or public.is_site_collaborator(target_org)
  ) then
    raise exception 'not authorized for this site';
  end if;

  select coalesce(settings, '{}'::jsonb) into cur from public.organizations where id = target_org;
  if cur is null then raise exception 'org not found'; end if;

  merged := cur;
  foreach k in array allowed loop
    if patch ? k then
      merged := jsonb_set(merged, array[k], patch -> k, true);
    end if;
  end loop;

  update public.organizations set settings = merged where id = target_org;
end $$;

-- Widen the public `branding` bucket so a granted collaborator can upload/replace/remove portfolio
-- photos into their org's folder (branding/<org_id>/…). Staff access is unchanged; the uuid-format
-- guard means non-uuid first segments (e.g. legacy "portfolio/…") never reach the cast.
drop policy if exists branding_insert on storage.objects;
create policy branding_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'branding' and (
      (storage.foldername(name))[1] = public.auth_org_id()::text
      or ((storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
          and public.is_site_collaborator(((storage.foldername(name))[1])::uuid))
    )
  );

drop policy if exists branding_update on storage.objects;
create policy branding_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'branding' and (
      (storage.foldername(name))[1] = public.auth_org_id()::text
      or ((storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
          and public.is_site_collaborator(((storage.foldername(name))[1])::uuid))
    )
  );

drop policy if exists branding_delete on storage.objects;
create policy branding_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'branding' and (
      (storage.foldername(name))[1] = public.auth_org_id()::text
      or ((storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
          and public.is_site_collaborator(((storage.foldername(name))[1])::uuid))
    )
  );
