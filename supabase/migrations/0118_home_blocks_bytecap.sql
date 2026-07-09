-- Harden update_site_content: add the WRITE-TIME BYTE CAP that 0117's comment claimed but didn't
-- enforce. jsonb_array_length only bounds element COUNT — a collaborator could still store 200
-- blocks each carrying a huge props.html (a multi-MB settings blob), which the uncached, force-dynamic
-- public homepage re-fetches + re-parses on every anonymous request (a cheap write → repeated
-- expensive reads). Cap each whitelisted array value's serialized size at ~512KB (a very generous
-- homepage; the render path re-caps blocks at 60 × 40KB anyway). Over-limit values are skipped, same
-- as wrong-typed ones. Text keys are inherently small but capped too for symmetry.
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

  update public.organizations set settings = merged where id = target_org;
end $$;
