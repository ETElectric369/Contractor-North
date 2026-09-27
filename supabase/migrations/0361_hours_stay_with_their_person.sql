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
--    run again (it reads the split table 0290 dropped). Its claims were re-pointed by a guarded data
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
--    direct PATCH, a hand-mark door) could.
--
-- 4. VOID, HAND THE SHIFT ON, UN-VOID. A void invoice's claims are inert (every claims reader skips
--    them, and 2 above lets a shift only a void invoice holds change hands, so a void bill never pins
--    a timecard). Then: void INV-X, give its "Labor — Erik" shift to Brian in Timecards, un-void
--    INV-X, and Erik's line holds Brian's shift. guard_invoice_unvoid (0259/0260) asks only whether
--    ANOTHER live invoice holds the same ids; nothing asked whose they are now.
--
-- 5. ALREADY BILLED ONTO A LINE TYPED BY HAND (0357). mark_already_billed checks a shift's company,
--    job and status, never its person, and 3's key check covers keyed lines only. So Erik's shift
--    could be marked billed on "Labor - Brian" (INV-059), and that line then read as Brian's hours.
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
--    invoice, or a changed key is judged whole. Never on a VOID invoice's line: split_time_entry
--    appends a new piece to every void line holding the parent (0313), and a void claim stays inert
--    until the invoice comes back, where D judges it whole.
--
-- C. invoice_items_hand_hours_are_its_persons (BEFORE INSERT OR UPDATE OF source_ids, hand_claims,
--    invoice_id, import_key ON invoice_items): the shifts a PERSON adds to a line's claim (0357's
--    hand_claims: the Already Billed door, or any write onto a line typed by hand) on a line whose
--    WORDS name exactly one person of the company belong to that person. A crew line ("Labor - ET
--    Electric hourly with 2 guys", INV-055: nobody named, or two people) takes anyone's. Judged on
--    what the write adds; never on a void invoice's line (as B). Keyed lines are B's.
--
-- D. invoices_unvoid_keeps_its_people (BEFORE UPDATE OF status ON invoices): an invoice comes back
--    from void only while every line that names one person (by key, or by its words) holds only that
--    person's shifts. Refused in words: "INV-X's line for Erik Taylor now holds Brian Taylor's 9/11
--    shift ...", with the two ways out that exist (the shift handed back in Timecards, which A
--    allows while only a void invoice holds it; or INV-X left void and a fresh invoice). A void
--    invoice's lines are locked in the app, so "take it off the line" is not offered.
--
-- THE ONE RULE FOR WHOSE A LINE IS: public.labor_line_person(import_key, description, org), the
-- app's laborLinePerson (src/lib/labor-claim-owner.ts) word for word: the person a `labor:<uuid>`
-- key names; else the ONE person of the company whose full name stands in the line's words as a
-- whole word (letters and digits end a word, as \p{L}\p{N} do there), else the one whose first name
-- does; two people, or nobody, is a crew line (null). The company's people are every profile of
-- the org with a name, as the app reads them. The Already Billed sheet asks the same rule, so it
-- never offers a line another person's shifts (lib/already-billed entriesForLine), and the app's
-- Mark refuses them before the database does (already-billed-actions).
--
-- WHY C IS A TRIGGER AND NOT A REWRITE OF mark_already_billed: 0364 (stock says stock, in flight on
-- fix/stock-not-shelf) rewrites mark_already_billed's words and pins its body by md5. A 0361 rewrite
-- would make whichever of the two lands second refuse, or undo the other (the 0320 lesson). The
-- trigger replaces no function: mark_already_billed's own `hand_claims || ids` write fires it, and
-- so does every other writer of a hand claim. 0361 creates functions and triggers only; it rewrites
-- no function another migration owns.
--
-- WHAT IT DOES NOT JUDGE, ON PURPOSE: an importer's claim on a line with no labor key (their words
-- are free text; C judges only what a PERSON added); a line's words changed after the fact (renaming
-- "Labor - Erik" to "Labor - Brian" re-judges nothing: an edit of words is not a claim); the
-- shifts a crew line holds.
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────────────────────
--   CREATE OR REPLACE FUNCTION: no table lock. CREATE OR REPLACE TRIGGER (PG 14+; production is 17)
--   on time_entries, invoice_items and invoices: SHARE ROW EXCLUSIVE for an instant (writes wait,
--   reads do not). No DROP TRIGGER, which would take ACCESS EXCLUSIVE and stall every read of the
--   table. lock_timeout 3s, statement_timeout 15s: queued behind a long transaction, it gives up
--   instead of stalling the clock or an import. Apply when nobody is mid-import.
--
-- ── ORDER ──────────────────────────────────────────────────────────────────────────────────
--   After 0261 (invoice_holding_claim), 0288 (split_org_tz) and 0357 (hand_claims). In any order
--   with 0360 and 0362-0364: it replaces no function they write. The app side (updateTimeEntry's
--   refusal, the importer's check, the Already Billed sheet and Mark) works without it.
--   On production (read 2026-09-27): no keyed line holds another person's shift, and no void
--   invoice's line holds a shift at all, so both counts at the end say 0.
--
-- ── SAFE TO RE-RUN ─────────────────────────────────────────────────────────────────────────
--   Yes: create or replace throughout, and the checks at the end raise "Nothing was changed." if any
--   part is missing or the rule reads a word differently from the app. Writes no data. One
--   transaction (apply-migration.cjs wraps it).
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regprocedure('public.invoice_holding_claim(uuid[], uuid)') is null then
    raise exception '0361: invoice_holding_claim (0261) is not on this database. Nothing was changed.';
  end if;
  if to_regprocedure('public.split_org_tz(uuid)') is null then
    raise exception '0361: split_org_tz (0288) is not on this database. Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'invoice_items' and column_name = 'hand_claims') then
    raise exception '0361: invoice_items.hand_claims (0357) is not on this database. Apply 0357 first. Nothing was changed.';
  end if;
end $$;

-- ── THE RULE: WHOSE A LINE IS (the app's laborLinePerson, lib/labor-claim-owner) ──────────────
-- Does `p_name` stand as a whole word in `p_words`? Letters and digits either side end it, as the
-- app's \p{L}\p{N} do: "erik" is in "labor - erik", not in "labor - eriksen". The name is matched
-- literally (every regex character escaped), both sides already lower-case.
create or replace function public.labor_words_name(p_words text, p_name text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(p_name, '') <> ''
     and coalesce(p_words, '') ~ ('(^|[^[:alnum:]])'
                                   || regexp_replace(p_name, '([.^$*+?(){}|\[\]\\])', '\\\1', 'g')
                                   || '($|[^[:alnum:]])');
$$;

revoke execute on function public.labor_words_name(text, text) from public, anon;
comment on function public.labor_words_name(text, text) is
  'Does p_name stand as a whole word in p_words (letters and digits end a word; the name matched literally)? The word test of labor_line_person (0361), the app''s standsIn.';

-- The person a labor line bills: the one its key names, else the one person of the company its
-- words name (full name first, then first name), else null (a crew line). SECURITY INVOKER: from a
-- trigger it reads as the trigger's owner; from a person's session, RLS shows that person their own
-- company, which is the only one anyone asks about.
create or replace function public.labor_line_person(p_import_key text, p_description text, p_org uuid)
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v_key   text := substring(coalesce(p_import_key, '')
                            from '^labor:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::[0-9]+)?$');
  v_words text := lower(coalesce(p_description, ''));
  v_hits  uuid[];
begin
  if v_key is not null then
    return v_key::uuid;
  end if;
  if p_org is null or btrim(v_words) = '' then
    return null;
  end if;
  -- Full names first: one is the line's person; two is a crew line.
  select coalesce(array_agg(x.id), '{}'::uuid[]) into v_hits
    from (select p.id, lower(regexp_replace(regexp_replace(coalesce(p.full_name, ''), '^\s+|\s+$', '', 'g'), '\s+', ' ', 'g')) as n
            from public.profiles p
           where p.org_id = p_org) x
   where x.n <> ''
     and public.labor_words_name(v_words, x.n);
  if cardinality(v_hits) >= 1 then
    return case when cardinality(v_hits) = 1 then v_hits[1] end;
  end if;
  -- Then first names ("Labor - Brian"): only one person may fit.
  select coalesce(array_agg(x.id), '{}'::uuid[]) into v_hits
    from (select p.id, lower(regexp_replace(regexp_replace(coalesce(p.full_name, ''), '^\s+|\s+$', '', 'g'), '\s+', ' ', 'g')) as n
            from public.profiles p
           where p.org_id = p_org) x
   where x.n <> ''
     and public.labor_words_name(v_words, split_part(x.n, ' ', 1));
  return case when cardinality(v_hits) = 1 then v_hits[1] end;
end $$;

revoke execute on function public.labor_line_person(text, text, uuid) from public, anon;
comment on function public.labor_line_person(text, text, uuid) is
  'Whose hours a labor line bills (0361): the person its labor:<uuid> key names, else the ONE person of the org whose full name (then first name) stands in its words as a whole word, else null (a crew line: nobody, or more than one person). The app''s laborLinePerson (lib/labor-claim-owner), word for word.';

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
  v_status text;
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

  select org_id, status::text into v_org, v_status from public.invoices where id = new.invoice_id;
  -- A VOID INVOICE'S CLAIM IS INERT: split_time_entry appends each new piece to the void lines that
  -- held the shift (0313), whoever it belongs to now. Judged whole when the invoice comes back (D).
  if v_status = 'void' then
    return new;
  end if;

  -- The same lock the claim trigger and 0361 A take: a shift handed to someone else this instant and
  -- this write contend, so the read below sees the person the shift has once both are done.
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
  'BEFORE INSERT OR UPDATE OF source_ids, invoice_id, import_key on invoice_items (0361): a line keyed labor:<person> may add only that person''s time entries (never judged on a void invoice: its claim is inert until it comes back). Lines without a key are guard_hand_claim_person''s.';

create or replace trigger invoice_items_labor_claim_is_its_persons
  before insert or update of source_ids, invoice_id, import_key on public.invoice_items
  for each row execute function public.guard_labor_claim_person();

-- ── C. A SHIFT A PERSON MARKS ON A LINE THAT NAMES ONE PERSON IS THAT PERSON'S ───────────────
-- Named to fire after invoice_items_hand_claims_follow (0357, BEFORE triggers run in name order), so
-- it judges hand_claims as that trigger leaves them: on a line typed by hand, every claim.
create or replace function public.guard_hand_claim_person()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_added  uuid[];
  v_inv    record;
  v_person uuid;
  v_name   text;
  v_hit    record;
begin
  -- A key is B's to judge.
  if coalesce(new.import_key, '') ~ '^labor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9]+)?$' then
    return new;
  end if;

  -- What this write adds to what a person claimed; a new line, a moved line or a changed key whole.
  if tg_op = 'INSERT' or new.invoice_id is distinct from old.invoice_id or new.import_key is distinct from old.import_key then
    v_added := coalesce(new.hand_claims, '{}');
  else
    select coalesce(array_agg(s), '{}') into v_added
      from unnest(coalesce(new.hand_claims, '{}')) as s
     where not (s = any (coalesce(old.hand_claims, '{}')));
  end if;
  if coalesce(array_length(v_added, 1), 0) = 0
     or not exists (select 1 from public.time_entries te where te.id = any (v_added)) then
    return new;
  end if;

  select i.org_id, i.status::text as status, i.invoice_number into v_inv from public.invoices i where i.id = new.invoice_id;
  -- A void invoice's claim is inert (as B); D judges it when the invoice comes back.
  if not found or v_inv.status = 'void' then
    return new;
  end if;

  v_person := public.labor_line_person(new.import_key, new.description, v_inv.org_id);
  if v_person is null then
    return new; -- a crew line: nobody named, or more than one person
  end if;

  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || coalesce(v_inv.org_id::text, new.invoice_id::text)));

  select te.clock_in,
         coalesce(case when te.org_id is not distinct from v_inv.org_id then nullif(btrim(p.full_name), '') end, 'another person') as who
    into v_hit
    from public.time_entries te
    left join public.profiles p on p.id = te.profile_id
   where te.id = any (v_added)
     and te.profile_id is distinct from v_person
   order by te.clock_in, te.id
   limit 1;
  if not found then
    return new;
  end if;

  select nullif(btrim(p.full_name), '') into v_name
    from public.profiles p
   where p.id = v_person and p.org_id is not distinct from v_inv.org_id;
  v_name := coalesce(v_name, 'one person');
  raise exception '"%" on % names %, so it holds only %''s hours, not %''s % shift. Nothing was changed.',
    coalesce(nullif(btrim(new.description), ''), 'This line'), coalesce(v_inv.invoice_number, 'this invoice'),
    v_name, v_name, v_hit.who, to_char(v_hit.clock_in at time zone public.split_org_tz(v_inv.org_id), 'FMMM/FMDD')
    using errcode = 'P0001',
          hint = 'A line that names one person holds that person''s hours. Mark the shift on its own person''s line, or on a crew line that names nobody.';
end $$;

revoke execute on function public.guard_hand_claim_person() from public, anon;
comment on function public.guard_hand_claim_person() is
  'BEFORE INSERT OR UPDATE OF source_ids, hand_claims, invoice_id, import_key on invoice_items (0361): the shifts a person adds to a line''s hand claims (0357: Already Billed, or a line typed by hand) belong to the one person the line''s words name (labor_line_person); a crew line takes anyone''s. Keyed lines are guard_labor_claim_person''s; a void invoice''s lines are judged when it comes back.';

create or replace trigger invoice_items_hand_hours_are_its_persons
  before insert or update of source_ids, hand_claims, invoice_id, import_key on public.invoice_items
  for each row execute function public.guard_hand_claim_person();

-- ── D. AN INVOICE COMES BACK FROM VOID ONLY WITH EACH PERSON'S HOURS ON THEIR OWN LINE ───────
create or replace function public.guard_invoice_unvoid_person()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hit record;
  v_num text;
begin
  if not (old.status = 'void' and new.status <> 'void') then
    return new;
  end if;
  -- The claim lock (0260's key, taken by 0259's un-void guard too): a shift handed on this instant
  -- (0361 A takes the same lock) is either before this read or after the invoice is live again,
  -- where A refuses it.
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || coalesce(new.org_id::text, new.id::text)));

  with held as (
    select li.id, li.sort_order, li.import_key, li.description, te.id as te_id, te.profile_id, te.clock_in, te.org_id as te_org
      from public.invoice_items li
      join public.time_entries te on te.id = any (li.source_ids)
     where li.invoice_id = new.id
  ), judged as (
    select l.id, public.labor_line_person(l.import_key, l.description, new.org_id) as person
      from (select distinct h.id, h.import_key, h.description from held h) l
  )
  select coalesce(nullif(btrim(lp.full_name), ''), 'its person') as line_who,
         coalesce(case when h.te_org is not distinct from new.org_id then nullif(btrim(tp.full_name), '') end, 'another person') as shift_who,
         h.clock_in
    into v_hit
    from held h
    join judged j on j.id = h.id
    left join public.profiles lp on lp.id = j.person and lp.org_id is not distinct from new.org_id
    left join public.profiles tp on tp.id = h.profile_id
   where j.person is not null
     and h.profile_id is distinct from j.person
   order by h.sort_order nulls last, h.id, h.clock_in, h.te_id
   limit 1;
  if not found then
    return new;
  end if;

  v_num := coalesce(new.invoice_number, 'This invoice');
  raise exception '%''s line for % now holds %''s % shift, so % can''t come back from void. Hand the shift back to % in Timecards, or leave % void and bill the work on a fresh invoice. Nothing was changed.',
    v_num, v_hit.line_who, v_hit.shift_who, to_char(v_hit.clock_in at time zone public.split_org_tz(new.org_id), 'FMMM/FMDD'),
    v_num, v_hit.line_who, v_num
    using errcode = 'P0001',
          hint = 'A line that names one person holds only that person''s hours. The shift changed hands while the invoice was void.';
