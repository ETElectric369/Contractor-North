-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0044: recurring jobs & expenses
-- Templates that spin off a real job or expense (bill) on a cadence. The app
-- (or the remote-control automation) calls a generator that creates anything
-- due and advances next_date. Progress payments reuse the existing invoice
-- tables, so they need no schema.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.recurring_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid references public.organizations(id) on delete cascade,
  kind          text not null check (kind in ('job', 'expense')),
  title         text not null,
  frequency     text not null default 'monthly'
                check (frequency in ('weekly', 'biweekly', 'monthly', 'quarterly', 'yearly')),
  next_date     date not null,
  active        boolean not null default true,
  -- job fields
  customer_id   uuid references public.customers(id) on delete set null,
  description   text,
  -- expense fields
  amount        numeric(12,2),
  category      text,
  vendor        text,
  created_by    uuid references public.profiles(id),
  last_generated_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists recurring_org_idx on public.recurring_templates(org_id, active, next_date);

drop trigger if exists touch_recurring on public.recurring_templates;
create trigger touch_recurring before update on public.recurring_templates
  for each row execute function public.touch_updated_at();

drop trigger if exists stamp_org_recurring on public.recurring_templates;
create trigger stamp_org_recurring before insert on public.recurring_templates
  for each row execute function public.set_org_id();

alter table public.recurring_templates enable row level security;

drop policy if exists recurring_templates_rw on public.recurring_templates;
create policy recurring_templates_rw on public.recurring_templates
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
