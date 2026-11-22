-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0414: money ahead of the work
--
-- The owner, 2026-11-21: "i think we do need to think about setting up a deposit schedule ability if
-- desired and to be able to have them pay the deposit with their card from the link or something
-- like that", and "im curious if we can go into the job and request a materials payment via a link
-- in the get paid box (like a quick payment link that applies immediately to that job regardless of
-- invoice status)".
--
-- THE RECORD (cn-v1177). A payment request is a small bill of its own kind: invoices.invoice_kind
-- 'prepayment', ONE line (import_source 'prepayment'), tax 0, no due date, born sent. Every other
-- bill made on the same job takes the job's requests off with one line per request (import_source
-- 'prepaid_credit', invoice_items.prepaid_invoice_id naming the request, a figure at or below zero),
-- oldest request first, capped at that bill's other lines (src/lib/prepayments.ts, the arithmetic;
-- src/lib/payment-request.ts, the reads and writes). It takes off what was ASKED, paid or not.
--
-- WHAT, eight things and nothing else:
--
--  1. invoices_invoice_kind_check takes a fifth word, 'prepayment'.
--  2. quotes.deposit_amount (numeric(12,2), null, never below 0) and quotes.deposit_by_hand (boolean,
--     not null, false): the deposit the estimate states, as the office's save writes it
--     (src/lib/deposit-rule.ts depositFor, unless typed by hand). NO BACKFILL: an estimate saved
--     before this file states none until it is saved again. Nothing is guessed.
--  3. invoice_items.prepaid_invoice_id (uuid, null): the request a 'prepaid_credit' line takes off.
--     Set EXACTLY when the line is one (a named check), at most one line per request on one bill (a
--     unique index), and an index to find a request's lines.
--     NO FOREIGN KEY, ON PURPOSE. A second reference from invoice_items to invoices makes every
--     PostgREST embed between the two tables ambiguous (invoice_items(...) under invoices, and
--     invoices(...) under invoice_items): the app's reads that embed them would all fail at once.
--     What the key would have held is held by triggers instead: the line's request must exist (4),
--     and a request a line names cannot be deleted (6, the "on delete restrict").
--  4. THE BOUNDARY, on invoice_items (a rule at one read path is a convention): for every payment
--     request R, the sizes of the 'prepaid_credit' lines naming R on bills that are not void never
--     add up to more than R's own lines. R's row is locked FOR UPDATE before the sum is read, so two
--     writers cannot both pass on the same dollar: the second waits, then sees the first. And a line
--     naming R: R is a payment request, not void, not a draft, in the same company and on the same
--     job as the line's bill; the bill is not itself a request; the line takes money off (<= 0).
--     R's own line may not go below what bills already take off it.
--  5. ON invoices: a request that a bill takes off keeps its kind and its job; it cannot be voided
--     or put back to draft while a bill that went out (not draft, not void) takes it off; a bill that
--     takes requests off cannot become a request, cannot move to another job while it carries those
--     lines, and is checked line by line when it goes out and when it comes back from void as anything
--     but a draft (a draft's lines are derived: its next recalculation re-resolves them).
--  6. A request a line names cannot be deleted (the restrict the key in 3 does not declare).
--  7. ONE LIVE DEPOSIT REQUEST PER ESTIMATE: a unique index on invoices(quote_id) for kind
--     'prepayment', not void. A second tap of the customer's Pay the Deposit is handed the first.
--  8. public.public_quote(text), the customer's estimate link: 0408's body (the last migration that
--     made it), every statement, with three keys added to the quote object and nothing else:
--     deposit_amount (the live deposit request's own ask when there is one, so the paper, the button
--     and the charge are one number; else the stored figure), deposit_state (paid / requested / none
--     / due; none also when the office voided the request, or the job is over with none live) and
--     can_take_card (the company's card door, the same expression public_invoice reads, 0301). Same
--     signature, same security,
--     same search path, no new input. CREATE OR REPLACE keeps the owner and the grants, and the
--     self-check compares both with what they were. If you re-create this function, copy THIS body.
--
-- Every refusal is a sentence a person can read: the app hands the database's own words to the
-- screen (src/lib/db-error.ts passes a raised message through).
--
-- THE WRITERS AND THE READERS, named the day the columns are added: quotes.deposit_amount and
-- deposit_by_hand are written by the estimate's save (src/app/(app)/quotes/actions.ts) and read by
-- the estimate editor, the estimate's paper, public_quote (here) and src/lib/payment-request.ts
-- (ensureDepositRequestForQuoteToken); invoice_items.prepaid_invoice_id is written only by
-- syncPrepaidCredit (src/lib/payment-request.ts) and read by readPrepaymentStates there. All three
-- are named in the company export (src/lib/export/registry.ts). tests/migration-0414.test.ts reads
-- this file; src/lib/payment-request.integration.test.ts asks the database.
--
-- ORDER. BEFORE the deploy, and it must be: the deployed app writes the new kind, the new columns and
-- the new key. Applied first, the app that is running now names none of them and nothing it does
-- changes; the customer's estimate link carries three more keys nobody reads yet.
--
-- LOCKS. ACCESS EXCLUSIVE on invoices, invoice_items and quotes for a moment each (the kind check is
-- swapped and re-validated by one read of invoices; the columns take no rewrite: deposit_amount and
-- prepaid_invoice_id are null, deposit_by_hand's default is a constant; each check reads its table
-- once; three indexes are built on small tables). lock_timeout 3s: a bill or an estimate somebody is
-- saving at that moment makes this fail fast and change nothing; run it again. statement_timeout
-- 15s. ONE TRANSACTION: the runners wrap the file, and the self-check leans on that (what the ground
-- check notes is read back at the end). NOT twice-safe, on purpose: a second run finds the columns
-- this file adds and refuses before it changes anything, and a run after a later migration has
-- re-made public_quote refuses at the md5 and never puts its own text back over a newer one.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

-- ── The ground it stands on ─────────────────────────────────────────────────────────────────────
do $$
declare
  r     record;
  v_src text;
  v_def text;
  v_n   int;
begin
  for r in select t.tbl from (values ('invoices'), ('invoice_items'), ('quotes'), ('organizations'), ('customer_credits')) as t(tbl) loop
    if to_regclass('public.' || r.tbl) is null then
      raise exception '0414: public.% is not on this database. Nothing was changed.', r.tbl;
    end if;
  end loop;
  if (select count(*) from pg_roles where rolname in ('anon', 'authenticated')) <> 2 then
    raise exception '0414: the roles anon and authenticated are not both on this database. Nothing was changed.';
  end if;

  -- EVERY COLUMN THE BOUNDARY AND THE LINK READ, with the migration that added it.
  for r in
    select * from (values
      ('invoices',      'invoice_number',         'text',    '0003'),
      ('invoices',      'job_id',                 'uuid',    '0003'),
      ('invoices',      'quote_id',               'uuid',    '0003'),
      ('invoices',      'created_at',             'timestamp with time zone', '0003'),
      ('invoices',      'org_id',                 'uuid',    '0004'),
      ('invoices',      'invoice_kind',           'text',    '0063'),
      ('invoice_items', 'invoice_id',             'uuid',    '0003'),
      ('invoice_items', 'line_total',             'numeric', '0003'),
      ('invoice_items', 'org_id',                 'uuid',    '0004'),
      ('invoice_items', 'import_source',          'text',    '0061'),
      ('invoice_items', 'line_kind',              'text',    '0342'),
      ('quotes',        'org_id',                 'uuid',    '0004'),
      ('organizations', 'stripe_charges_enabled', 'boolean', '0161')
    ) as t(tbl, col, kind, born)
  loop
    if not exists (
      select 1 from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col and c.data_type = r.kind
    ) then
      raise exception '0414: %.% (%, added by %) is missing. Apply % first. Nothing was changed.', r.tbl, r.col, r.kind, r.born, r.born;
    end if;
  end loop;
  if not exists (
    select 1 from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'invoices' and c.column_name = 'status' and c.udt_name = 'invoice_status'
  ) then
    raise exception '0414: invoices.status is not the invoice_status enum 0003 made. Nothing was changed.';
  end if;

  -- THE COLUMNS THIS FILE ADDS ARE NOT THERE YET. A second run stops here, before anything changes.
  for r in
    select * from (values ('quotes', 'deposit_amount'), ('quotes', 'deposit_by_hand'), ('invoice_items', 'prepaid_invoice_id')) as t(tbl, col)
  loop
    if exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col) then
      raise exception '0414: %.% is already on this database: this file has run, or something else made it. Read it before this runs. Nothing was changed.', r.tbl, r.col;
    end if;
  end loop;

  -- THE KIND CHECK IS THE ONE 0063 MADE: one check on invoice_kind, under its name, with the four words.
  select count(*), min(pg_get_constraintdef(k.oid)) into v_n, v_def
    from pg_constraint k
   where k.conrelid = 'public.invoices'::regclass and k.contype = 'c'
     and (select array_agg(a.attname::text) from pg_attribute a where a.attrelid = k.conrelid and a.attnum = any (k.conkey)) = array['invoice_kind'];
  if v_n <> 1
     or not exists (select 1 from pg_constraint k where k.conrelid = 'public.invoices'::regclass and k.conname = 'invoices_invoice_kind_check')
     or (select coalesce(array_agg(w[1] order by w[1]), '{}'::text[]) from regexp_matches(v_def, '''([^'']*)''', 'g') as w)
        <> array['deposit', 'final', 'progress', 'standard'] then
    raise exception '0414: the check on invoices.invoice_kind is not the one 0063 made (deposit, progress, final, standard; found %). Nothing was changed.', coalesce(v_def, 'none');
  end if;

  -- A CREDIT LINE IS A KIND OF LINE 0389 ALREADY KNOWS.
  select pg_get_constraintdef(k.oid) into v_def from pg_constraint k
   where k.conrelid = 'public.invoice_items'::regclass and k.conname = 'invoice_items_line_kind_known';
  if v_def is null or position('''credit''' in v_def) = 0 then
    raise exception '0414: invoice_items.line_kind does not take ''credit'' (0342, 0389). Nothing was changed.';
  end if;

  -- NO LINE ALREADY CALLS ITSELF WHAT THIS FILE GIVES A MEANING TO, and no bill is the new kind.
  if exists (select 1 from public.invoice_items where import_source in ('prepayment', 'prepaid_credit')) then
    raise exception '0414: invoice lines already carry import_source prepayment or prepaid_credit, which this file gives a meaning to. Read them first. Nothing was changed.';
  end if;

  -- THE NAMES THIS FILE TAKES ARE FREE.
  for r in
    select * from (values
      ('public.invoice_items_one_credit_per_request'),
      ('public.invoice_items_prepaid_invoice_idx'),
      ('public.invoices_one_live_deposit_request_per_estimate')
    ) as t(rel)
  loop
    if to_regclass(r.rel) is not null then
      raise exception '0414: % is already on this database. Nothing was changed.', r.rel;
    end if;
  end loop;
  if to_regprocedure('public.prepayment_hold(uuid, text)') is not null
     or to_regprocedure('public.prepaid_credit_line_holds(uuid, uuid, numeric)') is not null
     or to_regprocedure('public.guard_prepaid_credit_line()') is not null
     or to_regprocedure('public.guard_prepayment_bill()') is not null
     or to_regprocedure('public.guard_prepayment_delete()') is not null then
    raise exception '0414: a function this file makes is already on this database. Nothing was changed.';
  end if;

  -- THE FUNCTION THIS FILE REPLACES IS THE ONE IT WAS WRITTEN FROM: its statements, with comments and
  -- spacing taken out, must be 0408's. Anything else is refused and never overwritten.
  -- tests/migration-0414.test.ts recomputes the md5 from 0408's file.
  if to_regprocedure('public.public_quote(text)') is null then
    raise exception '0414: public.public_quote(text) is not on this database (0012; last made by 0408). Nothing was changed.';
  end if;
  select p.prosrc into v_src from pg_proc p where p.oid = 'public.public_quote(text)'::regprocedure;
  if coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '') <> '1fb44c873db221169e56bf191659db3d' then
    raise exception '0414: public_quote on this database is not the body 0408 left: it was changed outside this repository''s migrations, or by a later migration (then this file must not run again). Read it (select pg_get_functiondef(''public.public_quote(text)''::regprocedure)) and reconcile the two before this runs. Nothing was changed.';
  end if;
  if not has_function_privilege('anon', 'public.public_quote(text)', 'execute')
     or not has_function_privilege('authenticated', 'public.public_quote(text)', 'execute') then
    raise exception '0414: the customer''s link cannot call public_quote on this database (0395 and 0408 let anon and authenticated call it). Nothing was changed.';
  end if;

  -- Who owns the function and who may call it, as they stand, for the self-check to compare.
  perform set_config(
    'cn.m0414_quote_was',
    (select 'was:' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '') from pg_proc p where p.oid = 'public.public_quote(text)'::regprocedure),
    true);
