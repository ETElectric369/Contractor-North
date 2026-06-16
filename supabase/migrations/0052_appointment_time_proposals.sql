-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0052: unified date+TIME proposals
-- Generalises "propose 3 dates" to also cover APPOINTMENTS and per-option TIMES.
-- A proposal can target a job (legacy, date-only) or an appointment (new,
-- date+time). Customers pick a slot by index; times honor the org timezone.
-- Backward compatible: legacy date-only job proposals + choose_schedule_date
-- keep working. Run AFTER 0039.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.schedule_proposals
  add column if not exists appointment_id uuid references public.appointments(id) on delete cascade,
  add column if not exists chosen_at timestamptz;
alter table public.schedule_proposals alter column job_id drop not null;
create index if not exists schedule_proposals_appt_idx on public.schedule_proposals(appointment_id, status);

-- Tentative appointments awaiting a customer pick get their own status, so the
-- calendar can show them as a toggleable "pending" layer.
alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status = any (array['scheduled', 'completed', 'cancelled', 'proposed']));

-- Public read: works for a job OR an appointment; returns the option list
-- (`dates` holds ["YYYY-MM-DD"] legacy, or [{"date","time"}] with times).
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

-- Public pick by option index (0-based). Honors the org timezone for time-of-day.
create or replace function public.choose_schedule_slot(p_token text, p_index int)
returns json language plpgsql security definer set search_path = public as $$
declare
  v       record;
  v_slot  jsonb;
  v_date  date;
  v_time  text;
  v_tz    text;
  v_start timestamptz;
begin
  select * into v from public.schedule_proposals where token = p_token;
  if not found then raise exception 'Unknown link'; end if;
  if v.status <> 'pending' then raise exception 'This link was already used'; end if;

  v_slot := v.dates -> p_index;
  if v_slot is null then raise exception 'That option is no longer available'; end if;

  if jsonb_typeof(v_slot) = 'string' then
    v_date := (v_slot #>> '{}')::date;
    v_time := null;
  else
    v_date := (v_slot ->> 'date')::date;
    v_time := nullif(v_slot ->> 'time', '');
  end if;

  v_tz := coalesce((select settings ->> 'timezone' from public.organizations where id = v.org_id), 'America/Los_Angeles');
  v_start := (v_date::text || ' ' || coalesce(v_time, '08:00'))::timestamp at time zone v_tz;

  update public.schedule_proposals
    set status = 'confirmed', chosen_date = v_date, chosen_at = v_start
    where id = v.id;

  if v.appointment_id is not null then
    update public.appointments
      set starts_at = v_start,
          ends_at = coalesce(ends_at, v_start + interval '1 hour'),
          status = 'scheduled'
      where id = v.appointment_id;
  elsif v.job_id is not null then
    update public.jobs
      set scheduled_start = case when v_time is not null then v_start else (v_date::timestamptz + interval '15 hours') end,
          scheduled_end   = case when v_time is not null then v_start + interval '8 hours' else (v_date::timestamptz + interval '23 hours') end,
          status = 'scheduled',
          updated_at = now()
      where id = v.job_id;
  end if;

  return json_build_object('ok', true, 'chosen_at', v_start);
end $$;

grant execute on function public.get_schedule_proposal(text) to anon, authenticated;
grant execute on function public.choose_schedule_slot(text, int) to anon, authenticated;
