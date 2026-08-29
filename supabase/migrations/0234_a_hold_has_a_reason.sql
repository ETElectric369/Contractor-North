-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0234: a hold has a reason
--
-- Erik, parking Tanager Ln for its permit: "the tanager job requires a permit so im thinking that
-- any On Hold job should have a reason and therefore needs an action."
--
-- That second clause is the design. "On hold" alone is a shrug — it tells you the job is parked
-- and nothing about what un-parks it. "On hold — waiting on the permit" is an ACTION wearing a
-- status: the moment the PUD calls back, you know exactly which job just woke up. Same shape as
-- the why-line law: the reason is where the answer lands.
--
-- Nullable — an old hold without a reason is still a hold — but the UI asks for one at the moment
-- of parking, because that is the only moment anybody remembers why.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.jobs add column if not exists hold_reason text;

comment on column public.jobs.hold_reason is
  'Why this job is parked — "waiting on the permit", "customer traveling until Oct". Written when '
  'status goes on_hold, cleared when it comes off. The reason IS the next action.';
