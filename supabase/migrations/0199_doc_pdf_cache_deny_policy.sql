-- 0199 — SAY "SERVICE-ROLE ONLY" IN THE DATABASE, NOT BY OMISSION.
--
-- 0198 left doc_pdf_cache RLS-enabled with ZERO policies — correct behavior (anon and
-- authenticated see nothing; the service role bypasses RLS), but indistinguishable from a
-- forgotten policy. The RLS invariant test treats RLS-on + 0 policies as misconfiguration,
-- and it is right to: that shape is usually a locked-out table somebody will "fix" with a
-- too-wide policy later. An explicit always-false policy encodes the intent where the next
-- migration author will trip over it, and changes nothing at runtime.

create policy "service role only — every other role is denied"
  on public.doc_pdf_cache
  for all
  using (false);
