-- 0188 — A SERVICE CALL IS A KIND OF BOOKING, NOT A QUESTION ON THE WALK-THROUGH.
--
-- Erik, choosing between two options for where the service-call flag should live:
--   "At booking: [ Service call ] [ Contract job ] → service calls land on the job board →
--    walk-through never asks; it already knows"
--
-- WHY IT MOVED. His walk-through opened with "Is this a service call, or a job?" and that question
-- was doing damage out of proportion to its size. He tapped "Contract job" — honestly — for eight
-- unrelated small tasks at Sarah Cain's house, and that one tap switched on four subpanel questions
-- written for a wire run. His own words for it: a wall to everything else he could possibly say in
-- the scope.
--
-- The deeper problem is that it was asked at the wrong moment. Service-call-or-job is known when
-- the PHONE RINGS — Alexa knows it while she is writing the address down — and by the time he is
-- standing in the kitchen it is the one thing on the sheet he is certain of. A question whose
-- answer is already settled is not gathering information, it is confirming it, and confirmation
-- belongs nowhere near a ladder.
--
-- WHY A TYPE AND NOT A NEW COLUMN. appointments.type already carries exactly this shape: what kind
-- of visit this is, chosen at booking, printed on the calendar, and read by the Sales tab through
-- isInspectionType(). Adding a boolean beside it would make two facts where there is one, and they
-- would eventually disagree. The column is text with a CHECK, so widening the CHECK is the whole
-- schema change.
--
-- The board that consumes it is a separate build. This is the flag it will read, and it is useful
-- before that lands: "service call" on the calendar and in the day's list is already worth having.

alter table public.appointments drop constraint if exists appointments_type_check;

alter table public.appointments add constraint appointments_type_check
  check (type = any (array[
    'appointment'::text,
    'quote'::text,
    'meeting'::text,
    'inspection'::text,
    'final_inspection'::text,
    'service_call'::text,
    'other'::text
  ]));
