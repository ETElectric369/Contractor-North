-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0007: document template choice
-- Adds doc_template to organizations so each company can pick the look of its
-- printed quotes and invoices. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.organizations
  add column if not exists doc_template text not null default 'classic';
