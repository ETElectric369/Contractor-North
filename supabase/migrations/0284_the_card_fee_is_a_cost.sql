-- THE CARD FEE IS A COST, SO THE BOOKS HAVE TO KNOW IT (2026-09-24).
--
-- Erik chose to leave his prices alone and absorb card fees as a business expense: money that
-- comes off what is left for his draw. Until now no fee was stored anywhere. INV-069's card
-- payment landed as the full amount received, and the only fee figure anywhere was an estimate at
-- 2.9% + 30 cents, which is not what Stripe took.
--
-- The real figure is Stripe's: the fee on the charge's balance transaction, read ON THE
-- CONTRACTOR'S OWN connected account (Connect direct charges; we take no application fee, so the
-- whole fee is the processor's). The Stripe webhook stores it when it records the payment, and the
-- daily automations cron fills any it could not read at that moment, which is also how the online
-- payments recorded before this column existed get theirs.
--
-- NULL means NOT KNOWN YET, and 0 is a real zero. They must never be read as the same thing: a
-- payment whose fee has not been read yet did not cost nothing, and a sum that treats NULL as 0
-- would say it did. A payment recorded by hand (check, cash, Venmo) has no Stripe fee and stays
-- NULL for good.
--
-- The column only. Nothing sums it yet; `amount` stays the money received, and every Collected,
-- Received and balance figure is untouched by this.

alter table public.payments add column if not exists processor_fee numeric(12,2);

comment on column public.payments.processor_fee is
  'What Stripe took for processing this online payment, in dollars, read from the charge''s '
  'balance transaction on the contractor''s connected account. A business cost that reduces the '
  'owner''s draw; never subtracted from amount. NULL = not known yet (or not a Stripe payment); '
  '0 = a real zero. See migration 0284.';
