-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0016: running job notes
-- A free-form notes field on jobs (separate from the scope/description).
-- Run AFTER 0001.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.jobs add column if not exists notes text;
