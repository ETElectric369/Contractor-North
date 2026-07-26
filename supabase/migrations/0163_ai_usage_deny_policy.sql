-- Migration 0163: make ai_usage's denial EXPLICIT.
--
-- 0162 created ai_usage with RLS enabled and no policies, intending "service role only"
-- — which is functionally correct (RLS-on with zero policies denies every non-service
-- caller). But the RLS isolation invariant in CI requires every org-scoped table to
-- carry at least one policy, and it is right to: an empty policy list is
-- indistinguishable from "someone enabled RLS and forgot to write the rules." The same
-- thing happened to site_redirects in 0150.
--
-- So: state the denial rather than implying it. The service role bypasses RLS entirely,
-- so record_ai_usage / ai_spend_since keep working exactly as before.

drop policy if exists ai_usage_deny_all on public.ai_usage;
create policy ai_usage_deny_all on public.ai_usage
  for all
  using (false)
  with check (false);

comment on policy ai_usage_deny_all on public.ai_usage is
  'Deliberate deny-all. This is the PLATFORM''s cost ledger, not a customer-facing usage '
  'meter — no tenant may read what their AI use costs us, and nobody may write it from '
  'the client. Only the service role (which bypasses RLS) touches this table. Explicit '
  'so an empty policy list can never be mistaken for an oversight (0163).';
