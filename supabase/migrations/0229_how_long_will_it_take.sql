-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0229: how long is it going to take
--
-- Erik, planning a real week: "I see all the jobs but have no way to determine what goes where
-- with the information visible and what i need to know is how much time they are going to take
-- hours or days … if one has 6 hours set and the other has 1 hour set i can see that the visit is
-- on the way and choose to plan it/its for before or after."
--
-- Duration is modelled NOWHERE in this schema. Not on jobs, not on appointments. `scheduled_start`
-- and `scheduled_end` are a date SPAN — which days a job occupies — and say nothing about effort:
-- a job spanning Mon–Tue might be sixteen hours or might be two two-hour visits. Every walk-through
-- in production has a null `ends_at`, so appointments are POINTS, not blocks.
--
-- That single gap is why the calendar cannot answer the only question that matters when filling a
-- day: does this fit? It is also why he says the same thing every contractor says — the reason
-- people run five separate tools is that no one of them owns both the work and the clock.
--
-- ── ONE UNIT: MINUTES ──────────────────────────────────────────────────────────────────────
--
-- "Hours or days" are the same measurement at different scales, and storing two fields would mean
-- two things to keep in step and a rule about which wins. Minutes hold both — 60 is an hour, 480
-- is a working day — and the UI renders whichever reads better ("6h", "2 days").
--
-- NULLABLE, ALWAYS. Fragment-first: a job with no estimate is not an error, it is a job nobody has
-- sized yet, and the app must never demand the number before it will let you plan. An absent
-- duration renders as "—", never as zero, because zero is a claim and blank is the truth.
--
-- Deliberately NOT derived from logged hours or from the estimate's labour lines. Those are what
-- it COST; this is what he expects it to TAKE, decided up front — his words, "figure outer at the
-- beginning". Conflating a plan with an actual is how a schedule quietly becomes a report.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.jobs         add column if not exists planned_minutes integer;
alter table public.appointments add column if not exists planned_minutes integer;

-- A negative duration is not a shorter job, it is a typo. A month is not a plan either — anything
-- past that is a project, and it belongs to the schedule's date span rather than to one block.
alter table public.jobs         drop constraint if exists jobs_planned_minutes_sane;
alter table public.jobs         add  constraint jobs_planned_minutes_sane
  check (planned_minutes is null or (planned_minutes > 0 and planned_minutes <= 60 * 24 * 30));
alter table public.appointments drop constraint if exists appointments_planned_minutes_sane;
alter table public.appointments add  constraint appointments_planned_minutes_sane
  check (planned_minutes is null or (planned_minutes > 0 and planned_minutes <= 60 * 24 * 30));

comment on column public.jobs.planned_minutes is
  'Expected effort in minutes, set up front — 60 = an hour, 480 = a working day. NOT derived from '
  'logged time or estimate labour: this is the PLAN, those are the ACTUAL. Null = not sized yet.';
comment on column public.appointments.planned_minutes is
  'Expected effort in minutes. A walk-through is typically 60–90; a service call an hour or two. '
  'Null = not sized yet, which renders as a dash and never as zero.';

-- ── A SENSIBLE STARTING POINT, only where the shape is already known ───────────────────────
--
-- Backfilled ONLY where an appointment already carries a real start AND end — that span is a
-- duration somebody actually entered, so reading it is not a guess. Everything else stays null:
-- inventing 90 minutes for every existing walk-through would put numbers on his screen that no
-- human chose, and he would have no way to tell those from the ones he set.
update public.appointments
   set planned_minutes = greatest(15, least(60 * 24 * 30,
         (extract(epoch from (ends_at - starts_at)) / 60)::int))
 where planned_minutes is null
   and starts_at is not null and ends_at is not null
   and ends_at > starts_at;
