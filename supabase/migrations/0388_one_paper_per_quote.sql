-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0388: one work order and one materials list per estimate
--
-- Both builders (lib/estimate/work-order-from-quote, take-off-from-quote) are idempotent by READ:
-- "is there one for this quote already? open it; else make one." Two doors landing in the same second
-- — the customer's own Accept link (finishPublicAcceptance, cn-v1075) and the office's accept, or two
-- staff taps — both read "none" and both insert, and the job carries two work orders (two numbers
-- spent) and two lists. The skeptic's note on W3 (2026-10-10): nothing in the database said
-- otherwise. Now it does, the way tasks_job_source_key_uq (0358) does for a job's tasks: the loser's
-- insert is refused (23505), and both builders read the refusal as "the other door won" and return
-- the row that is there.
--
-- Production had no duplicate on either table when this was written (read-only count, every
-- company), so the index builds. The plain indexes (work_orders_quote_id_idx,
-- material_lists_quote_id_idx) stay; these are the UNIQUE partner on the same column. A null quote_id
-- (a hand-made work order, a job's own list) is outside the rule.
--
-- Additive and twice-safe (IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════════

create unique index if not exists work_orders_one_per_quote_uq
  on public.work_orders (quote_id)
  where quote_id is not null;
comment on index public.work_orders_one_per_quote_uq is
  'One work order per estimate (0388). The second door to land reads 23505 as "the other won".';

create unique index if not exists material_lists_one_per_quote_uq
  on public.material_lists (quote_id)
  where quote_id is not null;
comment on index public.material_lists_one_per_quote_uq is
  'One materials take-off per estimate (0388). The second door to land reads 23505 as "the other won".';
