-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0106: voice portal (authorized voice donation)
-- A private, consent-first page a named person (e.g. Bryan Hubbard) opens from a
-- secret link to record voice samples + give explicit, documented permission to
-- build a synthetic voice for the North assistant (Nort) via ElevenLabs PVC.
-- One invite = one secret token; the /voice/[token] page + its server actions
-- resolve/write via the SERVICE ROLE only (the invitee has no account), so there
-- is no anon RLS policy — the unguessable token is the capability.
-- Run AFTER 0004 (needs auth_org_id()).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.voice_invites (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  token         text not null unique,          -- secret, unguessable — the link path
  invitee_name  text not null,                 -- e.g. "Bryan Hubbard"
  purpose       text,                          -- short line shown on the page
  consent_name  text,                          -- their typed signature (null until they consent)
  consent_version text,                        -- which consent text they agreed to
  consented_at  timestamptz,
  completed_at  timestamptz,                   -- they finished the recording session
  clip_count    int not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists voice_invites_token_idx on public.voice_invites(token);
create index if not exists voice_invites_org_idx on public.voice_invites(org_id, created_at desc);

alter table public.voice_invites enable row level security;

-- Staff of the org see + manage their own invites (create the link, watch progress,
-- download the clips). The public page never uses a session — it's service-role only.
drop policy if exists voice_invites_staff on public.voice_invites;
create policy voice_invites_staff on public.voice_invites
  for all using (org_id = public.auth_org_id())
  with check (org_id = public.auth_org_id());
-- No anon policy on purpose: only the service-role server actions (token-gated) write here.

-- Private bucket for the raw recordings. NOT public: voice recordings are sensitive, so
-- they're read only by the staff who own the invite (via short-lived signed URLs). Writes
-- go through the token-gated /voice/[token] upload action under the service role, so no
-- INSERT policy is granted to anon. 50MB/clip covers a long natural-speech take.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'voice-clips', 'voice-clips', false, 52428800,
  array['audio/webm','audio/mp4','audio/mpeg','audio/wav','audio/ogg','audio/x-m4a','audio/aac']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 52428800,
  allowed_mime_types = array['audio/webm','audio/mp4','audio/mpeg','audio/wav','audio/ogg','audio/x-m4a','audio/aac'];
