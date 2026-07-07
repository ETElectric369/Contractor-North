-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0104: scope category on estimate lines
-- The linchpin for budget-vs-actual: every estimate line can carry a scope
-- CATEGORY (Demo, Framing, Decking, Railing, Electrical, …) — the same "group"
-- the grouped quote builder (cn-v411) already shows but used to DROP on save, so
-- Chris's grouped estimates lost their groups on reload. Persisting it (1) makes
-- grouped estimates survive a save/reload, and (2) gives the budget its per-
-- category buckets so an estimate can later be compared to actual costs by scope
-- (the SUMIF-by-category variance in the Tahoe Deck Budget-vs-Actual sheet). Run
-- AFTER 0001. Nullable + additive: existing quotes/lines are untouched.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.quote_line_items
  add column if not exists category text;
