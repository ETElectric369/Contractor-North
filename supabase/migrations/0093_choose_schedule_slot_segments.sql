-- 0093 — the customer "pick a date" RPCs write job_schedule_segments too.
--
-- THE LAST STALE-SEGMENT TRAP: choose_schedule_slot (0052, hardened 0058) wrote
-- only jobs.scheduled_start/end when a customer picked a JOB date. The calendar
-- and planner draw a job's job_schedule_segments FIRST whenever any exist, so a
-- multi-range job whose customer tapped a new date kept rendering on its OLD
-- days — the exact bug the in-app writers were cured of (setJobScheduleRanges
-- replaces segments and mirrors the window). Make the customer path match:
-- picking a job date now REPLACES that job's segments with the picked day,
-- exactly what setJobScheduleRanges writes for a single-day range.
--
-- org_id is stamped explicitly from the proposal row: the set_org_id trigger
-- fills it from auth_org_id(), which is NULL for the anon caller of this
-- security-definer function — an unstamped row would be invisible to the org.
--
-- Signatures, security posture (security definer + pinned search_path), grants,
-- and every 0058 guard (row lock, single-use, no resurrecting a closed
-- appointment, org-tz instants) are unchanged. The legacy date-only picker
-- (choose_schedule_date, still granted for old links) gets the same fix.

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
    -- Replace the day segments too — the calendar draws segments first, so a
    -- mirror-only write left a multi-range job on its old days.
    delete from public.job_schedule_segments where job_id = v.job_id;
    insert into public.job_schedule_segments (org_id, job_id, start_date, end_date)
      values (v.org_id, v.job_id, v_date, v_date);
  end if;

  return json_build_object('ok', true, 'chosen_at', v_start);
end $$;

-- Legacy date-only picker (0039/0058): the same segment replacement.
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

  if v.job_id is not null then
    delete from public.job_schedule_segments where job_id = v.job_id;
    insert into public.job_schedule_segments (org_id, job_id, start_date, end_date)
      values (v.org_id, v.job_id, p_date, p_date);
  end if;

  return json_build_object('ok', true, 'chosen_date', p_date);
end $$;

grant execute on function public.choose_schedule_slot(text, int) to anon, authenticated;
grant execute on function public.choose_schedule_date(text, date) to anon, authenticated;
