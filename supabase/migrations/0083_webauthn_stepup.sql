-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0083: WebAuthn step-up re-auth (box Phase C2)
-- The unforgeable gate: a tier-2 (money) action invoked by the agent/voice requires a
-- fresh WebAuthn assertion (Face ID / passkey) that the AI physically cannot produce.
-- Two tables: the enrolled credentials, and a short-lived single-use challenge per user.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.webauthn_credentials (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  org_id        uuid references public.organizations(id) on delete cascade,
  credential_id text not null unique,          -- base64url
  public_key    text not null,                 -- base64url COSE key
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  label         text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists webauthn_credentials_user_idx on public.webauthn_credentials(user_id);

drop trigger if exists stamp_org_webauthn_credentials on public.webauthn_credentials;
create trigger stamp_org_webauthn_credentials before insert on public.webauthn_credentials
  for each row execute function public.set_org_id();

alter table public.webauthn_credentials enable row level security;
-- A passkey belongs to ONE user — they alone manage it.
drop policy if exists webauthn_credentials_own on public.webauthn_credentials;
create policy webauthn_credentials_own on public.webauthn_credentials
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- One short-lived, single-use challenge per user (overwritten each ceremony, deleted on
-- verify). For a step-up the challenge is BOUND to one action+input via action_hash, so
-- an assertion can't be replayed for a different action.
create table if not exists public.webauthn_challenges (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  challenge   text not null,
  purpose     text not null,        -- 'register' | 'stepup'
  action_hash text,
  created_at  timestamptz not null default now()
);
alter table public.webauthn_challenges enable row level security;
drop policy if exists webauthn_challenges_own on public.webauthn_challenges;
create policy webauthn_challenges_own on public.webauthn_challenges
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
