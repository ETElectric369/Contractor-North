-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0394: Nort speaks first, per person
--
-- Erik, 2026-10-13, driving: "sometimes i have to wait longer than other times for it to be
-- ready for me to speak … if Nort can chime in with a quick greeting of choice (Hey Boss what
-- can i do for you or whatever … or the user wants to be called by name or nickname) and if Nort
-- has a message instead of just blurbing out everything from the start he could ask … and if
-- there is a pending nort notification we can have the waveform icon start pulsing red".
-- And the one rule for the ask: "if Nort says 'good time?' then i will have to respond 'a good
-- time for what?' … lets be clear, precise and to the point" — Nort names what he is holding.
--
-- PER PERSON, like 0183 (humour and register): the greeting is the ready signal for the one
-- holding the phone, and what Nort calls them is theirs to set. Two columns:
--   nort_greets  — Nort speaks the moment the mic is live (voice mode only; off = silence as before)
--   nort_name    — what Nort calls this person; null = their first name
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles add column if not exists nort_greets boolean not null default true;
alter table public.profiles add column if not exists nort_name   text    null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_nort_name_len') then
    alter table public.profiles add constraint profiles_nort_name_len check (nort_name is null or char_length(nort_name) <= 40);
  end if;
end $$;

-- 0216 revoked table-level SELECT on profiles and re-granted a column list: a new column is
-- private until it is granted here AND added to PROFILE_SAFE_COLS (tests/field-1013-nort-speaks-
-- first pins every safe column to a grant). Without this the shell's own profile read is refused
-- for every signed-in person and the app redirects them all into onboarding.
grant select (nort_greets, nort_name) on public.profiles to authenticated;

-- What Nort holds is read on every Bell poll: the caller's own resolved-unheard reports, by
-- reporter. bug_reports' only index was (org_id, created_at), a sequential scan per poll.
create index if not exists bug_reports_unheard_by_reporter_idx
  on public.bug_reports (reported_by)
  where filer_notified_at is null and status in ('fixed', 'closed', 'wontfix');

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'nort_greets') then
    raise exception '0394: profiles.nort_greets is missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'nort_name') then
    raise exception '0394: profiles.nort_name is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_nort_name_len') then
    raise exception '0394: profiles_nort_name_len is missing';
  end if;
  if not has_column_privilege('authenticated', 'public.profiles', 'nort_greets', 'select')
     or not has_column_privilege('authenticated', 'public.profiles', 'nort_name', 'select') then
    raise exception '0394: the new profile columns are not granted to authenticated';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'bug_reports_unheard_by_reporter_idx') then
    raise exception '0394: bug_reports_unheard_by_reporter_idx is missing';
  end if;
end $$;
