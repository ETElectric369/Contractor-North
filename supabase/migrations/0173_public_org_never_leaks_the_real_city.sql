-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0173: public_org() stops publishing the real city
--
-- Erik asked "why does Chris's site publish an address, I thought we went through
-- that in depth." The marketing site was clean — I checked all 19 sitemap URLs on
-- both domains: no streetAddress, no "Chilcoot", no 96105. The instinct was right
-- and the page was wrong: /inquire/<org-id> is NOT in any sitemap, so nothing in
-- that sweep ever looked at it, and it renders
--
--     <MapPin/> {[o.city, o.state].filter(Boolean).join(", ")}
--
-- from public_org(), which selected `city, state` straight off the organizations
-- row. Live before this migration, on BOTH tenants:
--     https://etelectricity.com/inquire/<org>  -> "Chilcoot, CA"
--     https://tahoedeck.com/inquire/<org>      -> "Chilcoot, CA"
-- The org record holds city=Chilcoot, state=CA, zip=96105, address_line1='PO Box 132'.
-- Both businesses are home-based there and market to Truckee/Tahoe, which is the
-- entire reason public_city/public_state exist.
--
-- THE SHAPE OF THE MISTAKE, worth naming because it is the same one twice today:
-- the address scrub was applied at ONE READ PATH (org-site.tsx, which correctly
-- reads settings->>'public_city' and cannot emit a street) and not at the OTHER
-- read path (this RPC). A rule enforced per-caller is a convention. The fix has to
-- live where the data leaves the database, so no future page can ask for the org
-- and get the private city back.
--
-- FAILS CLOSED: when public_city is unset the answer is NULL, not the real city.
-- A missing locality is a cosmetic gap; the wrong one published on the open web is
-- somebody's home address.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.public_org(p_org uuid)
returns json
language sql
stable
security definer
set search_path to 'public'
as $$
  select json_build_object(
    'name', name, 'logo_url', logo_url, 'brand_color', brand_color,
    'phone', phone, 'email', email,
    -- THE PUBLIC city/state ONLY. Never organizations.city — that is the mailing/
    -- home address. nullif('') so an empty string reads as unset rather than as a
    -- blank locality, and there is deliberately NO fallback to the real column.
    'city',  nullif(settings->>'public_city', ''),
    'state', nullif(settings->>'public_state', ''),
    'splash_headline',    settings->>'splash_headline',
    'splash_tagline',     settings->>'splash_tagline',
    'splash_bg_url',      settings->>'splash_bg_url',
    'splash_bullets',     settings->>'splash_bullets',
    'splash_credentials', settings->>'splash_credentials'
  )
  from public.organizations where id = p_org;
$$;

comment on function public.public_org(uuid) is
  'Public projection of an organization for anonymous lead pages. city/state are the PUBLIC overrides only (settings.public_city/public_state) and fail closed to NULL — organizations.city is a mailing/home address and must never cross this boundary. 0173.';
