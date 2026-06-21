-- Agent-security framework, Pillar 6 (audit & undo) + §8 build step 2.
-- An append-only trail of every WRITE that runs through the Action Registry's single
-- chokepoint (executeAction). Captures who / what action / risk tier / result / when,
-- attributable to a person and scoped to one org. No agent capability is added by
-- this table — it is instrumentation the human-driven registry writes today, and the
-- backstop the gated agent phases (confirm/step-up, exposure) will lean on.

create table if not exists public.agent_audit_log (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,
  action        text not null,                 -- registry action name, e.g. "bill.update"
  risk          smallint not null default 1,   -- 0..3 (framework §3 tier)
  effect        text,                          -- read | write
  ok            boolean not null,
  error         text,                          -- truncated error on failure
  input_summary jsonb,                         -- keys + record id ONLY (no PII / secret values)
  source        text not null default 'ui',    -- ui | voice | agent
  created_at    timestamptz not null default now()
);

create index if not exists agent_audit_log_org_idx on public.agent_audit_log(org_id, created_at desc);
create index if not exists agent_audit_log_user_idx on public.agent_audit_log(user_id, created_at desc);

-- org_id is stamped from the caller's auth context when not supplied (consistency
-- with every other tenant table).
drop trigger if exists set_org_id_agent_audit on public.agent_audit_log;
create trigger set_org_id_agent_audit before insert on public.agent_audit_log
  for each row execute function public.set_org_id();

alter table public.agent_audit_log enable row level security;

-- Read: management only (owner/admin/office) sees their org's audit trail.
drop policy if exists agent_audit_read on public.agent_audit_log;
create policy agent_audit_read on public.agent_audit_log
  for select using (org_id = public.auth_org_id() and public.is_org_staff());

-- Insert: any member of the org may append their own audit rows (a tech completing
-- a task logs one too). No update/delete policy -> the trail is immutable.
drop policy if exists agent_audit_insert on public.agent_audit_log;
create policy agent_audit_insert on public.agent_audit_log
  for insert with check (org_id = public.auth_org_id());
