-- 0058 — Harden the public "pick a date/time" RPCs.
--
-- Three confirmed issues in the customer-facing slot picker:
--  1. All-day JOB slots were stored as v_date + 15h/23h in the SESSION timezone
--     (UTC on Supabase), so "8am-4pm" was only right during Pacific summer and
--     ignored the org's configured timezone entirely. The TIMED branch right
--     above already did it correctly with `at time zone v_tz` — now the all-day
--     branch matches.
--  2. No row lock: two concurrent taps on the same link could both pass the
--     `status = 'pending'` check and both write. Add `for update`.
--  3. A cancelled appointment could be resurrected: choose_schedule_slot only
--     checked the PROPOSAL status, then unconditionally flipped the appointment
--     back to 'scheduled'. Guard the appointment update on `status = 'proposed'`.
--
-- Also fixes the same timezone flaw in the legacy choose_schedule_date (0039),
-- which is still granted to anon for older date-only links.

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
  select * into v from public.schedule_proposals where token = p_token for update;
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
    -- Only revive a still-tentative appointment; a cancelled/completed one stays closed.
    update public.appointments
      set starts_at = v_start,
          ends_at = coalesce(ends_at, v_start + interval '1 hour'),
          status = 'scheduled'
      where id = v.appointment_id and status = 'proposed';
    if not found then raise exception 'This appointment is no longer available'; end if;
  elsif v.job_id is not null then
    update public.jobs
      set scheduled_start = case when v_time is not null then v_start
                                 else (v_date::text || ' 08:00')::timestamp at time zone v_tz end,
          scheduled_end   = case when v_time is not null then v_start + interval '8 hours'
                                 else (v_date::text || ' 16:00')::timestamp at time zone v_tz end,
          status = 'scheduled',
          updated_at = now()
      where id = v.job_id;
  end if;

  return json_build_object('ok', true, 'chosen_at', v_start);
end $$;

-- Legacy date-only picker (0039): same timezone fix + row lock.
create or replace function public.choose_schedule_date(p_token text, p_date date)
returns json language plpgsql security definer set search_path = public as $$
declare
  v    record;
  v_tz text;
begin
  select * into v from public.schedule_proposals where token = p_token for update;
  if not found then raise exception 'Unknown link'; end if;
  if v.status <> 'pending' then raise exception 'This link was already used'; end if;
  if not (v.dates ? p_date::text) then raise exception 'That date is not one of the offered options'; end if;

  v_tz := coalesce((select settings ->> 'timezone' from public.organizations where id = v.org_id), 'America/Los_Angeles');

  update public.schedule_proposals
    set status = 'confirmed', chosen_date = p_date
    where id = v.id;

  update public.jobs
    set scheduled_start = (p_date::text || ' 08:00')::timestamp at time zone v_tz,
        scheduled_end   = (p_date::text || ' 16:00')::timestamp at time zone v_tz,
        status = 'scheduled',
        updated_at = now()
    where id = v.job_id;

  return json_build_object('ok', true, 'chosen_date', p_date);
end $$;

grant execute on function public.choose_schedule_slot(text, int) to anon, authenticated;
grant execute on function public.choose_schedule_date(text, date) to anon, authenticated;
