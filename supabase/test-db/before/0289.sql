-- TEST DATABASE ONLY. Runs right before 0289, in the same transaction.
--
-- WHAT PRODUCTION HAS: 20 old-style split rows in public.time_allocations (real shifts). 0289
-- carves them into time entries with Erik's answers hard-coded by entry id and proves the result
-- against those ids (INV-078 line 72c2c363 and so on), then archives the 20 rows; 0290 later
-- refuses to run unless archive.time_allocations holds exactly 20.
--
-- WHY A FRESH DATABASE LACKS IT: it has no ET data at all, so the carve's p_order names entries
-- that do not exist and 0289 raises. 0289 has its own "already converted" branch (time_allocations
-- empty AND archive non-empty -> notice, skip the carve); this shim takes that branch by creating
-- the archive table exactly as 0289 defines it and holding 20 PLACEHOLDER rows (no org, no job,
-- 0 h, became null), which also satisfies 0290's count. No production data is copied.
create schema if not exists archive;

create table if not exists archive.time_allocations (
  id            uuid primary key,
  time_entry_id uuid not null,
  org_id        uuid,
  job_id        uuid,
  job_code      text,
  hours         numeric(6,2) not null,
  description   text,
  sort_order    integer not null,
  created_at    timestamptz not null,
  archived_at   timestamptz not null default now(),
  became        uuid,
  carve_note    text
);

insert into archive.time_allocations (id, time_entry_id, hours, description, sort_order, created_at, carve_note)
select gen_random_uuid(), gen_random_uuid(), 0, 'test-db placeholder (production archived 20 real rows)', g, now(), 'test-db placeholder'
  from generate_series(1, 20) g;
