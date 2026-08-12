-- 0191 — THE PUBLIC INQUIRY DOOR STOPS BEING CALLABLE FROM A BROWSER.
--
-- Audit 6. /inquire/<org-uuid> was the ONE public write surface that submitted straight from the
-- client: inquiry-form.tsx called `supabase.rpc("submit_inquiry", …)` with the anon key that ships
-- in the JavaScript bundle. So:
--
--   · the honeypot was a client-side `if` — an attacker simply does not run it;
--   · nothing rate-limited the door at all, while every sibling already did (/estimate 5/60,
--     /site 10/60, site-chat 15/60, inbound/lead 60/60);
--   · the org uuid is IN THE URL, and that URL is printed on ET Electric's business cards and QR
--     codes — so anyone holding a card could write unbounded rows into that tenant, each one
--     costing a push to every office phone.
--
-- cn-v704 moved the call into a server action that owns the honeypot, a per-IP ceiling and a
-- per-org daily backstop. THIS migration is what makes that a boundary instead of a convention —
-- the project's own first law. Without it the old path is still open and the app-side ceiling is
-- decorative: an attacker keeps posting to PostgREST directly and never touches our action.
--
-- The function itself is unchanged. It stays SECURITY DEFINER and keeps owning triage, the org
-- check and referral validation; only WHO MAY CALL IT changes. `service_role` bypasses grants
-- entirely, which is exactly how the server action reaches it.
--
-- `authenticated` goes too: a signed-in user creating a lead does it through /leads with RLS, not
-- through the anonymous portal RPC. Nothing in the app calls it that way — verified with
-- `grep -rn 'submit_inquiry' src/`, whose only live hit after cn-v704 is the service-client call
-- in inquire/[org]/actions.ts.
--
-- 0026 granted it and 0092 recreated the function with the referral argument, re-granting on the
-- new 10-argument signature, whose last argument is a UUID (the referral profile id) rather than
-- the text the older one took. That is the one that has to be revoked; the 9-argument version
-- from 0026 was dropped by 0092 and no longer exists.

revoke execute on function public.submit_inquiry(uuid, text, text, text, text, text, text, text, text, uuid)
  from anon, authenticated, public;

comment on function public.submit_inquiry(uuid, text, text, text, text, text, text, text, text, uuid) is
  'Public lead intake. NOT callable by anon or authenticated (0191) — reach it through the server action submitPublicInquiry, which owns the honeypot, the per-IP ceiling and the per-org daily backstop. Callable by service_role only.';
