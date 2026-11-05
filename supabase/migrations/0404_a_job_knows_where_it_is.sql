-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0404: a job knows where it is
--
-- The clock-in picks the job the person is standing at (the owner, 2026-11-04: "location for
-- clock-in defaults to the job picker and doesn't necessarily ask location"). The punch already
-- carries its fix (time_entries.gps_in); a job carried no place at all, and the server geocoder
-- (lib/geocode-server) keeps its answers only in memory and in the fetch cache, keyed by nothing a
-- read can join on. This migration gives a job a place to remember where its address is, found once.
--
-- WHAT CHANGES:
--
--   public.jobs gets three nullable columns:
--     geo_lat      numeric(9,6)  the job's address, geocoded (-90..90).
--     geo_lng      numeric(9,6)  the same, east-west (-180..180).
--     geocoded_at  timestamptz   when the app asked. Set with null coordinates when the address
--                                would not geocode, so it is not asked again on every punch.
--   Null everywhere = never asked. The app fills them lazily (lib/timeclock/job-coordinates
--   coordinatesOfJobs): the first time a job with an address is near a punch, it is geocoded once
--   and stamped, on the service client, scoped to the job's id and its company.
--
--   ONE TRIGGER, so a stored place never outlives its address: jobs_geo_follows_address clears the
--   three when address, city, state or zip change, and the next punch near it asks again.
--
--   The readers, the day they are added (a stored answer nothing reads back is a hole):
--   coordinatesOfJobs reads all three, for resolveTechJobToday's nearest step (timeclock/actions)
--   and the "Which Job Are You On?" sheet's nearest-first rows (timeclock/which-job-actions).
--
--   No RLS change: jobs keeps its policies; a member already reads the job's address, and a place
--   is the same fact. Nothing here carries a price.
--
-- LOCKS: ALTER TABLE … ADD COLUMN takes jobs' ACCESS EXCLUSIVE lock for a moment; a nullable
-- column with no default is a catalog change, and each CHECK reads the table once to prove it
-- holds. lock_timeout 3s: a busy table fails fast and changes nothing; run it again. Twice-safe:
-- every column is ADD COLUMN IF NOT EXISTS, the function is CREATE OR REPLACE, the trigger is
-- dropped if it exists and made again, and the comments are set to the same text again.
--
-- ORDER: after 0402. Apply BEFORE the deploy that carries the nearest step: coordinatesOfJobs
-- selects these columns (a missing column fails its read, and the punch falls back to today's
-- rule, so the clock still works — it just does not know where anyone is).
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.jobs') is null then
    raise exception '0404: public.jobs is not on this database. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'jobs' and column_name = 'zip'
  ) then
    raise exception '0404: jobs has no zip (0177, the address spine). Apply 0177 first. Nothing was changed.';
  end if;
end $$;

-- ── where the job is ────────────────────────────────────────────────────────────────────────────
alter table public.jobs add column if not exists geo_lat numeric(9,6)
  constraint jobs_geo_lat_range check (geo_lat is null or (geo_lat >= -90 and geo_lat <= 90));
alter table public.jobs add column if not exists geo_lng numeric(9,6)
  constraint jobs_geo_lng_range check (geo_lng is null or (geo_lng >= -180 and geo_lng <= 180));
alter table public.jobs add column if not exists geocoded_at timestamptz;

comment on column public.jobs.geo_lat is
  'Where the job''s address is, north-south, geocoded once by the app (0404, lib/timeclock/job-coordinates). Null = not asked, or the address would not geocode (see geocoded_at). Cleared when the address changes.';
comment on column public.jobs.geo_lng is
  'Where the job''s address is, east-west (0404). Null with geo_lat.';
comment on column public.jobs.geocoded_at is
  'When the app geocoded the job''s address (0404). Set with null coordinates when the address would not geocode, so it is not asked again every punch. Cleared with the coordinates when the address changes.';

-- ── a place never outlives its address ──────────────────────────────────────────────────────────
create or replace function public.jobs_geo_follows_address()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.address is distinct from old.address
     or new.city is distinct from old.city
     or new.state is distinct from old.state
     or new.zip is distinct from old.zip then
    new.geo_lat := null;
    new.geo_lng := null;
    new.geocoded_at := null;
  end if;
  return new;
end
$fn$;

drop trigger if exists jobs_geo_follows_address on public.jobs;
create trigger jobs_geo_follows_address before update of address, city, state, zip on public.jobs
  for each row execute function public.jobs_geo_follows_address();

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_col text;
  v_con text;
begin
  foreach v_col in array array['geo_lat', 'geo_lng'] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'jobs' and column_name = v_col
         and data_type = 'numeric' and numeric_precision = 9 and numeric_scale = 6 and is_nullable = 'YES'
    ) then
      raise exception '0404: jobs.% is missing, or is not a numeric(9,6) that may be left empty. Nothing was changed.', v_col;
    end if;
  end loop;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'jobs' and column_name = 'geocoded_at'
       and data_type = 'timestamp with time zone' and is_nullable = 'YES'
  ) then
    raise exception '0404: jobs.geocoded_at is missing, or is not a timestamptz that may be left empty. Nothing was changed.';
  end if;
  foreach v_con in array array['jobs_geo_lat_range', 'jobs_geo_lng_range'] loop
    if not exists (select 1 from pg_constraint where conrelid = 'public.jobs'::regclass and conname = v_con and contype = 'c') then
      raise exception '0404: the check % is missing from jobs, so a point off the globe could be stored. Nothing was changed.', v_con;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'jobs_geo_follows_address' and not tgisinternal) then
    raise exception '0404: the trigger that clears a moved job''s place is not on jobs. Nothing was changed.';
  end if;
  -- jobs' boundary is untouched: row level security stays on.
  if not (select relrowsecurity from pg_class where oid = 'public.jobs'::regclass) then
    raise exception '0404: row level security is off on jobs. Nothing was changed.';
  end if;
  raise notice '0404: a job knows where it is — its address geocoded once, kept on the job, cleared when the address moves, and the clock-in reads it to pick the job the person is standing at.';
end $$;
