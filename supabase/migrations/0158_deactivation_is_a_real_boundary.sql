-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0158: make "Deactivate" an actual revocation.
--
-- THE HOLE (2026-07-25 offboarding audit, five independent agents, live-verified).
-- setMemberActive writes exactly one thing — profiles.active = false — and the ONLY
-- place in the entire stack that reads it is a render-time redirect in the (app)
-- route group layout. Confirmed against production: of 132 RLS policies, NOT ONE
-- keys on `active`. Every org-scoped policy routes through auth_org_id() /
-- is_org_staff() / is_staff() / app_user_role(), and all four read profiles with no
-- active predicate.
--
-- So "deactivating" a tech stopped their browser from RENDERING the app and nothing
-- else. Their session token stayed valid, and a direct PostgREST call with it —
-- trivially available from the installed PWA, or from anyone who kept the token —
-- still returned the org's customers, jobs, schedule and their own timeclock. They
-- could still clock in. A fired employee's phone kept working; only the UI lied
-- about it.
--
-- THE FIX. Teach the four trust-root helpers about `active`. Because every policy
-- in the schema is built on them, this closes all 132 at once instead of editing
-- each — and any policy written in the future inherits it automatically.
--
--   auth_org_id()   → NULL for a deactivated user, so `org_id = auth_org_id()`
--                     evaluates NULL (not true) and fails closed everywhere.
--   is_org_staff()  → false
--   is_staff()      → false
--   app_user_role() → NULL
--
-- STILL WORKS, deliberately:
--   • The deactivated person can read their OWN profile row — profiles_read's first
--     disjunct is `id = auth.uid()`, independent of these helpers — so
--     /account-deactivated renders and can sign them out.
--   • Nothing else. That is the point.
--   • The service role bypasses RLS entirely, so crons/webhooks are unaffected.
--   • Reactivation is instantaneous: flip active back and every helper answers again.
--
-- profiles.active is NOT NULL default true (verified live: 0 nulls of 15 rows), but
-- coalesce() is used anyway so a future nullable column can never fail OPEN.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.auth_org_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select org_id from public.profiles
   where id = auth.uid()
     and coalesce(active, true);
$$;

create or replace function public.is_org_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select role in ('owner','admin','office')
       from public.profiles
      where id = auth.uid()
        and coalesce(active, true)),
    false);
$$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select role in ('owner','admin','office')
       from public.profiles
      where id = auth.uid()
        and coalesce(active, true)),
    false);
$$;

create or replace function public.app_user_role()
returns user_role
language sql stable security definer set search_path = public
as $$
  select role from public.profiles
   where id = auth.uid()
     and coalesce(active, true);
$$;

comment on function public.auth_org_id() is
  'The caller''s org — NULL when the profile is deactivated, so every org-scoped policy '
  'fails closed for a removed employee. Deactivation is a DB boundary, not just a UI '
  'redirect (0158).';
comment on function public.is_org_staff() is
  'Caller is active office staff (owner/admin/office). Deactivated → false (0158).';
comment on function public.is_staff() is
  'Caller is active office staff (owner/admin/office). Deactivated → false (0158).';
comment on function public.app_user_role() is
  'The caller''s role — NULL when deactivated (0158).';
