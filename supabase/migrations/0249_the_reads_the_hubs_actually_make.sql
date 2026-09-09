-- 0249 — THE READS THE HUBS ACTUALLY MAKE (audit v921's last open perf finding, closed during the
-- 2026-09-08 phone-lag sweep).
--
-- Every job hub reads time_entries / invoices / quotes / documents BY job_id, and every timecard
-- and payroll screen reads time_entries by (org_id, clock_in) — and not one of those columns was
-- indexed. Today's tables are small enough that a sequential scan is microseconds, so this is not
-- the cause of the lag Erik reported (that was the app shell awaiting a ~31-query badge before
-- every page, and per-row Storage signing). It IS the thing that turns a fine job hub into a slow
-- one somewhere around the first few thousand rows, which is exactly the point at which nobody
-- wants to be diagnosing it. Index it now, while it costs nothing.
--
-- CONCURRENTLY is deliberately NOT used: it cannot run inside the transaction the migration runner
-- wraps every file in, and on tables this size a plain CREATE INDEX takes a lock for milliseconds.

-- The job hub's four tabs, each of which filters by the job it is showing.
create index if not exists time_entries_job_idx on public.time_entries (job_id) where job_id is not null;
create index if not exists invoices_job_idx     on public.invoices     (job_id) where job_id is not null;
create index if not exists quotes_job_idx       on public.quotes       (job_id) where job_id is not null;
create index if not exists documents_job_idx    on public.documents    (job_id) where job_id is not null;

-- documents had NOTHING but its primary key — every /organize and job-documents read was a full
-- scan of the org's whole filing cabinet.
create index if not exists documents_org_created_idx on public.documents (org_id, created_at desc);

-- Timecards, payroll and the week grid all ask "this org's entries in this date window".
create index if not exists time_entries_org_clock_idx on public.time_entries (org_id, clock_in desc);
