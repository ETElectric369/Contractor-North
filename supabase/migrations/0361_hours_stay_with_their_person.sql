-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0361: hours stay with their person
--
-- Found 2026-09-26 while fixing Erik's July hours: on ten paid ET invoices one person's labor line
-- claimed the OTHER person's shifts (invoice_items.source_ids, 0255). INV-050's "Labor — Erik Taylor"
-- held Brian's four J-030 shifts and "Labor — Brian Taylor" held none; INV-042's Brian line held
-- Erik's 7/22 shift; eight more like them (INV-00022 to INV-059). The money was right (the lines were
-- typed and paid). Who worked what, per-person hours and the payroll cross-checks read the claims, so
-- they read one man's hours as the other's.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────
--
-- 1. WHERE THE TEN CAME FROM: 0256, once (2026-09-11). The backfill gave a labor line a person only
--    from a `labor:<person>` key. Lines built before keys existed (0175, 2026-07-31) and lines typed
--    by hand have none, so every one was "invoice-level", and its anchor (distinct on invoice and
--    person, lowest sort_order) kept ONE per invoice and handed it every person's shifts. 0256 cannot
--    run again (it reads the split table 0290 dropped). Its claims are re-pointed by a guarded data
--    script, each line onto its own person's shifts, outside this file.
--
-- 2. A DOOR THAT STILL DOES IT: the Timecards edit modal's Team Member picker (updateTimeEntry,
--    profile_id). A shift an invoice bills could be handed to someone else: Erik's shift billed on
--    "Labor — Erik Taylor" moved to Brian, and Erik's line then claimed Brian's hours. Only a PAID
--    shift was locked (the payroll lock), and the owner's shifts are never paid through payroll
--    (0286), so every one of Erik's billed shifts could be moved. A job move on a billed shift has
--    been refused since 0288; a person move was not. The app now refuses it in words; this is the
--    boundary under it.
--
-- 3. NOTHING UNDER THE CLAIM SAID WHOSE. guard_invoice_item_claim (0258/0260) judges only an id
--    ANOTHER invoice holds. A line keyed to Erik could take Brian's shift and the database said
--    nothing. The importer builds its lines per person, so it never did; any other writer (a
--    hand-mark door such as 0357's mark_already_billed, a direct PATCH) could.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────────────────────
--
-- A. time_entries_billed_person_stays (BEFORE UPDATE OF profile_id ON time_entries): a shift a
--    non-void invoice claims keeps its person. Void or adjust that invoice first. Same shape, lock
--    and holder rule as 0288's time_entries_billed_job_stays (invoice_holding_claim, 0261).
--
-- B. invoice_items_labor_claim_is_its_persons (BEFORE INSERT OR UPDATE OF source_ids, invoice_id,
--    import_key ON invoice_items): a line keyed `labor:<person>` (or a legacy `labor:<person>:<n>`)
--    takes only that person's time entries. Judged on what the write ADDS, as 0258 judges (an
--    unrelated edit never re-judges what a line already holds); a new line, a line moved to another
--    invoice, or a changed key is judged whole.
--
-- WHAT IT DOES NOT JUDGE, ON PURPOSE: a line typed by hand ("Labor — Erik Taylor", "Labor - Brian")
-- has no key, only words, and words are free text: "Labor - ET Electric hourly with 2 guys" (INV-055)
-- is a crew line that rightly holds both men's hours. Reading a person out of a description in a
-- trigger would refuse honest lines. Hand-typed lines are held by the doors instead (the importer
-- writes keyed lines only; a hand-mark door must check the line's person before it writes).
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────────────────────
--   CREATE OR REPLACE FUNCTION: no table lock. CREATE OR REPLACE TRIGGER (PG 14+; production is 17)
--   on time_entries and invoice_items: SHARE ROW EXCLUSIVE for an instant (writes wait, reads do
--   not). No DROP TRIGGER, which would take ACCESS EXCLUSIVE and stall every read of the table.
--   lock_timeout 3s, statement_timeout 15s: queued behind a long transaction, it gives up instead of
--   stalling the clock or an import. Apply when nobody is mid-import.
--
-- ── ORDER ──────────────────────────────────────────────────────────────────────────────────
--   After 0261 (invoice_holding_claim) and 0288. New functions and new triggers only: it replaces
--   no existing function, so it cannot undo 0357-0360 or be undone by them, in any order. The app
--   side (updateTimeEntry's refusal, the importer's check) works without it.
--
-- ── SAFE TO RE-RUN ─────────────────────────────────────────────────────────────────────────
--   Yes: create or replace throughout, and the checks at the end raise "Nothing was
--   changed." if any part is missing. Writes no data. One transaction (apply-migration.cjs wraps it).
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

-- ── A. A SHIFT AN INVOICE BILLS STAYS WITH ITS PERSON ─────────────────────────────────────────
create or replace function public.guard_billed_time_entry_person()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_holder text;
  v_who    text;
begin
  if new.profile_id is not distinct from old.profile_id then
    return new;
  end if;

  -- The claim lock first (0260's key, the one guard_invoice_item_claim takes before ITS read): a read
  -- alone cannot see a claim an import is committing this instant.
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || coalesce(old.org_id::text, old.id::text)));
  v_holder := public.invoice_holding_claim(array[old.id], old.org_id);
  if v_holder is null then
    return new;
  end if;

  select nullif(btrim(p.full_name), '') into v_who
    from public.profiles p
   where p.id = old.profile_id and p.org_id is not distinct from old.org_id;
  raise exception '% already bills this shift as % hours', v_holder, coalesce(v_who || '''s', 'its person''s')
    using errcode = 'P0001',
          hint = 'Void or adjust ' || v_holder || ' before handing the shift to someone else. Nothing was changed.';
end $$;

revoke execute on function public.guard_billed_time_entry_person() from public, anon;
comment on function public.guard_billed_time_entry_person() is
  'BEFORE UPDATE OF profile_id on time_entries (0361): a shift a non-void invoice claims keeps its person; handed on, that person''s labor line would claim someone else''s hours. Raises "INV-0xx already bills this shift as <name>''s hours".';

create or replace trigger time_entries_billed_person_stays
  before update of profile_id on public.time_entries
  for each row execute function public.guard_billed_time_entry_person();

-- ── B. A LINE KEYED TO A PERSON HOLDS ONLY THAT PERSON'S HOURS ───────────────────────────────
create or replace function public.guard_labor_claim_person()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_person uuid;
  v_added  uuid[];
  v_org    uuid;
  v_who    text;
begin
  if new.import_key is null
     or new.import_key !~ '^labor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9]+)?$' then
    return new;
  end if;
  v_person := substring(new.import_key from 7 for 36)::uuid;

  -- What this write ADDS (0258's rule); a new line, a moved line or a changed key is judged whole.
  if tg_op = 'INSERT' or new.invoice_id is distinct from old.invoice_id or new.import_key is distinct from old.import_key then
    v_added := coalesce(new.source_ids, '{}');
  else
    select coalesce(array_agg(s), '{}') into v_added
      from unnest(coalesce(new.source_ids, '{}')) as s
     where not (s = any (coalesce(old.source_ids, '{}')));
  end if;
  if coalesce(array_length(v_added, 1), 0) = 0 then
    return new;
  end if;

  -- The same lock the claim trigger and 0361 A take: a shift handed to someone else this instant and
  -- this write contend, so the read below sees the person the shift has once both are done.
  select org_id into v_org from public.invoices where id = new.invoice_id;
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || coalesce(v_org::text, new.invoice_id::text)));

  -- The first added shift that is someone else's. Its person is named only inside the company
  -- (0173: never another tenant's name).
  select coalesce(case when te.org_id is not distinct from v_org then nullif(btrim(p.full_name), '') end, 'another person')
    into v_who
    from public.time_entries te
    left join public.profiles p on p.id = te.profile_id
   where te.id = any (v_added)
     and te.profile_id is distinct from v_person
   order by te.clock_in, te.id
   limit 1;
  if not found then
    return new;
  end if;

  raise exception 'Those hours are %''s, so they can''t go on %', v_who, coalesce(nullif(btrim(new.description), ''), 'this labor line')
    using errcode = 'P0001',
          hint = 'A labor line holds only its own person''s hours. Put them on that person''s line. Nothing was changed.';
end $$;

revoke execute on function public.guard_labor_claim_person() from public, anon;
comment on function public.guard_labor_claim_person() is
  'BEFORE INSERT OR UPDATE OF source_ids, invoice_id, import_key on invoice_items (0361): a line keyed labor:<person> may add only that person''s time entries. Hand-typed (unkeyed) lines are not judged: their words are free text.';

create or replace trigger invoice_items_labor_claim_is_its_persons
  before insert or update of source_ids, invoice_id, import_key on public.invoice_items
  for each row execute function public.guard_labor_claim_person();

-- ── CHECKS ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  n int;
begin
  if to_regprocedure('public.guard_billed_time_entry_person()') is null
     or to_regprocedure('public.guard_labor_claim_person()') is null
     or to_regprocedure('public.invoice_holding_claim(uuid[], uuid)') is null then
    raise exception '0361: a function is missing. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'time_entries_billed_person_stays' and tgrelid = 'public.time_entries'::regclass and not tgisinternal)
     or not exists (select 1 from pg_trigger where tgname = 'invoice_items_labor_claim_is_its_persons' and tgrelid = 'public.invoice_items'::regclass and not tgisinternal) then
    raise exception '0361: a trigger is missing. Nothing was changed.';
  end if;
  -- What is already crossed on a KEYED line (the triggers never re-judge it; said, not refused).
  select count(*) into n
    from public.invoice_items ii
    join public.invoices i on i.id = ii.invoice_id and i.status <> 'void'
    cross join lateral unnest(ii.source_ids) as s(id)
    join public.time_entries te on te.id = s.id
   where ii.import_key ~ '^labor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9]+)?$'
     and te.profile_id is distinct from substring(ii.import_key from 7 for 36)::uuid;
  raise notice '0361: a billed shift keeps its person; a keyed labor line takes only its person''s hours. Keyed labor lines already holding another person''s shift: %', n;
end $$;
