-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0105: scope category on costs (budget-vs-actual)
-- The ACTUAL side of per-scope budget-vs-actual. bills.category is the ACCOUNTING
-- type ("Materials","Fuel"…); scope_category is the JOB SCOPE (Framing, Decking,
-- Electrical…) — the SAME strings a job's estimate lines carry in
-- quote_line_items.category (0104), so budget (estimate) and actual (costs) join by
-- scope. The receipt AI auto-tags this from the job's own scopes; a receipt stays
-- NULL → "Uncategorized" until tagged. Nullable/additive, no RLS change (bills RLS
-- already scopes by org). Run AFTER 0017.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.bills
  add column if not exists scope_category text;
