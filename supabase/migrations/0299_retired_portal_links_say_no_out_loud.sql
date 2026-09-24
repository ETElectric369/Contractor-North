-- 0299 - THE RETIRED-LINK TABLE SAYS NO OUT LOUD.
--
-- 0298 made customer_portal_retired_links server-only: RLS on, every client grant revoked, no policy. That
-- is closed, but "RLS on + zero policies" is exactly the shape the tenant-isolation invariant test refuses
-- (rls.integration.test.ts), because on any other table it means locked out by accident or misconfigured.
-- 0199 settled the same question for doc_pdf_cache: write the denial down as a policy, so the intent is
-- in the catalog and not only in a revoke. The service role bypasses RLS and keeps working.
drop policy if exists "service role only - every other role is denied" on public.customer_portal_retired_links;
create policy "service role only - every other role is denied"
  on public.customer_portal_retired_links
  for all
  using (false)
  with check (false);
