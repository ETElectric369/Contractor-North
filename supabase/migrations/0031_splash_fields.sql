-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0031: splash fields on public_org
-- Adds splash headline/tagline/background (from settings) to the public RPC so
-- the inquiry splash page can render org-specific branding. Run AFTER 0026.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.public_org(p_org uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'name', name, 'logo_url', logo_url, 'brand_color', brand_color,
    'phone', phone, 'email', email, 'city', city, 'state', state,
    'splash_headline', settings->>'splash_headline',
    'splash_tagline',  settings->>'splash_tagline',
    'splash_bg_url',   settings->>'splash_bg_url'
  )
  from public.organizations where id = p_org;
$$;

grant execute on function public.public_org(uuid) to anon, authenticated;
