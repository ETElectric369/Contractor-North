-- site_redirects (0148) is SERVER-ONLY: read/written exclusively through the service client
-- (lib/site-redirects.ts), never by a browser session. It shipped with RLS enabled and ZERO
-- policies — correct deny-all behavior, but indistinguishable from "accidentally locked out"
-- to the RLS invariant tests (which have no org-scoped exemption list, by design). This single
-- explicit deny-all policy encodes the same behavior *visibly*: one policy exists, it grants
-- nothing, and the service role still bypasses RLS entirely.
create policy site_redirects_deny_all on public.site_redirects
  for all using (false) with check (false);
