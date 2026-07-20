-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0144: gate assistant-memory SCOPE + widen delete
--
-- Nort's `remember` tool was the one agent write outside the chokepoint: model-driven,
-- unaudited, uncapped, and — for scope 'business' — written into EVERY crew member's system
-- prompt as company fact, forever. The application layer (memory.remember action, cn this
-- audit) now routes it through executeAction: role gate, audit row, blast-radius cap, length
-- + count caps, and a scope downgrade so a non-staff caller can only save PERSONAL facts.
--
-- RLS — not the action — is the real write boundary (a direct PostgREST insert skips the
-- action entirely), so the scope rule must live in the policy too. 0108's insert policy gated
-- ONLY `user_id = auth.uid()` with no restriction on `scope`, so any authenticated member
-- could PATCH an org-wide 'business' fact straight in. Two changes:
--
--   1. INSERT/UPDATE: an org-wide 'business' fact requires a staff role; anyone may write their
--      own 'personal' facts. (public.is_staff() already = owner/admin/office.)
--   2. DELETE: an owner/admin/office member may remove a 'business' fact ANYONE wrote (so a
--      poisoned company fact is removable), while a personal fact stays deletable only by its
--      author. Prereq for the future "What Nort knows" settings panel.
-- ═══════════════════════════════════════════════════════════════════════════

-- INSERT: your own personal facts always; a shared business fact only if you're staff.
drop policy if exists user_memory_insert on public.user_memory;
create policy user_memory_insert on public.user_memory
  for insert with check (
    user_id = auth.uid()
    and (scope = 'personal' or public.is_staff())
  );

-- UPDATE: same rule on both sides of the write — you can't edit a row INTO an org-wide
-- business fact unless you're staff, and you can only touch your own rows.
drop policy if exists user_memory_update on public.user_memory;
create policy user_memory_update on public.user_memory
  for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (scope = 'personal' or public.is_staff())
  );

-- DELETE: your own rows (any scope), OR — for a SHARED business fact — any staff member in the
-- same org, so an owner can clear a fact a crew member's Nort saved. Scoped to the org via
-- auth_org_id() so staff can't reach into another tenant's memory.
drop policy if exists user_memory_delete on public.user_memory;
create policy user_memory_delete on public.user_memory
  for delete using (
    user_id = auth.uid()
    or (scope = 'business' and org_id = public.auth_org_id() and public.is_staff())
  );
