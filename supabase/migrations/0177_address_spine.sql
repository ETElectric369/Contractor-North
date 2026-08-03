-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0177: the address stops being flattened
--
-- Erik: "nothing collected the pertinent initial data like address which names the
-- everything from lead to invoice, i dont want to have to be digging around to enter
-- the most simple and pertinent data."
--
-- The forwards/backwards audit traced the address through every stage and found it is
-- captured properly EXACTLY ONCE and then degrades:
--
--   inquiries   address, city, state, zip   ← structured, Places-resolved. The only
--                                             correct capture in the entire chain.
--   appointments  location (one text line)  ← FLATTENED. Four columns become one string,
--                                             and city/state/zip are not even fetched.
--   quotes        (nothing)                 ← DISSOLVED. No address column at all; the
--                                             site address survives only as prose inside
--                                             the scope text.
--   jobs        address, city, state, zip   ← structured again, but was being written
--                                             NULL on accept (fixed in cn-v613).
--   invoices      (nothing)                 ← the customer's mailing address only.
--
-- So the two middle stages are where it dies, and both are the stages a contractor
-- actually stands in. THIS GIVES THEM THE SAME FOUR COLUMNS EVERYTHING ELSE HAS.
--
-- WHAT THIS IS NOT. It does not migrate any existing data. `appointments.location`
-- keeps its current meaning and every reader of it keeps working unchanged — the parts
-- are ADDITIVE, written going forward by the paths that actually know them (the link
-- picker, the address autocomplete, the lead→inspection carry). Parsing existing
-- free-text location strings into parts is exactly the kind of confident guess that
-- puts a wrong city on a record, and a wrong address is worse than a blank one.
--
-- `location` therefore becomes a PROJECTION, not a second source of truth: when the
-- parts are present they are authoritative, and `location` is the one-line rendering of
-- them. When they are absent, `location` is whatever a person typed. Both are honest.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── APPOINTMENTS — the site of the visit ────────────────────────────────────
alter table public.appointments add column if not exists city  text;
alter table public.appointments add column if not exists state text;
alter table public.appointments add column if not exists zip   text;

comment on column public.appointments.location is
  'The job-site address as one line. A PROJECTION of city/state/zip when those are set (written by the address autocomplete and the link picker); otherwise whatever a person typed. Never parsed back into parts — see 0177.';
comment on column public.appointments.city is
  'Site city. Additive (0177) — absent on every row written before it, and never back-filled by guessing at location text.';

-- ── QUOTES — the estimate had NO address at all ─────────────────────────────
-- An estimate is priced FOR A PLACE: access, distance, permit jurisdiction and travel
-- all follow from it. It survived only as prose inside the scope text, so nothing could
-- query it, render it on the customer's paper, or hand it to the job it becomes.
alter table public.quotes add column if not exists address text;
alter table public.quotes add column if not exists city    text;
alter table public.quotes add column if not exists state   text;
alter table public.quotes add column if not exists zip     text;

comment on column public.quotes.address is
  'The JOB SITE this estimate prices — not the customer''s mailing address (for a landlord or property manager those differ, and sending a crew to the wrong one is the failure this exists to prevent). Additive, 0177.';

-- ── The lookup that makes "is there already a record for this address?" cheap ──
-- The link picker searches leads, customers and jobs by name OR address on every
-- keystroke (debounced). Without these it is three sequential scans per keystroke on
-- tables that grow forever.
--
-- pg_trgm FIRST — the gin_trgm_ops operator class below does not exist until it is
-- installed, and a migration that references it beforehand fails outright.
create extension if not exists pg_trgm;

create index if not exists idx_inquiries_address_trgm  on public.inquiries  using gin (address gin_trgm_ops);
create index if not exists idx_customers_address_trgm  on public.customers  using gin (address gin_trgm_ops);
create index if not exists idx_jobs_address_trgm       on public.jobs       using gin (address gin_trgm_ops);
create index if not exists idx_appointments_location   on public.appointments (org_id, location);
