-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0294: a phone's push row knows its org
--
-- The native shell registers its APNs token through the SERVICE client (saveDeviceToken has to
-- be able to take a token off the previous person on a handed-around phone, which RLS can't
-- express). The set_org_id() insert trigger stamps org_id from auth_org_id(), and on the service
-- client there is no auth.uid(), so every iOS row was written with org_id NULL. Checked
-- 2026-09-24: the only NULL-org rows in the table were the two iOS rows, both on the owner of
-- ET Electric; every web row already matched its profile's org.
--
-- Nobody went unbuzzed: the fan-out (sendPushToProfiles) keys on profile_id, and the office list
-- (orgStaffIds) reads profiles.org_id, never this column. This is housekeeping so a row with no
-- org doesn't hide from anything that prunes or counts by org. The code side (saveDeviceToken now
-- writes the signed-in person's org on insert AND on re-point) stops new NULLs.
--
-- The backfill touches only rows whose org disagrees with their OWN profile's org, and copies the
-- profile's org — it can't move a row into an org its person isn't in. Idempotent.
--
-- ORDER: any time after 0250. Safe before or after the code.
-- ═══════════════════════════════════════════════════════════════════════════

update public.push_subscriptions s
   set org_id = p.org_id
  from public.profiles p
 where p.id = s.profile_id
   and p.org_id is not null
   and s.org_id is distinct from p.org_id;

-- Self-check: nothing is left pointing at the wrong org (or none) while its person has one.
do $$
declare n int;
begin
  select count(*) into n
    from public.push_subscriptions s
    join public.profiles p on p.id = s.profile_id
   where p.org_id is not null
     and s.org_id is distinct from p.org_id;
  if n > 0 then
    raise exception '0294: % push row(s) still disagree with their profile''s org. Nothing was changed.', n;
  end if;
end $$;