end $$;

-- ── 1. The fifth kind ───────────────────────────────────────────────────────────────────────────
alter table public.invoices drop constraint invoices_invoice_kind_check;
alter table public.invoices
  add constraint invoices_invoice_kind_check
  check (invoice_kind in ('deposit', 'progress', 'final', 'standard', 'prepayment'));

-- ── 2. The deposit an estimate states ───────────────────────────────────────────────────────────
alter table public.quotes
  add column deposit_amount numeric(12,2);
alter table public.quotes
  add column deposit_by_hand boolean not null default false;
alter table public.quotes
  add constraint quotes_deposit_amount_not_negative check (deposit_amount is null or deposit_amount >= 0);

comment on column public.quotes.deposit_amount is
  'The deposit this estimate states (0414): written by the estimate''s save, the company''s rule (src/lib/deposit-rule.ts depositFor) unless deposit_by_hand. Null: not saved since 0414, nothing is stated. 0: no deposit.';
comment on column public.quotes.deposit_by_hand is
  'True when the office typed deposit_amount for this estimate (0414); false when it follows the company''s rule.';

-- ── 3. The request a credit line takes off ──────────────────────────────────────────────────────
alter table public.invoice_items
  add column prepaid_invoice_id uuid;
alter table public.invoice_items
  add constraint invoice_items_prepaid_credit_names_its_request
  check ((import_source is not distinct from 'prepaid_credit') = (prepaid_invoice_id is not null));
