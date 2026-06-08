-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0015: QuickBooks Online connection
-- Stores the per-org OAuth connection + maps customers/invoices to QBO entities.
-- Run AFTER 0004. Tokens are server-only (read via the service role).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.accounting_connections (
  org_id        uuid primary key references public.organizations(id) on delete cascade,
  provider      text not null default 'quickbooks',
  realm_id      text,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.customers add column if not exists qbo_id text;
alter table public.invoices  add column if not exists qbo_id text;

drop trigger if exists touch_accounting_connections on public.accounting_connections;
create trigger touch_accounting_connections before update on public.accounting_connections
  for each row execute function public.touch_updated_at();

alter table public.accounting_connections enable row level security;

-- Owner/admin can see WHETHER they're connected (the app never selects the token
-- columns into the client). Writes happen server-side via the service role.
drop policy if exists accounting_select on public.accounting_connections;
create policy accounting_select on public.accounting_connections
  for select using (org_id = public.auth_org_id() and public.app_user_role() in ('owner','admin'));
