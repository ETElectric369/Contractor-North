-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0131: final_inspection appointment type
--
-- Erik's design (2026-07-14): appointments and inspections are ONE platform —
-- an inspection IS an appointment type. This adds the one genuinely new value,
-- `final_inspection` (the end-of-job code inspection, distinct from the
-- pre-sale `inspection` site walk-through), to the 0051 check constraint.
--
-- Deliberately NOT added: `client_meeting` — Erik's client-meeting concept
-- converges onto the pre-existing `meeting` value (the TS spine relabels it
-- "Client meeting"); a second value meaning the same thing would fork the data.
--
-- The TS spine lives in src/lib/statuses.ts (APPOINTMENT_TYPES) and MIRRORS
-- this list — keep the two in lockstep.
--
-- Run AFTER 0130.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.appointments drop constraint if exists appointments_type_check;
alter table public.appointments
  add constraint appointments_type_check
  check (type in ('appointment', 'quote', 'meeting', 'inspection', 'final_inspection', 'other'));
