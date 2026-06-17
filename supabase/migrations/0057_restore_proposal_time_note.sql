-- 0057 — Restore time_note to the public schedule-proposal payload.
--
-- Migration 0041 added schedule_proposals.time_note (the office's optional
-- "arrival window", e.g. "8–10 AM") and surfaced it in get_schedule_proposal so
-- the customer's pick page could show it. Migration 0052 then redefined that
-- same function (to add appointment proposals) and inadvertently DROPPED the
-- 'time_note' key — so the office UI still collects an arrival window and even
-- promises "Shown to the customer with every date option", but the customer
-- never saw it. This re-adds the field. Pure additive change to the returned
-- JSON; the slot-choosing function is untouched.

create or replace function public.get_schedule_proposal(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'org_name', o.name,
    'logo_url', o.logo_url,
    'brand_color', o.brand_color,
    'phone', o.phone,
    'kind', case when sp.appointment_id is not null then 'appointment' else 'job' end,
    'label', coalesce(a.title, j.name),
    'address', coalesce(a.location, j.address),
    'time_note', sp.time_note,
    'dates', sp.dates,
    'status', sp.status,
    'chosen_date', sp.chosen_date,
    'chosen_at', sp.chosen_at
  )
  from public.schedule_proposals sp
  left join public.jobs j on j.id = sp.job_id
  left join public.appointments a on a.id = sp.appointment_id
  join public.organizations o on o.id = sp.org_id
  where sp.token = p_token;
$$;

grant execute on function public.get_schedule_proposal(text) to anon, authenticated;
