-- OFFLINE WRITE IDEMPOTENCY (determinism survey, Wave E).
--
-- A queued write is retried, and a retry that isn't idempotent is worse than a lost write. If a
-- phone in a dead zone queues "save these inspection answers", comes back into signal, and the
-- request times out halfway through — the queue retries, and without this table the operation runs
-- twice. For a save that's harmless; for anything that CREATES a row it silently doubles it. The
-- offline queue is only safe to build on top of a guarantee like this one, so this lands first.
--
-- The key is generated ON THE DEVICE before the first attempt and stays fixed across every retry,
-- so "the same operation" is defined by the client's intent rather than by whatever the server
-- happens to see.

create table if not exists public.client_operations (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  -- Who queued it. A replayed operation must be attributable to the person who made it, not to
  -- whoever happened to be signed in when the phone reconnected.
  profile_id    uuid references public.profiles(id) on delete set null,
  client_op_id  text not null,
  action        text not null,
  -- The row the operation produced, so a duplicate can return the ORIGINAL result instead of a
  -- bare "already done" the caller can't use.
  result_id     uuid,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

-- THE GUARANTEE. Scoped per-org so two tenants can never collide on a client-generated string.
create unique index if not exists client_operations_key_idx
  on public.client_operations (org_id, client_op_id);

create index if not exists client_operations_created_idx
  on public.client_operations (org_id, created_at desc);

alter table public.client_operations enable row level security;

drop trigger if exists stamp_org_client_operations on public.client_operations;
create trigger stamp_org_client_operations before insert on public.client_operations
  for each row execute function public.set_org_id();

-- A member may claim and read their OWN operation keys. That's all this table is for; nobody needs
-- to see anyone else's, and nothing needs to update or delete one — an operation record is a fact
-- about something that already happened, so it is deliberately append-only from the client's side.
drop policy if exists client_operations_insert_self on public.client_operations;
create policy client_operations_insert_self on public.client_operations
  for insert to authenticated
  with check (org_id = public.auth_org_id() and profile_id = auth.uid());

drop policy if exists client_operations_select_self on public.client_operations;
create policy client_operations_select_self on public.client_operations
  for select to authenticated
  using (org_id = public.auth_org_id() and profile_id = auth.uid());

-- Server code (service role) bypasses RLS and does the completing write; no update policy is
-- granted to `authenticated`, so a client cannot mark its own operation complete or rewrite the
-- result id of one that already ran.

comment on table public.client_operations is
  'Idempotency ledger for writes queued offline. The client generates client_op_id before its first attempt and reuses it on every retry; a duplicate insert violates the unique index and the server returns the original result instead of performing the work twice.';
