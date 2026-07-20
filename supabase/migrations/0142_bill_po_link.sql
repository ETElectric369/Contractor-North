-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0142: link a supplier bill to the PO it pays
--
-- THE BUG this closes: a job's materials were summed as (every purchase order)
-- + (every supplier bill). When the office raises PO-00012 to CED for $2,400 and
-- then files CED's invoice for that same $2,400 as a bill, the job carried $4,800
-- of material cost and "Request next payment" billed the customer TWICE for one
-- delivery — consistently, on the invoice AND the job hub AND /analytics, so no
-- surface contradicted it.
--
-- The schema had no way to say "this bill IS the invoice for that PO". Now it does.
-- Once po_id is set, the BILL SUPERSEDES THE PO everywhere material cost is summed
-- (importCostsIntoInvoice, computeJobProgress, computeJobProfitRows,
-- getJobActualByCategory) — the bill is the real, delivered, invoiced number.
--
-- Backward-safe: existing bills keep po_id NULL and behave exactly as before.
-- ON DELETE SET NULL — deleting a PO must never delete the supplier's bill.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.bills
  add column if not exists po_id uuid references public.purchase_orders(id) on delete set null;

create index if not exists bills_po_idx on public.bills(po_id);

comment on column public.bills.po_id is
  'The purchase order this bill pays. When set, the bill SUPERSEDES the PO in every material-cost sum so one delivery is never costed or billed twice.';
