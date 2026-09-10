-- 0251 — AN INVITATION STOPS BEING A KEY (Erik 2026-09-09: "fix the invite path").
--
-- signup_allowed() is the invite-only door (0125). It let ANY unaccepted invitation through, with
-- no time limit — so a row written once is a permanent right to create an account on this install.
-- The table's whole history is one such row: grangerbuilt@yahoo.com, written 2026-07-20, never
-- accepted, still opening the door seven weeks later. It could never have been accepted either
-- (accept_invitation bails with "already in an org" — he already had a profile), so nothing would
-- ever have closed it.
--
-- Fourteen days is the window. Long enough that a crew member who reads email weekly still gets in;
-- short enough that a mistyped address or a hire who never started stops being a live key. An
-- expired invitation is not deleted — the office should still SEE that they invited someone and
-- that it lapsed, rather than the row silently vanishing (NOTHING SILENT). Re-inviting writes a
-- fresh row with a fresh window.

alter table public.invitations
  add column if not exists expires_at timestamptz;

-- Backfill on the row's OWN age, not on now(): a row written seven weeks ago must come out of this
-- migration already expired, not granted another fortnight.
update public.invitations set expires_at = created_at + interval '14 days' where expires_at is null;

alter table public.invitations
  alter column expires_at set default (now() + interval '14 days');
alter table public.invitations
  alter column expires_at set not null;

-- ── the door ────────────────────────────────────────────────────────────────────────────────
-- Body is the CURRENT shipped definition (read from pg_get_functiondef) with ONLY the expiry
-- added. signup_allowlist and site_collaborators are untouched — neither is an invitation, and
-- widening this migration to them would change two doors nobody asked about.
create or replace function public.signup_allowed(p_email text)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select
    exists (select 1 from public.signup_allowlist  where email = lower(trim(p_email)))
    or exists (
      select 1 from public.invitations
      where lower(email) = lower(trim(p_email))
        and accepted_at is null
        and expires_at > now()
    )
    or exists (select 1 from public.site_collaborators where lower(invited_email) = lower(trim(p_email)) and user_id is null);
$function$;

-- ── what the invitee is offered on /onboarding ──────────────────────────────────────────────
-- Same expiry, so an expired invite doesn't render a Join button that accept_invitation would
-- then refuse — a door that opens onto a wall is worse than no door.
create or replace function public.pending_invite()
returns table(org_id uuid, org_name text, role user_role)
language sql
stable security definer
set search_path to 'public'
as $function$
  select i.org_id, o.name, i.role
  from public.invitations i
  join public.organizations o on o.id = i.org_id
  where lower(i.email) = lower(coalesce(auth.email(), ''))
    and i.accepted_at is null
    and i.expires_at > now()
  order by i.created_at desc
  limit 1;
$function$;

-- ── and the definer that actually joins them ────────────────────────────────────────────────
-- accept_invitation picks "the newest unaccepted invitation for my email" — it must not pick an
-- expired one either, or a lapsed invite would still be redeemable by anyone who kept the link.
-- Body below is the CURRENT shipped definition (0246) with ONLY the expiry clause added; the
-- deactivation boundary and the already-in-an-org no-op are preserved verbatim.
CREATE OR REPLACE FUNCTION public.accept_invitation()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  em  text := auth.email();
  inv public.invitations;
  cur uuid;
begin
  if uid is null then raise exception 'Not authenticated.'; end if;

  -- 0246: same boundary as create_organization — a deactivated seat accepts nothing.
  if exists (select 1 from public.profiles where id = uid and active = false) then
    raise exception 'This account has been deactivated.';
  end if;

  select org_id into cur from public.profiles where id = uid;
  if cur is not null then return cur; end if;  -- already in an org

  select * into inv from public.invitations
   where lower(email) = lower(coalesce(em, '')) and accepted_at is null
     and expires_at > now()
   order by created_at desc limit 1;

  if inv.id is null then
    raise exception 'No pending invitation for your email.';
  end if;

  update public.profiles set org_id = inv.org_id, role = inv.role where id = uid;
  update public.invitations set accepted_at = now() where id = inv.id;
  return inv.org_id;
end $function$;
