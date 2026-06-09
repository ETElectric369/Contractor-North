-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0028: petty cash ledger
-- Simple cash-box ledger: replenishments add, expenses subtract. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.petty_cash (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  tx_date     date not null default current_date,
  kind        text not null default 'expense',   -- expense | replenish
  amount      numeric(12,2) not null default 0,
  category    text,
  description text,
  job_id      uuid references public.jobs(id) on delete set null,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index if not exists petty_cash_org_idx on public.petty_cash(org_id, tx_date);

drop trigger if exists stamp_org_petty_cash on public.petty_cash;
create trigger stamp_org_petty_cash before insert on public.petty_cash
  for each row execute function public.set_org_id();

alter table public.petty_cash enable row level security;

drop policy if exists petty_cash_read on public.petty_cash;
create policy petty_cash_read on public.petty_cash
  for select using (org_id = public.auth_org_id());

drop policy if exists petty_cash_write on public.petty_cash;
create policy petty_cash_write on public.petty_cash
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
