-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0231: a job is a kind of booking
--
-- Erik: "i just scheduled Matt warren for monday for a whole day as a job and it showed up as an
-- inspection for an hour."
--
-- He marked the lead JOB, sized it FULL DAY, and tapped Monday. The calendar drew "Site inspection:
-- Matt Warren", one hour. Every word of that was wrong, and the tag was wrong at the root: of the
-- six kinds the app offers on a lead, five survive to the calendar and 'job' silently became
-- 'inspection', because appointments.type had no value for it.
--
-- That broke the one law this whole vocabulary exists to keep (lib/schedule/work-shape): the tag is
-- chosen ONCE, at the moment somebody knew, and is never re-decided downstream. A mapping that
-- quietly rewrites the answer is worse than having no mapping — he told the app twice (on the lead,
-- then on the day) and the app overruled him both times without saying so.
--
-- ── WHY A TYPE AND NOT A CONVERSION ────────────────────────────────────────────────────────
--
-- convertInquiry(target:'job') exists and does something much bigger: it mints a customer, stamps
-- the lead WON, and creates a job record. That is the right move when the work is sold. It is NOT
-- what "put this on Monday" asked for, and doing it silently would close a lead he only meant to
-- schedule — the deferred-customer doctrine says a contact is minted at the win, not at a booking.
--
-- So: the booking says what it is. A day marked as a job reads as a job, spans the hours he set,
-- and the lead stays open and convertible. Turning it into a real job stays a thing he chooses.
--
-- Precedent is 0188, which added 'service_call' for exactly this reason — a kind of booking the
-- office already knew about and the schema had no word for.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.appointments drop constraint if exists appointments_type_check;

alter table public.appointments add constraint appointments_type_check
  check (type = any (array[
    'appointment'::text,
    'quote'::text,
    'meeting'::text,
    'inspection'::text,
    'final_inspection'::text,
    'service_call'::text,
    -- NEW: the work itself, on a day, before anybody has minted a job record for it.
    'job'::text,
    'other'::text
  ]));

comment on column public.appointments.type is
  'The kind of booking, in the app-wide WorkKind vocabulary (lib/schedule/work-shape maps both '
  'ways). inspection/final_inspection = walk-through, service_call, quote, meeting = office, '
  'job = the work itself on a day. Chosen ONCE — on the lead, or in the schedule rail — and never '
  're-decided downstream.';
