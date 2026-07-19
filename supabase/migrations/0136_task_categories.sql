-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0136: free-form task categories.
-- Owner reports: "No category option" + "organize tasks by type". The fixed
-- sales|operations|office CHECK becomes the org's OWN vocabulary: category is
-- free text (the UI autocompletes from values already in use — no invented
-- taxonomy) and optional — null renders as "No category".
-- The 'operations' default STAYS so any insert path that omits the column
-- behaves exactly as before; only an explicit blank/null stores null.
-- The legacy 'office' value keeps its My-Day meaning (Office door split,
-- six-rank flagged-undated exclusion) when used.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.tasks drop constraint if exists tasks_category_check;
alter table public.tasks alter column category drop not null;

comment on column public.tasks.category is
  'Free-form org vocabulary since 0136 (was sales|operations|office). Null = uncategorized. ''office'' keeps its My-Day meaning (Office door, rank-5 exclusion) when used.';
