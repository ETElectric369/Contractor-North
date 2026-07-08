-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0107: nort_reviews (Nort's self-review "pulse")
-- A nightly (or on-demand) operations digest Nort generates about ITSELF: it reads
-- the crew's recent Nort conversations + their filed bug reports and clusters them
-- into "what the crew struggled with, what broke, what to build next." This is the
-- learning loop made active — Nort reviews its own day and surfaces the work.
-- Written ONLY by the service-role job (cross-crew read needs to bypass per-user RLS);
-- staff of the org can READ their org's reviews.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.nort_reviews (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid references public.organizations(id) on delete cascade,
  period_start timestamptz not null,
  period_end   timestamptz not null,
  summary      text not null,
  findings     jsonb not null default '[]',   -- [{ title, kind, priority, evidence }]
  counts       jsonb not null default '{}',   -- { bug_reports, conversations, messages }
  created_at   timestamptz not null default now()
);
create index if not exists nort_reviews_org_idx on public.nort_reviews(org_id, created_at desc);

alter table public.nort_reviews enable row level security;

-- Read-only for the org's staff; the service-role generator writes (bypasses RLS).
drop policy if exists nort_reviews_read on public.nort_reviews;
create policy nort_reviews_read on public.nort_reviews
  for select using (org_id = public.auth_org_id() and public.is_org_staff());
