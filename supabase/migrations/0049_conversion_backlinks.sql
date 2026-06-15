-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0049: quote backlinks on work orders & material
-- lists so quote→WO and quote→material-list become idempotent (like quote→
-- invoice/job) and the spawned record can link back to its source quote.
-- Also records a material list's source on the PO it seeds (provenance).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.work_orders
  add column if not exists quote_id uuid references public.quotes(id) on delete set null;

alter table public.material_lists
  add column if not exists quote_id uuid references public.quotes(id) on delete set null;

alter table public.purchase_orders
  add column if not exists source_list_id uuid references public.material_lists(id) on delete set null;

create index if not exists work_orders_quote_id_idx on public.work_orders(quote_id);
create index if not exists material_lists_quote_id_idx on public.material_lists(quote_id);
create index if not exists purchase_orders_source_list_id_idx on public.purchase_orders(source_list_id);
