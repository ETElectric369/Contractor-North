-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0041:
--  • time_entries.rate_override — per-entry pay rate (e.g. owner logging
--    supervisor time at a different rate than the default profile rate). Job
--    costing uses rate_override when set, else the profile's hourly_rate.
--  • schedule_proposals.time_note — an optional arrival/time window the office
--    offers the customer alongside the proposed dates ("8–10 AM arrival").
--  • profiles.home_address (+ lat/lng) — employee home, used as the mileage
--    origin so per-employee round-trip miles can auto-calculate.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.time_entries
  add column if not exists rate_override numeric(10,2);

alter table public.schedule_proposals
  add column if not exists time_note text;

alter table public.profiles
  add column if not exists home_address text,
  add column if not exists home_lat numeric(9,6),
  add column if not exists home_lng numeric(9,6);

-- Surface the time window on the public customer pick page.
create or replace function public.get_schedule_proposal(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'org_name', o.name,
    'logo_url', o.logo_url,
    'brand_color', o.brand_color,
    'phone', o.phone,
    'job_name', j.name,
    'address', j.address,
    'dates', sp.dates,
    'time_note', sp.time_note,
    'status', sp.status,
    'chosen_date', sp.chosen_date
  )
  from public.schedule_proposals sp
  join public.jobs j on j.id = sp.job_id
  join public.organizations o on o.id = sp.org_id
  where sp.token = p_token;
$$;
grant execute on function public.get_schedule_proposal(text) to anon, authenticated;
