-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0085: assistant memory ("Claude in a box")
-- Two per-USER stores (RLS-private to the person, not just the org):
--   · assistant_state — the current conversation + the live quote draft, so you can
--     close and pick up exactly where you left off.
--   · user_memory     — durable facts Claude learns about THIS person (their style,
--     suppliers, trades, defaults) and feeds back into every future session.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.assistant_state (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  org_id      uuid references public.organizations(id) on delete cascade,
  messages    jsonb not null default '[]',   -- recent {role, content} turns
  draft       jsonb,                          -- the in-progress quote draft, if any
  updated_at  timestamptz not null default now()
);

drop trigger if exists stamp_org_assistant_state on public.assistant_state;
create trigger stamp_org_assistant_state before insert on public.assistant_state
  for each row execute function public.set_org_id();

alter table public.assistant_state enable row level security;
drop policy if exists assistant_state_own on public.assistant_state;
create policy assistant_state_own on public.assistant_state
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.user_memory (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  org_id      uuid references public.organizations(id) on delete cascade,
  content     text not null,                  -- one durable fact about the person
  created_at  timestamptz not null default now()
);
create index if not exists user_memory_user_idx on public.user_memory(user_id, created_at desc);

drop trigger if exists stamp_org_user_memory on public.user_memory;
create trigger stamp_org_user_memory before insert on public.user_memory
  for each row execute function public.set_org_id();

alter table public.user_memory enable row level security;
drop policy if exists user_memory_own on public.user_memory;
create policy user_memory_own on public.user_memory
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
