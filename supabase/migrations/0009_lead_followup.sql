-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0009: lead follow-up tracking
-- Adds last-contacted / next-follow-up dates to customers. Run AFTER 0001.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.customers
  add column if not exists last_contacted_at timestamptz,
  add column if not exists next_follow_up_at date;

create index if not exists customers_follow_up_idx
  on public.customers(next_follow_up_at) where status = 'lead';
