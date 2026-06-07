-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0006: structured org address
-- Adds city / state / zip to organizations so the company address can be
-- entered and printed like a normal address. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.organizations
  add column if not exists city  text,
  add column if not exists state text,
  add column if not exists zip   text;
