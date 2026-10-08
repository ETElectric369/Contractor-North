-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0383: a bill knows how much of it is paid
--
-- Erik, 2026-10-04, on how CED's own portal works: "i check all the boxes next to all the invoices
-- i want to pay and it totals it up and thats my amount, checked boxes get logged and if i make a
-- payment to the account instead it'll mark off in order from old to new the ones that are fully
-- paid and leave the last one partially paid" — and the rule under it: "if its an open bill its an
-- open bill and if its a paid bill its a paid bill, simple."
--
-- THE GAP. bills.status held two truths at once. On half his book 'paid' meant "bought at the
-- register" (80 receipts); on the other half it meant "I paid CED for this" (46 bills he ticked by
-- hand after sending the money). A supplier payment (supplier_payments, 0270) landed on the ACCOUNT
-- and said nothing about which bills it paid, so a bill the supplier's own closed paper covered
-- had to be read as "Settled · CED Says" by a walk over documents on every screen, never written
-- down, and the same ticket could read owed on one line and settled on the next.
--
-- THE SHAPE. ONE NUMBER PER BILL, kept by the database:
--   1. bills.amount_paid — how much of this bill is paid, whoever paid it and however. What is
--      OPEN on a bill is amount − amount_paid. A credit (a negative bill) is negative both ways.
--   2. supplier_payment_allocations — which payment paid which bill, and how much: cash in `amount`,
--      and the supplier's prompt-pay discount forgiven on that bill in `discount`. Both count as
--      paid. A payment's cash not matched to any bill is money ahead on the account.
--   3. bills.status STAYS and is DERIVED here, per PURCHASE (a bill and the corrections under it,
--      0381): 'paid' when the purchase has nothing open, 'unpaid' otherwise. Every reader of the
--      raw column — Nort, the registry, the P&L, the Unpaid filter — is right by construction.
--      A bill marked paid by a person (the Mark Paid tap, a receipt born paid at the counter) is
--      paid in full by his word: amount_paid := amount, with no allocation. Marking a bill back
--      On Account keeps what the payments actually paid, and is REFUSED when they cover it: the
--      door for that is Undo on the payment, which reopens every bill it paid (trigger 6).
--
-- THE TRIGGERS, and the order they fire in (BEFORE triggers on one table fire by name):
--   4. bill_money_follows (BEFORE INSERT OR UPDATE on bills): born paid → paid in full; an explicit
--      flip to paid → the whole purchase paid in full by his word; a flip to unpaid → back to what
--      the payments paid, refused when they cover it; the price changed → a bill paid in full by
--      his word stays paid in full, one paid by payments keeps theirs; then status := derived.
--      It runs BEFORE guard_bill_correction (b < g), which this file REPLACES in full to stop
--      copying status onto a correction: a correction's money is its own, and the purchase
--      re-derives — a paid $613.19 ticket corrected by $95.99 is a purchase $95.99 short, so both
--      read On Account until the difference is paid. Marking a correction by itself is still
--      refused in 0382's own words, by this trigger now.
--   5. bill_money_syncs (AFTER): every member of the purchase carries the one derived status.
--      bill_corrections_follow (0382) is REPLACED in full to carry job, bucket and part of the
--      job only.
--   6b. bill_takes_ahead_cash (AFTER INSERT on bills): cash a payment sent past every open purchase
--      is ahead on the account, and the next live bill recorded there takes it, oldest payment first
--      (supplier_apply_ahead). "It comes off the next bill you record" is kept by the database.
--   6. guard_payment_allocation / allocation_rolls_up / payment_void_rolls_up: same company on
--      payment and bill; a payment's cash never exceeds the payment; the payments on a bill never
--      exceed the bill; a voided payment pays nothing; every change rolls into amount_paid and
--      re-derives the purchase. What a person said was paid otherwise is never lost: Undo on a
--      payment takes back exactly what that payment paid.
--
-- THE BACKFILL, every company:
--   a. amount_paid := amount on every bill marked paid — his word, written down.
--   b. an open bill every LINKED supplier document calls closed (≥ 1 linked, none open) is paid by
--      the supplier's word: amount_paid := amount. On the measured book that is one bill. A bill
--      covered only by a number printed on its lines is not touched here: Reconcile names it.
--   c. THE PAYMENTS ALREADY RECORDED ARE MATCHED TO BILLS (Erik, 2026-10-07: "if we need to match
--      the bills to reconcile then do it then it'll be clean"), the way the Record A Payment door
--      would have, replayed in date order: each live payment pays its account's bills oldest first
--      — bills already marked paid first (explaining his ticks), then open bills — only bills
--      dated on or before the payment, only live bills with money to pay. Cash left over stays on
--      the payment as money ahead. On the measured book six payments ($11,207.64) match across the
--      oldest of the paid CED bills; no open bill is touched.
--
-- LOCKS: one column with a default (a catalog change on Postgres 11+), one check constraint
-- validated over the table (0 and amount always satisfy it), one new table, seven triggers, two
-- function swaps, the backfill (four updates and the replay), and REVOKEs on every helper: nothing
-- here is for a signed-in user to call as an RPC. ACCESS EXCLUSIVE on bills for a moment. lock_timeout
-- 15s. ORDER: after 0382. Safe to re-run: every step checks before it writes, and the replay
-- skips a payment that already pays something.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '15s';
set local statement_timeout = '120s';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bills' and column_name = 'corrects_bill_id'
  ) then
    raise exception '0383: bills.corrects_bill_id is not on this database. Run 0381 and 0382 first. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'supplier_payments'
  ) then
    raise exception '0383: supplier_payments is not on this database. Run 0270 first. Nothing was changed.';
  end if;
