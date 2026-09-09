-- 0250 — A PHONE IS A PUSH TARGET TOO (Erik 2026-09-09: "go for push notification fix in shell").
--
-- push_subscriptions was built for Web Push only: endpoint + p256dh + auth, the three fields the
-- W3C subscription carries. The native iOS shell can never produce those — Web Push needs a
-- service worker, and Apple's Web Push is Safari / home-screen only, never a WKWebView. So every
-- alert the product sends (assigned, inquiry, quote_accepted, invoice_paid, day_ahead, clock_out,
-- daily_report, booked) reached the PWA and NOT the App Store app, and Settings told the owner
-- "This browser doesn't support push notifications" — the word "browser", inside an app.
--
-- The fix keeps ONE table and one fan-out (sendPushToProfiles), because a second table would mean
-- a second place to remember `active` and the per-user push_prefs — and forgetting either is how
-- a fired employee's phone keeps buzzing with customer names. A row is now EITHER a web
-- subscription or a device token, and the check constraint says which.
--
--   platform     'web' (default, every existing row) | 'ios'
--   device_token APNs token, hex, 64 chars today but Apple does not promise that length
--   apns_env     which APNs host issued it — a token minted by a debug build is INVALID on the
--                production host and vice versa. Null until the first successful send teaches us.

alter table public.push_subscriptions
  add column if not exists platform     text not null default 'web',
  add column if not exists device_token text,
  add column if not exists apns_env     text;

-- The web columns were NOT NULL for a web-only world; an iOS row has none of them.
alter table public.push_subscriptions alter column endpoint drop not null;
alter table public.push_subscriptions alter column p256dh   drop not null;
alter table public.push_subscriptions alter column auth     drop not null;

alter table public.push_subscriptions drop constraint if exists push_subscriptions_shape;
alter table public.push_subscriptions add constraint push_subscriptions_shape check (
  (platform = 'web' and endpoint is not null and p256dh is not null and auth is not null and device_token is null)
  or
  (platform = 'ios' and device_token is not null and endpoint is null)
);

alter table public.push_subscriptions drop constraint if exists push_subscriptions_apns_env;
alter table public.push_subscriptions add constraint push_subscriptions_apns_env check (
  apns_env is null or apns_env in ('production', 'sandbox')
);

-- ONE ROW PER DEVICE. APNs re-issues a token after a reinstall or a restore, and the register
-- handler fires on EVERY app launch — without this, a phone accumulates a row per launch and the
-- crew gets the same alert a dozen times. Partial, because web rows have a null device_token.
create unique index if not exists push_subscriptions_device_token_key
  on public.push_subscriptions (device_token) where device_token is not null;

-- The fan-out reads by profile; it had no index at all.
create index if not exists push_subscriptions_profile_idx on public.push_subscriptions (profile_id);
