-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0389: a discount is a line of its own kind
--
-- Erik (2026-10-10, INV-089): he traded part of the work and wanted $165 off. The price box
-- refused −165, so the only door was a customer credit — which the paper prints as PAID, not as a
-- discount. A discount is neither a payment nor "Other": it is a line that takes money off, named
-- for what it is, printed between Subtotal and Tax (invoice-document.tsx) and filed as Discount on
-- the breakdown and the portal. The app writes it only through Add A Discount (billing/actions
-- addInvoiceItem with kind 'discount', amount negative) and the Kind chip on a negative line.
--
-- 0342's CHECK listed the four kinds it knew; this re-creates it with the fifth. Idempotent: drop
-- if exists, add. Nothing else changes — the public projection (0342) already carries line_kind,
-- so every reader of the paper sees the new word the moment the deploy lands.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
alter table public.invoice_items drop constraint if exists invoice_items_line_kind_known;
alter table public.invoice_items add constraint invoice_items_line_kind_known
  check (line_kind is null or line_kind in ('labor', 'materials', 'other', 'credit', 'discount'));
comment on constraint invoice_items_line_kind_known on public.invoice_items is
  'labor / materials / other / credit (0342) / discount (0389: a negative line that prints as a Discount between Subtotal and Tax).';
