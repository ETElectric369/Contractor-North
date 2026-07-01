-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0092: lead referral attribution
-- "Brian at the bar": any employee shares THEIR inquiry link/QR (…/inquire/{org}?ref={profile_id});
-- a lead that arrives through it is tagged referred_by so commission is a lookup, not a memory.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.inquiries
  add column if not exists referred_by uuid references public.profiles(id) on delete set null;

-- Single-signature replace (DROP first): keeping the old 9-arg overload alongside a 10-arg one
-- would make PostgREST named-arg calls from the ALREADY-DEPLOYED public form ambiguous (PGRST203).
-- With one function + a defaulted p_ref, old callers keep working and new callers pass the ref.
drop function if exists public.submit_inquiry(uuid, text, text, text, text, text, text, text, text);

create or replace function public.submit_inquiry(
  p_org     uuid,
  p_name    text,
  p_email   text default null,
  p_phone   text default null,
  p_message text default null,
  p_address text default null,
  p_city    text default null,
  p_state   text default null,
  p_zip     text default null,
  p_ref     uuid default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_ref uuid;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'Name is required';
  end if;
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'Unknown organization';
  end if;

  -- Attribution is best-effort and can never block a lead: only store a ref that is a real
  -- profile IN THIS ORG (an arbitrary/forged uuid in the URL is silently dropped).
  select id into v_ref from public.profiles where id = p_ref and org_id = p_org;

  insert into public.inquiries (
    org_id, name, email, phone, address, city, state, zip,
    message, source, status, type, referred_by
  ) values (
    p_org,
    left(btrim(p_name), 200),
    nullif(left(btrim(coalesce(p_email, '')), 200), ''),
    nullif(left(btrim(coalesce(p_phone, '')), 50), ''),
    nullif(left(btrim(coalesce(p_address, '')), 300), ''),
    nullif(left(btrim(coalesce(p_city, '')), 100), ''),
    nullif(left(btrim(coalesce(p_state, '')), 50), ''),
    nullif(left(btrim(coalesce(p_zip, '')), 20), ''),
    nullif(left(btrim(coalesce(p_message, '')), 2000), ''),
    'public_form', 'new', 'residential', v_ref
  );
end $$;

grant execute on function public.submit_inquiry(uuid, text, text, text, text, text, text, text, text, uuid) to anon, authenticated;
