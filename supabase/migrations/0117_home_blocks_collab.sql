-- Open the block HOMEPAGE (settings.home_blocks) to external site collaborators — through the SAME
-- whitelist RPC that already governs the rest of the marketing surface, so it inherits the proven
-- isolation: a collaborator can set ONLY home_blocks (+ the existing marketing keys) and never any
-- business config, even with a crafted patch. home_blocks must be a JSON array and is size-capped
-- here (a hard bound on write); the public site additionally normalizes/bounds + sanitizes the text
-- of every block on READ (renderReadyBlocks), so a bypassed/hostile write still can't XSS or overload
-- the homepage. Recreates the 0114 function verbatim + the one new array key + the length guard.
create or replace function public.update_site_content(target_org uuid, patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  text_keys text[] := array[
    'splash_headline','splash_tagline','splash_bg_url','splash_bullets','splash_credentials',
    'specialty_headline','specialty_blurb','service_area','social_instagram','google_business_url'
  ];
  array_keys text[] := array['portfolio','reviews','home_blocks'];
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
    -- Arrays only, and bounded (home_blocks caps at 200 sections; the renderer re-caps at 60).
    if patch ? k and jsonb_typeof(patch -> k) = 'array' and jsonb_array_length(patch -> k) <= 200 then
      merged := jsonb_set(merged, array[k], patch -> k, true);
    end if;
  end loop;
  if patch ? 'site_theme' and (patch ->> 'site_theme') in ('classic','bold','minimal') then
    merged := jsonb_set(merged, array['site_theme'], patch -> 'site_theme', true);
  end if;

  update public.organizations set settings = merged where id = target_org;
end $$;
