-- 0264 — A PAYMENT IS AN AMOUNT, NOT A CHECKBOX
--
-- Erik, 2026-09-17: "i need an easy way to be able to see how much i owe each employee and be able to
-- enter an amount i paid them instead of just a checkbox for each pay period", and then the reason:
-- "i have paid brian a large chunk of that and thats why im having trouble becuase theres been no way
-- for me to record it properly… sometimes i need to throw his a few hundred or an off ammount."
--
-- Until now "paid" meant ONE thing in this app: time_entries.paid_at, an all-or-nothing lock stamped
-- across a whole pay period by the Mark Paid button. A contractor who hands a man three hundred dollars
-- on a Tuesday has nowhere to put it, so he doesn't, and the record stops being kept. Live proof on the
-- day this shipped: payroll_runs holds TWO rows in the app's entire life, both Brian, both July, while
-- Brian's unpaid hours had been accruing since 2026-07-09. The app said Erik owed him $5,857. Erik had
-- already paid a large chunk of it. Both facts were true and the app could only hold one.
--
-- So the word splits in two, and each half gets to be honest:
--   · A PAYMENT is money that left Erik's hand: an amount, a date, a method, an optional note.
--     That is this table. It is never computed — Erik types it, the same law mileage has had since
--     0095, for the same reason: an app that fills in a paycheck figure is inventing one.
--   · A LOCK is time_entries.paid_at, unchanged, still stamped only by markPeriodPaid, still race-safe,
--     still refusing an open shift and an auto-closed ghost. It now happens as a CONSEQUENCE of
--     payments covering a period in full (Erik's choice, asked and answered today: "lock only what's
--     covered in full, oldest first"), instead of being a button that computes its own amount.
--
-- Owed = Earned − Paid, and every dollar on both sides traces to a row.

create table if not exists public.pay_payments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  -- Money that actually moved. Positive only: a correction is a VOID of the wrong row plus a new one,
  -- so the trail reads as what happened rather than as arithmetic nobody can follow.
  amount      numeric(12,2) not null check (amount > 0 and amount <= 9999999),
  -- The day Erik handed it over, in the ORG's day, not the server's. He pays early and he pays late,
  -- so this is his to set and it is not derived from created_at.
  paid_on     date not null,
  method      text not null default 'cash' check (method in ('cash','check','transfer','other')),
  reference   text,   -- a check number, a transfer id: whatever makes it findable in a bank statement
  note        text,
  -- VOID, NEVER DELETE (the NOT-ANNOYING law: autosave plus an undo trail, not a save game). A voided
  -- row stays visible and stops counting; nothing about money ever silently disappears.
  voided_at   timestamptz,
  voided_by   uuid references public.profiles(id),
  -- Set by 0265's backfill on rows built from an old Mark Paid tick, so the screen can say where the
  -- figure came from and ask Erik to confirm it rather than presenting a guess as a fact.
  imported_from_run uuid references public.payroll_runs(id) on delete set null,
  needs_check boolean not null default false,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

create index if not exists pay_payments_org_profile_idx on public.pay_payments (org_id, profile_id, paid_on desc);
create index if not exists pay_payments_live_idx on public.pay_payments (org_id, profile_id) where voided_at is null;

alter table public.pay_payments enable row level security;

-- READ: staff see the whole shop; a tech sees HIS OWN payments and nobody else's. This is the same
-- shape profile_pay uses for rates (0215/0216) and the reason is identical — a man is entitled to know
-- what he has been paid, and entitled to have nobody else's pay kept where he can reach it.
drop policy if exists pay_payments_read on public.pay_payments;
create policy pay_payments_read on public.pay_payments
  for select using (org_id = public.auth_org_id() and (public.is_org_staff() or profile_id = auth.uid()));

-- WRITE: staff only, and never for another org. Recording that money moved is an office act.
drop policy if exists pay_payments_write on public.pay_payments;
create policy pay_payments_write on public.pay_payments
  for all
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

drop trigger if exists stamp_org_pay_payments on public.pay_payments;
create trigger stamp_org_pay_payments
  before insert on public.pay_payments
  for each row execute function public.set_org_id();

comment on table public.pay_payments is
  'Money Erik actually handed a person: amount, date, method (0264). Typed by a human, never computed — the mileage rule from 0095, for the same reason. Owed = Earned - Paid, where Paid is the sum of non-voided rows here. Voided, never deleted. time_entries.paid_at remains the separate LOCK, stamped by markPeriodPaid when payments cover a period in full.';
