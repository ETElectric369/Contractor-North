-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0409: born from an estimate
--
-- The owner, 2026-11-10, on the page of a job made from an accepted estimate: "i like how the new
-- estimate tasks carry though to the items to buy and created a task to be done but the scope
-- remains empty when that can be filled from the estimate description all the way through we
-- already have the information right?"
--
-- WHY. Two papers are born from an estimate, and each lost something the estimate already held.
--
--   THE JOB LOST THE SCOPE. An estimate's description is the scope paragraph its paper prints. A
--   job's Description is the scope the crew reads, and an invoice made from the job starts with it
--   above its lines. Neither door that makes a job from an accepted estimate copied one to the
--   other: not the office's (createJobFromQuote, which this release changes in the app) and not the
--   customer's own Accept (accept_public_quote, in SQL, here). The job opened with an empty
--   Description and the same paragraph was typed a second time.
--
--   THE BILL LOST THE PLACE. An invoice owns no address. Its public document
--   (invoice_document_projection) offered ONE site candidate, the invoice's job. A bill made
--   straight from an estimate that never became a job has no job, so it fell to the customer's own
--   address while the estimate it came from printed the building the work is in: the estimate's
--   own site (0177 / 0187; written by a person since cn-v1158) or its lead's. Skeptic #61 carried
--   that out of cn-v1158 for "a migration with its own database proof". This is that migration.
--
-- WHAT, three things and nothing else:
--
--  1. public.accept_public_quote(text): A JOB BORN FROM AN ESTIMATE TAKES ITS SCOPE. The body is
--     0396's (the last migration that made it), every statement, with these additions and no others:
--       a. THE SCOPE IS WORKED OUT ONCE: the estimate's description with the blank space at its
--          ends removed, and nothing when that leaves nothing:
--          nullif(btrim(q.description, E' \t\n\r'), '').
--       b. THE JOB IT MAKES IS BORN WITH IT: one more column on the insert, the job's Description.
--       c. A JOB THAT WAS ALREADY THERE takes it ONLY WHERE ITS OWN DESCRIPTION IS EMPTY: the
--          estimate was written on a job; a revision was pinned to its original's job (0392); or
--          the office's door linked its own job first (0396). Words a person typed on a job are
--          never replaced, so a second estimate accepted onto a job changes nothing once the job
--          has a scope.
--     0392's guarded flip and revision pin, and 0396's customer address and compare-and-set link,
--     stand as they were. Same signature, same security, same search path; CREATE OR REPLACE keeps
--     the owner and the grants, and the self-check compares both with what they were. If you
--     re-create this function, copy THIS body.
--
--  2. public.invoice_document_projection(uuid): A BILL MADE STRAIGHT FROM AN ESTIMATE KNOWS ITS
--     PLACE. site_candidates becomes, in order: the invoice's job (as before, not touched), the
--     SOURCE ESTIMATE's own five address columns (source 'quote'), that estimate's LEAD's five
--     (source 'lead'), each read in the invoice's own company. The customer is not in the list: the
--     projection carries the customer beside it and the reader appends it last. A record that is
--     not there is a null in the list, which the readers already skip (lib/site-address pickSite).
--     THIS FUNCTION CANNOT BE RE-CREATED FROM A FILE: its live body is 0301's with two patches made
--     in place (0315 the customer's words, 0342 line_kind). So it is patched the same way. The live
--     definition is read (pg_get_functiondef); ONE fragment, the last line of the job candidate,
--     must appear exactly once, inside the site list, or this raises and changes nothing; that
--     fragment is replaced and nothing else in the function can be reverted by this file. Then
--     every invoice on the database is read again: every key but site_candidates must read as it
--     did before, and the first entry of site_candidates must be the one it was. public_invoice is
--     a wrapper over the projection and is not rebuilt.
--
--  3. THE ONE-TIME BACKFILL: the forward rule applied backward, for every company. Every job whose
--     Description is empty and that has an ACCEPTED estimate with a description takes it: the
--     earliest accepted one, in the job's own company, trimmed the same way. A job with words keeps
--     them. How many jobs were filled is RAISEd as a NOTICE.
--
-- WHAT COUNTS AS BLANK, spelled out because both ends must agree to the character: a space, a tab, a
-- line feed and a carriage return, and only those. In SQL that is btrim(x, E' \t\n\r'), everywhere
-- in this file; in the app it is scopeText (src/lib/estimate/job-scope.ts). Never JavaScript's
-- trim(), which also strips a no-break space and twenty more, and never a bare btrim(x), which
-- strips the space alone.
--
-- THE TWINS, named the day they are added: scopeForJob and jobTakesScope
-- (src/lib/estimate/job-scope.ts) for the scope and for "only where it is empty";
-- bornFromEstimateCandidates (src/lib/quote-site.ts) for the order of the site list. The database
-- suite src/lib/born-from-estimate.integration.test.ts holds each pair to one answer.
--
-- THE READERS, named the day they are added: site_candidates is read by the customer's invoice page
-- for its title (src/app/i/[token]/page.tsx, through lib/doc-place projectionPlace, which already
-- walks the whole list and then the customer). A job's Description is read by the job's own page,
-- by the schedule's box when the job has no Notes (lib/schedule/block-extras), by the calendar event
-- (lib/gcal-map) and by an invoice made from the job (createInvoiceForJob starts a blank one with it).
--
-- WHAT THE BACKFILL SETS OFF, read from every trigger the migrations put on public.jobs:
--   touch_jobs (0001, BEFORE UPDATE)                would stamp updated_at = now() on every job it
--                                                   fills, so it is SWITCHED OFF for the backfill's
--                                                   one statement (below) and on again after it.
--   jobs_hold_day (0366, BEFORE INSERT OR UPDATE)   changes nothing on a job that is on hold (with
--                                                   nobody signed in it leaves the day, the reason
--                                                   and the holder alone). On a job that is NOT on
--                                                   hold it clears the three hold columns, which are
--                                                   empty there already unless the row was last
--                                                   written before 0366: then a reason left over from
--                                                   an old hold goes, as on any other write to it.
--   jobs_unstamp_invoice_pdfs (0349) and jobs_geo_follows_address (0404) fire on an update OF the
--   billing type or the address: a Description alone does not fire them.
-- No trigger on jobs writes an activity row, rings a bell, sends a message or pushes a calendar.
-- WHY THE STAMP IS SWITCHED OFF: it is READ. A COMPLETE job with no real invoice is on Needs You
-- under Done, Not Billed for thirty days from its updated_at (needs_you_done_not_billed, 0371 /
-- 0403), so a finished, never-billed job this filled would come back onto that list as if it had
-- finished today; Timecards offers a complete job touched in the last thirty days; a job on hold
-- with no day set counts its age on Needs You from its last touch; the Google Calendar sync's sweep
-- pushes every job touched since its last run (lib/calendar-sync); and lists ordered by updated_at
-- would show the filled jobs first. A one-time fill is not an edit anybody made today, so, by 0298's
-- own method (it switched touch_customers off around its one-time update), touch_jobs is disabled
-- immediately before the backfill and enabled immediately after it, inside this file's one
-- transaction. The ground check finds it ENABLED before anything changes, and the self-check finds
-- it ENABLED again (pg_trigger.tgenabled = 'O'): a missed enable would stop updated_at on jobs for
-- good, without a word.
--
-- KNOWN AND SAID. The backfill reads estimates whose status is accepted. An original that was
-- accepted and then superseded by an accepted revision (0391) is not read: the revision is, because
-- it is the estimate that stands. And NO STORED PDF IS RETIRED HERE: 0349 un-stamps a bill's stored
-- copy when its JOB's address changes, and nothing un-stamps one when its estimate's own site or
-- that estimate's lead's address changes. A copy rendered before this release keeps the place it
-- was rendered with until the office opens the bill again. Carried, for the app's side to answer.
--
-- ORDER. BEFORE the deploy, as every migration goes; it is safe either way. Applied first: a
-- customer's Accept starts filling the scope at once; the jobs the backfill fills show their
-- Description at once, their updated_at as it was (above); the customer's invoice page
-- takes its title from the estimate's place for a bill with no job (the deployed reader already
-- walks the whole list); nothing else a person sees moves until the deploy changes the office's
-- own papers.
--
-- LOCKS. No column, constraint or policy is altered. The two functions are replaced (catalog rows
-- only). Switching touch_jobs off is an ALTER TABLE on public.jobs: it takes a lock on the table
-- that blocks every write to jobs until the commit, which is why it comes as LATE as it can, after
-- the invoice proof, immediately before the backfill. The backfill takes a row lock on each job it
-- fills, held until the commit. lock_timeout 3s: a job somebody is
-- saving at that moment fails this fast and changes nothing; run it again. statement_timeout 15s:
-- the before-and-after read of every invoice has to fit inside it. ONE TRANSACTION: the runners
-- wrap the file, and this file leans on that (what the ground check notes is read back by the
-- blocks after it, and the first of them refuses before anything is changed if it did not arrive).
-- Twice-safe: a second run finds its own accept_public_quote and its own site list, replaces the
-- first with the same text, leaves the second alone, finds no empty job to fill and passes the same
-- self-check. Run again AFTER a later migration has re-made accept_public_quote, it refuses at the
-- ground it checks; after one has changed the site list, it refuses at the patch; a later change
-- anywhere else in the projection it leaves exactly as it finds it. It never puts its own text
-- back over a newer one.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

