-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0002: Purchasing + Inventory
-- Run AFTER 0001_init.sql in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

do $$ begin
  create type po_status as enum ('draft', 'sent', 'partial', 'received', 'cancelled');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- INVENTORY
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.inventory_items (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  part_number      text,
  description      text,
  category         text,
  unit             text not null default 'ea',
  quantity_on_hand numeric(12,2) not null default 0,
  reorder_point    numeric(12,2) not null default 0,
  unit_cost        numeric(12,2),
  vendor           text,
  location         text,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists inventory_part_idx on public.inventory_items(part_number);

-- ─────────────────────────────────────────────────────────────────────────────
-- PURCHASE ORDERS
-- ─────────────────────────────────────────────────────────────────────────────
create sequence if not exists po_number_seq;
create table if not exists public.purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  po_number    text not null unique default ('PO-' || lpad(nextval('po_number_seq')::text, 5, '0')),
  vendor       text not null default 'CED',
  status       po_status not null default 'draft',
  job_id       uuid references public.jobs(id) on delete set null,
  notes        text,
  subtotal     numeric(12,2) not null default 0,
  total        numeric(12,2) not null default 0,
  ordered_at   timestamptz,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists po_job_idx on public.purchase_orders(job_id);
create index if not exists po_status_idx on public.purchase_orders(status);

create table if not exists public.purchase_order_items (
  id           uuid primary key default gen_random_uuid(),
  po_id        uuid not null references public.purchase_orders(id) on delete cascade,
  description  text not null,
  part_number  text,
  quantity     numeric(12,2) not null default 1,
  unit         text default 'ea',
  unit_cost    numeric(12,2) not null default 0,
  line_total   numeric(12,2) generated always as (round(quantity * unit_cost, 2)) stored,
  received_qty numeric(12,2) not null default 0,
  sort_order   int not null default 0
);
create index if not exists po_items_po_idx on public.purchase_order_items(po_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at triggers (reuse touch_updated_at from 0001)
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['inventory_items','purchase_orders'] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s;', t);
    execute format(
      'create trigger touch_%1$s before update on public.%1$s
       for each row execute function public.touch_updated_at();', t);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: read = any member, write = staff (office+). Reuses helpers from 0001.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.inventory_items       enable row level security;
alter table public.purchase_orders        enable row level security;
alter table public.purchase_order_items   enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'inventory_items','purchase_orders','purchase_order_items'
  ] loop
    execute format('drop policy if exists %1$s_read on public.%1$s;', t);
    execute format(
      'create policy %1$s_read on public.%1$s for select using (public.is_member());', t);
    execute format('drop policy if exists %1$s_write on public.%1$s;', t);
    execute format(
      'create policy %1$s_write on public.%1$s for all
         using (public.is_staff()) with check (public.is_staff());', t);
  end loop;
end $$;