end $$;

revoke execute on function public.guard_invoice_unvoid_person() from public, anon;
comment on function public.guard_invoice_unvoid_person() is
  'BEFORE UPDATE OF status on invoices (0361): a void invoice comes back only while every line that names one person (labor:<uuid> key, or its words: labor_line_person) holds only that person''s shifts. A shift may change hands while only a void invoice holds it (0361 A); un-voiding then would put it on another person''s line.';

create or replace trigger invoices_unvoid_keeps_its_people
  before update of status on public.invoices
  for each row execute function public.guard_invoice_unvoid_person();

-- ── CHECKS ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  n int;
  v int;
begin
  if to_regprocedure('public.guard_billed_time_entry_person()') is null
     or to_regprocedure('public.guard_labor_claim_person()') is null
     or to_regprocedure('public.guard_hand_claim_person()') is null
     or to_regprocedure('public.guard_invoice_unvoid_person()') is null
     or to_regprocedure('public.labor_line_person(text, text, uuid)') is null
     or to_regprocedure('public.labor_words_name(text, text)') is null then
    raise exception '0361: a function is missing. Nothing was changed.';
  end if;
  if exists (
    select 1
      from (values
        ('public.time_entries',  'time_entries_billed_person_stays',         'public.guard_billed_time_entry_person()'),
        ('public.invoice_items', 'invoice_items_labor_claim_is_its_persons', 'public.guard_labor_claim_person()'),
        ('public.invoice_items', 'invoice_items_hand_hours_are_its_persons', 'public.guard_hand_claim_person()'),
        ('public.invoices',      'invoices_unvoid_keeps_its_people',         'public.guard_invoice_unvoid_person()')
      ) as w(tbl, tg, fn)
     where not exists (
       select 1 from pg_trigger t
        where t.tgrelid = w.tbl::regclass
          and t.tgname = w.tg
          and t.tgfoid = w.fn::regprocedure
          and t.tgenabled <> 'D'
          and not t.tgisinternal
          and (t.tgtype & 3) = 3)) then -- row, before
    raise exception '0361: a trigger is missing, disabled, or not a BEFORE row trigger on its function. Nothing was changed.';
  end if;
  -- C must fire after 0357's hand_claims_follow (BEFORE triggers run in name order).
  if not ('invoice_items_hand_claims_follow' < 'invoice_items_hand_hours_are_its_persons') then
    raise exception '0361: invoice_items_hand_hours_are_its_persons would fire before invoice_items_hand_claims_follow. Nothing was changed.';
  end if;
  -- The rule reads words as the app does (lib/labor-claim-owner standsIn and laborLinePerson).
  if not public.labor_words_name('labor - erik', 'erik')
     or public.labor_words_name('labor - eriksen', 'erik')
     or not public.labor_words_name('labor: erik_t', 'erik')
     or public.labor_words_name('labor - rené', 'ren')
     or not public.labor_words_name('labor (c.j.) extra', 'c.j.')
     or public.labor_words_name('labor cxjx', 'c.j.')
     or not public.labor_words_name('crew: o''brien, 6 h', 'o''brien')
     or public.labor_words_name('labor', '')
     or public.labor_line_person('labor:0b8e3e2a-1f00-4c33-9b1a-6f0e5a1d2c3b:2', 'Labor - Anyone', null) is distinct from '0b8e3e2a-1f00-4c33-9b1a-6f0e5a1d2c3b'::uuid
     or public.labor_line_person('labor:unknown', 'Labor', null) is not null
     or public.labor_line_person(null, '', gen_random_uuid()) is not null then
    raise exception '0361: labor_line_person reads a line''s words differently from the app. Nothing was changed.';
  end if;
  -- B and C leave a void invoice's claims inert.
  if (select prosrc from pg_proc where oid = 'public.guard_labor_claim_person()'::regprocedure) not like '%v_status = ''void''%'
     or (select prosrc from pg_proc where oid = 'public.guard_hand_claim_person()'::regprocedure) not like '%v_inv.status = ''void''%' then
    raise exception '0361: a claim trigger judges void invoices. Nothing was changed.';
  end if;

  -- SAID, NOT REFUSED: what is already crossed. A keyed line on a live invoice (B never re-judges it)...
  select count(*) into n
    from public.invoice_items ii
    join public.invoices i on i.id = ii.invoice_id and i.status <> 'void'
    cross join lateral unnest(ii.source_ids) as s(id)
    join public.time_entries te on te.id = s.id
   where ii.import_key ~ '^labor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9]+)?$'
     and te.profile_id is distinct from substring(ii.import_key from 7 for 36)::uuid;
  -- ...and void invoices D would keep void (a line that names one person holding another's shift).
  select count(distinct i.id) into v
    from public.invoices i
    join public.invoice_items li on li.invoice_id = i.id
    join public.time_entries te on te.id = any (li.source_ids)
   where i.status = 'void'
     and public.labor_line_person(li.import_key, li.description, i.org_id) is not null
     and te.profile_id is distinct from public.labor_line_person(li.import_key, li.description, i.org_id);
  raise notice '0361: a billed shift keeps its person; a line keyed to a person, or a line whose words name one person, takes only that person''s hours; a void invoice comes back only with each person''s hours on their own line. Keyed labor lines already holding another person''s shift: %. Void invoices that could not come back as they stand: %.', n, v;
end $$;
