-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0108: org-shared assistant memory
-- Nort's durable memory was RLS-private per user — yet the prompt told it "save a
-- fact, this is how you learn the BUSINESS." Contradiction: teach Nort once and only
-- you benefited, not the crew. Split memory by scope:
--   · business — how the COMPANY runs (suppliers, rates, crew, billing rhythm). Shared
--     across the org's people, so Nort learns the business once for everyone.
--   · personal — one person's own style/defaults. Stays private to that person.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.user_memory
  add column if not exists scope text not null default 'business'
  check (scope in ('business', 'personal'));

-- READ: your org's shared business facts + your own personal facts.
drop policy if exists user_memory_own on public.user_memory;
drop policy if exists user_memory_read on public.user_memory;
create policy user_memory_read on public.user_memory
  for select using (
    org_id = public.auth_org_id()
    and (scope = 'business' or user_id = auth.uid())
  );

-- WRITE: you can only add / change / remove facts saved under your own name.
drop policy if exists user_memory_insert on public.user_memory;
create policy user_memory_insert on public.user_memory
  for insert with check (user_id = auth.uid());
drop policy if exists user_memory_update on public.user_memory;
create policy user_memory_update on public.user_memory
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists user_memory_delete on public.user_memory;
create policy user_memory_delete on public.user_memory
  for delete using (user_id = auth.uid());
