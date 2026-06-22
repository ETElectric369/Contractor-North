-- Payment schedule for a Fixed-Bid job: an ordered set of milestones (deposit,
-- progress draws, final/retention) as a % of the contract — the "payment structure"
-- that "Request next payment" bills against, one milestone at a time. T&M jobs bill
-- work-to-date instead (createProgressReportInvoice) and don't use this table.

create table if not exists public.payment_milestones (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  job_id      uuid not null references public.jobs(id) on delete cascade,
  sort_order  int not null default 0,
  label       text not null default '',
  percent     numeric,                          -- % of contract; null when a fixed $ is used
  amount      numeric,                          -- fixed $ override / fallback when there's no contract %
  status        text not null default 'pending' check (status in ('pending', 'billed')),
  invoice_id    uuid references public.invoices(id) on delete set null,
  billed_amount numeric,                          -- $ frozen at draw time (quote edits can't retro-change a billed milestone)
  created_at    timestamptz not null default now()
);
-- (idempotent for DBs created before billed_amount was added)
alter table public.payment_milestones add column if not exists billed_amount numeric;

create index if not exists payment_milestones_job_idx
  on public.payment_milestones(org_id, job_id, sort_order);

-- One milestone per draw, and at most one open draft draw per job — DB-enforced so a
-- double-submit can't link two draws to one milestone or open two draws at once.
create unique index if not exists payment_milestones_one_per_invoice
  on public.payment_milestones(invoice_id) where invoice_id is not null;
create unique index if not exists invoices_one_open_draft_draw
  on public.invoices(job_id) where status = 'draft' and invoice_kind in ('deposit', 'progress', 'final');

alter table public.payment_milestones enable row level security;

drop trigger if exists stamp_org_payment_milestones on public.payment_milestones;
create trigger stamp_org_payment_milestones before insert on public.payment_milestones
  for each row execute function public.set_org_id();

-- Staff manage the schedule; (a future customer portal reads via a SECURITY DEFINER
-- RPC, not direct RLS, like the public invoice/quote views).
drop policy if exists payment_milestones_rw on public.payment_milestones;
create policy payment_milestones_rw on public.payment_milestones
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
