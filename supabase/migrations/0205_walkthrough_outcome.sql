-- 0205 — HOW A WALK-THROUGH ENDS (Erik, 8/19).
--
-- "mineral springs is done and paid, 10191 donner pass rd i lost the bid … theres some work that
-- needs to be done on the logic system", and: "it would be the one in the same with the estimate
-- acceptance."
--
-- The Needs-action inbox asked one question — "has an ESTIMATE been written for this visit?" —
-- and treated every other ending as unfinished business. But a walk-through really ends four ways:
--
--   · an estimate gets written        → already recognised (a quote linked to it)
--   · the work just gets DONE and billed → recognised now, in code: money is an outcome
--   · you LOSE the bid                 → had no representation anywhere in the app
--   · you decide not to pursue it      → same
--
-- So Donner Pass sat in his inbox with no way out: it has no customer, no inquiry, no job, no
-- capture and no estimate — marking "Declined" had nothing to write to, which is exactly why it
-- "didn't save". This column is that missing place, and it is deliberately ON THE APPOINTMENT so
-- an orphaned visit can still be settled by the person who was standing there.
--
-- SAME CONCEPT AS THE ESTIMATE'S STATUS, per his instruction: declining an estimate stamps 'lost'
-- on the walk-through behind it, accepting stamps 'won'. One decision, recorded wherever it is
-- made, visible everywhere it matters.

alter table public.appointments
  add column if not exists outcome text,
  add column if not exists outcome_at timestamptz;

alter table public.appointments
  drop constraint if exists appointments_outcome_check;
alter table public.appointments
  add constraint appointments_outcome_check
  check (outcome is null or outcome in ('won', 'lost', 'no_bid'));

comment on column public.appointments.outcome is
  'How this walk-through ended (0205): won / lost / no_bid. Set by hand from the inbox, or stamped by an estimate being accepted or declined — one decision, one meaning. NULL = still open business.';
