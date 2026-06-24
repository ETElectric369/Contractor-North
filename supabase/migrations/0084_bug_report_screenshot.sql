-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0084: auto-screenshot on bug reports
-- The "Report a bug" button now grabs a screenshot of the screen the reporter was
-- looking at and stores it in the `documents` bucket; this column holds the path.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.bug_reports
  add column if not exists screenshot_path text;
