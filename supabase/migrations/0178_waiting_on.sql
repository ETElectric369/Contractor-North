-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0178: waiting on somebody else
--
-- Erik: "there is a difference between to be inspected and waiting for inspection to
-- proceed like i have a couple on hold that keep popping up because i keep bumping the
-- dates back but we are waiting on permits to do the work because panel swaps with
-- meters attached need to be permitted first and arent going on the calendar until we
-- get notice."
--
-- TWO STATES THAT LOOK THE SAME AND ARE OPPOSITE:
--   TO BE INSPECTED          the work is done, an inspection needs booking. An ACTION,
--                            on him, schedulable today.
--   WAITING TO PROCEED       the work CANNOT START until somebody else acts. A BLOCK,
--                            not schedulable, and asking for a date is meaningless.
--
-- The app only had `on_hold`, which is a status carrying NO reason and NO trigger. So the
-- second state got encoded as the only field available — a date — which then has to be
-- maintained by hand forever. In production right now:
--
--   200A Service Upgrade   on_hold, start Aug 31, created Jul 16, TOUCHED TODAY (bumped again)
--   Tao Zhu                on_hold, start Jul 9  — a date a month in the past
--   TTP #56                on_hold, start Jun 17 — same
--
-- THE FIX IS NOT A BETTER DATE FIELD. It is removing the requirement for one. A permit
-- office does not tell you when it will call. Inventing a date so a row stops looking
-- wrong is the app making a person lie to it, and then charging him rent on the lie every
-- week.
--
-- WHAT REPLACES IT — a WHY and a SINCE, and deliberately no UNTIL:
--   blocked_on     the reason IN HIS WORDS. "County permit for the meter swap."
--   blocked_since  when the wait started.
--
-- `blocked_since` is the whole point. What he actually needs to see is not a date he made
-- up, it is AGE: "waiting 19 days on the county" is a fact that should get louder on its
-- own, and is the thing you call somebody about. A made-up date can only ever be wrong or
-- moved; an age is true the moment it is written and stays true without maintenance.
--
-- Nothing here changes `status`. on_hold keeps meaning what it means; this says WHY, which
-- is the dimension the whole app has never had a column for.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.jobs add column if not exists blocked_on    text;
alter table public.jobs add column if not exists blocked_since date;

comment on column public.jobs.blocked_on is
  'Why this job cannot proceed, in the contractor''s own words — "county permit for the meter swap". The WHY the app never had a column for. Null = not waiting on anybody. 0178.';
comment on column public.jobs.blocked_since is
  'When the wait started. Deliberately paired with NO "until": a permit office does not tell you when it will call, and inventing a date is what forced the weekly bumping this replaces. AGE is the signal. 0178.';

-- The same distinction on a visit. An inspection appointment can be "book this" or "we are
-- waiting on the inspector to give us a window" — and only the first belongs on a calendar.
alter table public.appointments add column if not exists blocked_on    text;
alter table public.appointments add column if not exists blocked_since date;

comment on column public.appointments.blocked_on is
  'Why this visit cannot be booked yet — waiting on a permit, an inspector''s window, another trade. Null = bookable. 0178.';

-- The waiting list is read constantly (My Day, the job hub) and is always a small subset.
create index if not exists idx_jobs_blocked on public.jobs (org_id, blocked_since) where blocked_on is not null;
create index if not exists idx_appointments_blocked on public.appointments (org_id, blocked_since) where blocked_on is not null;
