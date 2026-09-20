-- NO EM-DASHES IN USER-FACING COPY, AND A TRIGGER'S EXCEPTION IS USER-FACING COPY.
--
-- dbError passes an unrecognised database message through unchanged, so every sentence these
-- guards raise lands in front of Erik word for word. 0278's own overlap refusal broke the rule it
-- was written under, and so did the two sentences it inherited from 0214/0217. Nothing else about
-- the guard changes: same tests, same tolerance, same gate on a time actually moving.
create or replace function public.guard_time_entry_sanity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_span interval;
  v_times_changed boolean;
  v_clash record;
begin
  v_times_changed := tg_op = 'INSERT'
    or new.clock_in is distinct from old.clock_in
    or new.clock_out is distinct from old.clock_out
    or new.profile_id is distinct from old.profile_id;

  if not v_times_changed then
    return new;
  end if;

  if new.clock_in is not null and new.clock_out is not null then
    if exists (
      select 1 from public.time_entries t
       where t.profile_id = new.profile_id
         and t.id is distinct from new.id
         and t.clock_in = new.clock_in
         and t.clock_out = new.clock_out
    ) then
      raise exception 'Those exact times are already recorded for this person on another entry. Change the times, or edit that entry instead.';
    end if;

    -- A person cannot be on two jobs at once, and payroll pays for both when they are.
    select t.id, t.clock_in, t.clock_out
      into v_clash
      from public.time_entries t
     where t.profile_id = new.profile_id
       and t.id is distinct from new.id
       and t.clock_out is not null
       and t.clock_in < new.clock_out
       and new.clock_in < t.clock_out
       and least(t.clock_out, new.clock_out) - greatest(t.clock_in, new.clock_in) > interval '1 minute'
     order by t.clock_in
     limit 1;

    if found then
      raise exception 'Those hours overlap a shift already recorded for this person on % (% to %). Edit that entry instead, or move these times clear of it.',
        to_char(v_clash.clock_in at time zone 'America/Los_Angeles', 'Mon FMDD'),
        to_char(v_clash.clock_in at time zone 'America/Los_Angeles', 'FMHH12:MIam'),
        to_char(v_clash.clock_out at time zone 'America/Los_Angeles', 'FMHH12:MIam');
    end if;
  end if;

  if new.clock_in is not null and new.clock_out is not null then
    v_span := new.clock_out - new.clock_in;
    if v_span > interval '18 hours' and coalesce(new.auto_closed_reason, '') = '' then
      raise exception 'That shift is % hours long, so a punch was probably forgotten. Fix the times, or add a note saying what happened.',
        round(extract(epoch from v_span) / 3600.0, 1);
    end if;
    if v_span < interval '0' then
      raise exception 'That shift ends before it starts.';
    end if;
  end if;

  return new;
end $$;
