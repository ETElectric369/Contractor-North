-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0172: voice invites can be CLOSED
--
-- Erik, 2026-07-27: "the Bryan Hubbard portal, i dont know what i was thinking.
-- sending him that sketchy link and havent heard anything ... i dont think we
-- should be keeping any random portals like that open."
--
-- He is right, and the shape of the problem is worse than the one link. 0106 gave
-- voice_invites a secret token as the capability and then gave it NO off switch:
--   * no revoked_at, no expires_at — the token worked forever;
--   * no management UI anywhere in the app (grep: zero references to voice_invites
--     outside src/app/voice/) — the row was inserted by hand, so there was no way
--     for the owner to close it even if he wanted to;
--   * so the ONLY way to withdraw the invitation was to remember it existed and
--     go into the database.
-- A capability nobody can see and nobody can revoke is not a capability anyone is
-- actually in control of. That is the same law this codebase already wrote down
-- after the offline-punch audit: a control has to be one the owner can operate.
--
-- WHAT THIS DOES
--   1. Adds revoked_at + expires_at.
--   2. Closes the Bryan Hubbard invite. He never opened it — consented_at,
--      completed_at and consent_name are all NULL, clip_count is 0, and the
--      voice-clips bucket holds zero objects — so there is no recording and no
--      consent record to preserve, and nothing of his is being destroyed. The row
--      is kept, revoked, so the history of "this was sent and then withdrawn" is
--      legible rather than silently vanished.
--   3. Gives every existing and future invite a default 30-day expiry, so an
--      unanswered invitation lapses on its own instead of lingering for years.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.voice_invites
  add column if not exists revoked_at timestamptz,
  add column if not exists expires_at timestamptz;

comment on column public.voice_invites.revoked_at is
  'Set when the invitation is withdrawn. The /voice/[token] page and every one of its server actions refuse a revoked invite — 0172.';
comment on column public.voice_invites.expires_at is
  'An unanswered invitation lapses on its own. Defaults to 30 days from creation so a forgotten link cannot stay live indefinitely — 0172.';

-- Default 30 days for anything created from here on.
alter table public.voice_invites
  alter column expires_at set default (now() + interval '30 days');

-- Backfill: existing rows expire 30 days after they were created — which, for anything
-- already sent, means they are already expired. That is the intended outcome.
update public.voice_invites
   set expires_at = created_at + interval '30 days'
 where expires_at is null;

-- Close the Bryan Hubbard invite explicitly. Matched on the invitee name AND the
-- never-opened state, so this cannot touch a live, consented session if one ever exists.
update public.voice_invites
   set revoked_at = now()
 where invitee_name = 'Bryan Hubbard'
   and consented_at is null
   and completed_at is null
   and clip_count = 0
   and revoked_at is null;

-- Belt and braces at the DB boundary: even if a future caller forgets the filter, a
-- revoked or expired invite must not accept a consent signature or a clip. The public
-- page and actions run as the SERVICE ROLE (the invitee has no account), which bypasses
-- RLS entirely — so the guard has to be a trigger, not a policy.
create or replace function public.voice_invite_is_open()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cur public.voice_invites%rowtype;
begin
  select * into cur from public.voice_invites where id = new.id;
  if cur.revoked_at is not null then
    raise exception 'This voice invitation has been withdrawn.' using errcode = '42501';
  end if;
  if cur.expires_at is not null and cur.expires_at < now() then
    raise exception 'This voice invitation has expired.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists voice_invites_open_only on public.voice_invites;
create trigger voice_invites_open_only
  before update of consent_name, consented_at, completed_at, clip_count
  on public.voice_invites
  for each row
  -- Only guards the invitee-driven columns. Staff revoking or re-opening an invite writes
  -- revoked_at/expires_at, which this trigger deliberately does not fire on.
  execute function public.voice_invite_is_open();