end $$;

-- ── 1. THE NUMBER ───────────────────────────────────────────────────────────────────────────────
alter table public.bills add column if not exists amount_paid numeric(12,2) not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bills'::regclass and conname = 'bills_amount_paid_within_amount'
  ) then
    alter table public.bills
      add constraint bills_amount_paid_within_amount
      check (amount_paid between least(0, amount) and greatest(0, amount));
  end if;
end $$;

comment on column public.bills.amount_paid is
  'How much of this bill is paid, whoever paid it and however (0383): the payments matched to it (supplier_payment_allocations, cash plus discount) and whatever a person said was paid otherwise (a receipt paid at the counter, the Mark Paid tap). OPEN = amount − amount_paid. A credit is negative both ways. bills.status is derived from it per purchase by trigger; never write status to mean money.';

-- ── 2. THE ALLOCATIONS: WHICH PAYMENT PAID WHICH BILL ───────────────────────────────────────────
create table if not exists public.supplier_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  supplier_payment_id uuid not null references public.supplier_payments(id) on delete cascade,
  bill_id uuid not null references public.bills(id) on delete cascade,
  -- Cash from the payment applied to this bill.
  amount numeric(12,2) not null default 0 check (amount >= 0),
  -- The supplier's prompt-pay discount forgiven on this bill when the payment took it. Not cash;
  -- it counts as paid on the bill and never against the payment's amount.
  discount numeric(12,2) not null default 0 check (discount >= 0),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  unique (supplier_payment_id, bill_id),
  check (amount + discount > 0)
);

comment on table public.supplier_payment_allocations is
  'Which supplier payment paid which bill, and how much (0383): cash in amount, the prompt-pay discount forgiven on that bill in discount. Rolled into bills.amount_paid by trigger. A payment''s cash with no row here is money ahead on the account.';

create index if not exists supplier_payment_allocations_bill_idx
  on public.supplier_payment_allocations (bill_id);
create index if not exists supplier_payment_allocations_payment_idx
  on public.supplier_payment_allocations (org_id, supplier_payment_id);

alter table public.supplier_payment_allocations enable row level security;
drop policy if exists supplier_payment_allocations_staff_all on public.supplier_payment_allocations;
create policy supplier_payment_allocations_staff_all on public.supplier_payment_allocations
  for all
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

-- ── 3. THE HELPERS THE TRIGGERS SHARE ───────────────────────────────────────────────────────────

-- What the live (non-voided) payments paid on this one bill, cash and discount together.
create or replace function public.bill_live_allocated(p_bill uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(a.amount + a.discount), 0)
    from public.supplier_payment_allocations a
    join public.supplier_payments p on p.id = a.supplier_payment_id
   where a.bill_id = p_bill
     and p.voided_at is null
$$;

-- What is open on a PURCHASE: the original and the live corrections under it, one member left out
-- when the caller holds that member's new numbers in hand (a BEFORE trigger).
create or replace function public.bill_family_open(p_root uuid, p_except uuid default null)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(b.amount - b.amount_paid), 0)
    from public.bills b
   where (b.id = p_root or b.corrects_bill_id = p_root)
     and b.superseded_by_bill_id is null
     and (p_except is null or b.id <> p_except)
$$;