-- ── The ground it stands on ─────────────────────────────────────────────────────────────────────
do $$
declare
  r     record;
  v_src text;
begin
  for r in select t.tbl from (values ('jobs'), ('quotes'), ('invoices'), ('inquiries'), ('customers'), ('organizations')) as t(tbl) loop
    if to_regclass('public.' || r.tbl) is null then
      raise exception '0409: public.% is not on this database. Nothing was changed.', r.tbl;
    end if;
  end loop;
  if (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception '0409: the roles anon, authenticated and service_role are not all on this database. Nothing was changed.';
  end if;

  -- EVERY COLUMN THIS FILE READS OR WRITES, with the migration that added it. Verified against the
  -- migration files themselves by tests/migration-0409.test.ts, so "born in" is never a guess.
  for r in
    select * from (values
      ('jobs',      'description', 'text',                     '0001'),
      ('jobs',      'org_id',      'uuid',                     '0004'),
      ('quotes',    'description', 'text',                     '0120'),
      ('quotes',    'accepted_at', 'timestamp with time zone', '0014'),
      ('quotes',    'created_at',  'timestamp with time zone', '0001'),
      ('quotes',    'job_id',      'uuid',                     '0001'),
      ('quotes',    'inquiry_id',  'uuid',                     '0109'),
      ('quotes',    'org_id',      'uuid',                     '0004'),
      ('quotes',    'address',     'text',                     '0177'),
      ('quotes',    'unit',        'text',                     '0187'),
      ('quotes',    'city',        'text',                     '0177'),
      ('quotes',    'state',       'text',                     '0177'),
      ('quotes',    'zip',         'text',                     '0177'),
      ('invoices',  'quote_id',    'uuid',                     '0003'),
      ('invoices',  'org_id',      'uuid',                     '0004'),
      ('inquiries', 'address',     'text',                     '0034'),
      ('inquiries', 'unit',        'text',                     '0187'),
      ('inquiries', 'city',        'text',                     '0034'),
      ('inquiries', 'state',       'text',                     '0034'),
      ('inquiries', 'zip',         'text',                     '0034'),
      ('inquiries', 'org_id',      'uuid',                     '0034')
    ) as t(tbl, col, kind, born)
  loop
    if not exists (
      select 1 from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col and c.data_type = r.kind
    ) then
      raise exception '0409: %.% (%, added by %) is missing. Apply % first. Nothing was changed.', r.tbl, r.col, r.kind, r.born, r.born;
    end if;
  end loop;

  -- THE STAMP ON JOBS, switched off around the backfill and on again after it: it must be there and
  -- ENABLED now, or the enable at the end would turn on a trigger somebody had switched off.
  if not exists (select 1 from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'touch_jobs' and not tgisinternal) then
    raise exception '0409: the trigger touch_jobs (0001) is not on public.jobs on this database. Nothing was changed.';
  end if;
  if (select tgenabled from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'touch_jobs' and not tgisinternal) <> 'O' then
    raise exception '0409: the trigger touch_jobs on public.jobs is not enabled on this database (somebody switched it off; read why before this runs). Nothing was changed.';
  end if;

  -- THE FUNCTION THIS FILE REPLACES IS THE ONE IT WAS WRITTEN FROM. A function rebuilt from the
  -- migration that made it silently undoes whatever was changed since (0377's lesson), so the live
  -- body is read first: its statements, with comments and spacing taken out, must be 0396's (the
  -- first md5) or, on a second run, exactly this file's own (the second). Anything else is refused
  -- and never overwritten: a body changed by hand, or one a LATER migration made when this file is
  -- run again out of order. tests/migration-0409.test.ts recomputes both md5s from the two files.
  if to_regprocedure('public.accept_public_quote(text)') is null then
    raise exception '0409: public.accept_public_quote(text) is not on this database (0014; last made by 0396). Nothing was changed.';
  end if;
  select p.prosrc into v_src from pg_proc p where p.oid = 'public.accept_public_quote(text)'::regprocedure;
  if coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '')
       not in ('dd99a09340ab12e483379d9d3d610e5c', '883480080186365bab3f9607c236bdaa') then
    raise exception '0409: accept_public_quote on this database is not the body 0396 left, nor this file''s own: it was changed outside this repository''s migrations, or by a later migration (then this file must not run again), or 0396 was applied from another text. Read it (select pg_get_functiondef(''public.accept_public_quote(text)''::regprocedure)) and reconcile the two before this runs. Nothing was changed.';
  end if;
  if not has_function_privilege('anon', 'public.accept_public_quote(text)', 'execute')
     or not has_function_privilege('authenticated', 'public.accept_public_quote(text)', 'execute') then
    raise exception '0409: the customer''s link cannot call accept_public_quote on this database (0014, 0066 and 0119 granted it to anon and authenticated). Nothing was changed.';
  end if;

  -- THE PROJECTION AND ITS DOOR, as 0301 left their grants: the projection takes an id, so nobody
  -- outside the database calls it; public_invoice is the token door in front of it.
  if to_regprocedure('public.invoice_document_projection(uuid)') is null
     or to_regprocedure('public.public_invoice(text)') is null then
    raise exception '0409: invoice_document_projection and public_invoice (0301) are not both on this database. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public.invoice_document_projection(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.invoice_document_projection(uuid)', 'execute') then
    raise exception '0409: invoice_document_projection is callable without the service role on this database (0301 revoked it from anon and authenticated). Nothing was changed.';
  end if;
  if not has_function_privilege('service_role', 'public.invoice_document_projection(uuid)', 'execute')
     or not has_function_privilege('anon', 'public.public_invoice(text)', 'execute') then
    raise exception '0409: the service role cannot read invoice_document_projection, or the customer''s link cannot call public_invoice, on this database (0301 left both able to). Nothing was changed.';
  end if;

  -- Who owns each function and who may call it, as they stand, for the self-check to compare once
  -- both have been replaced.
  perform set_config(
    'cn.m0409_accept_was',
    (select 'was:' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '') from pg_proc p where p.oid = 'public.accept_public_quote(text)'::regprocedure),
    true);
  perform set_config(
    'cn.m0409_projection_was',
    (select 'was:' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '') from pg_proc p where p.oid = 'public.invoice_document_projection(uuid)'::regprocedure),
    true);
