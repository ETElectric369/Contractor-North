-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0045: Organize My archive + voice notes
-- • file_url becomes nullable so a typed/voice note (no photo) is a valid item.
-- • status already free text (default 'filed'); we now use a third value
--   'archived' for items set aside without filing. The main view shows only
--   'needs_review'; the Archive view shows 'filed' + 'archived'.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.organized_items alter column file_url drop not null;
