-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0406: one list of the ways money moves
--
-- Erik, 2026-11-07: "there are some payment entry windows that show venmo as an option then others
-- that dont … i had to add venmo in the notes and now in the invoice im creating … i just recorded a
-- payment with a venmo button". Three doors record a payment and each kept a list of its own: the
-- customer's (payments.method — any key since 0287, its chips the company's Settings › Payment
-- methods), the crew's (pay_payments.method — a CHECK on four words since 0264: cash, check,
-- transfer, other) and the supplier's (supplier_payments.method — a CHECK on five since 0270: those
-- and card). The app now draws every door's chips from the one list in Settings and stores the key
-- the chip stands for (src/lib/payment-method paymentMethodKey: Venmo → venmo, Apple Cash → apple
-- cash). This migration lets the two columns hold any key, the way payments.method already does.
--
-- WHAT CHANGES:
--
--   THE TWO WORD LISTS COME OFF: pay_payments_method_check and supplier_payments_method_check, the
--   names Postgres gave the inline checks of 0264 and 0270 (neither named its own). The columns stay
--   text not null with their defaults (cash on pay_payments, check on supplier_payments).
--
--   ONE NORMALIZER RUNS ON BOTH — the one 0287 wrote for payments. public.money_method_to_key() is a
--   BEFORE INSERT OR UPDATE OF method trigger function that sets new.method to
--   public.payment_method_key(new.method): blank and null to other, an alias to its key (cheque →
--   check, bank transfer → transfer, credit card → card), anything else trimmed and lower-cased — so
--   a build still sending a label stores a key, and no door, old or new, can store "Venmo" and
--   "venmo" as two ways of being paid. Two triggers, one per table: pay_payments_method_to_key and
--   supplier_payments_method_to_key. 0287's payments_method_to_key on payments is untouched; its
--   function body is this one's, and the app's test holds the two normalizers to each other.
--
--   NO BACKFILL. Every row the two tables hold carries one of its old CHECK's words, and each of
--   those words (cash, check, transfer, card, other) is already its own key: payment_method_key()
--   returns them unchanged. There is nothing to rewrite, so no row is touched.
--
--   THE READERS, named the day they are added: the payroll pay form (payroll/pay-sheet) draws the
--   company's chips and sends the key; recordPayment (payroll/actions) refuses a word that is not a
--   method; the statement (payroll/person-statement) and the board's sentences (payroll-view,
--   lib/payroll-math paymentSentence) render paymentMethodLabel; the supplier pay door
--   (bills/suppliers-card) and recordSupplierPayment (bills/supplier-actions) do the same; the one
--   list lives in Settings › Payment methods (settings/payment-methods; org-settings
--   payment_methods, whose house default is lib/payment-method's DEFAULT_PAYMENT_METHODS).
--
-- LOCKS: ALTER TABLE … DROP CONSTRAINT and CREATE TRIGGER each take the table's ACCESS EXCLUSIVE
-- lock for a moment; neither reads a row. lock_timeout 3s: a busy table fails fast and changes
-- nothing; run it again. Twice-safe: each constraint is dropped IF EXISTS, the function is CREATE
-- OR REPLACE, each trigger is dropped if it exists and made again, and the comments are set to the
-- same text again.
--
-- ORDER: after 0287 (payment_method_key must exist; the first check proves it). Apply BEFORE the
-- deploy that carries the chips: the new pay forms send venmo, and the old CHECKs would refuse it.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.pay_payments') is null then
    raise exception '0406: public.pay_payments is not on this database (0264). Nothing was changed.';
  end if;
  if to_regclass('public.supplier_payments') is null then
    raise exception '0406: public.supplier_payments is not on this database (0270). Nothing was changed.';
  end if;
  if to_regprocedure('public.payment_method_key(text)') is null then
    raise exception '0406: public.payment_method_key(text) is not on this database (0287, the one normalizer). Apply 0287 first. Nothing was changed.';
  end if;
end $$;

-- ── the two word lists come off ─────────────────────────────────────────────────────────────────
alter table public.pay_payments drop constraint if exists pay_payments_method_check;
alter table public.supplier_payments drop constraint if exists supplier_payments_method_check;

-- ── one normalizer, on every table that records how money moved ────────────────────────────────
create or replace function public.money_method_to_key()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.method := public.payment_method_key(new.method);
  return new;
end
$fn$;

drop trigger if exists pay_payments_method_to_key on public.pay_payments;
create trigger pay_payments_method_to_key
  before insert or update of method on public.pay_payments
  for each row execute function public.money_method_to_key();

drop trigger if exists supplier_payments_method_to_key on public.supplier_payments;
create trigger supplier_payments_method_to_key
  before insert or update of method on public.supplier_payments
  for each row execute function public.money_method_to_key();

comment on column public.pay_payments.method is
  'A KEY, never a label (0406): cash, check, card, ach, transfer, venmo, zelle, paypal, cashapp, other, or a custom method lower-cased — the same keys payments.method holds (0287). payment_method_key() is the one normalizer, run by pay_payments_method_to_key; the app renders paymentMethodLabel(). Default cash (0264).';
comment on column public.supplier_payments.method is
  'A KEY, never a label (0406): cash, check, card, ach, transfer, venmo, zelle, paypal, cashapp, other, or a custom method lower-cased — the same keys payments.method holds (0287). payment_method_key() is the one normalizer, run by supplier_payments_method_to_key; the app renders paymentMethodLabel(). Default check (0270).';

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_tbl text;
begin
  foreach v_tbl in array array['pay_payments', 'supplier_payments'] loop
    if exists (
      select 1 from pg_constraint
       where conrelid = format('public.%I', v_tbl)::regclass and conname = v_tbl || '_method_check' and contype = 'c'
    ) then
      raise exception '0406: the check % is still on %, so a Venmo payment would be refused. Nothing was changed.', v_tbl || '_method_check', v_tbl;
    end if;
    if not exists (
      select 1 from pg_trigger
       where tgrelid = format('public.%I', v_tbl)::regclass and tgname = v_tbl || '_method_to_key' and not tgisinternal
    ) then
      raise exception '0406: the trigger that files a method under its key is not on %. Nothing was changed.', v_tbl;
    end if;
    -- the table's boundary is untouched: row level security stays on.
    if not (select relrowsecurity from pg_class where oid = format('public.%I', v_tbl)::regclass) then
      raise exception '0406: row level security is off on %. Nothing was changed.', v_tbl;
    end if;
  end loop;
  -- the normalizer answers as the app does (lib/payment-method paymentMethodKey).
  if public.payment_method_key('Venmo') <> 'venmo'
     or public.payment_method_key('Cheque') <> 'check'
     or public.payment_method_key(' Apple  Cash ') <> 'apple cash'
     or public.payment_method_key('') <> 'other'
     or public.payment_method_key(null) <> 'other' then
    raise exception '0406: payment_method_key() does not answer as the app does. Nothing was changed.';
  end if;
  raise notice '0406: one list of the ways money moves — the crew''s and the supplier''s payment columns hold any key the customer''s does, filed by the one normalizer, and every pay door draws its chips from Settings › Payment methods.';
end $$;
