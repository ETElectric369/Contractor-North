-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0129: inspection pipeline plumbing
--
-- 1. appointments.inquiry_id — provenance backlink from an appointment (site
--    inspection booked off a lead, or a customer's public "schedule inspection"
--    tap) to the inquiry it came from. Mirrors jobs.inquiry_id / quotes.inquiry_id.
--    Lets the lead flow stay OPEN (deferred-customer doctrine: no customer row
--    is forced at inspection time) while the calendar entry still knows its lead —
--    and lets a re-proposal withdraw the lead's earlier pending pick-a-time link
--    instead of orphaning it.
--
-- 2. appointments.capture — the on-site inspection field capture (notes,
--    measurements, materials needed, photo storage paths) filled in on the
--    appointment's capture surface and read by /quotes/new to prefill the
--    estimator scope. jsonb so the shape can grow without more migrations:
--    { notes, measurements, materials, photos: ["<org_id>/appointments/<id>/…"] }
--    Photos live in the private `documents` bucket (org-scoped paths, signed
--    URLs on read) — same pipeline as job photos.
--
-- Run AFTER 0128.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.appointments
  add column if not exists inquiry_id uuid references public.inquiries(id) on delete set null,
  add column if not exists capture jsonb;

-- Partial index: the dedup/withdraw lookup ("pending proposal for this lead?")
-- and the lead → appointments join both filter on inquiry_id; most rows are null.
create index if not exists appointments_inquiry_idx
  on public.appointments(inquiry_id)
  where inquiry_id is not null;