end $$;

-- ── Every invoice document as it reads today ────────────────────────────────────────────────────
-- The proof's helper: a document with site_candidates taken out. Arrays are compared as sets of
-- their entries (sorted by their text), as 0342's helper compared them: two lines that share a
-- sort_order, or two payments that share a paid_at, come back from json_agg in either order from
-- one read to the next, and this file changes no ORDER BY, so order is not what the proof checks.
-- (The order of site_candidates itself IS checked, separately, below.) It lives in the session's
-- own temporary schema and is dropped at the end of this file.
create or replace function pg_temp._0409_rest(j jsonb) returns jsonb
language plpgsql immutable as $$
begin
  if j is null then
    return null;
  elsif jsonb_typeof(j) = 'object' then
    return coalesce((select jsonb_object_agg(k, pg_temp._0409_rest(v)) from jsonb_each(j) e(k, v) where k <> 'site_candidates'), '{}'::jsonb);
  elsif jsonb_typeof(j) = 'array' then
    return coalesce((select jsonb_agg(s order by s::text) from (select pg_temp._0409_rest(v) as s from jsonb_array_elements(j) a(v)) x), '[]'::jsonb);
  end if;
  return j;
end $$;

drop table if exists pg_temp._0409_before;
create temp table _0409_before as
select i.id, public.invoice_document_projection(i.id)::jsonb as j
  from public.invoices i;

-- ── 2. A bill made straight from an estimate knows its place ────────────────────────────────────
-- (Before the function in 1, so the read of every invoice above and the read again below stand as
-- close together as they can: an invoice somebody saves in between fails the proof, and the cure
-- for that is to run this again.)
--
-- THE COLUMNS THE TWO NEW CANDIDATES READ, and the migration that added each: invoices.quote_id
-- (0003, the table's own), quotes.inquiry_id (0109), quotes.address / city / state / zip (0177) and
-- quotes.unit (0187), inquiries.address / city / state / zip (0034, the table's own) and
-- inquiries.unit (0187); org_id on invoices and quotes (0004) and on inquiries (0034). The ground
-- check above found every one of them.
do $$
declare
  v_def  text;
  v_old  text := $old$from public.jobs j where j.id = i.job_id and j.org_id = i.org_id)),$old$;
  v_new  text := $new$from public.jobs j where j.id = i.job_id and j.org_id = i.org_id),
      -- 0409: NOT ONE CANDIDATE ANY MORE. A bill made straight from an estimate has no job, so after
      -- its job the list offers the place its ESTIMATE prints, in the estimate's own order: the
      -- estimate's own site (0177 / 0187), then its lead's (0034 / 0187), each read in the
      -- invoice's own company. The customer is not in this list: it rides beside it and the reader
      -- appends it last. A record that is not there is a null here, which pickSite skips. The
      -- app's twin is bornFromEstimateCandidates (src/lib/quote-site.ts): keep the two in one order.
      (select json_build_object('source', 'quote', 'parts', json_build_object(
        'address', q.address, 'unit', q.unit, 'city', q.city, 'state', q.state, 'zip', q.zip))
        from public.quotes q where q.id = i.quote_id and q.org_id = i.org_id),
      (select json_build_object('source', 'lead', 'parts', json_build_object(
        'address', inq.address, 'unit', inq.unit, 'city', inq.city, 'state', inq.state, 'zip', inq.zip))
        from public.quotes q
        join public.inquiries inq on inq.id = q.inquiry_id and inq.org_id = q.org_id
       where q.id = i.quote_id and q.org_id = i.org_id)),$new$;
  v_olds int;
  v_news int;
  v_list int;
  v_at   int;
  v_head text;
