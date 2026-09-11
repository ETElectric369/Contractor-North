-- 0253 — TAP TO PAY ON IPHONE: TWO "ONCE" MARKERS (Erik 2026-09-11, Apple review requirements v1.7).
--
-- Apple's App Requirements for Tap to Pay on iPhone say every eligible user must be TOLD the
-- feature exists (3.1 highly visible communication; 3.3 "to all eligible users at least once —
-- this can be done using a push notification"; 6.2/6.3 the launch splash and launch push). "At
-- least once" is Apple's floor. The NOT-ANNOYING law is ours: the awareness moment is shown ONCE,
-- then never again, and a launch push goes out ONCE per company, never twice by accident. Both of
-- those need somewhere to remember that they happened — that is all this migration is.
--
-- ── profiles.tap_to_pay_intro_seen_at ──────────────────────────────────────────────────────────
--
-- PER PERSON, like onboarded_at (0180) and lessons_seen (0197): being shown the intro is something
-- that happens to a HUMAN on a phone, and one person having seen it says nothing about the next.
-- Null = this person has not been shown the awareness moment; the UI shows it once and stamps.
--
-- THIS IS A UI FLAG, NOT THE MERCHANT'S APPLE STATUS. Apple requirement 1.6 forbids storing
-- whether the merchant has accepted the Tap to Pay on iPhone Terms and Conditions in the app —
-- that answer is read from Apple every time (StripeTerminal.isTapToPayAccountLinked), never
-- cached, never written here. This column only says "the intro card was on this person's screen
-- once". A stale or wrong value costs nothing but a second look at a card.
--
-- 0216 revoked the table-level SELECT on profiles and re-grants columns one by one, so a new
-- column is unreadable until it is granted — deliberate: a column is private until someone says
-- otherwise. This one is safe for every member to read (it is their own once-flag), so it is
-- granted here. UPDATE needs nothing: the self branch of profiles_update_self (0224) pins only the
-- six pay/role fields, and this is not one of them.
--
-- ── organizations.tap_to_pay_announced_at ──────────────────────────────────────────────────────
--
-- PER COMPANY: the one-shot launch push (Apple 3.3 / 6.3, "Tap to Pay on iPhone is here") is sent
-- by an owner or admin from Settings, to the whole crew, once. announceTapToPay (billing/
-- tap-actions.ts) CLAIMS this column with a checked, null-guarded write BEFORE it sends, so two
-- admins tapping the button in the same second cannot each buzz the crew — the second write
-- matches zero rows and is told the date the first one already went out. Null = never announced.
-- Not a billing column, so the organizations_update policy (0181) lets owner/admin/office write it;
-- the action itself narrows that to owner/admin because a launch announcement is the owner's word.

alter table public.profiles
  add column if not exists tap_to_pay_intro_seen_at timestamptz;

comment on column public.profiles.tap_to_pay_intro_seen_at is
  'When THIS PERSON was shown the Tap to Pay on iPhone awareness moment (Apple 3.1/3.3). Shown once, then never again — a UI once-flag, NOT the merchant''s Apple T&C status, which Apple 1.6 forbids storing (read from Apple every time). Null = not yet shown. 0253.';

-- 0216 model: column-by-column SELECT grants on profiles. Readable by every signed-in member —
-- it is their own flag and carries nothing about anyone else.
grant select (tap_to_pay_intro_seen_at) on public.profiles to authenticated;

alter table public.organizations
  add column if not exists tap_to_pay_announced_at timestamptz;

comment on column public.organizations.tap_to_pay_announced_at is
  'When an owner/admin sent the one-shot "Tap to Pay on iPhone is here" push to the crew (Apple 3.3/6.3). Claimed with a null-guarded write BEFORE the send so it can never go out twice. Null = never announced. 0253.';
