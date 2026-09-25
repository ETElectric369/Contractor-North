-- 0338 - A BANK TRANSFER ON ITS WAY IS NOT MONEY YET, AND IT IS NOT NOTHING EITHER (audit v994 BK3).
--
-- A card settles inside Stripe Checkout: checkout.session.completed arrives with payment_status
-- 'paid' and the webhook books it. A bank debit (ACH, us_bank_account) does not. It arrives as
-- completed(UNPAID), rightly booked as nothing, because the money is 3-5 business days away and can
-- still be refused. It lands later as checkout.session.async_payment_succeeded, or never, as
-- checkout.session.async_payment_failed.
--
-- In between, NOTHING KNEW. The invoice kept its whole balance and both Pay buttons, the customer's
-- own "on its way" banner showed exactly once, the office heard nothing, and the reminder cron was
-- free to chase a customer whose money was already moving. A second payment was one tap away.
--
-- THIS TABLE IS THAT IN-BETWEEN, AND ONLY THAT. One row per PaymentIntent a bank debit started on:
--   pending  -> the debit is on its way. /i says so and offers no second online payment, /api/pay
--               opens no second checkout, reminders skip the invoice, the office is told.
--   cleared  -> async_payment_succeeded booked the payments row (the ONLY money record).
--   failed   -> async_payment_failed: nothing was ever booked; the invoice was open all along.
--
-- IT IS NEVER MONEY. Nothing here is read by amount_paid, recalc, AR, Collected, the claims
-- triggers or any total. `amount` is what the customer started, said in words and nothing more.
--
-- WRITTEN ONLY BY THE STRIPE WEBHOOK, as the service role, after the same org<->connected-account
-- and invoice<->org checks the payment itself stands behind. Staff can READ their own org's rows
-- (the invoice page says a transfer is on its way); no role but the service role writes, so no
-- screen can mark a transfer cleared and no customer page can make one up.
--
-- Bank Transfer stays OFF (organizations.settings.bank_transfer_enabled) until this is applied,
-- BK1-BK3 are live, and both async events are subscribed on the connected-accounts webhook (Erik,
-- 2026-09-24). Applying this turns nothing on.
--
-- NEW TABLE ONLY. No function, view or existing table is replaced or altered.

create table if not exists public.pending_bank_transfers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  -- Stripe's PaymentIntent (pi_...): the one id every event about this debit carries.
  payment_intent text not null,
  -- The Checkout session that started it (cs_...), for tracing back from the dashboard.
  checkout_session text,
  -- What the customer started. Words only, never a total (see the header).
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'cleared', 'failed')),
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  -- Set once the daily cron has told the office a debit has been pending more than a week, so it is
  -- said once, not every morning.
  stale_alerted_at timestamptz,
  constraint pending_bank_transfers_pi_key unique (payment_intent),
  constraint pending_bank_transfers_resolved check ((status = 'pending') = (resolved_at is null))
);

comment on table public.pending_bank_transfers is
  'A bank debit (ACH) a customer started on an invoice and Stripe has not settled yet (0338, audit v994 BK3). pending = on its way; cleared = the payments row was booked by async_payment_succeeded; failed = async_payment_failed, nothing booked. NEVER money: no total, balance or claim reads it. Written only by the Stripe webhook (service role).';

create index if not exists pending_bank_transfers_open_idx
  on public.pending_bank_transfers (org_id, invoice_id)
  where status = 'pending';

alter table public.pending_bank_transfers enable row level security;

drop policy if exists pending_bank_transfers_staff_read on public.pending_bank_transfers;
create policy pending_bank_transfers_staff_read on public.pending_bank_transfers
  for select
  using (org_id = public.auth_org_id() and public.is_org_staff());

-- Read-only to every signed-in role; the webhook writes as the service role, which bypasses RLS.
revoke all on public.pending_bank_transfers from anon;
revoke insert, update, delete, truncate, references, trigger on public.pending_bank_transfers from authenticated;
grant select on public.pending_bank_transfers to authenticated;
