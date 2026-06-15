-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0050: customer credits / refunds
-- A credit (e.g. from an overpayment or return) is posted to the customer's
-- account with a disposition flag: keep it on account as a credit, or flag it
-- for accounting to issue a refund. Status tracks whether it's been resolved.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.customer_credits (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  invoice_id  uuid references public.invoices(id) on delete set null,
  amount      numeric(12,2) not null,
  disposition text not null default 'credit' check (disposition in ('credit', 'refund')),
  status      text not null default 'open' check (status in ('open', 'resolved')),
  note        text,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index if not exists customer_credits_customer_idx on public.customer_credits(customer_id);
create index if not exists customer_credits_invoice_idx on public.customer_credits(invoice_id);

alter table public.customer_credits enable row level security;

create policy customer_credits_read on public.customer_credits
  for select using (org_id = auth_org_id());
create policy customer_credits_write on public.customer_credits
  for all using (org_id = auth_org_id() and is_org_staff())
  with check (org_id = auth_org_id() and is_org_staff());

create trigger stamp_org_customer_credits
  before insert on public.customer_credits
  for each row execute function public.set_org_id();
