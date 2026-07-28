-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0174: the address is the BUSINESS's call
--
-- 0173 stopped public_org() from leaking organizations.city (it was printing the
-- owner's home town on /inquire). Correct fix, wrong law: it left the platform
-- unable to publish a street address AT ALL.
--
-- Erik: "the publishing of an address is up to the business, a lot of business do
-- publish addresses but we are not so that cant be a hard rule, this has to adapt
-- to the GBP of each person's need and be completely compartmentalized."
--
-- Right. A contractor with a shop or a yard WANTS a full address on the web and in
-- their Google listing — it is a ranking and trust asset for them. A one-truck
-- operator working out of the house must not publish one. The platform must serve
-- both, and it is not the platform's business which one a tenant is.
--
-- SO THE RULE IS NOT "never publish an address". It is:
--   publish EXACTLY what the owner typed into the public_* fields, at whatever
--   level of detail they chose — street, or city/state only, or nothing —
--   and NEVER anything from organizations.address_line1/city/state/zip, which is
--   the mailing/billing address used on invoices and internally.
--
-- That separation is the actual guarantee, and it is what "compartmentalized"
-- means here: two different stores for two different purposes, with no fallback
-- path between them. It holds identically for the tenant who publishes a full
-- street address and the one who publishes nothing.
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
    -- The PUBLIC address fields, whatever the owner chose to fill in. nullif('') so a
    -- blank reads as unset. There is deliberately NO fallback to the organizations
    -- columns for any of these — not even for state, which 0173's caller still did.
    'address', nullif(settings->>'public_address', ''),
    'city',    nullif(settings->>'public_city', ''),
    'state',   nullif(settings->>'public_state', ''),
    'zip',     nullif(settings->>'public_zip', ''),
    'splash_headline',    settings->>'splash_headline',
    'splash_tagline',     settings->>'splash_tagline',
    'splash_bg_url',      settings->>'splash_bg_url',
    'splash_bullets',     settings->>'splash_bullets',
    'splash_credentials', settings->>'splash_credentials'
  )
  from public.organizations where id = p_org;
$$;

comment on function public.public_org(uuid) is
  'Public projection of an organization for anonymous lead pages. The address fields are the PUBLIC ones only (settings.public_address/city/state/zip) — whatever detail the owner chose to publish, including a full street address if they want one. organizations.address_line1/city/state/zip is the mailing/billing address and never crosses this boundary. 0174 (supersedes 0173).';