create unique index invoice_items_one_credit_per_request
  on public.invoice_items (invoice_id, prepaid_invoice_id) where prepaid_invoice_id is not null;
create index invoice_items_prepaid_invoice_idx
  on public.invoice_items (prepaid_invoice_id) where prepaid_invoice_id is not null;

comment on column public.invoice_items.prepaid_invoice_id is
  'The payment request (an invoice of kind prepayment) this prepaid_credit line takes off its bill (0414). Set exactly on those lines. No foreign key on purpose (a second key to invoices makes every PostgREST embed between the two tables ambiguous): its existence and its restrict are held by the triggers guard_prepaid_credit_line and guard_prepayment_delete.';

-- ── 4. The boundary ─────────────────────────────────────────────────────────────────────────────
-- THE SUM, for one request: its lines on bills that are not void never take off more than it asks.
-- The request's row is locked first, so a second writer waits and then reads the first one's line.
-- p_said: 'credit' when a bill's line is being written, 'own' when the request's own line is.
create or replace function public.prepayment_hold(p_request uuid, p_said text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number text;
  v_asked  numeric;
  v_taken  numeric;
begin
  select i.invoice_number into v_number from public.invoices i where i.id = p_request for update;
  if not found then
    return; -- the request itself is being deleted, and its own lines with it
  end if;
  select coalesce(sum(it.line_total), 0) into v_asked
    from public.invoice_items it where it.invoice_id = p_request;
  select coalesce(sum(-it.line_total), 0) into v_taken
    from public.invoice_items it
    join public.invoices b on b.id = it.invoice_id
   where it.import_source = 'prepaid_credit'
     and it.prepaid_invoice_id = p_request
     and b.status <> 'void';
  if v_taken > v_asked then
    if p_said = 'own' then
      raise exception '% can''t ask for $%: bills already take $% of it off. Nothing was saved.',
        coalesce(v_number, 'This payment request'), to_char(v_asked, 'FM999,999,990.00'), to_char(v_taken, 'FM999,999,990.00');
    end if;
    raise exception '% asks for $%, and its bills would take $% off. A bill takes off only what is left of a payment request: put this bill back to Draft and it takes the right amount. Nothing was saved.',
      coalesce(v_number, 'This payment request'), to_char(v_asked, 'FM999,999,990.00'), to_char(v_taken, 'FM999,999,990.00');
  end if;
end $$;

comment on function public.prepayment_hold(uuid, text) is
  'The boundary of one payment request (0414): locks its row, then refuses when its prepaid_credit lines on bills that are not void take off more than its own lines ask. Called by the triggers only.';
revoke all on function public.prepayment_hold(uuid, text) from public, anon, authenticated;

-- ONE LINE THAT TAKES A REQUEST OFF A BILL, as it stands: every rule of the line, then the sum.
create or replace function public.prepaid_credit_line_holds(p_bill uuid, p_request uuid, p_line_total numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req  record;
  v_bill record;
begin
  select i.invoice_number, i.invoice_kind, i.status::text as status, i.org_id, i.job_id
    into v_req from public.invoices i where i.id = p_request for update;
  if not found then
    raise exception 'This line takes off a payment request that is not on the books. Nothing was saved.';
  end if;
  select b.invoice_number, b.invoice_kind, b.status::text as status, b.org_id, b.job_id
    into v_bill from public.invoices b where b.id = p_bill;
  if not found then
    return; -- the bill is being deleted, and its lines with it
  end if;
  if v_req.invoice_kind <> 'prepayment' then
    raise exception '% is not a payment request, so no bill can take it off as one. Nothing was saved.', coalesce(v_req.invoice_number, 'That invoice');
  end if;
  if v_req.status = 'void' then
    raise exception '% was voided, so it asks for nothing and no bill can take it off. Put % back to Draft: as a draft it drops the line. Nothing was saved.',
      coalesce(v_req.invoice_number, 'That payment request'), coalesce(v_bill.invoice_number, 'this bill');
  end if;
  if v_req.status = 'draft' then
    raise exception '% is a draft, so it asks for nothing yet and no bill can take it off. Nothing was saved.', coalesce(v_req.invoice_number, 'That payment request');
  end if;
  if v_bill.invoice_kind = 'prepayment' then
    raise exception 'A payment request can''t take another payment request off. Nothing was saved.';
  end if;
  if v_bill.org_id is distinct from v_req.org_id or v_bill.job_id is null or v_bill.job_id is distinct from v_req.job_id then
    raise exception '% is on another job, so % can''t take it off. Nothing was saved.',
      coalesce(v_req.invoice_number, 'That payment request'), coalesce(v_bill.invoice_number, 'this bill');
  end if;
  if coalesce(p_line_total, 0) > 0 then
    raise exception 'The line that takes % off a bill takes money off: it can''t add any. Nothing was saved.', coalesce(v_req.invoice_number, 'a payment request');
  end if;
  perform public.prepayment_hold(p_request, 'credit');
end $$;

comment on function public.prepaid_credit_line_holds(uuid, uuid, numeric) is
  'Every rule of one prepaid_credit line (0414): its request exists, is a payment request, is not void or a draft, is in the same company and on the same job as the line''s bill; the bill is not itself a request; the line is at or below zero; then prepayment_hold. Called by the triggers only.';
revoke all on function public.prepaid_credit_line_holds(uuid, uuid, numeric) from public, anon, authenticated;

create or replace function public.guard_prepaid_credit_line()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
begin
  -- A line that takes a request off a bill, as it now stands.
  if tg_op <> 'DELETE' then
    if new.import_source = 'prepaid_credit' then
      perform public.prepaid_credit_line_holds(new.invoice_id, new.prepaid_invoice_id, new.line_total);
    end if;
    -- A request's own line (written, raised, lowered, moved onto it): never below what bills take off.
    select i.invoice_kind into v_kind from public.invoices i where i.id = new.invoice_id;
    if v_kind = 'prepayment' then
      perform public.prepayment_hold(new.invoice_id, 'own');
    end if;
  end if;
  -- A request's own line lowered, moved away or deleted.
  if tg_op <> 'INSERT' then
    v_kind := null;
    select i.invoice_kind into v_kind from public.invoices i where i.id = old.invoice_id;
    if v_kind = 'prepayment' and (tg_op = 'DELETE' or new.invoice_id is distinct from old.invoice_id or new.line_total < old.line_total) then
      perform public.prepayment_hold(old.invoice_id, 'own');
    end if;
  end if;
  return null;
end $$;

comment on function public.guard_prepaid_credit_line() is
  'The boundary of payment requests on invoice_items (0414): every prepaid_credit line is checked as it stands (prepaid_credit_line_holds), and a request''s own lines never ask for less than its bills already take off (prepayment_hold).';
revoke all on function public.guard_prepaid_credit_line() from public, anon, authenticated;

create trigger invoice_items_prepaid_boundary
  after insert or update or delete on public.invoice_items
  for each row execute function public.guard_prepaid_credit_line();

-- ── 5. A request, and a bill that takes requests off, keep their shape ──────────────────────────
create or replace function public.guard_prepayment_bill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_taker text;
  v_named boolean;
  r       record;
begin
  -- THE REQUEST ITSELF.
  if old.invoice_kind = 'prepayment' or new.invoice_kind = 'prepayment' then
    select exists (
      select 1 from public.invoice_items it
       where it.import_source = 'prepaid_credit' and it.prepaid_invoice_id = new.id
    ) into v_named;
    if v_named and new.invoice_kind is distinct from old.invoice_kind then
      raise exception '% is a payment request a bill takes off, so it stays one. Nothing was saved.', coalesce(new.invoice_number, 'This payment request');
    end if;
    if v_named and (new.job_id is distinct from old.job_id or new.org_id is distinct from old.org_id) then
      raise exception '% is taken off a bill on its own job, so it can''t move to another. Nothing was saved.', coalesce(new.invoice_number, 'This payment request');
    end if;
    if new.status is distinct from old.status and new.status::text in ('void', 'draft') then
      select b.invoice_number into v_taker
        from public.invoice_items it
        join public.invoices b on b.id = it.invoice_id
       where it.import_source = 'prepaid_credit'
         and it.prepaid_invoice_id = new.id
         and b.status::text not in ('void', 'draft')
       order by b.created_at, b.id
       limit 1;
      if found then
        raise exception '% can''t be %: % already took it off and went out. Void % first, or leave % as it is.',
          coalesce(new.invoice_number, 'This payment request'),
          case when new.status::text = 'void' then 'voided' else 'put back to draft' end,
          coalesce(v_taker, 'a bill'), coalesce(v_taker, 'that bill'), coalesce(new.invoice_number, 'the request');
      end if;
    end if;
  end if;

  -- A BILL THAT TAKES REQUESTS OFF.
  if exists (select 1 from public.invoice_items it where it.invoice_id = new.id and it.import_source = 'prepaid_credit') then
    if new.invoice_kind = 'prepayment' then
      raise exception '% takes payment requests off, so it can''t become one. Nothing was saved.', coalesce(new.invoice_number, 'This bill');
    end if;
    if new.job_id is distinct from old.job_id or new.org_id is distinct from old.org_id then
      raise exception '% takes this job''s payment requests off. Take those lines off before it moves to another job. Nothing was saved.', coalesce(new.invoice_number, 'This bill');
    end if;
    -- Going out, or coming back from void as anything but a draft, its lines stand as written: each is
    -- checked. Back from void AS A DRAFT they are not (skeptic #80): a draft's lines are derived, its
    -- next recalculation re-resolves them (the app's un-void door takes off first the ones that would
    -- no longer hold), and they are checked when it goes out.
    if (old.status::text = 'void' and new.status::text not in ('void', 'draft'))
       or (old.status::text = 'draft' and new.status::text not in ('draft', 'void')) then
      for r in
        select it.prepaid_invoice_id, it.line_total from public.invoice_items it
         where it.invoice_id = new.id and it.import_source = 'prepaid_credit'
         order by it.prepaid_invoice_id
      loop
        perform public.prepaid_credit_line_holds(new.id, r.prepaid_invoice_id, r.line_total);
      end loop;
    end if;
  end if;
  return null;
end $$;

comment on function public.guard_prepayment_bill() is
  'Payment requests on invoices (0414): a request a bill takes off keeps its kind and its job, and is not voided or put back to draft while a bill that went out takes it off; a bill carrying prepaid_credit lines does not become a request, does not move job while it carries them, and has each line checked when it goes out or comes back from void as anything but a draft.';
revoke all on function public.guard_prepayment_bill() from public, anon, authenticated;

create trigger invoices_prepayment_boundary
  after update of status, job_id, org_id, invoice_kind on public.invoices
  for each row execute function public.guard_prepayment_bill();

-- ── 6. A request a line names is not deleted ────────────────────────────────────────────────────
create or replace function public.guard_prepayment_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_taker text;
begin
  select b.invoice_number into v_taker
    from public.invoice_items it
    join public.invoices b on b.id = it.invoice_id
   where it.import_source = 'prepaid_credit'
     and it.prepaid_invoice_id = old.id
     and it.invoice_id <> old.id
   order by b.created_at, b.id
   limit 1;
  if found then
    raise exception '% can''t be deleted: % takes it off. Take it off % first, then delete. Nothing was deleted.',
      coalesce(old.invoice_number, 'This payment request'), coalesce(v_taker, 'a bill'), coalesce(v_taker, 'that bill');
  end if;
  return old;
end $$;

comment on function public.guard_prepayment_delete() is
  'The restrict of invoice_items.prepaid_invoice_id (0414; no foreign key, see the column): a payment request a prepaid_credit line names is not deleted.';
revoke all on function public.guard_prepayment_delete() from public, anon, authenticated;

create trigger invoices_prepayment_restrict
  before delete on public.invoices
  for each row execute function public.guard_prepayment_delete();

-- ── 7. One live deposit request per estimate ────────────────────────────────────────────────────
create unique index invoices_one_live_deposit_request_per_estimate
  on public.invoices (quote_id)
  where invoice_kind = 'prepayment' and quote_id is not null and status <> 'void';

-- ── 8. The customer's estimate link says the deposit ────────────────────────────────────────────
create or replace function public.public_quote(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'quote', json_build_object(
      'quote_number', q.quote_number, 'status', q.status, 'title', q.title,
      'description', q.description,
      'notes', q.notes, 'tax_rate', q.tax_rate, 'subtotal', q.subtotal,
      'tax', q.tax, 'total', q.total, 'valid_until', q.valid_until,
      'circuits', q.circuits,
      'doc_type', q.doc_type, 'created_at', q.created_at,
      -- 0414: THE DEPOSIT, AND WHERE IT STANDS: ONE NUMBER FOR THE PAPER, THE BUTTON AND THE CHARGE.
      -- deposit_amount: when the estimate has a live (not void) deposit request, THAT request's ask
      -- (the sum of its own lines), which is what its card door charges; otherwise the figure the
      -- office's save wrote (null on an estimate not saved since 0414: nothing is said for it).
      -- deposit_state: paid (the live request is paid); requested (it exists and is not paid yet: a
      -- live request is owed, on a finished job too); none (no live request and no figure, or 0; or
      -- the office voided the request, and a new one is made only by the office's own form; or the
      -- estimate's job is complete or cancelled); else due. can_take_card is the company's card
      -- door, the same expression public_invoice reads (0301's projection).
      'deposit_amount', coalesce((select sum(it.line_total) from public.invoices d
                                    join public.invoice_items it on it.invoice_id = d.id
                                   where d.quote_id = q.id and d.org_id = q.org_id
                                     and d.invoice_kind = 'prepayment' and d.status <> 'void'),
                                 q.deposit_amount),
      'deposit_state', case
        when exists (select 1 from public.invoices d
                      where d.quote_id = q.id and d.org_id = q.org_id
                        and d.invoice_kind = 'prepayment' and d.status = 'paid') then 'paid'
        when exists (select 1 from public.invoices d
                      where d.quote_id = q.id and d.org_id = q.org_id
                        and d.invoice_kind = 'prepayment' and d.status <> 'void') then 'requested'
        when coalesce(q.deposit_amount, 0) <= 0 then 'none'
        when exists (select 1 from public.invoices d
                      where d.quote_id = q.id and d.org_id = q.org_id
                        and d.invoice_kind = 'prepayment' and d.status = 'void') then 'none'
        when exists (select 1 from public.jobs j
                      where j.id = q.job_id and j.org_id = q.org_id
                        and (j.status = 'complete' or j.status = 'cancelled')) then 'none'
        else 'due' end,
      'can_take_card', (select coalesce(o.stripe_charges_enabled, false)
                          from public.organizations o where o.id = q.org_id),
      -- 0408: THE WORD THE PAGE PRINTS BY, as resolved once below (fmt).
      'estimate_format', fmt.word),
    'items', coalesce((select json_agg(json_build_object(
      'description', li.description, 'quantity', li.quantity, 'unit', li.unit,
      'unit_price', li.unit_price, 'line_total', li.line_total,
      -- THE BREAKDOWN THE CUSTOMER MAY SEE (0386/0387/0395/0408), by the format resolved once below
      -- (fmt.word: the estimate's own word, else the company's):
      --   detailed  0395's object, key for key: his hours, the rate, the units, each labor row's
      --             label / hours / rate and each part's name, count and sell.
      --   grouped   the same labor keys, NO part at all (the list ships empty; no name, count or
      --             price is read) and ONE figure for one of the task: the parts' total, null when
      --             there is nothing priced.
      --   tasks     no breakdown.
      -- NEVER the contractor's net, the task id, the kit id, a book code or a person's id, in any
      -- arm. NO LABOR MONEY and no adds-up gate here: known and carried, see this migration's header.
      'detail', case
        when jsonb_typeof(li.detail) = 'object' and fmt.word = 'detailed'
        then jsonb_build_object(
          'hours', li.detail->'hours',
          'rate', li.detail->'rate',
          'units', li.detail->'units',
          'labor', coalesce((select jsonb_agg(jsonb_build_object(
              'label', l->'label', 'hours', l->'hours', 'rate', l->'rate') order by ord)
            from jsonb_array_elements(case when jsonb_typeof(li.detail->'labor') = 'array' then li.detail->'labor' else '[]'::jsonb end) with ordinality as lab(l, ord)), '[]'::jsonb),
          'materials', coalesce((select jsonb_agg(jsonb_build_object(
              'name', m->'name', 'qty', m->'qty', 'sell', m->'sell') order by ord)
            from jsonb_array_elements(case when jsonb_typeof(li.detail->'materials') = 'array' then li.detail->'materials' else '[]'::jsonb end) with ordinality as mats(m, ord)), '[]'::jsonb))
        when jsonb_typeof(li.detail) = 'object' and fmt.word = 'grouped'
        then jsonb_build_object(
          'hours', li.detail->'hours',
          'rate', li.detail->'rate',
          'units', li.detail->'units',
          'labor', coalesce((select jsonb_agg(jsonb_build_object(
              'label', l->'label', 'hours', l->'hours', 'rate', l->'rate') order by ord)
            from jsonb_array_elements(case when jsonb_typeof(li.detail->'labor') = 'array' then li.detail->'labor' else '[]'::jsonb end) with ordinality as lab(l, ord)), '[]'::jsonb),
          'materials', '[]'::jsonb,
          'materials_total', nullif(public.task_parts_total(li.detail), 0))
        else null end) order by li.sort_order)
      from public.quote_line_items li where li.quote_id = q.id), '[]'::json),
    'customer', coalesce(
      (select json_build_object('name', c.name, 'company_name', c.company_name,
        'address', c.address, 'unit', c.unit, 'city', c.city, 'state', c.state, 'zip', c.zip)
        from public.customers c where c.id = q.customer_id and c.org_id = q.org_id),
      (select json_build_object('name', i.name, 'company_name', i.company_name,
        'address', i.address, 'unit', i.unit, 'city', i.city, 'state', i.state, 'zip', i.zip)
        from public.inquiries i where i.id = q.inquiry_id and i.org_id = q.org_id)),
    -- RAW CANDIDATES, most specific first. No precedence here — see pickSite().
    'site_candidates', json_build_array(
      json_build_object('source', 'quote', 'parts', json_build_object(
        'address', q.address, 'unit', q.unit, 'city', q.city, 'state', q.state, 'zip', q.zip)),
      (select json_build_object('source', 'job', 'parts', json_build_object(
        'address', j.address, 'unit', j.unit, 'city', j.city, 'state', j.state, 'zip', j.zip))
        from public.jobs j where j.id = q.job_id and j.org_id = q.org_id),
      (select json_build_object('source', 'lead', 'parts', json_build_object(
        'address', i.address, 'unit', i.unit, 'city', i.city, 'state', i.state, 'zip', i.zip))
        from public.inquiries i where i.id = q.inquiry_id and i.org_id = q.org_id)),
    -- LETTERHEAD ONLY (0059's list) + the doc_style layout sub-key (0239). Never to_jsonb(o):
    -- organizations carries the settings jsonb (markup, labor rate, playbook,
    -- lead_inbound_secret) and the Stripe/subscription columns. If you re-create this
    -- function, copy THIS body.
    'org', (select json_build_object(
      'name', o.name, 'logo_url', o.logo_url,
      'address_line1', o.address_line1, 'address_line2', o.address_line2,
      'city', o.city, 'state', o.state, 'zip', o.zip,
      'phone', o.phone, 'email', o.email, 'license', o.license,
      'brand_color', o.brand_color,
      'doc_template', o.doc_template, 'doc_templates', o.doc_templates,
      'doc_style', o.settings->'doc_style')
      from public.organizations o where o.id = q.org_id)
  )
  from public.quotes q
  -- THE FORMAT, RESOLVED ONCE (0408): the estimate's own word, else the company's Doc Studio choice;
  -- anything that is not one of the three words (nothing set, or an old or unknown value) reads as
  -- tasks. The twin of lib/doc-style estimateFormatFor. Exactly one row, so the estimate above is
  -- neither dropped nor doubled.
  cross join lateral (
    select case when said.word in ('tasks', 'detailed', 'grouped') then said.word else 'tasks' end as word
      from (select coalesce(q.estimate_format, (select o.settings->'doc_style'->>'estimate_format' from public.organizations o where o.id = q.org_id)) as word) said
  ) fmt
  where q.public_token = p_token
    and q.status in ('sent', 'accepted', 'declined', 'expired');
$$;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_quote regprocedure := 'public.public_quote(text)'::regprocedure;
  v_def   text;
  v_src   text;
  v_was   text;
  v_now   text;
  v_n     int;
  r       record;
begin
  -- 1. THE KIND CHECK: one, under its name, validated, with the five words and no other.
  select count(*), min(pg_get_constraintdef(k.oid)) into v_n, v_def
    from pg_constraint k
   where k.conrelid = 'public.invoices'::regclass and k.contype = 'c'
     and (select array_agg(a.attname::text) from pg_attribute a where a.attrelid = k.conrelid and a.attnum = any (k.conkey)) = array['invoice_kind'];
  if v_n <> 1
     or not exists (select 1 from pg_constraint k where k.conrelid = 'public.invoices'::regclass and k.conname = 'invoices_invoice_kind_check' and k.convalidated)
     or (select coalesce(array_agg(w[1] order by w[1]), '{}'::text[]) from regexp_matches(v_def, '''([^'']*)''', 'g') as w)
        <> array['deposit', 'final', 'prepayment', 'progress', 'standard'] then
    raise exception '0414: the check on invoices.invoice_kind is not deposit, progress, final, standard and prepayment (found %). Nothing was changed.', coalesce(v_def, 'none');
  end if;

  -- 2. THE ESTIMATE'S TWO COLUMNS AND THEIR CHECK.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'quotes' and column_name = 'deposit_amount'
       and data_type = 'numeric' and numeric_precision = 12 and numeric_scale = 2 and is_nullable = 'YES' and column_default is null
  ) or not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'quotes' and column_name = 'deposit_by_hand'
       and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false'
  ) then
    raise exception '0414: quotes.deposit_amount is not a nullable numeric(12,2) with no default, or quotes.deposit_by_hand not a boolean, not null, default false. Nothing was changed.';
  end if;
  select lower(pg_get_constraintdef(k.oid)) into v_def from pg_constraint k
   where k.conrelid = 'public.quotes'::regclass and k.contype = 'c' and k.convalidated and k.conname = 'quotes_deposit_amount_not_negative';
  if v_def is null or position('deposit_amount >=' in v_def) = 0 then
    raise exception '0414: the check quotes_deposit_amount_not_negative is not there. Nothing was changed.';
  end if;

  -- 3. THE LINE'S REQUEST: a nullable uuid, set exactly on a prepaid_credit line, one per request on
  --    a bill, indexed, and NO foreign key (see the column's comment).
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'invoice_items' and column_name = 'prepaid_invoice_id'
       and data_type = 'uuid' and is_nullable = 'YES' and column_default is null
  ) then
    raise exception '0414: invoice_items.prepaid_invoice_id is not a nullable uuid with no default. Nothing was changed.';
  end if;
  if exists (
    select 1 from pg_constraint k
     where k.conrelid = 'public.invoice_items'::regclass and k.contype = 'f'
       and k.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = 'public.invoice_items'::regclass and a.attname = 'prepaid_invoice_id')]::int2[]
  ) then
    raise exception '0414: invoice_items.prepaid_invoice_id carries a foreign key, which makes every embed between invoices and invoice_items ambiguous. Nothing was changed.';
  end if;
  select lower(pg_get_constraintdef(k.oid)) into v_def from pg_constraint k
   where k.conrelid = 'public.invoice_items'::regclass and k.contype = 'c' and k.convalidated and k.conname = 'invoice_items_prepaid_credit_names_its_request';
  if v_def is null or position('prepaid_credit' in v_def) = 0 or position('prepaid_invoice_id is not null' in v_def) = 0 then
    raise exception '0414: the check invoice_items_prepaid_credit_names_its_request is not there. Nothing was changed.';
  end if;
  for r in
    select * from (values
      ('invoice_items_one_credit_per_request', true, 'prepaid_invoice_id is not null'),
      ('invoice_items_prepaid_invoice_idx', false, 'prepaid_invoice_id is not null'),
      ('invoices_one_live_deposit_request_per_estimate', true, 'prepayment')
    ) as t(idx, uniq, mark)
  loop
    if not exists (
      select 1 from pg_index x
       where x.indexrelid = to_regclass('public.' || r.idx)
         and x.indisunique = r.uniq and x.indisvalid
         and position(r.mark in lower(pg_get_expr(x.indpred, x.indrelid))) > 0
    ) then
      raise exception '0414: the index % is not there as this file made it. Nothing was changed.', r.idx;
    end if;
  end loop;

  -- 4-6. THE FUNCTIONS AND THE TRIGGERS: definer functions with the search path pinned, nobody outside
  --    the database may call them, and each trigger is bound where this file put it.
  for r in
    select * from (values
      ('public.prepayment_hold(uuid, text)'),
      ('public.prepaid_credit_line_holds(uuid, uuid, numeric)'),
      ('public.guard_prepaid_credit_line()'),
      ('public.guard_prepayment_bill()'),
      ('public.guard_prepayment_delete()')
    ) as t(fn)
  loop
    if to_regprocedure(r.fn) is null
       or not (select p.prosecdef from pg_proc p where p.oid = to_regprocedure(r.fn))
       or not coalesce((select p.proconfig @> array['search_path=public'] from pg_proc p where p.oid = to_regprocedure(r.fn)), false) then
      raise exception '0414: % is not a security-definer function with its search path pinned. Nothing was changed.', r.fn;
    end if;
    if has_function_privilege('anon', to_regprocedure(r.fn), 'execute') or has_function_privilege('authenticated', to_regprocedure(r.fn), 'execute') then
      raise exception '0414: a caller outside the database can run %. Nothing was changed.', r.fn;
    end if;
  end loop;
  for r in
    select * from (values
      ('public.invoice_items', 'invoice_items_prepaid_boundary', 'public.guard_prepaid_credit_line()', 'after', 'insert update delete'),
      ('public.invoices', 'invoices_prepayment_boundary', 'public.guard_prepayment_bill()', 'after', 'update'),
      ('public.invoices', 'invoices_prepayment_restrict', 'public.guard_prepayment_delete()', 'before', 'delete')
    ) as t(tbl, tg, fn, timing, ops)
  loop
    if not exists (
      select 1 from pg_trigger t
       where t.tgrelid = r.tbl::regclass and t.tgname = r.tg and not t.tgisinternal
         and t.tgfoid = r.fn::regprocedure and t.tgenabled <> 'D'
         and (t.tgtype & 1) = 1                                                -- row
         and ((t.tgtype & 2) = 2) = (r.timing = 'before')                      -- before / after
         and ((t.tgtype & 4) = 4) = (position('insert' in r.ops) > 0)          -- insert
         and ((t.tgtype & 8) = 8) = (position('delete' in r.ops) > 0)          -- delete
         and ((t.tgtype & 16) = 16) = (position('update' in r.ops) > 0)        -- update
    ) then
      raise exception '0414: the trigger % on % is not bound as this file made it. Nothing was changed.', r.tg, r.tbl;
    end if;
  end loop;

  -- 8. public_quote: still the customer's door, the same kind of function, owned and granted as it
  --    was, its body this file's own, carrying the three keys and 0408's gate.
  select p.prosrc into v_src from pg_proc p where p.oid = v_quote;
  if not (select p.prosecdef from pg_proc p where p.oid = v_quote)
     or (select p.provolatile from pg_proc p where p.oid = v_quote) <> 's'
     or (select p.prorettype from pg_proc p where p.oid = v_quote) <> 'json'::regtype
     or not coalesce((select p.proconfig @> array['search_path=public'] from pg_proc p where p.oid = v_quote), false) then
    raise exception '0414: public_quote is no longer the stable security-definer function that returns json with its search path pinned. Nothing was changed.';
  end if;
  if coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '') <> 'd0874c32f52cdcb1ec997dc8ef7f637a' then
    raise exception '0414: the public_quote now on this database does not read as the body this file wrote. Nothing was changed.';
  end if;
  if position('''deposit_amount'', coalesce((select sum(it.line_total) from public.invoices d' in v_src) = 0
     or position('''deposit_state'', case' in v_src) = 0
     or position('''can_take_card'', (select coalesce(o.stripe_charges_enabled, false)' in v_src) = 0
     or position('q.status in (''sent'', ''accepted'', ''declined'', ''expired'')' in v_src) = 0 then
    raise exception '0414: public_quote does not carry the three keys, or lost its status gate. Nothing was changed.';
  end if;
  if not has_function_privilege('anon', v_quote, 'execute') or not has_function_privilege('authenticated', v_quote, 'execute') then
    raise exception '0414: the customer''s link can no longer call public_quote. Nothing was changed.';
  end if;
  v_was := current_setting('cn.m0414_quote_was', true);
  if v_was is null or left(v_was, 4) <> 'was:' then
    raise exception '0414: this file has to run in ONE transaction (the runners wrap it in begin and commit): who owned public_quote before the change did not reach this check. Run it through the migration runner.';
  end if;
  select 'was:' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '') into v_now from pg_proc p where p.oid = v_quote;
  if v_now is distinct from v_was then
    raise exception '0414: the owner or the grants of public_quote changed (before: %; now: %). Nothing was changed.', v_was, v_now;
  end if;
  -- It runs: an unknown token is answered with nothing, not an error.
  if public.public_quote('0414 self-check: no estimate has this token') is not null then
    raise exception '0414: public_quote answered a token no estimate has. Nothing was changed.';
  end if;

  raise notice '0414: a payment request is a bill of its own kind; the bills after it take it off one line each, never the same dollar twice; an estimate states its deposit, and its link says it.';
end $$;
