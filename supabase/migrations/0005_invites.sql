-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0005: team invite accept flow
-- Run AFTER 0004. Adds RPCs so an invited user (who has no org yet, and so
-- cannot read the invitations table under RLS) can discover and accept their
-- invitation. Both are SECURITY DEFINER and only ever act on the caller.
-- ═══════════════════════════════════════════════════════════════════════════

-- Returns the caller's most recent pending invitation (matched by their email).
create or replace function public.pending_invite()
returns table(org_id uuid, org_name text, role user_role)
language sql stable security definer set search_path = public as $$
  select i.org_id, o.name, i.role
  from public.invitations i
  join public.organizations o on o.id = i.org_id
  where lower(i.email) = lower(coalesce(auth.email(), ''))
    and i.accepted_at is null
  order by i.created_at desc
  limit 1;
$$;

-- Accepts the caller's pending invitation: joins the org with the invited role.
create or replace function public.accept_invitation()
returns uuid language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  em  text := auth.email();
  inv public.invitations;
  cur uuid;
begin
  if uid is null then raise exception 'Not authenticated.'; end if;

  select org_id into cur from public.profiles where id = uid;
  if cur is not null then return cur; end if;  -- already in an org

  select * into inv from public.invitations
   where lower(email) = lower(coalesce(em, '')) and accepted_at is null
   order by created_at desc limit 1;

  if inv.id is null then
    raise exception 'No pending invitation for your email.';
  end if;

  update public.profiles set org_id = inv.org_id, role = inv.role where id = uid;
  update public.invitations set accepted_at = now() where id = inv.id;
  return inv.org_id;
end $$;
