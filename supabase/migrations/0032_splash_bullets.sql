-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0032: splash bullets on public_org
-- Adds splash_bullets (newline-separated highlights) to the public RPC.
-- Run AFTER 0031.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.public_org(p_org uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'name', name, 'logo_url', logo_url, 'brand_color', brand_color,
    'phone', phone, 'email', email, 'city', city, 'state', state,
    'splash_headline', settings->>'splash_headline',
    'splash_tagline',  settings->>'splash_tagline',
    'splash_bg_url',   settings->>'splash_bg_url',
    'splash_bullets',  settings->>'splash_bullets'
  )
  from public.organizations where id = p_org;
$$;

grant execute on function public.public_org(uuid) to anon, authenticated;
