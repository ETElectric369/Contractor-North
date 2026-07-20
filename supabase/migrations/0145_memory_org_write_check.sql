-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0145: pin org_id on user_memory writes
--
-- Audit re-review 2026-07-20. 0144 gated user_memory INSERT/UPDATE on user_id +
-- scope but NOT org_id, while the DELETE branch DID pin org_id = auth_org_id().
-- org_id is a client-supplied column, so a staff member could INSERT/UPDATE a
-- 'business' fact carrying ANOTHER tenant's org_id — seeding a competitor org's
-- Nort memory, which the recall path injects into that org's prompts. The write
-- path (memory.remember via executeAction) never sets a foreign org_id, but RLS
-- is the real boundary, so pin it in the policy the way DELETE already does.
-- Everything else (user_id ownership, personal-vs-business staff gate) is 0144's,
-- unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists user_memory_insert on public.user_memory;
create policy user_memory_insert on public.user_memory
  for insert with check (
    user_id = auth.uid()
    and org_id = public.auth_org_id()
    and (scope = 'personal' or public.is_staff())
  );

drop policy if exists user_memory_update on public.user_memory;
create policy user_memory_update on public.user_memory
  for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and org_id = public.auth_org_id()
    and (scope = 'personal' or public.is_staff())
  );
