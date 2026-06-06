-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0003: Billing (invoices + payments)
-- Run AFTER 0001 and 0002 in the Supabase SQL editor.
-- ═══════════════════════════════════════════════════════════════════════════

do $$ begin
  create type invoice_status as enum ('draft', 'sent', 'partial', 'paid', 'overdue', 'void');
exception when duplicate_object then null; end $$;

create sequence if not exists invoice_number_seq;
create table if not exists public.invoices (
  id              uuid primary key default gen_random_uuid(),
  invoice_number  text not null unique default ('INV-' || lpad(nextval('invoice_number_seq')::text, 5, '0')),
  customer_id     uuid references public.customers(id) on delete set null,
  job_id          uuid references public.jobs(id) on delete set null,
  quote_id        uuid references public.quotes(id) on delete set null,
  status          invoice_status not null default 'draft',
  title           text,
  notes           text,
  tax_rate        numeric(6,4) not null default 0,
  subtotal        numeric(12,2) not null default 0,
  tax             numeric(12,2) not null default 0,
  total           numeric(12,2) not null default 0,
  amount_paid     numeric(12,2) not null default 0,
  due_date        date,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists invoices_customer_idx on public.invoices(customer_id);
create index if not exists invoices_status_idx on public.invoices(status);

create table if not exists public.invoice_items (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  description text not null,
  quantity    numeric(12,2) not null default 1,
  unit        text default 'ea',
  unit_price  numeric(12,2) not null default 0,
  line_total  numeric(12,2) generated always as (round(quantity * unit_price, 2)) stored,
  sort_order  int not null default 0
);
create index if not exists invoice_items_invoice_idx on public.invoice_items(invoice_id);

create table if not exists public.payments (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  amount      numeric(12,2) not null,
  method      text not null default 'check',   -- check, card, cash, ach, other
  note        text,
  paid_at     timestamptz not null default now(),
  recorded_by uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index if not exists payments_invoice_idx on public.payments(invoice_id);

-- updated_at trigger
drop trigger if exists touch_invoices on public.invoices;
create trigger touch_invoices before update on public.invoices
  for each row execute function public.touch_updated_at();

-- RLS: read = member, write = staff
alter table public.invoices      enable row level security;
alter table public.invoice_items enable row level security;
alter table public.payments      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['invoices','invoice_items','payments'] loop
    execute format('drop policy if exists %1$s_read on public.%1$s;', t);
    execute format(
      'create policy %1$s_read on public.%1$s for select using (public.is_member());', t);
    execute format('drop policy if exists %1$s_write on public.%1$s;', t);
    execute format(
      'create policy %1$s_write on public.%1$s for all
         using (public.is_staff()) with check (public.is_staff());', t);
  end loop;
end $$;
