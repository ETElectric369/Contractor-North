-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0378: a permit can need more than one inspection
--
-- Erik, 2026-10-03, asked for a worked example and gave this one:
--
--   "oct 12 job at 10244 schaffer has a permit pulled and its on file, when we do the job we have to
--    get it inspected by both the Town of Truckee and Liberty Utilities before Liberty will put the
--    meter back on, so final inspections come with permits."
--
-- And the order matters, because it is a sequence and not a checklist:
--
--   "Liberty's inspection is after the town puts the tag on in and involves putting the meter back on
--    in the same visit."
--
-- So: the Town inspects and tags it; only then does Liberty come; and Liberty's visit is the
-- inspection AND the meter going back on, in one trip. Liberty passing is not a box ticked — it is
-- the moment the customer has power and the job is genuinely finished.
--
-- Asked whether rough-in inspections need modelling too, he said: "final". So there are no STAGES to
-- model. What varies is the AUTHORITY, and how many of them one permit needs.
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────────────
-- public.permits (0022) carries ONE inspection, inline: inspection_date, inspector,
-- inspection_result. To record Schaffer today he would have to create TWO permit rows for ONE permit
-- number — duplicating the fee, the dates and the number, and making the permit list overstate how
-- many permits he has. The utility's inspection, the one that gates the meter, has nowhere to live at
-- all: the word "utility" appears nowhere in the app.
--
-- ── WHAT THIS ADDS ───────────────────────────────────────────────────────────────────────────────
-- public.permit_inspections — one row per visit an authority makes about a permit.
--
--   authority         who is coming ("Town of Truckee", "Liberty Utilities"). The permit's own
--                     `authority` column stays and keeps its own meaning: who ISSUED the permit.
--                     Who issues it and who inspects it are not the same question.
--   position          the order they come in. Position 2 is not bookable until position 1 has
--                     passed — the town's tag is what lets Liberty be called. Derived, not stored:
--                     nothing here records "waits for", because the order plus the previous row's
--                     result already says it.
--   scheduled_for     the DAY, and `scheduled_window` the part of it. An inspector gives you a
--                     morning, never 9:14, and a timestamp would invent a precision nobody has.
--                     Both of Schaffer's are booked for the morning of Thursday 15 October.
--   result            NULL until they have been. Then passed / failed / cancelled. A failed final
--                     is re-inspected, so the same authority may have several rows over time and
--                     NOTHING here is unique per authority.
--
-- WHEN IS THE JOB DONE? When every inspection on its permit has passed. That is all, and it is why
-- there is no "this is the one that sets the meter" flag: Liberty being last is a fact about the
-- world, not a thing the schema needs to carry. The highest position that passes is the end.
--
-- ── THE OLD COLUMNS ──────────────────────────────────────────────────────────────────────────────
-- Every permit that has recorded an inspection gets it as its first row, so nothing is lost. The
-- three columns are LEFT IN PLACE and commented as superseded rather than dropped: dropping a column
-- in the same breath as creating its replacement leaves no way back if the shape is wrong. The code
-- stops reading them in the release that follows this; a later migration drops them once nothing
-- does. Until then they are not a second source of truth — they are a backup of the first row.
--
-- LOCKS: one new table and one backfill INSERT over a small table. No lock on anything a person is
-- using. lock_timeout 3s. Additive only. Safe to re-run: the backfill skips a permit that already
-- has rows.
--
-- ORDER: after 0022 (permits). Safe before or after the code.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if to_regclass('public.permits') is null then
    raise exception '0378: permits is not on this database. Run 0022 first. Nothing was changed.';
  end if;
end $$;

create table if not exists public.permit_inspections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- The permit this is an inspection OF. Cascade: delete the permit and its visits go with it,
  -- because a visit about a permit that no longer exists is not a record of anything.
  permit_id uuid not null references public.permits(id) on delete cascade,
  -- Who is coming. Free text on purpose: every town, county and utility names itself differently,
  -- and a list this app invented would be wrong in the next county ([[build-for-millions]]).
  authority text not null check (char_length(btrim(authority)) between 1 and 80),
  -- The order they come in. Position 2 is not bookable until 1 has passed.
  position smallint not null default 1 check (position between 1 and 20),
  scheduled_for date,
  -- An inspector gives you a part of a day, never a time.
  scheduled_window text check (scheduled_window is null or scheduled_window in ('morning', 'afternoon', 'all_day')),
  inspector text check (inspector is null or char_length(inspector) <= 80),
  -- NULL until they have been.
  result text check (result is null or result in ('passed', 'failed', 'cancelled')),
  result_on date,
  notes text check (notes is null or char_length(notes) <= 2000),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A result needs a day it happened; a day without a result is a visit nobody has written up.
  constraint permit_inspections_result_has_a_day check ((result is null) or (result_on is not null)),
  -- One permit does not have two visits in the same place in the queue.
  constraint permit_inspections_one_per_position unique (permit_id, position)
);

