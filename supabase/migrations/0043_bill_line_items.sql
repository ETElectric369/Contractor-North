-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0043: itemized bills from receipts
-- A receipt photo (e.g. Home Depot) now auto-extracts its line items, so a bill
-- carries the full breakdown — qty, unit price, amount, and a per-line category —
-- not just a grand total. organized_items.line_items keeps the parsed breakdown
-- so tray items filed later still produce an itemized bill.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.bill_line_items (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  bill_id     uuid not null references public.bills(id) on delete cascade,
  description text not null,
  quantity    numeric(12,2) not null default 1,
  unit_price  numeric(12,2) not null default 0,
  amount      numeric(12,2) not null default 0,   -- line total
  category    text,
  sort_order  int not null default 0
);
create index if not exists bill_items_bill_idx on public.bill_line_items(bill_id);

drop trigger if exists stamp_org_bill_line_items on public.bill_line_items;
create trigger stamp_org_bill_line_items before insert on public.bill_line_items
  for each row execute function public.set_org_id();

alter table public.bill_line_items enable row level security;

drop policy if exists bill_line_items_rw on public.bill_line_items;
create policy bill_line_items_rw on public.bill_line_items
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

alter table public.organized_items
  add column if not exists line_items jsonb;
