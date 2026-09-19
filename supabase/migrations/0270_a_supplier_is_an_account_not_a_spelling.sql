-- A SUPPLIER IS AN ACCOUNT YOU PAY, NOT A NAME A SCANNER TYPED (Erik, 2026-09-18).
--
-- His Bills screen opens on Unpaid and shows $13,040.07 across 21 bills. He asked whether that was
-- what made his profit margins red. It is not - job profit is cash COLLECTED minus cost, and a bill
-- costs the job the moment it exists whether or not he has paid it - but the question found a real
-- hole: there is no way to record PAYING a supplier at all, only a checkbox that flips one bill
-- paid. That is the shape he threw out for payroll two nights ago, and it fits even worse here:
--
--   "yes i pay them in chunks that never match the ticckets"
--
-- The balance he owes is per ACCOUNT, and `bills.supplier` is free text the receipt reader writes
-- afresh on every scan. CED alone is stored five ways - "Consolidated Electrical Distributors, Inc.
-- (CED)", "Consolidated Electrical Dist.", "Consolidated Electrical Distributors, Inc.",
-- "Consolidated Electrical Distributors", "CED" - holding $12,572.20 of that $13,040 between them.
-- A running balance keyed on the text would have shown him four CED balances on day one.
--
-- ACCOUNT vs LOCATION, and why both. Asked about the sixth name, "Contractors Electrical
-- Distributors" ($467.87), he said:
--
--   "its the local distributor near sunnyvale for the job so i used my truckee account number,
--    thats how they roll"
--
-- CED branches are independently owned; he charged a Sunnyvale counter to his Truckee account. So
-- the money rolls up to the ACCOUNT (TR-34426, at Truckee profit centre 8802) while the ticket
-- stays with the branch it came from. Collapsing the storefronts into one row would be right for
-- the balance and wrong for the price book, which learns from these same receipts - a Sunnyvale
-- counter price is not a Truckee counter price, and merging them would quietly average two markets.
-- Hence a supplier_accounts row for what he pays, and an alias per spelling/branch underneath it.
--
-- THE INVOICE NUMBER, which the app already has and throws away. CED's own portal names its PDFs
-- `TR-34426_20260616_32136931_15165103264.pdf` - account, date, invoice number - and the scanner
-- files that whole string in `notes` as a leftover filename while `bill_number` sits empty. Worse,
-- the documents he imported from email are STATEMENTS, not tickets: one "bill" carries several CED
-- invoices, their numbers captured by OCR inside LINE DESCRIPTIONS like
-- "Sales Tax 9.00000 (Invoice 8802-1101363)". Until an invoice has a field of its own, "I sent CED
-- $4,000" cannot be matched to anything CED lists when they ask for it.
--
-- WHAT THIS MIGRATION DOES NOT DO: it does not merge, rename or re-file a single existing bill, and
-- it does not decide what anything is. Every column it adds is nullable and every existing screen
-- reads exactly what it read before. The mapping is a person's judgement (is that Sunnyvale branch
-- the same account? which job does a duplicated ticket belong to?) and it belongs in front of Erik,
-- not inside a backfill that rewrites his books while he sleeps.

create table if not exists public.supplier_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- What he calls them: "CED Truckee", "Home Depot".
  name text not null,
  -- The number on the statement. TR-34426. Null for a cash vendor with no account.
  account_number text,
  -- CED prints its branch (profit centre) as the prefix of every invoice: 8802-1101363.
  branch_code text,
  -- A counter you pay at the register has no running balance; an account does. This is what tells
  -- the balance card whether to exist at all.
  on_account boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  unique (org_id, name)
);

comment on table public.supplier_accounts is
  'A supplier as a thing you OWE money to, keyed by account number rather than by whatever the scanner typed. Branch names live in supplier_aliases beneath it, because one account can be used at several independently-owned branches.';

create table if not exists public.supplier_aliases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  supplier_account_id uuid not null references public.supplier_accounts(id) on delete cascade,
  -- The free-text supplier string exactly as it was scanned, or a branch's own name.
  alias text not null,
  -- The branch this spelling is, when it is a different storefront rather than a sloppy spelling.
  -- Kept so the price book can still tell Sunnyvale from Truckee while the money does not.
  branch_label text,
  created_at timestamptz not null default now()
);

create unique index if not exists supplier_aliases_one_per_spelling
  on public.supplier_aliases (org_id, lower(alias));

comment on column public.supplier_aliases.alias is
  'A spelling of this account as it appears in bills.supplier. Lowercased-unique per org, so one string can never point at two accounts.';

alter table public.bills
  add column if not exists supplier_account_id uuid references public.supplier_accounts(id),
  -- The supplier's OWN invoice number for this document (CED: 8802-1101363). Null while unknown.
  add column if not exists supplier_invoice_number text,
  -- True when the document is a STATEMENT covering several of the supplier's invoices, which is
  -- what arrived in the email import. A statement's total is real; its single invoice number is not.
  add column if not exists is_statement boolean not null default false;

create index if not exists bills_supplier_account_idx
  on public.bills (org_id, supplier_account_id)
  where supplier_account_id is not null;

create table if not exists public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  supplier_account_id uuid not null references public.supplier_accounts(id) on delete cascade,
  -- AN AMOUNT, NOT A TICK. The whole point: a chunk that matches no ticket.
  amount numeric(12,2) not null check (amount > 0),
  paid_on date not null default current_date,
  method text not null default 'check' check (method in ('cash','check','transfer','card','other')),
  -- Check number, confirmation code, whatever he can match to his bank.
  reference text,
  note text,
  -- Voided rather than deleted, like every other money row in this app.
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);

comment on table public.supplier_payments is
  'Money actually sent to a supplier account. Owed = the account''s unpaid bills minus its live payments - the same Earned minus Paid shape as pay_payments, for the same reason: "i pay them in chunks that never match the ticckets".';

create index if not exists supplier_payments_account_idx
  on public.supplier_payments (org_id, supplier_account_id, paid_on desc)
  where voided_at is null;

-- RLS, matching the money tables around it: staff read and write, nobody else sees a payable.
alter table public.supplier_accounts enable row level security;
alter table public.supplier_aliases enable row level security;
alter table public.supplier_payments enable row level security;

do $$
declare t text;
begin
  foreach t in array array['supplier_accounts','supplier_aliases','supplier_payments'] loop
    execute format('drop policy if exists %I_staff_all on public.%I', t, t);
    execute format(
      'create policy %I_staff_all on public.%I for all using (org_id = public.auth_org_id() and public.is_org_staff()) with check (org_id = public.auth_org_id() and public.is_org_staff())',
      t, t);
  end loop;
end $$;
