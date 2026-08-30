-- THE PICK RINGS THE BELL (cn-v883).
--
-- When a customer taps a time on their /pick link, choose_schedule_slot writes the booking as
-- pure SQL from the customer's browser — no server code runs, so the boss saw NOTHING: the visit
-- just materialized on the calendar whenever a page happened to re-render. Erik: "the boss just
-- gets a notification and its already on the schedule."
--
-- This column is the once-only latch for the notify hop (/api/pick/confirmed, fired by the pick
-- page after the RPC succeeds): a compare-and-set on NULL means a retried or replayed call can
-- never ring the bell twice.
alter table public.schedule_proposals
  add column if not exists boss_notified_at timestamptz;
