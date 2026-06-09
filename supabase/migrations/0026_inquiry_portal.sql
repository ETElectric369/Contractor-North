-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0026: public inquiry portal
-- Lets an anonymous visitor submit a lead to an org from a public splash page,
-- and read minimal public branding for that page. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

-- Minimal public branding for the inquiry splash page.
create or replace function public.public_org(p_org uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'name', name, 'logo_url', logo_url, 'brand_color', brand_color,
    'phone', phone, 'email', email, 'city', city, 'state', state
  )
  from public.organizations where id = p_org;
$$;

-- Anonymous lead submission → creates a customer with status 'lead'.
create or replace function public.submit_inquiry(
  p_org     uuid,
  p_name    text,
  p_email   text default null,
  p_phone   text default null,
  p_message text default null,
  p_address text default null,
  p_city    text default null,
  p_state   text default null,
  p_zip     text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Name is required';
  end if;
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'Unknown organization';
  end if;

  insert into public.customers (
    org_id, name, email, phone, address, city, state, zip, status, type, notes
  ) values (
    p_org,
    left(btrim(p_name), 200),
    nullif(left(btrim(coalesce(p_email, '')), 200), ''),
    nullif(left(btrim(coalesce(p_phone, '')), 50), ''),
    nullif(left(btrim(coalesce(p_address, '')), 300), ''),
    nullif(left(btrim(coalesce(p_city, '')), 100), ''),
    nullif(left(btrim(coalesce(p_state, '')), 50), ''),
    nullif(left(btrim(coalesce(p_zip, '')), 20), ''),
    'lead', 'residential',
    nullif('[Web inquiry] ' || left(btrim(coalesce(p_message, '')), 2000), '[Web inquiry] ')
  );
end $$;

grant execute on function public.public_org(uuid) to anon, authenticated;
grant execute on function public.submit_inquiry(uuid, text, text, text, text, text, text, text, text) to anon, authenticated;
