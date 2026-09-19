-- THE SUPPLIER'S OWN INVOICES, WHICH THE APP HAS NEVER HELD (Erik, 2026-09-19).
--
-- He got into his CED payment portal and the first thing it said was that we were wrong:
--
--     CED says he owes $3,819.66.   This app said $6,476.93.
--
-- Reconciling the two, document by document, is what this table exists to make possible. What the
-- portal showed, against what his books held:
--
--  * $5,421.55 of bills the app called OWED that CED had already settled. Eight invoices: all three
--    Tao Zhu (235 Timber Creek), two Rhodesia, a Herringbone and two Whitney.
--  * $975.10 open at CED and never scanned at all - twelve documents, including both credit memos.
--  * $1,765.72 of invoices bought since the app started and recorded nowhere: $523.47 on TTP56,
--    which is about to be billed; $451.75 he cannot place; $186.93 on Randy's Purple Sage job,
--    already paid and closed, so its profit is overstated by exactly that.
--  * Two of his "bills" were never bills. They were STATEMENTS, and the arithmetic proves it to the
--    cent: his $3,034.54 is invoice 1105868 ($2,950.17, settled) plus 1105963 ($84.37, still open),
--    and his $162.32 is 1103059 ($47.92, Rhodesia) plus 1103061 ($114.40, whose job name at CED is
--    literally "STOCK" - he has been telling his supplier what is shop stock all along).
--  * $60.42 of late-payment interest paid, at 1.5% a month, while $123.46 of prompt-pay discounts
--    sat on those same invoices unclaimed. He had the money; nothing told him what was due.
--
-- A BILL AND AN INVOICE ARE NOT THE SAME THING, which is the fault underneath all of it. `bills` is
-- a piece of paper the app scanned. A supplier invoice is a document the SUPPLIER issued, with its
-- own number, its own status, and its own job name. One scanned bill can carry several of them
-- (a statement), a supplier invoice can arrive with no scan at all, and only the supplier can say
-- whether one is paid. Holding both, linked, is what lets the two disagree out loud instead of
-- silently.
--
-- THE JOB NAME IS THE GIFT. CED prints a JOB NAME on every invoice and it matches his own job names
-- almost exactly: 13631 NORTHWOODS, 85 WHITNEY PLACE, 13897 HERRINGBONE, 13683 HILLSIDE, 235 TIMBER
-- CREEK. It is stored RAW and resolved to a job by a person, because the drift is real - the same
-- road appears as "5659 RHODESIA", "561 RHODESIA", "5661 RHODESIA" and "5659 RODESSIA", and he has
-- five separate jobs on it. A machine that picked one would be guessing with his job costs.

create table if not exists public.supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  supplier_account_id uuid references public.supplier_accounts(id) on delete set null,

  -- The supplier's own number. "8802-1103832" - branch 8802, invoice 1103832.
  invoice_number text not null,
  kind text not null default 'invoice'
    check (kind in ('invoice', 'credit_memo', 'service_charge', 'statement')),

  invoice_date date,
  due_date date,

  -- CED's JOB NAME / CUSTOMER ORDER NO., verbatim, before anyone interprets it.
  job_name_raw text,
  -- Where a PERSON said it belongs. Never inferred: see the header on the five Rhodesia jobs.
  job_id uuid references public.jobs(id) on delete set null,

  merchandise numeric(12,2),
  tax numeric(12,2),
  shipping numeric(12,2),
  total numeric(12,2) not null,

  -- "CASH DISCOUNT 11.87 OFF TOTAL DUE IF PAID BY THE 10TH OF THE MONTH FOLLOWING PURCHASE."
  -- Both halves matter: the money, and the day it stops being available.
  discount_amount numeric(12,2),
  discount_by date,

  -- What the supplier says is still owed on THIS document, and whether they consider it settled.
  -- Only the supplier can answer either, which is the whole reason this table exists.
  open_balance numeric(12,2),
  closed boolean not null default false,

  -- Which file it was read out of, so a figure on screen can always be traced to a document.
  source_file text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),

  unique (org_id, invoice_number)
);

comment on table public.supplier_invoices is
  'A document the SUPPLIER issued, as opposed to `bills`, which is a piece of paper this app scanned. One bill can cover several of these (a statement); one of these can exist with no bill at all. Only the supplier can say whether it is paid.';

create index if not exists supplier_invoices_account_idx
  on public.supplier_invoices (org_id, supplier_account_id, invoice_date desc);
create index if not exists supplier_invoices_open_idx
  on public.supplier_invoices (org_id, closed, discount_by)
  where closed = false;
create index if not exists supplier_invoices_job_idx
  on public.supplier_invoices (org_id, job_id)
  where job_id is not null;

-- THE LINE ITEMS, AT HIS REAL CONTRACT PRICES.
--
-- These are worth more than the reconciliation. A scanned counter ticket is a photograph read by a
-- language model; this is the supplier's own file, with product codes, the quantity shipped, the
-- price and the unit that price is per. Every one of the 40 invoices parsed reconciles exactly:
-- the extensions sum to merchandise, and merchandise + tax + shipping equals the total, on all 40.
--
-- `per_unit` is the column that stops a wire price being read as a piece price. CED prints E for
-- each, C for per hundred and M for per thousand: 55 feet of 6/3 at $4,321.03 per M is $237.66, and
-- reading that 4321.03 as a unit price would put a four thousand dollar reel on a customer's bill.
create table if not exists public.supplier_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  supplier_invoice_id uuid not null references public.supplier_invoices(id) on delete cascade,
  product_code text,
  part_number text,
  description text,
  quantity numeric(12,3),
  unit_price numeric(12,4),
  /** E = each, C = per hundred, M = per thousand. The supplier's own pricing unit. */
  per_unit text,
  extension numeric(12,2),
  sort_order int not null default 0
);

create index if not exists supplier_invoice_lines_invoice_idx
  on public.supplier_invoice_lines (supplier_invoice_id, sort_order);

-- WHICH SCANNED BILL COVERS WHICH SUPPLIER INVOICES.
--
-- A join table rather than a column on `bills`, because the interesting case is one-to-MANY and it
-- is the case that broke his books: a statement he imported from email became a single $3,034.54
-- "bill" standing for two invoices with two different fates. A column could not have said that.
create table if not exists public.bill_supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  bill_id uuid not null references public.bills(id) on delete cascade,
  supplier_invoice_id uuid not null references public.supplier_invoices(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (bill_id, supplier_invoice_id)
);

create index if not exists bill_supplier_invoices_inv_idx
  on public.bill_supplier_invoices (supplier_invoice_id);

alter table public.supplier_invoices enable row level security;
alter table public.supplier_invoice_lines enable row level security;
alter table public.bill_supplier_invoices enable row level security;

do $$
declare t text;
begin
  foreach t in array array['supplier_invoices','supplier_invoice_lines','bill_supplier_invoices'] loop
    execute format('drop policy if exists %I_staff_all on public.%I', t, t);
    execute format(
      'create policy %I_staff_all on public.%I for all using (org_id = public.auth_org_id() and public.is_org_staff()) with check (org_id = public.auth_org_id() and public.is_org_staff())',
      t, t);
  end loop;
end $$;
