-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0047: estimate vs quote = one document, a label
-- A quote and an estimate are the same priced document, just named differently
-- at different stages. A single `doc_type` toggles the wording everywhere
-- (detail page, list, printed PDF, email).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.quotes
  add column if not exists doc_type text not null default 'quote'
  check (doc_type in ('estimate', 'quote'));
