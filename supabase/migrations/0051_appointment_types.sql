-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0051: more appointment types
-- Allow the reasons an appointment gets booked: quote/estimate a job, meet with
-- a client, an inspection, or other (plus the legacy generic "appointment").
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.appointments drop constraint if exists appointments_type_check;
alter table public.appointments
  add constraint appointments_type_check
  check (type in ('appointment', 'quote', 'meeting', 'inspection', 'other'));
