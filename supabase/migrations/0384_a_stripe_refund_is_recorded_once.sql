-- 0384: A STRIPE REFUND IS RECORDED ONCE (Wednesday task 4, item C, 2026-10-07).
--
-- The charge.refunded webhook tells the office a refund left Stripe; Record This Refund writes the
-- customer_credits row for it (disposition 'refund', resolved: the money has already gone back).
-- This column is what makes that one tap idempotent: the Stripe charge id rides on the row, and
-- the partial unique index refuses a second row for the same charge in the same company, however
-- many times the notice is opened. Hand-made credits and refunds carry null and are untouched.

alter table public.customer_credits
  add column if not exists stripe_refund_id text;

comment on column public.customer_credits.stripe_refund_id is
  'The Stripe charge (ch_…) this refund row records, when it was recorded from a Stripe refund; null for a hand-made credit or refund. One row per charge per company (customer_credits_one_per_stripe_refund).';

create unique index if not exists customer_credits_one_per_stripe_refund
  on public.customer_credits (org_id, stripe_refund_id)
  where stripe_refund_id is not null;
