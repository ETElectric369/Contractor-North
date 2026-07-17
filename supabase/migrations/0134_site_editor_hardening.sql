-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0134: site-editor hardening
-- Two silent failures on the public-site editing surface:
--   1. update_site_content never whitelisted splash_headline_size, so a
--      collaborator's S/M/L headline pick (a real key the splash editor sends)
--      was dropped without a word — the save "succeeded" and changed nothing.
--   2. The public `branding` bucket had no size or mime cap. The RLS policies
--      (0114/0115) gate WHO writes WHERE — including the collaborator
--      portfolio-*-image-extension rule — but the extension check is name-only:
--      a hand-rolled client could still store a portfolio-x.png with a
--      non-image content-type (served as declared → script on our origin), or
--      an arbitrarily large file.
-- Fix: re-create update_site_content (from 0118) with splash_headline_size,
-- enum-guarded like site_theme; cap the bucket at 5MB + raster image mimes.
-- NOTE: the mime cap intentionally excludes image/svg+xml (scriptable), which
-- retires the staff SVG-logo upload path — PNG/JPG logos are unaffected.
-- Run AFTER 0118.
-- ═══════════════════════════════════════════════════════════════════════════

-- Whitelist splash_headline_size. Fixed enum ('s'|'m'|'l' — exactly the sizes the splash editor's
-- picker offers), guarded like site_theme rather than added to text_keys: a free string here would
-- let a crafted patch store a junk size the homepage hero then has to defend against.
create or replace function public.update_site_content(target_org uuid, patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  text_keys text[] := array[
    'splash_headline','splash_tagline','splash_bg_url','splash_bullets','splash_credentials',
    'specialty_headline','specialty_blurb','service_area','social_instagram','google_business_url'
  ];
  array_keys text[] := array['portfolio','reviews','home_blocks'];
  max_bytes int := 512000;
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
    if patch ? k and jsonb_typeof(patch -> k) = 'string' and length((patch -> k)::text) <= max_bytes then
      merged := jsonb_set(merged, array[k], patch -> k, true);
    end if;
  end loop;
  foreach k in array array_keys loop
    if patch ? k and jsonb_typeof(patch -> k) = 'array'
       and jsonb_array_length(patch -> k) <= 200
       and length((patch -> k)::text) <= max_bytes then
      merged := jsonb_set(merged, array[k], patch -> k, true);
    end if;
  end loop;
  if patch ? 'site_theme' and (patch ->> 'site_theme') in ('classic','bold','minimal') then
    merged := jsonb_set(merged, array['site_theme'], patch -> 'site_theme', true);
  end if;
  if patch ? 'splash_headline_size' and (patch ->> 'splash_headline_size') in ('s','m','l') then
    merged := jsonb_set(merged, array['splash_headline_size'], patch -> 'splash_headline_size', true);
  end if;

  update public.organizations set settings = merged where id = target_org;
end $$;

-- Cap WHAT can land in the public branding bucket (the policies above cap who/where). 5MB is
-- generous: every in-app uploader resizes through prepareImageForUpload (≤ ~2200px JPEG) or
-- enforces its own 2MB logo cap first, so only a hand-rolled client ever hits this. Existing
-- objects are untouched — the caps apply at upload time.
update storage.buckets
  set file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif','image/avif']
  where id = 'branding';