comment on table public.permit_inspections is
  'The inspections a permit needs (0378). One row per visit an authority makes: who is coming, where they sit in the order, the day and part-day it is booked for, who came, and whether it passed. A permit can need several from DIFFERENT authorities — Erik: "we have to get it inspected by both the Town of Truckee and Liberty Utilities before Liberty will put the meter back on". The job is done when every row on its permit has passed; the utility is last because its visit is the inspection AND the meter going back on. permits.authority is a different fact: who ISSUED the permit.';

comment on column public.permit_inspections.position is
  'The order the authorities come in (0378). Position 2 is not bookable until position 1 has passed — the town''s tag is what lets the utility be called. Nothing records "waits for": the order plus the previous row''s result already says it.';

create index if not exists permit_inspections_permit_idx on public.permit_inspections (org_id, permit_id, position);
create index if not exists permit_inspections_waiting_idx on public.permit_inspections (org_id, scheduled_for) where result is null;

drop trigger if exists touch_permit_inspections on public.permit_inspections;
create trigger touch_permit_inspections before update on public.permit_inspections
  for each row execute function public.touch_updated_at();

drop trigger if exists stamp_org_permit_inspections on public.permit_inspections;
create trigger stamp_org_permit_inspections before insert on public.permit_inspections
  for each row execute function public.set_org_id();

-- ── WHO MAY SEE IT: exactly what a permit allows, no wider and no narrower ───────────────────────
alter table public.permit_inspections enable row level security;

drop policy if exists permit_inspections_read on public.permit_inspections;
create policy permit_inspections_read on public.permit_inspections
  for select using (org_id = public.auth_org_id());

drop policy if exists permit_inspections_write on public.permit_inspections;
create policy permit_inspections_write on public.permit_inspections
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

-- ── THE INSPECTION ALREADY RECORDED BECOMES THE FIRST ROW ───────────────────────────────────────
-- Only where there is something to carry, and only for a permit with no rows yet, so running this
-- again changes nothing.
insert into public.permit_inspections (org_id, permit_id, authority, position, scheduled_for, inspector, result, result_on, created_by)
select p.org_id,
       p.id,
       coalesce(nullif(btrim(p.authority), ''), 'Not said'),
       1,
       p.inspection_date,
       nullif(btrim(p.inspector), ''),
       case lower(btrim(coalesce(p.inspection_result, '')))
         when 'passed' then 'passed' when 'pass' then 'passed' when 'approved' then 'passed'
         when 'failed' then 'failed' when 'fail' then 'failed'
         when 'cancelled' then 'cancelled' when 'canceled' then 'cancelled'
         else null
       end,
       -- A result needs the day it happened; the only day this table knows is the one it was booked
       -- for, which for a recorded result is the day they came.
       case when lower(btrim(coalesce(p.inspection_result, ''))) in
                 ('passed','pass','approved','failed','fail','cancelled','canceled')
            then coalesce(p.inspection_date, p.issued_date, p.applied_date, current_date) end,
       p.created_by
  from public.permits p
 where (p.inspection_date is not null
        or nullif(btrim(coalesce(p.inspector, '')), '') is not null
        or nullif(btrim(coalesce(p.inspection_result, '')), '') is not null)
   and not exists (select 1 from public.permit_inspections pi where pi.permit_id = p.id);

comment on column public.permits.inspection_date is
  'SUPERSEDED by permit_inspections (0378) — a permit can need more than one inspection. Kept as the backup of the first row until the code stops reading it; do not read it.';
comment on column public.permits.inspector is
  'SUPERSEDED by permit_inspections (0378). Kept as the backup of the first row until the code stops reading it; do not read it.';
comment on column public.permits.inspection_result is
  'SUPERSEDED by permit_inspections (0378). Kept as the backup of the first row until the code stops reading it; do not read it.';

-- ── WHAT MUST BE TRUE NOW ───────────────────────────────────────────────────────────────────────
do $$
declare missed int;
begin
  if to_regclass('public.permit_inspections') is null then
    raise exception '0378: permit_inspections was not created. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='permit_inspections' and policyname='permit_inspections_read') then
    raise exception '0378: permit_inspections has no read policy, so it would be readable by nobody or everybody. Nothing was changed.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.permit_inspections'::regclass) then
    raise exception '0378: row level security is off on permit_inspections. Nothing was changed.';
  end if;
  select count(*) into missed
    from public.permits p
   where (p.inspection_date is not null
          or nullif(btrim(coalesce(p.inspector, '')), '') is not null
          or nullif(btrim(coalesce(p.inspection_result, '')), '') is not null)
     and not exists (select 1 from public.permit_inspections pi where pi.permit_id = p.id);
  if missed > 0 then
    raise exception '0378: % permit(s) had an inspection recorded and did not get a row. Nothing was changed.', missed;
  end if;
  raise notice '0378: a permit can need more than one inspection.';
end $$;
