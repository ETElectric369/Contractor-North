-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0232: a phone call is work, and it goes on a day
--
-- Erik: "and phone call as an option too."
--
-- The rail has been telling him to make calls for weeks. Nine of his twelve leads have no phone or
-- email; Mike Scrivano has no address but a real note and a number, and his card literally reads
-- "Call to get the address" as its next action. Until now that next action was the one kind of work
-- the app could describe but not schedule — so it lived in his head, which is precisely the place
-- this whole project exists to empty.
--
-- It is also the honest tag for a chunk of the week nobody bills and everybody spends: the ten
-- minutes to the PUD, the supplier chasing a part, the customer who wants a verbal before they
-- sign. Filing those under "Meeting" or "Other" is how a day looks free right up until you live it.
--
-- 0231's reasoning applies unchanged: the vocabulary a person picks on the lead has to survive to
-- the calendar, and a kind with no word in appointments.type gets silently rewritten into one that
-- has one. Adding the word is the whole fix.
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
    'job'::text,
    -- NEW: a phone call somebody has to actually sit down and make.
    'call'::text,
    'other'::text
  ]));

-- The lead's own kind (0230) must accept it too, or the tag can be chosen on the calendar and not
-- at the phone — which is the one place the answer reliably exists.
alter table public.inquiries drop constraint if exists inquiries_work_kind_known;
alter table public.inquiries add  constraint inquiries_work_kind_known
  check (work_kind is null or work_kind in ('job', 'walkthrough', 'service', 'office', 'quote', 'call', 'other'));
