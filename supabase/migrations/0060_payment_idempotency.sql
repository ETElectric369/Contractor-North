-- IDEMPOTENCY: the Stripe webhook recorded an online payment with a blind
-- INSERT. Stripe retries deliver the SAME event.id, so a retry (network blip,
-- timeout) created a duplicate payment row and over-counted amount_paid.
-- Tag each webhook-recorded payment with its Stripe event id and make it unique,
-- so a retry's insert fails cleanly and the webhook can treat it as already done.
-- Partial index (where not null) leaves all existing/manual payment rows alone.
alter table public.payments add column if not exists stripe_event_id text;

create unique index if not exists payments_stripe_event_id_key
  on public.payments (stripe_event_id)
  where stripe_event_id is not null;