begin
  -- ONE TRANSACTION, CHECKED BEFORE ANYTHING IS CHANGED: what the ground check noted has to have
  -- reached this block. Run statement by statement it would not have.
  if coalesce(left(current_setting('cn.m0409_projection_was', true), 4), '') <> 'was:' then
    raise exception '0409: this file has to run in ONE transaction (the runners wrap it in begin and commit): what the ground check noted did not reach the next block. Run it through the migration runner. Nothing was changed.';
  end if;

  v_def  := pg_get_functiondef('public.invoice_document_projection(uuid)'::regprocedure);
  v_olds := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  v_news := (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new);

  -- A second run: the list is already this file's. Nothing to patch.
  if v_news = 1 and v_olds = 0 then
    return;
  end if;

  -- A first run: the fragment exactly once, inside the one site list, after its job candidate, and
  -- no estimate or lead candidate there yet. Anything else is not the ground this was written on.
  v_list := position('''site_candidates'', json_build_array(' in v_def);
  v_at   := position(v_old in v_def);
  -- What stands between the head of the site list and the fragment: the job candidate, or nothing
  -- when the fragment is not inside the list at all.
  v_head := case when v_list > 0 and v_at > v_list then substr(v_def, v_list, v_at - v_list) else '' end;
  if v_olds <> 1 or v_news <> 0
     or (length(v_def) - length(replace(v_def, '''site_candidates''', ''))) / length('''site_candidates''') <> 1
     or position('''source'', ''job''' in v_head) = 0
     or position('''source'', ''quote''' in v_def) > 0
     or position('''source'', ''lead''' in v_def) > 0 then
    raise exception '0409: invoice_document_projection''s site list is not the one 0301 wrote (its job candidate''s last line appears % time(s), this file''s own list % time(s)): someone changed it since 0342, or a later migration did (then this file must not run again). Read it (select pg_get_functiondef(''public.invoice_document_projection(uuid)''::regprocedure)) before this runs. Nothing was changed.', v_olds, v_news;
  end if;
  execute replace(v_def, v_old, v_new);

  -- Read back: this file's list once, the old tail gone, and the two earlier patches still there.
  v_def  := pg_get_functiondef('public.invoice_document_projection(uuid)'::regprocedure);
  v_olds := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  v_news := (length(v_def) - length(replace(v_def, v_new, ''))) / length(v_new);
  if v_news <> 1 or v_olds <> 0 then
    raise exception '0409: invoice_document_projection does not read back with this file''s site list (found % time(s); the old tail % time(s)). Nothing was changed.', v_news, v_olds;
  end if;
  if position('customer_line_words' in v_def) = 0 or position('it.line_kind' in v_def) = 0 then
    raise exception '0409: the rewrite of invoice_document_projection lost an earlier patch (0315 the customer''s words, 0342 line_kind). Nothing was changed.';
  end if;
end $$;

-- THE PROOF, as 0342 gave it: every invoice on the database is read again and held against what it
-- read before the patch.
do $$
declare
  v_all    int;
  v_gone   int;
  v_rest   int;
  v_first  int;
  v_shape  int;
  v_placed int;
begin
  select count(*),
         count(*) filter (where a.j is null),
         count(*) filter (where a.j is not null and pg_temp._0409_rest(b.j) is distinct from pg_temp._0409_rest(a.j)),
         count(*) filter (where a.j is not null and (b.j -> 'site_candidates' -> 0) is distinct from (a.j -> 'site_candidates' -> 0)),
         count(*) filter (where a.j is not null and not coalesce(
           case when jsonb_typeof(a.j -> 'site_candidates') = 'array'
                then jsonb_array_length(a.j -> 'site_candidates') = 3
                 and (a.j -> 'site_candidates' -> 0 = 'null'::jsonb or a.j -> 'site_candidates' -> 0 ->> 'source' = 'job')
                 and (a.j -> 'site_candidates' -> 1 = 'null'::jsonb or a.j -> 'site_candidates' -> 1 ->> 'source' = 'quote')
                 and (a.j -> 'site_candidates' -> 2 = 'null'::jsonb or a.j -> 'site_candidates' -> 2 ->> 'source' = 'lead')
                else false end, false)),
         count(*) filter (where coalesce(a.j -> 'site_candidates' -> 0 -> 'parts' ->> 'address', '') = ''
                            and (coalesce(a.j -> 'site_candidates' -> 1 -> 'parts' ->> 'address', '') <> ''
                              or coalesce(a.j -> 'site_candidates' -> 2 -> 'parts' ->> 'address', '') <> ''))
    into v_all, v_gone, v_rest, v_first, v_shape, v_placed
    from pg_temp._0409_before b
   cross join lateral (select public.invoice_document_projection(b.id)::jsonb as j) a;

  if v_gone > 0 then
    raise exception '0409: % invoice(s) read before the patch are not there to read after it: somebody removed one while this ran. Run it again. Nothing was changed.', v_gone;
  end if;
  if v_rest > 0 then
    raise exception '0409: % invoice document(s) would read differently outside their site list (if somebody was saving an invoice at that moment, run it again). Nothing was changed.', v_rest;
  end if;
  if v_first > 0 then
    raise exception '0409: on % invoice document(s) the first site candidate, the invoice''s job, is not the one it was. Nothing was changed.', v_first;
  end if;
  if v_shape > 0 then
    raise exception '0409: on % invoice document(s) the site list is not three entries in order: the job, the estimate, the estimate''s lead (each a null when there is none). Nothing was changed.', v_shape;
  end if;
  raise notice '0409: % invoice document(s) read before and after: nothing moved but the site list. % of them (no address on a job) now carry the address of the estimate they were made from, or of its lead.', v_all, v_placed;
end $$;

-- ── 1. A job born from an estimate takes its scope ──────────────────────────────────────────────
create or replace function public.accept_public_quote(p_token text)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  q public.quotes;
  inq public.inquiries;
  cust_id uuid;
  new_job uuid;
  inq_phone text;
  inq_email text;
  inq_name text;
  site_address text; site_unit text; site_city text; site_state text; site_zip text;
  cust public.customers;   -- 0369: who, for the job's name
  org_tz text;             -- 0369: the company's today, for "New Job · Sep 27"
  scope_for_job text;      -- 0409: what the job takes from the estimate's description
begin
  select * into q from public.quotes where public_token = p_token;
  if q.id is null then
    return json_build_object('ok', false, 'error', 'Quote not found.');
  end if;

  if q.status = 'accepted' then
    return json_build_object('ok', true);
  end if;

  if q.status <> 'sent' then
    return json_build_object('ok', false, 'error', 'This quote is no longer available to accept.');
  end if;

  -- 0392: the flip is guarded on the status just read — a supersede or another Accept that landed
  -- between the read and this write is not overwritten; the row is read again and answered as it is.
  update public.quotes set status = 'accepted', accepted_at = now() where id = q.id and status = 'sent';
  if not found then
    select * into q from public.quotes where id = q.id;
    if q.status = 'accepted' then
      return json_build_object('ok', true);
    end if;
    return json_build_object('ok', false, 'error', 'This quote is no longer available to accept.');
  end if;

  -- THE LEAD IS LOADED WHATEVER HAPPENS NEXT. It carries the site address, and a repeat customer
  -- (q.customer_id already set) skips the contact branch below without ever needing it — which is
  -- how the job lost its address for exactly the customers who had bought before.
  if q.inquiry_id is not null then
    select * into inq from public.inquiries where id = q.inquiry_id;
  end if;

  -- Deferred-customer estimate → born a Contact now. Crosscheck the book first (same phone / email /
  -- normalized name → link the existing customer, never duplicate), else auto-fill from the inquiry.
  if q.customer_id is null and inq.id is not null then
    inq_phone := regexp_replace(coalesce(inq.phone, ''), '\D', '', 'g');
    inq_email := btrim(lower(coalesce(inq.email, '')));
    inq_name  := regexp_replace(lower(coalesce(inq.name, '')), '[^a-z0-9]', '', 'g');

    select c.id into cust_id
    from public.customers c
    where c.org_id = q.org_id
      and (
        (length(inq_phone) >= 7
          and right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10) = right(inq_phone, 10))
        or (inq_email <> '' and btrim(lower(coalesce(c.email, ''))) = inq_email)
        or (inq_name <> '' and regexp_replace(lower(coalesce(c.name, '')), '[^a-z0-9]', '', 'g') = inq_name)
      )
    order by c.created_at asc
    limit 1;

    if cust_id is null then
      insert into public.customers (org_id, name, company_name, type, status, email, phone,
                                    address, unit, city, state, zip, notes, created_by)
      values (q.org_id, inq.name, inq.company_name,
              (coalesce(inq.type, 'residential'))::customer_type, 'active'::customer_status,
              inq.email, inq.phone,
              -- WHERE THE PERSON IS, all-or-nothing — the SQL twin of customerAddressFrom.
              case when inq.contact_address is not null then inq.contact_address else inq.address end,
              case when inq.contact_address is not null then inq.contact_unit  else inq.unit  end,
              case when inq.contact_address is not null then inq.contact_city  else inq.city  end,
              case when inq.contact_address is not null then inq.contact_state else inq.state end,
              case when inq.contact_address is not null then inq.contact_zip   else inq.zip   end,
              case when coalesce(inq.message, '') <> '' then 'From inquiry: ' || inq.message else inq.notes end,
              q.created_by)
      returning id into cust_id;
    end if;

    update public.quotes set customer_id = cust_id where id = q.id;
    update public.inquiries
      set customer_id = cust_id, status = 'won',
          converted_at = coalesce(converted_at, now()), updated_at = now()
      where id = q.inquiry_id;
    q.customer_id := cust_id; -- so the job below links the Contact
  end if;

  -- A REVISION TAKES THE ORIGINAL'S JOB (0391/0392; the SQL twin of createJobFromQuote's pin): born
  -- while the original was only sent (no job yet), a revision accepted through its own link would make
  -- a SECOND job when the original had been accepted in between. The work is one job: the revision is
  -- pinned to it (only while its own job_id is still null, the company's own row) and no job is born.
  if q.job_id is null and q.revises_quote_id is not null then
    select o.job_id into new_job from public.quotes o where o.id = q.revises_quote_id and o.org_id = q.org_id;
    if new_job is not null then
      update public.quotes set job_id = new_job where id = q.id and job_id is null;
      if found then
        q.job_id := new_job;
      else
        -- the office pinned or made a job in between: read it, so no second job is born below
        select job_id into q.job_id from public.quotes where id = q.id;
      end if;
      new_job := null;
    end if;
  end if;

  -- 0409: THE SCOPE THE JOB TAKES (the SQL twin of scopeForJob, src/lib/estimate/job-scope.ts): the
  -- estimate's description with the blank space at its ends removed, and nothing when that leaves
  -- nothing. Blank is a space, a tab, a line feed and a carriage return, and only those: the app's
  -- twin strips exactly these four, so neither JavaScript's trim() nor a bare btrim() will do here.
  scope_for_job := nullif(btrim(q.description, E' \t\n\r'), '');

  if q.job_id is null then
    -- 0396: the customer is read FIRST — the site address below falls through to theirs, as the
    -- office door does, and the name still reads it as before.
    if q.customer_id is not null then
      select * into cust from public.customers where id = q.customer_id and org_id = q.org_id;
    end if;

    -- WHERE THE WORK IS. One whole record wins: the quote if it has a street, else the lead, else
    -- (0396) the customer's address on file — the office door's own order (createJobFromQuote).
    -- Left null when none has one, so pickSite falls through to the customer exactly as before.
    if coalesce(q.address, '') <> '' then
      site_address := q.address; site_unit := q.unit; site_city := q.city; site_state := q.state; site_zip := q.zip;
    elsif coalesce(inq.address, '') <> '' then
      site_address := inq.address; site_unit := inq.unit; site_city := inq.city; site_state := inq.state; site_zip := inq.zip;
    elsif cust.id is not null and coalesce(cust.address, '') <> '' then
      site_address := cust.address; site_unit := cust.unit; site_city := cust.city; site_state := cust.state; site_zip := cust.zip;
    end if;

    -- THE NAME IS THE STREET, NEVER WHERE IT CAME FROM (0369; Erik 2026-09-28, "street number and
    -- name as always"): the street number and name (the site above, else the customer's own, as the
    -- staff path's createJobFromQuote reads it) and " #<unit>" with that street's unit; with no
    -- street, the customer as written · the estimate's own words with any source tag taken off
    -- ("Estimate — Rita Moss" is the tag and the person: no words; the lead door's "New deck — Rita
    -- Moss" is "New deck", and the lead's own spelling, inq.name, counts as the person too); else
    -- "New Job · Sep 27" on the company's today. Was: the title, else 'Job from ' || quote_number.
    select o.settings->>'timezone' into org_tz from public.organizations o where o.id = q.org_id;
    if org_tz is null or not exists (select 1 from pg_timezone_names where name = org_tz) then
      org_tz := 'America/Los_Angeles';
    end if;

    insert into public.jobs (org_id, customer_id, inquiry_id, name, status,
                             address, unit, city, state, zip, description, created_by)
    values (q.org_id, q.customer_id, q.inquiry_id,
            public.job_name_from(null, q.title, cust.name, cust.company_name, cust.type::text,
                                 coalesce(nullif(site_address, ''), cust.address),
                                 case when coalesce(site_address, '') <> '' then site_unit else cust.unit end,
                                 inq.name,
                                 (now() at time zone org_tz)::date),
            'to_be_scheduled',
            site_address, site_unit, site_city, site_state, site_zip,
            -- 0409: born with the estimate's scope as its Description (null when the estimate has none)
            scope_for_job,
            q.created_by)
    returning id into new_job;
    -- 0396: THE LINK IS COMPARE-AND-SET, as the office door's is (createJobFromQuote, cn-v1133). Two
    -- doors in the same second — the office's Accept and this one — each read "no job yet" and each
    -- made a job; this write, unguarded, then pointed the estimate at the second job and orphaned the
    -- first with its tasks. The link lands only while job_id is still null; when it does not, the
    -- other door's job IS the job: it is read back, and the job just made here (nothing on it yet,
    -- the company's own row) is removed. The answer is the same either way: accepted.
    update public.quotes set job_id = new_job where id = q.id and job_id is null;
    if not found then
      select job_id into q.job_id from public.quotes where id = q.id;
      delete from public.jobs where id = new_job and org_id = q.org_id;
    end if;
  end if;

  -- 0409: A JOB THAT WAS ALREADY THERE TAKES THE SCOPE ONLY WHERE ITS OWN DESCRIPTION IS EMPTY (the
  -- SQL twin of jobTakesScope). q.job_id is set here in three cases, and in none of them did this
  -- call make the job: the estimate was already on a job when it was accepted; a revision was pinned
  -- to its original's job above (0392); or the office's door linked its own job first and the one
  -- made here was removed (0396). The job made just above is not one of them: its link leaves
  -- q.job_id null, and it was born with the scope. Words a person typed on a job are never replaced.
  if q.job_id is not null and scope_for_job is not null then
    update public.jobs set description = scope_for_job
     where id = q.job_id and org_id = q.org_id
       and btrim(coalesce(description, ''), E' \t\n\r') = '';
  end if;

  return json_build_object('ok', true);
end $function$;

-- ── 3. The one-time backfill ────────────────────────────────────────────────────────────────────
-- THE FORWARD RULE APPLIED BACKWARD, for every company: a job whose Description is empty, with an
-- accepted estimate that has a description, takes the earliest accepted one's (the one that would
-- have named the scope the day it was accepted: by when it was accepted, an estimate with no
-- accepted_at by when it was made, then the oldest row). Same company on both sides, the same trim,
-- and the empty test is asked AGAIN on the row being written, so a Description somebody types while
-- this runs is theirs. Twice-safe by construction: a second run finds no empty job that has one.
--
-- WHAT THIS UPDATE SETS OFF (every trigger the migrations put on public.jobs was read):
--   touch_jobs (0001, BEFORE UPDATE, every row) would set updated_at = now() on each job filled.
--     That stamp is read by Needs You's Done, Not Billed (a COMPLETE job with no real invoice shows
--     for thirty days from it: needs_you_done_not_billed, 0371 / 0403), by the age of a job on hold,
--     by Timecards' list of finished jobs, by the Google Calendar sync's sweep and by every list
--     ordered by updated_at. A one-time fill is not an edit anybody made today, so it is SWITCHED
--     OFF for this one statement and on again right after it (0298's method, the two lines around
--     this block); the ground check found it enabled, and the self-check finds it enabled again.
--   jobs_hold_day (0366, BEFORE INSERT OR UPDATE) still fires: run here with nobody signed in, it
--     leaves a held job alone (its day, its reason and its holder); on a job that is not on hold it
--     clears the three hold columns (empty there already, unless the row was last written before
--     0366, when a reason left over from an old hold goes).
--   jobs_unstamp_invoice_pdfs (0349) and jobs_geo_follows_address (0404) are UPDATE OF the billing
--     type or the address: not fired by a Description.
-- No activity row, no bell, no message, no calendar push comes from a trigger.
alter table public.jobs disable trigger touch_jobs;
do $$
declare
  v_jobs int;
  v_orgs int;
begin
  with pick as (
    select distinct on (j.id)
           j.id as job_id, j.org_id,
           nullif(btrim(q.description, E' \t\n\r'), '') as scope
      from public.jobs j
      join public.quotes q on q.job_id = j.id and q.org_id = j.org_id
     where btrim(coalesce(j.description, ''), E' \t\n\r') = ''
       and q.status = 'accepted'
       and nullif(btrim(q.description, E' \t\n\r'), '') is not null
     order by j.id, coalesce(q.accepted_at, q.created_at), q.created_at, q.id
  ), filled as (
    update public.jobs j
       set description = p.scope
      from pick p
     where j.id = p.job_id and j.org_id = p.org_id
       and btrim(coalesce(j.description, ''), E' \t\n\r') = ''
    returning j.org_id
  )
  select count(*), count(distinct f.org_id) into v_jobs, v_orgs from filled f;
  raise notice '0409: the backfill filled % job(s) in % organization(s): each had an empty Description and an accepted estimate with one.', v_jobs, v_orgs;
end $$;
alter table public.jobs enable trigger touch_jobs;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_accept     regprocedure := 'public.accept_public_quote(text)'::regprocedure;
  v_projection regprocedure := 'public.invoice_document_projection(uuid)'::regprocedure;
  guard        constant text := 'set job_id = new_job where id = q.id and job_id is null';
  v_src  text;
  v_def  text;
  v_got  text;
  v_was  text;
  v_now  text;
  v_left int;
  r      record;
begin
  -- 1. THE RULE, ON THIS DATABASE, IS THE APP'S. tests/migration-0409.test.ts runs these same
  --    descriptions through scopeForJob and jobTakesScope and wants the same answers. Each one is
  --    written as a JSON string so a tab or a no-break space is an escape a person can read, never
  --    an invisible character in this file.
  for r in
    select * from (values
      ('words are taken as they are', '"Replace the main panel"'::jsonb, '"Replace the main panel"'::jsonb),
      ('spaces at both ends go', '"   Replace the main panel  "'::jsonb, '"Replace the main panel"'::jsonb),
      ('a tab, a line feed and a carriage return at the ends go', '"\t\r\n Replace the main panel \n\r\t"'::jsonb, '"Replace the main panel"'::jsonb),
      ('what is blank between the words stays', '" Replace the main panel.\n\n\tPatch  the drywall.\r\n"'::jsonb, '"Replace the main panel.\n\n\tPatch  the drywall."'::jsonb),
      ('only blank space is no scope', '" \t\r\n "'::jsonb, null::jsonb),
      ('an empty description is no scope', '""'::jsonb, null::jsonb),
      ('no description is no scope', null::jsonb, null::jsonb),
      ('a no-break space is not blank: it stays, and so does the space inside it', '" \u00a0 Replace the main panel \u00a0 "'::jsonb, '"\u00a0 Replace the main panel \u00a0"'::jsonb),
      ('a no-break space alone is words', '"\u00a0"'::jsonb, '"\u00a0"'::jsonb),
      ('a vertical tab and a form feed are not blank either', '"\u000bReplace the main panel\u000c"'::jsonb, '"\u000bReplace the main panel\u000c"'::jsonb)
    ) as t(why, given, want)
  loop
    v_got := nullif(btrim(r.given #>> '{}', E' \t\n\r'), '');
    if v_got is distinct from (r.want #>> '{}') then
      raise exception '0409: the scope taken is "%" where the app''s scopeForJob takes "%" (%). Nothing was changed.', v_got, r.want #>> '{}', r.why;
    end if;
  end loop;
  for r in
    select * from (values
      ('a job with no Description takes the scope', null::jsonb, true),
      ('an empty Description takes it', '""'::jsonb, true),
      ('a Description of blank space takes it', '" \t\r\n"'::jsonb, true),
      ('a job with words keeps them', '"Call before arriving"'::jsonb, false),
      ('a no-break space is something a person left: it stays', '"\u00a0"'::jsonb, false)
    ) as t(why, has, takes)
  loop
    if (btrim(coalesce(r.has #>> '{}', ''), E' \t\n\r') = '') is distinct from r.takes then
      raise exception '0409: whether a job takes the scope is not the app''s jobTakesScope (%). Nothing was changed.', r.why;
    end if;
  end loop;

  -- 2. accept_public_quote: still the customer's door, the same kind of function, with 0392's and
  --    0396's guards and this file's three additions, owned and granted exactly as it was.
  select p.prosrc into v_src from pg_proc p where p.oid = v_accept;
  if not (select p.prosecdef from pg_proc p where p.oid = v_accept)
     or (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = v_accept) <> 'plpgsql'
     or (select p.prorettype from pg_proc p where p.oid = v_accept) <> 'json'::regtype
     or not coalesce((select p.proconfig @> array['search_path=public'] from pg_proc p where p.oid = v_accept), false) then
    raise exception '0409: accept_public_quote is no longer the security-definer plpgsql function that returns json with its search path pinned. Nothing was changed.';
  end if;
  if position('and status = ''sent''' in v_src) = 0 or position('revises_quote_id' in v_src) = 0 then
    raise exception '0409: accept_public_quote lost 0392''s guarded flip or its revision pin. Nothing was changed.';
  end if;
  if position('site_address := cust.address' in v_src) = 0
     or position('delete from public.jobs where id = new_job and org_id = q.org_id' in v_src) = 0 then
    raise exception '0409: accept_public_quote lost 0396''s customer address or its losing door''s clean-up. Nothing was changed.';
  end if;
  -- The guarded link reads TWICE, as 0396 left it: once on the revision pin, once on the new job.
  if (length(v_src) - length(replace(v_src, guard, ''))) / length(guard) <> 2 then
    raise exception '0409: accept_public_quote does not carry the guarded job link exactly twice. Nothing was changed.';
  end if;
  if position($m$scope_for_job := nullif(btrim(q.description, E' \t\n\r'), '');$m$ in v_src) = 0 then
    raise exception '0409: accept_public_quote does not work out the scope as the app''s scopeForJob does. Nothing was changed.';
  end if;
  if position('address, unit, city, state, zip, description, created_by)' in v_src) = 0
     or position('scope_for_job,' in v_src) = 0 then
    raise exception '0409: the job accept_public_quote makes is not born with the scope as its Description. Nothing was changed.';
  end if;
  if position('if q.job_id is not null and scope_for_job is not null then' in v_src) = 0
     or position('update public.jobs set description = scope_for_job' in v_src) = 0
     or position($m$and btrim(coalesce(description, ''), E' \t\n\r') = '';$m$ in v_src) = 0 then
    raise exception '0409: accept_public_quote does not fill a job that was already there only where its Description is empty. Nothing was changed.';
  end if;
  -- The body now stored is this file's own, by the same reading the ground check gave the old one:
  -- so a second run of this file finds what it expects, which is what makes it twice-safe.
  if coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '') <> '883480080186365bab3f9607c236bdaa' then
    raise exception '0409: the accept_public_quote now on this database does not read as the body this file wrote, so a second run of this file would refuse. Nothing was changed.';
  end if;
  if not has_function_privilege('anon', v_accept, 'execute') or not has_function_privilege('authenticated', v_accept, 'execute') then
    raise exception '0409: the customer''s link can no longer call accept_public_quote. Nothing was changed.';
  end if;
  v_was := current_setting('cn.m0409_accept_was', true);
  if v_was is null or left(v_was, 4) <> 'was:' then
    raise exception '0409: this file has to run in ONE transaction (the runners wrap it in begin and commit): who owned accept_public_quote before the change did not reach this check. Run it through the migration runner.';
  end if;
  select 'was:' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '') into v_now from pg_proc p where p.oid = v_accept;
  if v_now is distinct from v_was then
    raise exception '0409: the owner or the grants of accept_public_quote changed (before: %; now: %). Nothing was changed.', v_was, v_now;
  end if;
  -- It runs: a token no estimate has is answered as it always was, and nothing is written.
  if (public.accept_public_quote('0409 self-check: no estimate has this token') ->> 'ok') is distinct from 'false' then
    raise exception '0409: accept_public_quote did not refuse a token no estimate has. Nothing was changed.';
  end if;

  -- 3. invoice_document_projection: still the stable definer's projection nobody outside the
  --    database calls, with the three candidates once each and both earlier patches.
  v_def := pg_get_functiondef(v_projection);
  if not (select p.prosecdef from pg_proc p where p.oid = v_projection)
     or (select p.provolatile from pg_proc p where p.oid = v_projection) <> 's'
     or (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = v_projection) <> 'sql'
     or not coalesce((select p.proconfig @> array['search_path=public'] from pg_proc p where p.oid = v_projection), false) then
    raise exception '0409: invoice_document_projection is no longer the stable security-definer SQL function with its search path pinned. Nothing was changed.';
  end if;
  for r in select * from (values ('''source'', ''job'''), ('''source'', ''quote'''), ('''source'', ''lead''')) as t(mark) loop
    if (length(v_def) - length(replace(v_def, r.mark, ''))) / length(r.mark) <> 1 then
      raise exception '0409: invoice_document_projection does not carry the candidate % exactly once. Nothing was changed.', r.mark;
    end if;
  end loop;
  if position('customer_line_words' in v_def) = 0 or position('it.line_kind' in v_def) = 0 then
    raise exception '0409: invoice_document_projection lost an earlier patch (0315 the customer''s words, 0342 line_kind). Nothing was changed.';
  end if;
  if has_function_privilege('anon', v_projection, 'execute') or has_function_privilege('authenticated', v_projection, 'execute') then
    raise exception '0409: invoice_document_projection became callable without the service role. Nothing was changed.';
  end if;
  if not has_function_privilege('service_role', v_projection, 'execute')
     or not has_function_privilege('anon', 'public.public_invoice(text)', 'execute') then
    raise exception '0409: the service role lost invoice_document_projection, or the customer''s link lost public_invoice. Nothing was changed.';
  end if;
  v_was := current_setting('cn.m0409_projection_was', true);
  if v_was is null or left(v_was, 4) <> 'was:' then
    raise exception '0409: this file has to run in ONE transaction (the runners wrap it in begin and commit): who owned invoice_document_projection before the change did not reach this check. Run it through the migration runner.';
  end if;
  select 'was:' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '') into v_now from pg_proc p where p.oid = v_projection;
  if v_now is distinct from v_was then
    raise exception '0409: the owner or the grants of invoice_document_projection changed (before: %; now: %). Nothing was changed.', v_was, v_now;
  end if;
  -- Both run: an id no invoice has, and a token no invoice has, are answered with nothing.
  if public.invoice_document_projection('00000000-0000-0000-0000-000000000000'::uuid) is not null
     or public.public_invoice('0409 self-check: no invoice has this token') is not null then
    raise exception '0409: the invoice document answered an invoice that is not there. Nothing was changed.';
  end if;

  -- 4. THE BACKFILL LEFT NOTHING IT SHOULD HAVE FILLED, which is also why a second run fills nothing.
  select count(*) into v_left
    from public.jobs j
   where btrim(coalesce(j.description, ''), E' \t\n\r') = ''
     and exists (
       select 1 from public.quotes q
        where q.job_id = j.id and q.org_id = j.org_id and q.status = 'accepted'
          and nullif(btrim(q.description, E' \t\n\r'), '') is not null);
  if v_left > 0 then
    raise exception '0409: % job(s) still have an empty Description beside an accepted estimate that has one (if an estimate was accepted while this ran, run it again). Nothing was changed.', v_left;
  end if;

  -- 5. THE STAMP IS ON AGAIN. touch_jobs was switched off for the backfill alone; left off, every job
  --    saved from now on would keep its old updated_at, without a word.
  if coalesce((select tgenabled from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'touch_jobs' and not tgisinternal), '-') <> 'O' then
    raise exception '0409: the trigger touch_jobs on public.jobs is not enabled again after the backfill. Nothing was changed.';
  end if;

  raise notice '0409: born from an estimate: a job the customer''s Accept makes takes the estimate''s description as its Description, a job that was already there takes it only where its own is empty, and an invoice''s site list offers its job, then its estimate''s own address, then that estimate''s lead''s.';
end $$;

-- The proof's two helpers leave with it.
drop table pg_temp._0409_before;
drop function pg_temp._0409_rest(jsonb);
