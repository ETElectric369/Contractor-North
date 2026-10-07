-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0382: a correction follows its bucket and its part of the job too
--
-- 0381 made a correction follow the bill it corrects in two things: the job and the state (On
-- Account / Settled). The skeptic review of that release, the same day, found the two it left out:
--
--   · a no-job Fuel bill of $200 gets a +$50 correction (Fuel). The original is re-filed as Auto.
--     The correction stays Fuel, so one purchase the bills list prints as "$250 together" lands in two
--     profit-and-loss buckets;
--   · a bill on a job is moved to Business Cost · Auto. 0381 clears the correction's job but leaves its
--     bucket empty (filed as Other) and its part of the job (a scope word) riding on a no-job bill.
--
-- Totals were never lost or doubled; the SPLIT was wrong. ONE PURCHASE, ONE JOB, ONE PART OF IT, ONE
-- BUCKET, ONE STATE: a correction takes all four from its original when it is attached, cannot leave
-- them after, and follows them when the original changes. The app hides those fields on a
-- correction's Edit Bill box and says which bill to change instead.
--
-- 0381 is applied and is not edited (applied migrations are immutable). This file REPLACES the two
-- functions it wrote, each in full, and recreates the follow trigger over the wider column list.
--
-- NOTHING IS MOVED: every correction row (none today) is checked at the end against all four rules.
-- LOCKS: two CREATE OR REPLACE FUNCTION and one trigger swap; ACCESS EXCLUSIVE on bills for a moment.
-- lock_timeout 15s. ORDER: after 0381. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '15s';
set local statement_timeout = '60s';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bills' and column_name = 'corrects_bill_id'
  ) then
    raise exception '0382: bills.corrects_bill_id is not on this database. Run 0381 first. Nothing was changed.';
  end if;
end $$;

-- ── 1. ONE PURCHASE: JOB, PART OF THE JOB, BUCKET, STATE ────────────────────────────────────────
create or replace function public.guard_bill_correction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  orig    record;
  v_label text;
begin
  -- A bill carrying corrections cannot be set aside as a duplicate: its corrections would be left
  -- correcting "not a cost". Asked only when superseded_by_bill_id is being set.
  if new.superseded_by_bill_id is not null
     and (tg_op = 'INSERT' or new.superseded_by_bill_id is distinct from old.superseded_by_bill_id)
     and exists (select 1 from public.bills b where b.corrects_bill_id = new.id) then
    raise exception 'This bill carries a correction, so it cannot be set aside as a duplicate. Delete the correction first. Nothing was changed.'
      using errcode = 'P0001';
  end if;

  if new.corrects_bill_id is null then
    return new;
  end if;

  if new.corrects_bill_id = new.id then
    raise exception 'A bill cannot correct itself. Nothing was changed.' using errcode = 'P0001';
  end if;
  if new.superseded_by_bill_id is not null then
    raise exception 'A correction cannot be set aside as a duplicate: it belongs to the bill it corrects. Nothing was changed.'
      using errcode = 'P0001';
  end if;

  select b.id, b.org_id, b.job_id, b.status, b.category, b.scope_category, b.corrects_bill_id, b.superseded_by_bill_id, b.bill_number
    into orig
    from public.bills b
   where b.id = new.corrects_bill_id;
  if not found or orig.org_id is distinct from new.org_id then
    raise exception 'The bill this corrects is not on the books. Nothing was changed.' using errcode = 'P0001';
  end if;
  v_label := coalesce(nullif(orig.bill_number, ''), 'that bill');

  if orig.corrects_bill_id is not null then
    raise exception '% is itself a correction. Attach this one to the bill it corrects. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  if orig.superseded_by_bill_id is not null then
    raise exception '% was set aside as a duplicate. Correct the bill that was kept. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' or new.corrects_bill_id is distinct from old.corrects_bill_id then
    -- Attached: the correction takes the original's job, part of the job, bucket and state, whatever
    -- the caller sent.
    new.job_id         := orig.job_id;
    new.status         := orig.status;
    new.category       := orig.category;
    new.scope_category := orig.scope_category;
    return new;
  end if;
  if new.job_id is distinct from orig.job_id then
    raise exception 'A correction stays on the job of the bill it corrects (%). Move that bill and this one follows. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  if new.status is distinct from orig.status then
    raise exception 'A correction is settled with the bill it corrects (%). Mark that bill and this one follows. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  if new.category is distinct from orig.category then
    raise exception 'A correction is filed in the bucket of the bill it corrects (%). Change that bill and this one follows. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  if new.scope_category is distinct from orig.scope_category then
    raise exception 'A correction belongs to the same part of the job as the bill it corrects (%). Change that bill and this one follows. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ── 2. THE ORIGINAL CHANGES; ITS CORRECTIONS FOLLOW IN ALL FOUR ─────────────────────────────────
create or replace function public.bill_corrections_follow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bills b
     set job_id         = new.job_id,
         status         = new.status,
         category       = new.category,
         scope_category = new.scope_category
   where b.corrects_bill_id = new.id
     and (b.job_id is distinct from new.job_id
       or b.status is distinct from new.status
       or b.category is distinct from new.category
       or b.scope_category is distinct from new.scope_category);
  return null;
end $$;

drop trigger if exists bill_corrections_follow on public.bills;
create trigger bill_corrections_follow
  after update of job_id, status, category, scope_category on public.bills
  for each row
  when (old.job_id is distinct from new.job_id
     or old.status is distinct from new.status
     or old.category is distinct from new.category
     or old.scope_category is distinct from new.scope_category)
  execute function public.bill_corrections_follow();

-- ── 3. VERIFY, OR FAIL THE RUN ──────────────────────────────────────────────────────────────────
do $$
declare
  n   int;
  def text;
begin
  select pg_get_triggerdef(oid) into def from pg_trigger
   where tgrelid = 'public.bills'::regclass and tgname = 'bill_corrections_follow' and not tgisinternal;
  if def is null or def not like '%category%' or def not like '%scope_category%' then
    raise exception '0382: bill_corrections_follow does not watch category and scope_category (%).', coalesce(def, 'missing');
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.bills'::regclass and tgname = 'guard_bill_correction' and not tgisinternal) then
    raise exception '0382: guard_bill_correction is not on bills.';
  end if;
  select count(*) into n
    from public.bills c
    join public.bills o on o.id = c.corrects_bill_id
   where c.job_id is distinct from o.job_id
      or c.status is distinct from o.status
      or c.category is distinct from o.category
      or c.scope_category is distinct from o.scope_category;
  if n > 0 then
    raise exception '0382: % correction row(s) differ from their original in job, state, bucket or part of the job. Nothing more was changed.', n;
  end if;
  select count(*) into n from public.bills where corrects_bill_id is not null;
  raise notice '0382 OK: a correction follows job, state, bucket and part of the job; % correction row(s) checked.', n;
end $$;
