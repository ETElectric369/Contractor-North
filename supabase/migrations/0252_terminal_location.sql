-- 0252 — TAP TO PAY NEEDS A PLACE TO STAND (Erik 2026-09-10: Tap to Pay on iPhone plumbing).
--
-- Stripe Terminal will not connect a Tap to Pay reader without a Terminal Location: the iPhone is
-- "associated with a location at connection time", and the location's display_name is what the
-- customer reads on the tap screen unless the app names the business itself. Tap to Pay readers
-- are never registered ahead of time; the Location is the only fleet object the flow needs.
--
-- ONE PER ORG, ON THE TENANT'S OWN STRIPE ACCOUNT. The money law (0161) says every Terminal object
-- — connection token, Location, PaymentIntent — is created with the Stripe-Account header set to
-- the org's Express account, so the Location lives in THEIR Stripe, not ours, and a platform-level
-- Location would be useless for a direct charge anyway. The id is a `tml_…` string, minted once by
-- ensureTerminalLocation (billing/tap-actions.ts) from the org's mailing address and kept here so
-- every later connect on every phone reuses it instead of littering the tenant's Stripe with one
-- Location per tap.
--
-- Null means "not yet" — the column is filled lazily the first time a staff member reaches for Tap
-- to Pay, so orgs that never do carry nothing. Nothing else reads it; the public projections
-- (0059/0174) list their columns explicitly and do not pick this up.

alter table public.organizations
  add column if not exists stripe_terminal_location_id text;

comment on column public.organizations.stripe_terminal_location_id is
  'Stripe Terminal Location id (tml_…) created ON the org''s connected Express account for Tap to Pay on iPhone. One per org, minted lazily by ensureTerminalLocation. 0252.';
