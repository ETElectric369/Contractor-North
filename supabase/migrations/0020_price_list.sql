-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0020: price list (priced catalog)
-- A reusable catalog of priced items/services that can be dropped onto quotes,
-- invoices, POs and bills. Separate from stock inventory_items. Supports bulk
-- import from a supplier CSV (e.g. CED). Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.price_list_items (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  code        text,                              -- supplier/part number
  description text not null,
  category    text,
  supplier    text,
  unit        text not null default 'ea',
  buy_price   numeric(12,2) not null default 0,  -- cost
  markup_pct  numeric(7,2)  not null default 0,  -- % markup over buy → sell
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists price_list_org_idx on public.price_list_items(org_id);
create index if not exists price_list_code_idx on public.price_list_items(org_id, code);

drop trigger if exists touch_price_list on public.price_list_items;
create trigger touch_price_list before update on public.price_list_items
  for each row execute function public.touch_updated_at();

drop trigger if exists stamp_org_price_list on public.price_list_items;
create trigger stamp_org_price_list before insert on public.price_list_items
  for each row execute function public.set_org_id();

alter table public.price_list_items enable row level security;

drop policy if exists price_list_read on public.price_list_items;
create policy price_list_read on public.price_list_items
  for select using (org_id = public.auth_org_id());

drop policy if exists price_list_write on public.price_list_items;
create policy price_list_write on public.price_list_items
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
