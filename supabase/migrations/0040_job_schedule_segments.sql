-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0040: multi-range job scheduling
-- A job can run several non-contiguous date ranges (e.g. Mon–Thu this week,
-- Tue–Fri next week). Each range is a row here; jobs.scheduled_start/end keep
-- mirroring the overall min/max so every legacy reader (lists, dashboard,
-- calendar fallback) keeps working. When a job has segments, the calendar and
-- scheduler place it only on the days its segments cover (gaps stay empty).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.job_schedule_segments (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid references public.organizations(id) on delete cascade,
  job_id     uuid not null references public.jobs(id) on delete cascade,
  start_date date not null,
  end_date   date not null,
  created_at timestamptz not null default now()
);
create index if not exists job_seg_job_idx on public.job_schedule_segments(job_id);

drop trigger if exists stamp_org_job_schedule_segments on public.job_schedule_segments;
create trigger stamp_org_job_schedule_segments before insert on public.job_schedule_segments
  for each row execute function public.set_org_id();

alter table public.job_schedule_segments enable row level security;

drop policy if exists job_schedule_segments_rw on public.job_schedule_segments;
create policy job_schedule_segments_rw on public.job_schedule_segments
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
