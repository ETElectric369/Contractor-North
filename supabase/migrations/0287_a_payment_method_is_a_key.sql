-- A PAYMENT METHOD IS A KEY, NOT A LABEL (2026-09-24).
--
-- payments.method was written in three spellings by five doors: the settle-up chips sent the chip
-- LABEL ("Cash", "Venmo"), the Venmo QR sent the literal 'venmo', the Stripe webhook sent 'card',
-- and a custom method from Settings arrived however it was typed. The same money read "Cash" on
-- one row and "cash" on the next, and anything that grouped by method counted two ways of being
-- paid where there was one.
--
-- The app now stores a key (src/lib/payment-method.ts paymentMethodKey) and renders a label
-- (paymentMethodLabel). This is the database half: one normalizer and a trigger that runs it on
-- every write, so no door, old or new, can store a label again.
--
--   blank                                          -> other
--   cheque                                         -> check
--   credit card, debit card, credit, debit         -> card
--   bank transfer, wire, wire transfer             -> transfer
--   bank debit, us_bank_account                    -> ach
--   cash app                                       -> cashapp
--   anything else                                  -> itself, trimmed and lower-cased
--
-- The alias table is PAYMENT_METHOD_ALIASES in the app; payment-method.test.ts reads the WHEN
-- lines below and checks each one against it, so the two cannot drift apart.
--
-- A TRIGGER, NOT A CHECK. During the deploy window the old build still inserts "Cash"; a CHECK
-- would refuse a real payment someone is recording in a driveway, a trigger quietly files it
-- under the right key.
--
-- SCHEMA ONLY. The rows already stored are normalized by a separate, reviewed data correction.

create or replace function public.payment_method_key(m text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case k
    when '' then 'other'
    when 'cheque' then 'check'
    when 'credit card' then 'card'
    when 'debit card' then 'card'
    when 'credit' then 'card'
    when 'debit' then 'card'
    when 'bank transfer' then 'transfer'
    when 'wire' then 'transfer'
    when 'wire transfer' then 'transfer'
    when 'bank debit' then 'ach'
    when 'us_bank_account' then 'ach'
    when 'cash app' then 'cashapp'
    else k
  end
  from (select lower(btrim(regexp_replace(coalesce(m, ''), '\s+', ' ', 'g'))) as k) s
$$;

create or replace function public.payments_method_to_key()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.method := public.payment_method_key(new.method);
  return new;
end
$$;

drop trigger if exists payments_method_to_key on public.payments;
create trigger payments_method_to_key
  before insert or update of method on public.payments
  for each row execute function public.payments_method_to_key();

comment on column public.payments.method is
  'A KEY, never a label: cash, check, card, ach, transfer, venmo, zelle, paypal, cashapp, other, or a custom method lower-cased (0287). payment_method_key() is the one normalizer; the app renders paymentMethodLabel().';
