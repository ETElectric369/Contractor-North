-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0090: hot-path performance indexes
-- From the 2026-06-27 latency audit. Pure-additive, zero behavior change — these
-- replace full-table scans on the most-loaded pages (/planner, /schedule, /jobs/[id])
-- with index lookups. All IF NOT EXISTS, so safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- /planner + /timecards: day/week time-entry ranges filter profile_id + order/range on clock_in.
-- (Existing time_entries_profile_idx is profile_id-only; this composite covers the date range too.)
create index if not exists time_entries_profile_clock_idx
  on public.time_entries(profile_id, clock_in desc);

-- /planner + /schedule: jobs filtered by scheduled_start date ranges (no index existed on it).
create index if not exists jobs_scheduled_start_idx
  on public.jobs(scheduled_start);

-- /planner + /schedule: multi-day segment overlap queries on start_date/end_date (only job_id was indexed).
create index if not exists job_segments_date_range_idx
  on public.job_schedule_segments(start_date, end_date);

-- Labor billing + /jobs/[id] costs: time_allocations looked up by job_id (only time_entry_id was indexed).
create index if not exists time_allocations_job_idx
  on public.time_allocations(job_id);

-- /planner current-job material list + /jobs/[id]: material_lists by job_id (only quote_id was indexed).
create index if not exists material_lists_job_idx
  on public.material_lists(job_id);
