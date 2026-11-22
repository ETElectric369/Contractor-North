-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0413: the customer's own Accept finds the right customer, and says who said yes
--
-- The owner, 2026-11-21, on the inspection that ends in a sale: "if the inspector were to be
-- generating an estimated total while being recorded could that then be an instant create and
-- approve estimate button at the bottom which would run the proper cycle of things, streamline the
-- new workflow properly and pop into the new job having a proper record and simplify our
-- environment while safeguarding the data at the same time? check the math on that". And his rule
-- from two days before: "id like to re-explore the idea of fragment first so we dont piss anyone off
-- forcing them to do something in order to do something else".
--
-- WHY. Fragment first means an estimate can be written for a lead before anybody is a customer, and
-- the customer is made the moment the estimate is accepted. There are two doors for that moment, and
-- they did not agree on who the customer is.
--
--   THE OFFICE'S DOOR (customerForInquiry, src/lib/actions/win-customer.ts) asks the one matcher,
--   sureCustomerMatch (src/lib/crm/duplicates.ts): the lead's own customer when it already has one;
--   else a phone or an e-mail, which is one person; else a name ONLY when it is the one such name in
--   the book, is not a placeholder, and no phone or e-mail on file says it is somebody else; else a
--   NEW customer.
--
--   THE CUSTOMER'S OWN ACCEPT (accept_public_quote, in SQL, here) took ANY customer that shared a
--   phone, an e-mail OR a name, oldest first. The lead's own customer was never asked. A stranger
--   with the same name and another phone, made earlier, won over the right person's phone. Two leads
--   named Unknown caller, or named by a number, linked to each other. And the money, the job and the
--   portal landed on whoever that was, with nobody asked.
--
--   AND NOTHING SAID WHO SAID YES. The new door at the bottom of an inspection records an estimate
--   approved in person by the office person who tapped. An estimate has one time for that
--   (accepted_at, 0014) and no word for how or by whom.
--
-- WHAT, three things and nothing else:
--
--  1. quotes.accepted_how (text, null) and quotes.accepted_by (uuid, null, a profile, set null when
--     the profile goes), each added only if it is not there, with two named checks:
--       quotes_accepted_how_known       null, 'customer_link', 'in_person' or 'office';
--       quotes_accepted_by_not_on_link  nobody is named beside 'customer_link': the customer said yes.
--     NO BACKFILL. Null is a real answer: recorded before this release. Nothing is guessed.
--
--  2. public.accept_public_quote(text), the customer's Accept on their link: 0409's body (the last
--     migration that made it), every statement, with these four changes and no others, each marked
--     in the body with a comment that names 0413:
--       a. the lead is read in the estimate's own company (org_id = q.org_id), as every other read in
--          it already was;
--       b. THE SURE MATCH, the SQL twin of sureCustomerMatch, with the lead's own customer first:
--          (1) the lead's customer, when it is in this company; (2) a phone, the last ten digits, at
--          least seven; (3) an e-mail, lowered and trimmed; (4) a name only when it is not a
--          placeholder (Unknown caller, digits alone), it is the ONE such name in the company, and
--          neither a phone nor an e-mail on that record contradicts the lead's. Otherwise a NEW
--          customer, by the insert that was there. Ties: the oldest record first, then its id;
--       c. the guarded flip writes accepted_how = 'customer_link' and accepted_by = null beside the
--          status and the time. The null matters: an estimate the office marked accepted, walked back
--          to sent and then accepted on the link would otherwise break the second check and the
--          customer's tap would be refused;
--       d. the job it makes names its billing_type: the company's usual kind, by
--          public.usual_billing_type (0379), counted in the estimate's own company before the row
--          exists. 0379's trigger already gave a job that named none that same answer, so no job is
--          born differently: the door says it out loud, as every door in the app does.
--     Same signature, same security, same search path, no new input beyond the token. CREATE OR
--     REPLACE keeps the owner and the grants, and the self-check compares both with what they were.
--     If you re-create this function, copy THIS body.
--
--  3. Nothing else. No row is written by this file.
--
-- THE TWINS, named the day they are added: sureCustomerMatch and findCustomerMatch
-- (src/lib/crm/duplicates.ts) for the match, customerForInquiry (src/lib/actions/win-customer.ts)
-- for the lead's own customer first, usualBillingKind (src/lib/schedule-options.ts) for the billing
-- kind through 0379's usual_billing_type. tests/migration-0413.test.ts feeds the same cases to the
-- app's matcher and says the SQL's answer beside each; the database suite
-- src/lib/sure-accept.integration.test.ts asks the database the same cases.
--
-- WHERE THE TWO CAN STILL DIFFER, said so nobody finds it by accident:
--   ORDER. The app walks the book in the order it was read and takes the first record that shares
--     a phone OR an e-mail; this takes a phone over all records first, then an e-mail. They differ
--     only when the phone is on one record and the e-mail on another.
--   TRIM. The app's trim() strips every Unicode space; btrim strips the plain space alone. Only an
--     e-mail with a pasted no-break space at an end reads differently.
--   CASE. The app lowers by Unicode, this by the database's collation. A name keeps only a to z and
--     0 to 9 after lowering on both sides, so only a letter outside them could differ.
--   THE BOOK. The office's door reads the book with no paging, so past the row cap it may not see
--     the second record of a name; this reads every record in the company.
--   THE NEW CUSTOMER'S PHONE. The app writes it formatted; the insert here, not changed, writes it
--     as the lead had it.
--
-- THE WRITERS AND THE READERS, named the day the columns are added: written by this function
-- ('customer_link') and by updateQuoteStatus (src/app/(app)/quotes/actions.ts: 'in_person' or
-- 'office', with the signed-in person's id, on a fresh acceptance only); read by the estimate's own
-- page under src/app/(app)/quotes/ (one plain line for the office while the estimate is accepted)
-- and by the company export (src/lib/export/registry.ts). The estimate's public projection names
-- its own columns (0408), so neither column reaches the customer's page, the paper or the portal.
--
-- ORDER. BEFORE the deploy, and it must be: the deployed app names both columns in the estimate
-- editor's read and writes them on an acceptance. Applied first, the app that is running now never
-- names them and nothing it does changes; the customer's Accept starts matching surely at once.
--
-- LOCKS. Two columns and two checks are added to public.quotes: ACCESS EXCLUSIVE on quotes for a
-- moment (the columns are null and take no default; each check reads the table once), and the
-- reference takes a lock on public.profiles that holds off a change to a profile until the commit.
-- The function is replaced (catalog rows only). lock_timeout 3s: an estimate somebody is saving at
-- that moment makes this fail fast and change nothing; run it again. statement_timeout 15s. ONE
-- TRANSACTION: the runners wrap the file, and the self-check leans on that (what the ground check
-- notes is read back at the end). Twice-safe: a second run finds both columns and both checks there
-- and adds nothing, finds its own function, replaces it with the same text and passes the same
-- self-check. Run again AFTER a later migration has re-made accept_public_quote, it refuses at the
-- ground it checks and never puts its own text back over a newer one.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

-- ── The ground it stands on ─────────────────────────────────────────────────────────────────────
do $$
declare
  r     record;
  v_src text;
  v_kind text;
begin
  for r in select t.tbl from (values ('quotes'), ('inquiries'), ('customers'), ('jobs'), ('profiles'), ('organizations')) as t(tbl) loop
    if to_regclass('public.' || r.tbl) is null then
      raise exception '0413: public.% is not on this database. Nothing was changed.', r.tbl;
    end if;
  end loop;
  if (select count(*) from pg_roles where rolname in ('anon', 'authenticated')) <> 2 then
    raise exception '0413: the roles anon and authenticated are not both on this database. Nothing was changed.';
  end if;

  -- EVERY COLUMN THE MATCH, THE FLIP AND THE JOB READ THAT 0409 DID NOT ALREADY CHECK, with the
  -- migration that added it.
  for r in
    select * from (values
      ('quotes',    'customer_id',  'uuid',                     '0001'),
      ('quotes',    'org_id',       'uuid',                     '0004'),
      ('quotes',    'inquiry_id',   'uuid',                     '0109'),
      ('quotes',    'accepted_at',  'timestamp with time zone', '0014'),
      ('inquiries', 'customer_id',  'uuid',                     '0034'),
      ('inquiries', 'name',         'text',                     '0034'),
      ('inquiries', 'phone',        'text',                     '0034'),
      ('inquiries', 'email',        'text',                     '0034'),
      ('inquiries', 'org_id',       'uuid',                     '0034'),
      ('customers', 'name',         'text',                     '0001'),
      ('customers', 'phone',        'text',                     '0001'),
      ('customers', 'email',        'text',                     '0001'),
      ('customers', 'created_at',   'timestamp with time zone', '0001'),
      ('customers', 'org_id',       'uuid',                     '0004'),
      ('jobs',      'billing_type', 'text',                     '0063'),
      ('jobs',      'org_id',       'uuid',                     '0004'),
      ('profiles',  'id',           'uuid',                     '0001')
    ) as t(tbl, col, kind, born)
  loop
    if not exists (
      select 1 from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col and c.data_type = r.kind
    ) then
      raise exception '0413: %.% (%, added by %) is missing. Apply % first. Nothing was changed.', r.tbl, r.col, r.kind, r.born, r.born;
    end if;
  end loop;

  -- A SECOND RUN finds the two columns this file adds; anything else under those names is not this
  -- file's and is refused before it is built on.
  select c.data_type into v_kind from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'quotes' and c.column_name = 'accepted_how';
  if v_kind is not null and v_kind <> 'text' then
    raise exception '0413: quotes.accepted_how is on this database as % and not text: it was not made by this file. Nothing was changed.', v_kind;
  end if;
  v_kind := null;
  select c.data_type into v_kind from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'quotes' and c.column_name = 'accepted_by';
  if v_kind is not null and v_kind <> 'uuid' then
    raise exception '0413: quotes.accepted_by is on this database as % and not uuid: it was not made by this file. Nothing was changed.', v_kind;
  end if;

  -- THE COMPANY'S USUAL KIND, which the job is born with: 0379's function, statement for statement
  -- (its body with comments and spacing taken out, read the same way as the function below).
  if to_regprocedure('public.usual_billing_type(uuid)') is null then
    raise exception '0413: public.usual_billing_type(uuid) (0379) is not on this database. Nothing was changed.';
  end if;
  select p.prosrc into v_src from pg_proc p where p.oid = 'public.usual_billing_type(uuid)'::regprocedure;
  if coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '') <> '6580468629986ba2ff89f11fc7c3cabe' then
    raise exception '0413: usual_billing_type on this database is not the body 0379 wrote (more fixed than time and material is fixed, else time and material, counted in one company). Read it (select pg_get_functiondef(''public.usual_billing_type(uuid)''::regprocedure)) before this runs. Nothing was changed.';
  end if;

  -- THE FUNCTION THIS FILE REPLACES IS THE ONE IT WAS WRITTEN FROM: its statements, with comments and
  -- spacing taken out, must be 0409's (the first md5) or, on a second run, exactly this file's own
  -- (the second). Anything else is refused and never overwritten. tests/migration-0413.test.ts
  -- recomputes both md5s from the two files.
  if to_regprocedure('public.accept_public_quote(text)') is null then
    raise exception '0413: public.accept_public_quote(text) is not on this database (0014; last made by 0409). Nothing was changed.';
  end if;
  v_src := null;
  select p.prosrc into v_src from pg_proc p where p.oid = 'public.accept_public_quote(text)'::regprocedure;
  if coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '')
       not in ('883480080186365bab3f9607c236bdaa', '12278c3bde6fe0e7ab556cfa50a85634') then
    raise exception '0413: accept_public_quote on this database is not the body 0409 left, nor this file''s own: it was changed outside this repository''s migrations, or by a later migration (then this file must not run again). Read it (select pg_get_functiondef(''public.accept_public_quote(text)''::regprocedure)) and reconcile the two before this runs. Nothing was changed.';
  end if;
  if not has_function_privilege('anon', 'public.accept_public_quote(text)', 'execute')
     or not has_function_privilege('authenticated', 'public.accept_public_quote(text)', 'execute') then
    raise exception '0413: the customer''s link cannot call accept_public_quote on this database (0014, 0066 and 0119 granted it to anon and authenticated). Nothing was changed.';
  end if;

  -- Who owns the function and who may call it, as they stand, for the self-check to compare.
  perform set_config(
    'cn.m0413_accept_was',
    (select 'was:' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '') from pg_proc p where p.oid = 'public.accept_public_quote(text)'::regprocedure),
    true);
