-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0011: per-user language preference
-- Lets employees use the app (and the AI assistant) in Spanish. Run AFTER 0001.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles
  add column if not exists language text not null default 'en';