-- The day of the latest live payment that pays any member of the purchase, as the sentences say it.
create or replace function public.bill_family_paid_by(p_root uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select to_char(max(p.paid_on), 'Mon FMDD')
    from public.supplier_payment_allocations a
    join public.supplier_payments p on p.id = a.supplier_payment_id
    join public.bills b on b.id = a.bill_id
   where (b.id = p_root or b.corrects_bill_id = p_root)
     and b.superseded_by_bill_id is null
     and p.voided_at is null
$$;

-- ONE STATUS FOR THE WHOLE PURCHASE. Writes with the sync flag up, so bill_money_follows only
-- derives and bill_money_syncs does not come back round.
create or replace function public.bill_family_sync(p_root uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_prev   text;
begin
  v_status := case when abs(public.bill_family_open(p_root)) < 0.005 then 'paid' else 'unpaid' end;
  v_prev := coalesce(current_setting('cn.bill_money_sync', true), '');
  perform set_config('cn.bill_money_sync', '1', true);
  update public.bills b
     set status = v_status
   where (b.id = p_root or b.corrects_bill_id = p_root)
     and b.superseded_by_bill_id is null
     and b.status is distinct from v_status;
  perform set_config('cn.bill_money_sync', v_prev, true);
end $$;

-- A CHANGE IN WHAT THE PAYMENTS PAID ROLLS INTO THE BILL'S NUMBER. What a person said was paid
-- otherwise is kept: the number moves by the change and never drops under what the live payments
-- pay, never over the bill. Then the purchase re-derives.
create or replace function public.bill_roll_up(p_bill uuid, p_delta numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r        record;
  v_alloc  numeric;
  v_target numeric;
  v_prev   text;
begin
  select b.id, b.amount, b.amount_paid, b.corrects_bill_id into r from public.bills b where b.id = p_bill;
  if not found then
    return;
  end if;
  v_alloc := public.bill_live_allocated(p_bill);
  v_target := greatest(v_alloc, r.amount_paid + coalesce(p_delta, 0));
  v_target := least(greatest(v_target, least(0, r.amount)), greatest(0, r.amount));
  v_prev := coalesce(current_setting('cn.bill_money_sync', true), '');
  perform set_config('cn.bill_money_sync', '1', true);
  if v_target is distinct from r.amount_paid then
    update public.bills set amount_paid = v_target where id = p_bill;
  end if;
  perform set_config('cn.bill_money_sync', v_prev, true);
  perform public.bill_family_sync(coalesce(r.corrects_bill_id, p_bill));
end $$;

-- ── 4. THE BILL'S OWN NUMBER FOLLOWS WHAT WAS SAID, AND STATUS FOLLOWS THE NUMBER ───────────────
create or replace function public.bill_money_follows()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sync    boolean := coalesce(current_setting('cn.bill_money_sync', true), '') = '1';
  v_was     text;
  v_root    uuid;
  v_alloc   numeric;
  v_open    numeric;
  v_prev    text;
  v_label   text;
  v_paid_by text;
begin
  new.amount_paid := coalesce(new.amount_paid, 0);
  -- THE WORD IS ONE OF TWO, whatever a caller spelled ("Paid", "PAID ", null): anything else read
  -- as a flip and reset the number. Normalised here, once, and compared normalised.
  new.status := case when lower(btrim(coalesce(new.status, ''))) = 'paid' then 'paid' else 'unpaid' end;
  v_was := case when tg_op = 'INSERT' then null when lower(btrim(coalesce(old.status, ''))) = 'paid' then 'paid' else 'unpaid' end;

  if not v_sync then
    -- A BILL A PAYMENT PAID CANNOT BE SET ASIDE AS A DUPLICATE: its cash would be matched to a paper
    -- that no longer counts, neither open nor ahead. Undo the payment first (it reopens the bill).
    if tg_op = 'UPDATE' and new.superseded_by_bill_id is not null
       and new.superseded_by_bill_id is distinct from old.superseded_by_bill_id
       and public.bill_live_allocated(new.id) > 0.005 then
      raise exception '% is paid by the payment of %. Undo that payment before setting this bill aside. Nothing was changed.',
        coalesce(nullif(new.bill_number, ''), 'This bill'),
        coalesce(public.bill_family_paid_by(coalesce(new.corrects_bill_id, new.id)), 'a day')
        using errcode = 'P0001';
    end if;

    if tg_op = 'INSERT' then
      -- BORN PAID: a receipt paid at the counter, or a supplier document the supplier closed. The
      -- door may send the number itself (Record It As A Bill does); otherwise 'paid' means all of it.
      -- A CORRECTION IS NEVER BORN PAID BY ITS ORIGINAL'S WORD: its money is its own, and the
      -- purchase re-derives below.
      if new.status = 'paid' and new.amount_paid = 0 and new.corrects_bill_id is null then
        new.amount_paid := new.amount;
      end if;

    elsif new.status is distinct from v_was then
      -- THE EXPLICIT FLIP, by a person or by Nort.
      if new.corrects_bill_id is not null then
        select coalesce(nullif(o.bill_number, ''), 'that bill') into v_label
          from public.bills o where o.id = new.corrects_bill_id;
        raise exception 'A correction is settled with the bill it corrects (%). Mark that bill and this one follows. Nothing was changed.',
          coalesce(v_label, 'that bill')
          using errcode = 'P0001';
      end if;
      v_root := new.id;
      if new.status = 'paid' then
        -- PAID IN FULL BY HIS WORD, the whole purchase.
        v_prev := coalesce(current_setting('cn.bill_money_sync', true), '');
        perform set_config('cn.bill_money_sync', '1', true);
        update public.bills b
           set amount_paid = b.amount
         where b.corrects_bill_id = v_root
           and b.superseded_by_bill_id is null
           and b.amount_paid is distinct from b.amount;
        perform set_config('cn.bill_money_sync', v_prev, true);
        new.amount_paid := new.amount;
      else
        -- BACK ON ACCOUNT: what the payments paid stays paid. When they cover the purchase, the
        -- payment is the door, and Undo on it reopens every bill it paid.
        select coalesce(sum(b.amount - public.bill_live_allocated(b.id)), 0) into v_open
          from public.bills b
         where b.corrects_bill_id = v_root and b.superseded_by_bill_id is null;
        v_open := v_open + (new.amount - public.bill_live_allocated(new.id));
        if abs(v_open) < 0.005 and public.bill_family_paid_by(v_root) is not null then
          v_paid_by := public.bill_family_paid_by(v_root);
          v_label := coalesce(nullif(new.bill_number, ''), 'This bill');
          raise exception '% is paid by the payment of %. Undo that payment to put it back on account. Nothing was changed.',
            v_label, v_paid_by
            using errcode = 'P0001';
        end if;
        v_prev := coalesce(current_setting('cn.bill_money_sync', true), '');
        perform set_config('cn.bill_money_sync', '1', true);
        update public.bills b
           set amount_paid = public.bill_live_allocated(b.id)
         where b.corrects_bill_id = v_root
           and b.superseded_by_bill_id is null
           and b.amount_paid is distinct from public.bill_live_allocated(b.id);
        perform set_config('cn.bill_money_sync', v_prev, true);
        new.amount_paid := public.bill_live_allocated(new.id);
      end if;

    elsif new.amount is distinct from old.amount and new.amount_paid = old.amount_paid then
      -- THE PRICE CHANGED (Edit Bill; a correction's figure fixed). What the payments paid is
      -- theirs; what he said was paid in full stays paid in full; part-paid keeps its number.
      v_alloc := public.bill_live_allocated(new.id);
      if v_alloc > greatest(0, new.amount) + 0.005 then
        v_label := coalesce(nullif(new.bill_number, ''), 'this bill');
        raise exception 'The payment of % paid $% of %, more than its new amount. Undo that payment before changing the amount. Nothing was changed.',
          coalesce(public.bill_family_paid_by(coalesce(new.corrects_bill_id, new.id)), 'a day'),
          to_char(v_alloc, 'FM999,999,990.00'), v_label
          using errcode = 'P0001';
      end if;
      if old.amount_paid = old.amount and v_alloc < abs(old.amount) - 0.005 then
        new.amount_paid := new.amount;
      else
        new.amount_paid := least(greatest(old.amount_paid, least(0, new.amount)), greatest(0, new.amount));
      end if;
    end if;
  end if;

  -- STATUS IS THE NUMBER'S, per purchase. A bill set aside as a duplicate stands on its own number.
  if new.superseded_by_bill_id is not null then
    v_open := new.amount - new.amount_paid;
  else
    v_open := (new.amount - new.amount_paid) + public.bill_family_open(coalesce(new.corrects_bill_id, new.id), new.id);
  end if;
  new.status := case when abs(v_open) < 0.005 then 'paid' else 'unpaid' end;
  return new;
end $$;

drop trigger if exists bill_money_follows on public.bills;
create trigger bill_money_follows
  before insert or update of status, amount, amount_paid, corrects_bill_id, superseded_by_bill_id on public.bills
  for each row execute function public.bill_money_follows();

-- ── 5. EVERY MEMBER OF THE PURCHASE CARRIES THE ONE STATUS ─────────────────────────────────────
create or replace function public.bill_money_syncs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('cn.bill_money_sync', true), '') = '1' then
    return null;
  end if;
  if tg_op = 'DELETE' then
    if old.corrects_bill_id is not null then
      perform public.bill_family_sync(old.corrects_bill_id);
    end if;
    return null;
  end if;
  perform public.bill_family_sync(coalesce(new.corrects_bill_id, new.id));
  if tg_op = 'UPDATE' and old.corrects_bill_id is not null and old.corrects_bill_id is distinct from new.corrects_bill_id then
    perform public.bill_family_sync(old.corrects_bill_id);
  end if;
  return null;
end $$;

drop trigger if exists bill_money_syncs on public.bills;
create trigger bill_money_syncs
  after insert or delete or update of status, amount, amount_paid, corrects_bill_id, superseded_by_bill_id on public.bills
  for each row execute function public.bill_money_syncs();

-- guard_bill_correction, REPLACED IN FULL (0381, 0382): one level, same company, never on or as a
-- duplicate, and ONE PURCHASE ONE JOB ONE PART ONE BUCKET — status is no longer copied or compared
-- here, because it is derived per purchase from the money (trigger 4 refuses marking a correction
-- by itself, in 0382's own words).
create or replace function public.guard_bill_correction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  orig    record;
  v_label text;
begin
  if new.superseded_by_bill_id is not null
     and (tg_op = 'INSERT' or new.superseded_by_bill_id is distinct from old.superseded_by_bill_id)
     and exists (select 1 from public.bills b where b.corrects_bill_id = new.id) then
    raise exception 'This bill carries a correction, so it cannot be set aside as a duplicate. Delete the correction first. Nothing was changed.'
      using errcode = 'P0001';
  end if;

  if new.corrects_bill_id is null then
    return new;
  end if;

  if new.corrects_bill_id = new.id then
    raise exception 'A bill cannot correct itself. Nothing was changed.' using errcode = 'P0001';
  end if;
  if new.superseded_by_bill_id is not null then
    raise exception 'A correction cannot be set aside as a duplicate: it belongs to the bill it corrects. Nothing was changed.'
      using errcode = 'P0001';
  end if;

  select b.id, b.org_id, b.job_id, b.category, b.scope_category, b.corrects_bill_id, b.superseded_by_bill_id, b.bill_number
    into orig
    from public.bills b
   where b.id = new.corrects_bill_id;
  if not found or orig.org_id is distinct from new.org_id then
    raise exception 'The bill this corrects is not on the books. Nothing was changed.' using errcode = 'P0001';
  end if;
  v_label := coalesce(nullif(orig.bill_number, ''), 'that bill');

  if orig.corrects_bill_id is not null then
    raise exception '% is itself a correction. Attach this one to the bill it corrects. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  if orig.superseded_by_bill_id is not null then
    raise exception '% was set aside as a duplicate. Correct the bill that was kept. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' or new.corrects_bill_id is distinct from old.corrects_bill_id then
    new.job_id         := orig.job_id;
    new.category       := orig.category;
    new.scope_category := orig.scope_category;
    return new;
  end if;
  if new.job_id is distinct from orig.job_id then
    raise exception 'A correction stays on the job of the bill it corrects (%). Move that bill and this one follows. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  if new.category is distinct from orig.category then
    raise exception 'A correction is filed in the bucket of the bill it corrects (%). Change that bill and this one follows. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  if new.scope_category is distinct from orig.scope_category then
    raise exception 'A correction belongs to the same part of the job as the bill it corrects (%). Change that bill and this one follows. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- bill_corrections_follow, REPLACED IN FULL (0381, 0382): job, bucket and part of the job. Status
-- travels by the money now (trigger 5).
create or replace function public.bill_corrections_follow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bills b
     set job_id         = new.job_id,
         category       = new.category,
         scope_category = new.scope_category
   where b.corrects_bill_id = new.id
     and (b.job_id is distinct from new.job_id
       or b.category is distinct from new.category
       or b.scope_category is distinct from new.scope_category);
  return null;
end $$;

drop trigger if exists bill_corrections_follow on public.bills;
create trigger bill_corrections_follow
  after update of job_id, category, scope_category on public.bills
  for each row
  when (old.job_id is distinct from new.job_id
     or old.category is distinct from new.category
     or old.scope_category is distinct from new.scope_category)
  execute function public.bill_corrections_follow();

-- ── 6. A PAYMENT PAYS BILLS, AND THE BILLS HEAR IT ──────────────────────────────────────────────
create or replace function public.guard_payment_allocation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p       record;
  b       record;
  v_sum   numeric;
  v_label text;
begin
  select sp.id, sp.org_id, sp.amount, sp.paid_on, sp.voided_at into p
    from public.supplier_payments sp where sp.id = new.supplier_payment_id;
  if not found or p.org_id is distinct from new.org_id then
    raise exception 'That payment is not on the books. Nothing was changed.' using errcode = 'P0001';
  end if;
  if p.voided_at is not null then
    raise exception 'The payment of % was undone, so it cannot pay a bill. Nothing was changed.', to_char(p.paid_on, 'Mon FMDD')
      using errcode = 'P0001';
  end if;

  -- LOCKED: two payments recorded at once could each pass "never exceed the bill" and overpay it.
  select bl.id, bl.org_id, bl.amount, bl.bill_number, bl.superseded_by_bill_id into b
    from public.bills bl where bl.id = new.bill_id for update;
  if not found or b.org_id is distinct from new.org_id then
    raise exception 'That bill is not on the books. Nothing was changed.' using errcode = 'P0001';
  end if;
  v_label := coalesce(nullif(b.bill_number, ''), 'That bill');
  if b.superseded_by_bill_id is not null then
    raise exception '% was set aside as a duplicate. Pay the bill that was kept. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  if b.amount <= 0 then
    raise exception '% is a credit, not a bill to pay. Nothing was changed.', v_label using errcode = 'P0001';
  end if;

  select coalesce(sum(a.amount), 0) into v_sum
    from public.supplier_payment_allocations a
   where a.supplier_payment_id = new.supplier_payment_id and a.id <> new.id;
  if v_sum + new.amount > p.amount + 0.005 then
    raise exception 'That puts $% on bills out of the $% payment of %. Nothing was changed.',
      to_char(v_sum + new.amount, 'FM999,999,990.00'), to_char(p.amount, 'FM999,999,990.00'), to_char(p.paid_on, 'Mon FMDD')
      using errcode = 'P0001';
  end if;

  select coalesce(sum(a.amount + a.discount), 0) into v_sum
    from public.supplier_payment_allocations a
    join public.supplier_payments q on q.id = a.supplier_payment_id
   where a.bill_id = new.bill_id and a.id <> new.id and q.voided_at is null;
  if v_sum + new.amount + new.discount > b.amount + 0.005 then
    raise exception '% is $%; the payments on it would come to $%. Nothing was changed.',
      v_label, to_char(b.amount, 'FM999,999,990.00'), to_char(v_sum + new.amount + new.discount, 'FM999,999,990.00')
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists guard_payment_allocation on public.supplier_payment_allocations;
create trigger guard_payment_allocation
  before insert or update on public.supplier_payment_allocations
  for each row execute function public.guard_payment_allocation();

create or replace function public.allocation_rolls_up()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live boolean;
begin
  if tg_op = 'INSERT' then
    select sp.voided_at is null into v_live from public.supplier_payments sp where sp.id = new.supplier_payment_id;
    if coalesce(v_live, false) then
      perform public.bill_roll_up(new.bill_id, new.amount + new.discount);
    end if;
    return null;
  end if;
  if tg_op = 'DELETE' then
    select sp.voided_at is null into v_live from public.supplier_payments sp where sp.id = old.supplier_payment_id;
    perform public.bill_roll_up(old.bill_id, case when coalesce(v_live, false) then -(old.amount + old.discount) else 0 end);
    return null;
  end if;
  select sp.voided_at is null into v_live from public.supplier_payments sp where sp.id = new.supplier_payment_id;
  if not coalesce(v_live, false) then
    return null;
  end if;
  if new.bill_id is distinct from old.bill_id then
    perform public.bill_roll_up(old.bill_id, -(old.amount + old.discount));
    perform public.bill_roll_up(new.bill_id, new.amount + new.discount);
  else
    perform public.bill_roll_up(new.bill_id, (new.amount + new.discount) - (old.amount + old.discount));
  end if;
  return null;
end $$;

drop trigger if exists allocation_rolls_up on public.supplier_payment_allocations;
create trigger allocation_rolls_up
  after insert or update or delete on public.supplier_payment_allocations
  for each row execute function public.allocation_rolls_up();

-- UNDO ON A PAYMENT PUTS ITS BILLS BACK ON ACCOUNT, and undoing the undo pays them again.
create or replace function public.payment_void_rolls_up()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  a      record;
  v_sign numeric := case when new.voided_at is null then 1 else -1 end;
begin
  for a in select al.bill_id, al.amount, al.discount from public.supplier_payment_allocations al where al.supplier_payment_id = new.id loop
    perform public.bill_roll_up(a.bill_id, v_sign * (a.amount + a.discount));
  end loop;
  return null;
end $$;

drop trigger if exists payment_void_rolls_up on public.supplier_payments;
create trigger payment_void_rolls_up
  after update of voided_at on public.supplier_payments
  for each row
  when ((old.voided_at is null) <> (new.voided_at is null))
  execute function public.payment_void_rolls_up();

-- ── 6b. MONEY AHEAD COMES OFF THE NEXT BILL RECORDED ───────────────────────────────────────────
-- Which account a bill is on, the app's rule (lib/supplier-owed supplierAccountForPaper), strongest
-- first: the account it is filed on, an alias a person created, the account's own name. Exact
-- spelling only here (the app's third step also folds punctuation); a bill this leaves unplaced
-- stays as it is and Reconcile names it.
create or replace function public.supplier_account_of_bill(p_org uuid, p_filed uuid, p_supplier text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    p_filed,
    (select a.supplier_account_id from public.supplier_aliases a
      where a.org_id = p_org and lower(trim(a.alias)) = lower(trim(coalesce(p_supplier, ''))) and lower(trim(coalesce(p_supplier, ''))) <> ''
      limit 1),
    (select s.id from public.supplier_accounts s
      where s.org_id = p_org and lower(trim(s.name)) = lower(trim(coalesce(p_supplier, ''))) and lower(trim(coalesce(p_supplier, ''))) <> ''
      limit 1))
$$;

-- Erik, 2026-10-07: "the extra needs to apply or able to be applied". Cash a payment sent past every
-- open purchase is ahead on the account; the next live bill recorded there (a scanned ticket, Record
-- It As A Bill, a typed cost) takes it, oldest payment first, up to what is open on the bill. No date
-- bound: money ahead is a credit on the account, and a credit pays the next purchase whatever its
-- date (that is the supplier's own rule). The ledger row then says "paid 1 bill".
create or replace function public.supplier_apply_ahead(p_org uuid, p_account uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  p      record;
  b      record;
  v_left numeric;
  v_take numeric;
  n      int := 0;
begin
  if p_org is null or p_account is null then
    return 0;
  end if;
  for p in
    select sp.id, sp.amount - coalesce((select sum(a.amount) from public.supplier_payment_allocations a where a.supplier_payment_id = sp.id), 0) as ahead
      from public.supplier_payments sp
     where sp.org_id = p_org and sp.supplier_account_id = p_account and sp.voided_at is null
     order by sp.paid_on, sp.created_at, sp.id
  loop
    if p.ahead < 0.005 then
      continue;
    end if;
    v_left := p.ahead;
    for b in
      select bl.id, bl.amount - bl.amount_paid as open
        from public.bills bl
       where bl.org_id = p_org
         and bl.superseded_by_bill_id is null
         and bl.amount > 0
         and bl.amount - bl.amount_paid > 0.005
         and public.supplier_account_of_bill(bl.org_id, bl.supplier_account_id, bl.supplier) = p_account
         and not exists (select 1 from public.supplier_payment_allocations a where a.supplier_payment_id = p.id and a.bill_id = bl.id)
       order by bl.bill_date nulls last, bl.created_at, bl.id
    loop
      exit when v_left < 0.005;
      v_take := least(v_left, b.open);
      insert into public.supplier_payment_allocations (org_id, supplier_payment_id, bill_id, amount)
      values (p_org, p.id, b.id, v_take);
      n := n + 1;
      v_left := v_left - v_take;
    end loop;
  end loop;
  return n;
end $$;

create or replace function public.bill_takes_ahead_cash()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('cn.bill_money_sync', true), '') = '1' then
    return null;
  end if;
  perform public.supplier_apply_ahead(new.org_id, public.supplier_account_of_bill(new.org_id, new.supplier_account_id, new.supplier));
  return null;
end $$;

drop trigger if exists bill_takes_ahead_cash on public.bills;
create trigger bill_takes_ahead_cash
  after insert on public.bills
  for each row
  when (new.superseded_by_bill_id is null and new.amount > 0)
  execute function public.bill_takes_ahead_cash();

-- ── 7. THE BACKFILL ─────────────────────────────────────────────────────────────────────────────

-- THE REPLAY, as a function so the DB suite can prove it on a fixture and a later company's
-- imported payments can be matched the same way. Each live payment with no allocation yet pays its
-- account's bills oldest first: bills already marked paid first (explaining a person's ticks), then
-- open bills; only live bills with money to pay, dated on or before the payment. Cash left over
-- stays on the payment as money ahead. Idempotent: a payment that already pays something is skipped.
create or replace function public.supplier_payments_match_oldest_first()
returns table (payments_matched int, bills_matched int, left_ahead numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  p      record;
  b      record;
  v_left numeric;
  v_take numeric;
begin
  payments_matched := 0;
  bills_matched := 0;
  left_ahead := 0;
  for p in
    select sp.id, sp.org_id, sp.supplier_account_id, sp.amount, sp.paid_on
      from public.supplier_payments sp
     where sp.voided_at is null
       and not exists (select 1 from public.supplier_payment_allocations a where a.supplier_payment_id = sp.id)
     order by sp.paid_on, sp.created_at, sp.id
  loop
    v_left := p.amount;
    for b in
      select bl.id,
             bl.amount - public.bill_live_allocated(bl.id) as room
        from public.bills bl
       where bl.org_id = p.org_id
         and bl.superseded_by_bill_id is null
         and bl.amount > 0
         and bl.bill_date is not null
         and bl.bill_date <= p.paid_on
         and public.supplier_account_of_bill(bl.org_id, bl.supplier_account_id, bl.supplier) = p.supplier_account_id
       order by (bl.status = 'paid') desc, bl.bill_date, bl.created_at, bl.id
    loop
      exit when v_left < 0.005;
      if b.room < 0.005 then
        continue;
      end if;
      v_take := least(v_left, b.room);
      insert into public.supplier_payment_allocations (org_id, supplier_payment_id, bill_id, amount)
      values (p.org_id, p.id, b.id, v_take);
      bills_matched := bills_matched + 1;
      v_left := v_left - v_take;
    end loop;
    if v_left < p.amount then
      payments_matched := payments_matched + 1;
    end if;
    left_ahead := left_ahead + greatest(v_left, 0);
  end loop;
  return next;
end $$;

do $$
declare
  n_word     int;
  n_supplier int;
  n_derived  int := 0;
  r          record;
  f          record;
begin
  -- THE TWO NUMBER WRITES RUN WITH THE SYNC FLAG UP. With it down, the first member of a corrected
  -- purchase that this statement touches re-derives the family and its AFTER trigger writes the
  -- correction's status - and when the same statement then reaches that correction, Postgres refuses
  -- it ("tuple to be updated was already modified by an operation triggered by the current command").
  -- That is what rolled this file back on the live book on its first run: one corrected purchase was
  -- enough. With the flag up the triggers only derive the row in hand; step e derives every purchase
  -- afterwards, one purchase per statement, which can never visit a row a trigger already wrote.
  perform set_config('cn.bill_money_sync', '1', true);

  -- a. HIS WORD: a bill marked paid is paid in full.
  update public.bills set amount_paid = amount where status = 'paid' and amount_paid is distinct from amount;
  get diagnostics n_word = row_count;

  -- b. THE SUPPLIER'S WORD: an open bill every linked supplier document calls closed.
  update public.bills bl
     set amount_paid = bl.amount
   where bl.status is distinct from 'paid'
     and bl.superseded_by_bill_id is null
     and bl.corrects_bill_id is null
     and bl.amount_paid is distinct from bl.amount
     and exists (select 1 from public.bill_supplier_invoices l join public.supplier_invoices d on d.id = l.supplier_invoice_id
                  where l.bill_id = bl.id and d.closed = true)
     and not exists (select 1 from public.bill_supplier_invoices l join public.supplier_invoices d on d.id = l.supplier_invoice_id
                      where l.bill_id = bl.id and d.closed is distinct from true);
  get diagnostics n_supplier = row_count;

  perform set_config('cn.bill_money_sync', '', true);

  -- c. THE PAYMENTS ALREADY SENT, MATCHED OLDEST-FIRST the way the door does it, in date order. Every
  -- write inside is one row at a time, through the live triggers.
  select * into r from public.supplier_payments_match_oldest_first();

  -- d. WHAT IS STILL AHEAD COMES OFF THE OPEN BILLS, account by account (the rule 6b keeps from now on).
  perform public.supplier_apply_ahead(sp.org_id, sp.supplier_account_id)
     from (select distinct org_id, supplier_account_id from public.supplier_payments where voided_at is null) sp;

  -- e. EVERY PURCHASE'S WORD IS ITS NUMBER'S, from here on: a $0 bill, a purchase that nets to
  -- nothing, a status spelled some other way - each derives through the one function, one purchase
  -- per statement, so the checks below judge what the triggers keep, not what was stored.
  for f in select b.id from public.bills b where b.corrects_bill_id is null order by b.created_at, b.id loop
    perform public.bill_family_sync(f.id);
    n_derived := n_derived + 1;
  end loop;

  raise notice '0383 backfill: % bill(s) paid in full by his word, % by the supplier''s closed paper, % payment(s) matched to % bill(s), $% left ahead on the account(s), % purchase(s) derived.',
    n_word, n_supplier, r.payments_matched, r.bills_matched, to_char(r.left_ahead, 'FM999,999,990.00'), n_derived;
end $$;

-- ── 7b. NOTHING HERE IS FOR A SIGNED-IN USER TO CALL ────────────────────────────────────────────
-- SECURITY DEFINER with the default grant is an RPC any authenticated user can POST to, in any
-- company whose ids they hold (0261, 0278 did the same). Every caller is a trigger or this file;
-- the triggers run as the owner, so taking the grant away costs nothing.
revoke all on function public.bill_live_allocated(uuid) from public, anon, authenticated;
revoke all on function public.bill_family_open(uuid, uuid) from public, anon, authenticated;
revoke all on function public.bill_family_paid_by(uuid) from public, anon, authenticated;
revoke all on function public.bill_family_sync(uuid) from public, anon, authenticated;
revoke all on function public.bill_roll_up(uuid, numeric) from public, anon, authenticated;
revoke all on function public.supplier_account_of_bill(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.supplier_payments_match_oldest_first() from public, anon, authenticated;
revoke all on function public.supplier_apply_ahead(uuid, uuid) from public, anon, authenticated;
revoke all on function public.bill_money_follows() from public, anon, authenticated;
revoke all on function public.bill_money_syncs() from public, anon, authenticated;
revoke all on function public.bill_takes_ahead_cash() from public, anon, authenticated;
revoke all on function public.guard_payment_allocation() from public, anon, authenticated;
revoke all on function public.allocation_rolls_up() from public, anon, authenticated;
revoke all on function public.payment_void_rolls_up() from public, anon, authenticated;

-- ── 8. VERIFY, OR FAIL THE RUN ──────────────────────────────────────────────────────────────────
do $$
declare
  n   int;
  t   text;
  def text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bills' and column_name = 'amount_paid' and data_type = 'numeric'
  ) then
    raise exception '0383: bills.amount_paid is missing after the run.';
  end if;
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'supplier_payment_allocations') then
    raise exception '0383: supplier_payment_allocations is missing after the run.';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'supplier_payment_allocations' and policyname = 'supplier_payment_allocations_staff_all') then
    raise exception '0383: the staff policy is not on supplier_payment_allocations.';
  end if;
  foreach t in array array['bill_money_follows', 'bill_money_syncs', 'bill_takes_ahead_cash', 'guard_bill_correction', 'bill_corrections_follow', 'guard_claimed_bill_amount', 'guard_bill_claim'] loop
    if not exists (select 1 from pg_trigger where tgrelid = 'public.bills'::regclass and tgname = t and not tgisinternal) then
      raise exception '0383: trigger % is not on bills.', t;
    end if;
  end loop;
  foreach t in array array['guard_payment_allocation', 'allocation_rolls_up'] loop
    if not exists (select 1 from pg_trigger where tgrelid = 'public.supplier_payment_allocations'::regclass and tgname = t and not tgisinternal) then
      raise exception '0383: trigger % is not on supplier_payment_allocations.', t;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.supplier_payments'::regclass and tgname = 'payment_void_rolls_up' and not tgisinternal) then
    raise exception '0383: payment_void_rolls_up is not on supplier_payments.';
  end if;
  select pg_get_triggerdef(oid) into def from pg_trigger
   where tgrelid = 'public.bills'::regclass and tgname = 'bill_corrections_follow' and not tgisinternal;
  if def is null or def like '%status%' then
    raise exception '0383: bill_corrections_follow still carries status (%).', coalesce(def, 'missing');
  end if;
  if pg_get_functiondef('public.guard_bill_correction'::regproc) like '%new.status%' then
    raise exception '0383: guard_bill_correction still copies or compares status.';
  end if;
  foreach t in array array['public.bill_roll_up(uuid, numeric)', 'public.bill_family_sync(uuid)', 'public.supplier_payments_match_oldest_first()', 'public.supplier_apply_ahead(uuid, uuid)', 'public.supplier_account_of_bill(uuid, uuid, text)', 'public.bill_live_allocated(uuid)', 'public.bill_family_open(uuid, uuid)', 'public.bill_family_paid_by(uuid)'] loop
    if has_function_privilege('authenticated', t, 'execute') or has_function_privilege('anon', t, 'execute') then
      raise exception '0383: % is callable by a signed-in user.', t;
    end if;
  end loop;

  -- The number is within the amount on every bill, and on a bill to pay (a positive one) never under
  -- what the live payments pay. A credit carries a negative number and no payment, so it is not asked.
  select count(*) into n from public.bills b
   where b.amount_paid < least(0, b.amount) or b.amount_paid > greatest(0, b.amount)
      or (b.amount > 0 and b.amount_paid + 0.005 < public.bill_live_allocated(b.id));
  if n > 0 then
    raise exception '0383: % bill(s) carry a number outside their amount or under their payments. Nothing more was changed.', n;
  end if;
  -- Status is the number's, on every live bill, per purchase.
  select count(*) into n from public.bills b
   where b.superseded_by_bill_id is null
     and b.status is distinct from (case when abs(public.bill_family_open(coalesce(b.corrects_bill_id, b.id))) < 0.005 then 'paid' else 'unpaid' end);
  if n > 0 then
    raise exception '0383: % live bill(s) carry a status their money does not derive. Nothing more was changed.', n;
  end if;
  -- Every correction still reads as its original (0382's own check, now by the money).
  select count(*) into n
    from public.bills c join public.bills o on o.id = c.corrects_bill_id
   where c.superseded_by_bill_id is null and (c.status is distinct from o.status or c.job_id is distinct from o.job_id
      or c.category is distinct from o.category or c.scope_category is distinct from o.scope_category);
  if n > 0 then
    raise exception '0383: % correction row(s) differ from their original. Nothing more was changed.', n;
  end if;
  -- No payment pays out more than it is.
  select count(*) into n from public.supplier_payments p
   where (select coalesce(sum(a.amount), 0) from public.supplier_payment_allocations a where a.supplier_payment_id = p.id) > p.amount + 0.005;
  if n > 0 then
    raise exception '0383: % payment(s) pay out more than their amount. Nothing more was changed.', n;
  end if;
  select count(*) into n from public.supplier_payment_allocations;
  raise notice '0383 OK: bills.amount_paid, supplier_payment_allocations (% row(s)), status derived per purchase, 7 triggers, helpers revoked.', n;
end $$;