end $$;

-- ── 1. Who said yes ─────────────────────────────────────────────────────────────────────────────
alter table public.quotes
  add column if not exists accepted_how text;
alter table public.quotes
  add column if not exists accepted_by uuid references public.profiles(id) on delete set null;

comment on column public.quotes.accepted_how is
  'How the estimate was accepted (0413): customer_link (the customer, on their own link), in_person (approved in person, recorded by the office person in accepted_by), office (marked accepted by the office person in accepted_by). Null: recorded before 0413, or not accepted. Written on a fresh acceptance only.';
comment on column public.quotes.accepted_by is
  'The office person who recorded the acceptance (0413), a profile; null when the customer accepted on their link, when it was recorded before 0413, or when that profile is gone.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.quotes'::regclass
       and conname = 'quotes_accepted_how_known'
  ) then
    alter table public.quotes
      add constraint quotes_accepted_how_known
      check (accepted_how is null or accepted_how in ('customer_link', 'in_person', 'office'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.quotes'::regclass
       and conname = 'quotes_accepted_by_not_on_link'
  ) then
    alter table public.quotes
      add constraint quotes_accepted_by_not_on_link
      check (accepted_how is distinct from 'customer_link' or accepted_by is null);
  end if;
end $$;

-- ── 2. The customer's own Accept finds the right customer ───────────────────────────────────────
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
  -- 0413: (c) WHO SAID YES. The customer, on their own link: accepted_how says so, and accepted_by is
  -- written empty ON PURPOSE. An estimate the office marked accepted, walked back to sent and then
  -- accepted on the link still carries the office person's id; left there, it would break the check
  -- quotes_accepted_by_not_on_link and the customer's tap would be refused.
  update public.quotes set status = 'accepted', accepted_at = now(), accepted_how = 'customer_link', accepted_by = null
   where id = q.id and status = 'sent';
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
    -- 0413: (a) THE LEAD IS READ IN THE ESTIMATE'S OWN COMPANY. This function runs as its owner for
    -- somebody holding a token and nothing else: no row of another company is read on their behalf.
    select * into inq from public.inquiries where id = q.inquiry_id and org_id = q.org_id;
  end if;

  -- Deferred-customer estimate → born a Contact now. Crosscheck the book first (same phone / email /
  -- normalized name → link the existing customer, never duplicate), else auto-fill from the inquiry.
  if q.customer_id is null and inq.id is not null then
    -- 0413: (b) THE SURE MATCH, the SQL twin of sureCustomerMatch (src/lib/crm/duplicates.ts), with
    -- the lead's own customer first, as customerForInquiry (src/lib/actions/win-customer.ts) has it.
    -- Every read is in the estimate's own company, and each step runs only while nothing is found.
    -- 1. A LEAD ALREADY TIED TO A CUSTOMER KEEPS IT: that customer, when it is in this company.
    if inq.customer_id is not null then
      select c.id into cust_id from public.customers c
       where c.id = inq.customer_id and c.org_id = q.org_id;
    end if;

    -- The keys, as normPhone, normEmail and normName make them: the last ten digits (the ASCII digits
    -- alone, spelled [^0-9], never the class that follows the locale), the e-mail lowered and
    -- trimmed, the name lowered with everything but a to z and 0 to 9 taken out.
    inq_phone := right(regexp_replace(coalesce(inq.phone, ''), '[^0-9]', '', 'g'), 10);
    inq_email := btrim(lower(coalesce(inq.email, '')));
    inq_name  := regexp_replace(lower(coalesce(inq.name, '')), '[^a-z0-9]', '', 'g');

    -- 2. A PHONE IS ONE PERSON: seven digits at least; the oldest record first, then by id.
    if cust_id is null and length(inq_phone) >= 7 then
      select c.id into cust_id
      from public.customers c
      where c.org_id = q.org_id
        and right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = inq_phone
      order by c.created_at, c.id
      limit 1;
    end if;

    -- 3. AN E-MAIL IS ONE PERSON, the same way.
    if cust_id is null and inq_email <> '' then
      select c.id into cust_id
      from public.customers c
      where c.org_id = q.org_id
        and btrim(lower(coalesce(c.email, ''))) = inq_email
      order by c.created_at, c.id
      limit 1;
    end if;

    -- 4. A NAME ONLY WHEN IT IS SURE: not a placeholder (a fragment's Unknown caller, or digits
    -- alone), the ONE customer in this company with that name, and no phone or e-mail on that record
    -- saying it is somebody else (both sides have one, and they differ). When the HAVING fails the
    -- select returns no row, and a SELECT INTO that finds no row sets cust_id to null: it stays
    -- null, and a NEW customer is made just below. Find Duplicates still shows the pair by name.
    if cust_id is null and inq_name <> '' and inq_name <> 'unknowncaller' and inq_name !~ '^[0-9]+$' then
      select (array_agg(c.id))[1] into cust_id
      from public.customers c
      where c.org_id = q.org_id
        and regexp_replace(lower(coalesce(c.name, '')), '[^a-z0-9]', '', 'g') = inq_name
      having count(*) = 1
         and not bool_or(
               (length(inq_phone) >= 7
                and length(right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10)) >= 7
                and right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) <> inq_phone)
            or (inq_email <> ''
                and btrim(lower(coalesce(c.email, ''))) <> ''
                and btrim(lower(coalesce(c.email, ''))) <> inq_email));
    end if;

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

    -- THE NAME IS THE STREET, NEVER WHERE IT CAME FROM (0369; the owner 2026-09-28, "street number and
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

    -- 0413: (d) THE JOB SAYS HOW IT BILLS: the company's usual kind, counted in its own company
    -- before this row exists, by public.usual_billing_type (0379; the SQL twin of usualBillingKind in
    -- src/lib/schedule-options.ts): fixed only when its fixed jobs outnumber its time and material
    -- ones, else time and material. 0379's trigger gave a job that named none the same answer; the
    -- door says it out loud now, as every door that makes a job in the app does.
    insert into public.jobs (org_id, customer_id, inquiry_id, name, status, billing_type,
                             address, unit, city, state, zip, description, created_by)
    values (q.org_id, q.customer_id, q.inquiry_id,
            public.job_name_from(null, q.title, cust.name, cust.company_name, cust.type::text,
                                 coalesce(nullif(site_address, ''), cust.address),
                                 case when coalesce(site_address, '') <> '' then site_unit else cust.unit end,
                                 inq.name,
                                 (now() at time zone org_tz)::date),
            'to_be_scheduled',
            public.usual_billing_type(q.org_id),
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

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_accept regprocedure := 'public.accept_public_quote(text)'::regprocedure;
  guard    constant text := 'set job_id = new_job where id = q.id and job_id is null';
  v_src    text;
  v_def    text;
  v_was    text;
  v_now    text;
  r        record;
begin
  -- 1. THE TWO COLUMNS AND THEIR CHECKS, as this file made them.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'quotes'
       and column_name = 'accepted_how' and data_type = 'text' and is_nullable = 'YES' and column_default is null
  ) or not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'quotes'
       and column_name = 'accepted_by' and data_type = 'uuid' and is_nullable = 'YES' and column_default is null
  ) then
    raise exception '0413: quotes.accepted_how is not a nullable text column, or quotes.accepted_by not a nullable uuid column, with no default. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_constraint k
     where k.conrelid = 'public.quotes'::regclass and k.contype = 'f'
       and k.confrelid = 'public.profiles'::regclass and k.confdeltype = 'n'
       and k.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = 'public.quotes'::regclass and a.attname = 'accepted_by')]::int2[]
  ) then
    raise exception '0413: quotes.accepted_by does not refer to public.profiles with on delete set null. Nothing was changed.';
  end if;
  select lower(pg_get_constraintdef(k.oid)) into v_def from pg_constraint k
   where k.conrelid = 'public.quotes'::regclass and k.contype = 'c' and k.convalidated and k.conname = 'quotes_accepted_how_known';
  if v_def is null
     or position('accepted_how is null' in v_def) = 0
     or position('''customer_link''::text' in v_def) = 0
     or position('''in_person''::text' in v_def) = 0
     or position('''office''::text' in v_def) = 0 then
    raise exception '0413: the check quotes_accepted_how_known is not "null, customer_link, in_person or office". Nothing was changed.';
  end if;
  v_def := null;
  select lower(pg_get_constraintdef(k.oid)) into v_def from pg_constraint k
   where k.conrelid = 'public.quotes'::regclass and k.contype = 'c' and k.convalidated and k.conname = 'quotes_accepted_by_not_on_link';
  if v_def is null
     or position('accepted_how is distinct from ''customer_link''::text' in v_def) = 0
     or position('accepted_by is null' in v_def) = 0 then
    raise exception '0413: the check quotes_accepted_by_not_on_link is not "nobody named beside customer_link". Nothing was changed.';
  end if;

  -- 2. accept_public_quote: still the customer's door, the same kind of function, owned and granted
  --    as it was, its body this file's own.
  select p.prosrc into v_src from pg_proc p where p.oid = v_accept;
  if not (select p.prosecdef from pg_proc p where p.oid = v_accept)
     or (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = v_accept) <> 'plpgsql'
     or (select p.prorettype from pg_proc p where p.oid = v_accept) <> 'json'::regtype
     or not coalesce((select p.proconfig @> array['search_path=public'] from pg_proc p where p.oid = v_accept), false) then
    raise exception '0413: accept_public_quote is no longer the security-definer plpgsql function that returns json with its search path pinned. Nothing was changed.';
  end if;
  if coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '') <> '12278c3bde6fe0e7ab556cfa50a85634' then
    raise exception '0413: the accept_public_quote now on this database does not read as the body this file wrote, so a second run of this file would refuse. Nothing was changed.';
  end if;
  if not has_function_privilege('anon', v_accept, 'execute') or not has_function_privilege('authenticated', v_accept, 'execute') then
    raise exception '0413: the customer''s link can no longer call accept_public_quote. Nothing was changed.';
  end if;
  v_was := current_setting('cn.m0413_accept_was', true);
  if v_was is null or left(v_was, 4) <> 'was:' then
    raise exception '0413: this file has to run in ONE transaction (the runners wrap it in begin and commit): who owned accept_public_quote before the change did not reach this check. Run it through the migration runner.';
  end if;
  select 'was:' || pg_get_userbyid(p.proowner) || ' ' || coalesce(p.proacl::text, '') into v_now from pg_proc p where p.oid = v_accept;
  if v_now is distinct from v_was then
    raise exception '0413: the owner or the grants of accept_public_quote changed (before: %; now: %). Nothing was changed.', v_was, v_now;
  end if;

  -- 3. WHAT THE EARLIER MAKERS PUT THERE STILL STANDS: 0392's guarded flip and revision pin, 0396's
  --    customer address, its compare-and-set link (twice) and the losing door's clean-up, 0369's name,
  --    and 0409's scope.
  for r in
    select * from (values
      ('0392', 'and status = ''sent'''),
      ('0392', 'revises_quote_id'),
      ('0396', 'site_address := cust.address'),
      ('0396', 'delete from public.jobs where id = new_job and org_id = q.org_id'),
      ('0369', 'public.job_name_from(null, q.title,'),
      ('0409', $m$scope_for_job := nullif(btrim(q.description, E' \t\n\r'), '');$m$),
      ('0409', 'address, unit, city, state, zip, description, created_by)'),
      ('0409', 'if q.job_id is not null and scope_for_job is not null then'),
      ('0409', 'update public.jobs set description = scope_for_job')
    ) as t(born, mark)
  loop
    if position(r.mark in v_src) = 0 then
      raise exception '0413: accept_public_quote lost what % put there (%). Nothing was changed.', r.born, r.mark;
    end if;
  end loop;
  if (length(v_src) - length(replace(v_src, guard, ''))) / length(guard) <> 2 then
    raise exception '0413: accept_public_quote does not carry the guarded job link exactly twice. Nothing was changed.';
  end if;

  -- 4. THIS FILE'S FOUR CHANGES ARE THERE, and the any-name arm they replace is gone.
  for r in
    select * from (values
      ('a', 'where id = q.inquiry_id and org_id = q.org_id;'),
      ('b', 'where c.id = inq.customer_id and c.org_id = q.org_id;'),
      ('b', 'inq_phone := right(regexp_replace(coalesce(inq.phone, ''''), ''[^0-9]'', '''', ''g''), 10);'),
      ('b', 'if cust_id is null and length(inq_phone) >= 7 then'),
      ('b', 'if cust_id is null and inq_email <> '''' then'),
      ('b', 'inq_name <> ''unknowncaller'' and inq_name !~ ''^[0-9]+$'''),
      ('b', 'having count(*) = 1'),
      ('b', 'and not bool_or('),
      ('b', 'order by c.created_at, c.id'),
      ('c', 'accepted_how = ''customer_link'', accepted_by = null'),
      ('d', 'name, status, billing_type,'),
      ('d', 'public.usual_billing_type(q.org_id),')
    ) as t(part, mark)
  loop
    if position(r.mark in v_src) = 0 then
      raise exception '0413: accept_public_quote does not carry this file''s change % (%). Nothing was changed.', r.part, r.mark;
    end if;
  end loop;
  if position('or (inq_name <> '''' and regexp_replace(' in v_src) > 0
     or position('order by c.created_at asc' in v_src) > 0
     or position($m$'\D'$m$ in v_src) > 0 then
    raise exception '0413: accept_public_quote still carries the any-name match this file replaces. Nothing was changed.';
  end if;

  -- 5. IT RUNS: a token no estimate has is answered as it always was, and nothing is written; and
  --    the billing kind of a company with no jobs is time and material.
  if (public.accept_public_quote('0413 self-check: no estimate has this token') ->> 'ok') is distinct from 'false' then
    raise exception '0413: accept_public_quote did not refuse a token no estimate has. Nothing was changed.';
  end if;
  if public.usual_billing_type('00000000-0000-0000-0000-000000000000'::uuid) is distinct from 'tm' then
    raise exception '0413: usual_billing_type does not answer time and material for a company with no jobs. Nothing was changed.';
  end if;

  raise notice '0413: the customer''s own Accept takes the lead''s customer, then a phone, then an e-mail, then a name only when it is sure, else makes a new customer; it says the customer accepted on their link; the job it makes names its billing kind; quotes.accepted_how and accepted_by are there for the office''s doors.';
end $$;
