-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0220: the refund alert gets something it can actually match on
--
-- The webhook's charge.refunded / charge.dispute.created branch looks the payment up like this:
--
--     .eq("stripe_event_id", charge.payment_intent)
--
-- stripe_event_id holds `event.id` — an `evt_…`. charge.payment_intent is a `pi_…`. Those two
-- namespaces can never collide, so the lookup returns null EVERY time, org_id is always null,
-- and the `if (orgId)` around the alert means the notification has never fired and never could.
-- The branch's own comment calls the match "best-effort"; it was in fact impossible.
--
-- What that costs: a contractor refunds a card payment from their own Stripe dashboard, or a
-- customer's bank opens a dispute, and CN says nothing at all. The invoice keeps reading
-- paid-in-full, A/R keeps counting the money, job profitability keeps counting the money, and
-- the customer's own public invoice keeps showing a paid receipt — for cash that left.
--
-- The payments row simply had nowhere to keep the one id that ties a charge back to us. It does
-- now, written at record time from the Checkout session. Nullable and unconstrained on purpose:
-- a payment recorded by hand in the office has no payment intent and never will.
--
-- No backfill needed — verified against production before writing this: 20 payment rows, ZERO
-- with a stripe_event_id. Nobody has paid online yet, so there is no history to repair and this
-- is right from the first online dollar.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.payments add column if not exists stripe_payment_intent text;

-- The refund handler's whole job is this one lookup; it should never be a scan.
create index if not exists payments_stripe_payment_intent_idx
  on public.payments (stripe_payment_intent)
  where stripe_payment_intent is not null;

comment on column public.payments.stripe_payment_intent is
  'Stripe pi_… for an online payment, so charge.refunded / charge.dispute.created can find the '
  'invoice this money settled. Null for payments recorded by hand. See migration 0220.';
