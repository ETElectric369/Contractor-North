-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0225: an admin could take the company
--
-- Demonstrated against production (rolled back). Chris promotes Alexa to admin through the
-- ordinary /team flow — a completely normal thing for a contractor to do — and from that moment
-- Alexa can, straight through PostgREST:
--
--     demote Chris from owner to tech      ALLOWED
--     set Chris active = false             ALLOWED   (he loses access entirely)
--     promote herself to owner             ALLOWED
--     set her own hourly_rate to 250       ALLOWED
--
-- That is a complete account takeover, and the demotion is irreversible through the UI:
-- updateMember whitelists role to ('admin','office','tech'), so once the owner is a tech nobody
-- can put them back without a database.
--
-- ── WHY EVERY EXISTING GUARD MISSED IT ─────────────────────────────────────────────────────
--
--   · updateMember's own check is `id === user.id && patch.role !== "owner"` — it stops you
--     demoting YOURSELF. It says nothing about demoting somebody else who happens to be the
--     owner. And it is app-layer anyway: the table is writable straight through PostgREST.
--   · prevent_role_escalation (0004) asks only whether the CALLER is owner-or-admin. An admin
--     passes. It never looks at whose row is being changed.
--   · profiles_update_self's WITH CHECK has two branches — yourself (six fields pinned) OR
--     owner/admin acting in your org (nothing pinned). An admin editing their OWN row matches
--     the SECOND branch, so all six pins evaporate. That is the self-paid-raise, and it is the
--     0141 control being routed around rather than broken.
--
-- Three guards, none of which was looking at the owner seat. This is the project's own law
-- again: a rule at one path is a convention. The trigger is the boundary, and a trigger is the
-- right place because it can see OLD — a policy cannot.
--
-- Nobody holds `admin` in production today (owner/office/tech only), so nothing has happened.
-- This closes it before the first promotion, not after.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.prevent_role_escalation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_caller  text := coalesce(public.app_user_role()::text, '');
  v_service boolean := false;
begin
  -- Our own server (service key) still does what it needs — creating an employee login, the
  -- onboarding path, offboarding jobs. Same trust gate as 0219; a malformed claims blob is
  -- simply not trusted rather than an error.
  begin
    v_service := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '') = 'service_role';
  exception when others then
    v_service := false;
  end;
  if v_service then return new; end if;

  -- Unchanged from 0004: a caller who is not staff can never change any role.
  -- `old.org_id is null` is first-time onboarding (create_organization seeds the first owner).
  if new.role is distinct from old.role
     and old.org_id is not null
     and v_caller not in ('owner', 'admin') then
    raise exception 'Only an owner or admin can change roles.';
  end if;

  if old.org_id is not null and v_caller <> 'owner' then
    -- THE OWNER SEAT IS OWNER-ONLY TERRITORY. An admin runs the company day to day; they do not
    -- get to decide who owns it.
    if old.role = 'owner' and new.role is distinct from old.role then
      raise exception 'Only the owner can change the owner''s role.';
    end if;
    if old.role = 'owner' and new.active is distinct from old.active then
      raise exception 'Only the owner can deactivate the owner.';
    end if;
    -- And nobody hands themselves the keys.
    if new.role = 'owner' and old.role is distinct from 'owner' then
      raise exception 'Only an owner can grant the owner role.';
    end if;
  end if;

  -- YOUR OWN PAY IS NOT YOURS TO SET (the 0141 control, finally applied to staff too).
  -- profiles_update_self pins this for a tech and lets owner/admin past; an admin editing their
  -- own row took that second branch. An OWNER setting their own draw is their business — it is
  -- their company — so the exemption is exactly one role wide.
  if new.id = auth.uid()
     and v_caller <> 'owner'
     and (new.hourly_rate is distinct from old.hourly_rate
       or new.bill_rate is distinct from old.bill_rate) then
    raise exception 'You cannot change your own pay rate — ask the owner.';
  end if;

  return new;
end $$;

-- Recreate the trigger so the new body is definitely the one bound (0004 named it guard_role).
drop trigger if exists guard_role on public.profiles;
create trigger guard_role before update on public.profiles
  for each row execute function public.prevent_role_escalation();
