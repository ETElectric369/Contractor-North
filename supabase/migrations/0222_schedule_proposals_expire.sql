-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0222: a pick-a-time link stops being good forever
--
-- schedule_proposals had no expiry of any kind, and choose_schedule_slot / choose_schedule_date
-- check only that the status is still 'pending'. So every "pick a day that works for you" link
-- ever texted to a customer is live until somebody taps it — a year later, two years later.
--
-- This is not theoretical. Checked against production while writing this: ONE pending proposal,
-- created 2026-07-20. Five weeks old, still armed. Tapping it today would set the job's
-- scheduled_start, flip its status to 'scheduled', and rewrite its calendar segments — to one of
-- the days offered five weeks ago, every one of which is now in the PAST.
--
-- That is the second half of the bug and the worse one. Nothing anywhere checked that the date
-- being chosen is still in the future. A customer finding an old text and tapping it in good
-- faith would silently reschedule a live job into last month, and the first anyone would know is
-- a crew not showing up.
--
-- So two guards, because they fail differently:
--
--   THE LINK EXPIRES — 30 days, which is far longer than any real "when works for you?" exchange
--   and short enough that a forgotten text stops being a loaded gun. Backfilled onto existing
--   rows from created_at, so the July proposal above is already expired by the time this lands
--   rather than staying armed until someone happens to look.
--
--   A DAY IN THE PAST IS REFUSED — independently, and even inside the window. A three-week-old
--   link offering last Tuesday is inside 30 days and still must not book last Tuesday.
--
-- NO DEAD ENDS (the standing ground rule). get_schedule_proposal now reports 'expired' as the
-- status rather than returning null, so /pick/<token> can say what happened in plain words and
-- show the company's phone number, instead of the customer meeting "this link isn't valid
-- anymore" and having nowhere to go.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.schedule_proposals
  add column if not exists expires_at timestamptz;

-- Existing rows date from their creation, so nothing gets a fresh 30 days out of this migration.
update public.schedule_proposals
   set expires_at = created_at + interval '30 days'
 where expires_at is null;

alter table public.schedule_proposals
  alter column expires_at set default (now() + interval '30 days');

-- ── the reader ─────────────────────────────────────────────────────────────────────────────
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
    -- An expired link reads as 'expired', never as 'pending' — the page must not offer buttons
    -- that the RPC behind them will refuse.
    'status', case
                when sp.status = 'pending' and sp.expires_at is not null and sp.expires_at < now()
                then 'expired' else sp.status end,
    'expires_at', sp.expires_at,
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

-- ── the two writers ────────────────────────────────────────────────────────────────────────
create or replace function public.choose_schedule_slot(p_token text, p_index integer)
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
  if v.expires_at is not null and v.expires_at < now() then
    raise exception 'This scheduling link has expired — please call us and we''ll find you a time';
  end if;

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

  -- INDEPENDENT OF THE WINDOW. A link three weeks old is inside 30 days and may still be
  -- offering last Tuesday. Compared in the ORG's timezone, because "today" on a schedule is the
  -- contractor's today, not UTC's.
  if v_date < (now() at time zone v_tz)::date then
    raise exception 'That day has already passed — please call us and we''ll find you a time';
  end if;

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
grant execute on function public.choose_schedule_slot(text, integer) to anon, authenticated;

create or replace function public.choose_schedule_date(p_token text, p_date date)
returns json language plpgsql security definer set search_path = public as $$
declare
  v    record;
  v_tz text;
begin
  select * into v from public.schedule_proposals where token = p_token for update;
  if not found then raise exception 'Unknown link'; end if;
  if v.status <> 'pending' then raise exception 'This link was already used'; end if;
  if v.expires_at is not null and v.expires_at < now() then
    raise exception 'This scheduling link has expired — please call us and we''ll find you a time';
  end if;
  if not (v.dates ? p_date::text) then raise exception 'That date is not one of the offered options'; end if;

  v_tz := coalesce((select settings ->> 'timezone' from public.organizations where id = v.org_id), 'America/Los_Angeles');

  if p_date < (now() at time zone v_tz)::date then
    raise exception 'That day has already passed — please call us and we''ll find you a time';
  end if;

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
grant execute on function public.choose_schedule_date(text, date) to anon, authenticated;
