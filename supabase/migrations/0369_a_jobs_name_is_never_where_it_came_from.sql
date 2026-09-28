-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0369: a job's name is never where it came from
--
-- ═══ APPLY ORDER ═══════════════════════════════════════════════════════════════════════════
--   Any time. It adds one pure function and re-creates accept_public_quote with its live (0192)
--   body, changed only in the job's name. No table, no column, no lock beyond the function swap;
--   nothing on main reads the new function but accept_public_quote itself.
--   THE TEST DATABASE: src/lib/job-name.integration.test.ts applies this file inside its own
--   rolled-back transaction when the database doesn't have it yet; CI's check-test-db wants the
--   file applied to the test database (scripts/test-db/rebuild.cjs, or the integrator's apply).
-- ═══════════════════════════════════════════════════════════════════════════════════════════
--
-- Erik (2026-09-27): "site inspections are labeled with the tag they shouldnt carry site inspection
-- in the job title same goes for any conversion." A job read "Site inspection: Rita Moss" because
-- the visit's title was copied onto it; an accepted estimate is named after its title the same way,
-- so "Estimate — Rita Moss" (the lead door's seeded title) became a job called that, and an
-- estimate with no title became "Job from Q-0012". Neither says who, where or what.
--
-- Then, final (2026-09-28): "street number and name as always". His company's jobs have always been
-- named "3245 West Lake Boulevard", "498 Mil Drae Lane"; with no address, the person ("Jackie
-- Burks"); a unit complex "TTP #56".
--
-- The app names every new job with ONE namer, src/lib/job-name.ts jobNameFrom. This is its SQL twin,
-- public.job_name_from, for the one door that makes a job inside the database: a customer tapping
-- Accept on the emailed /q/<token> link (accept_public_quote). The rule, identical in both:
--   1. a name a PERSON typed (p_typed) stays exactly as typed, unless it is ONLY a source tag, or a
--      tag and the customer or the street: that is no name;
--   2. with a street: the street number and name (a one-line address cut at its first comma), and
--      " #<unit>" when there is a unit ("56", "#56", "Unit 56", "Apt 56" all ride as "#56"; never
--      twice). No person, no town. Words a SOURCE carried (p_words: the estimate's title) never
--      replace the street;
--   3. no street: the customer as written (the company, else the whole name), then " · " and the
--      source's own words once the tag is off, cut at a word to 40 characters ("Jackie Burks ·
--      Panel Upgrade"); words that are only the customer are no words;
--   4. neither: the work words alone if any, else "New Job · Sep 27" on the company's today.
-- A source tag is a LEADING "Site inspection", "Site visit", "Service call", "Phone call",
-- "Walk-through"/"Walk through"/"Walkthrough", "Inspection", "Appointment", "Estimate", "Inquiry",
-- "Meeting", "Quote", "Call", "Lead", "Visit", followed by ":", "—", "–", "·", "|", a hyphen with a
-- space on one side, or the end, any case; the old stock fallbacks ("Job from appointment", "Job
-- from Q-0012") are no words at all; the phone-call booking's "Call Rita Moss" / "Call Visit" (no
-- separator) is a tag only when the person, the street or nothing follows, so "Call box install"
-- stays; a real name that merely contains the word ("RV Inspection") is not a tag.
-- job-name.integration.test.ts runs the SAME cases (job-name.cases.ts) through both and wants the
-- same answers.
--
-- Everything else in accept_public_quote is the live 0192 body, verbatim.
--
-- SAFE TO RUN TWICE: create or replace, both. Writes no company data and renames no existing job
-- (the three that were named after their source are fixed by hand, job-names-not-sources-et.sql).
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '15s';

-- An earlier draft of this file had a six-argument twin (no typed name, no unit). Should a database
-- have taken that draft, it goes, so only one twin exists. (A no-op everywhere else.)
drop function if exists public.job_name_from(text, text, text, text, text, date);

create or replace function public.job_name_from(
  p_typed text,
  p_words text,
  p_customer_name text,
  p_company_name text,
  p_customer_type text,
  p_street text,
  p_unit text,
  p_today date
)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  tag_re constant text :=
    '^(site\s+inspection|site\s+visit|service\s+call|phone\s+call|walk-through|walk\s+through|walkthrough|inspection|appointment|estimate|inquiry|meeting|quote|call|lead|visit)\s*([—–·|:]|\s-|-\s|$)\s*';
  stock_re constant text :=
    '^job\s+from\s+(appointment|lead|inquiry|estimate|quote|visit|[a-z]{1,3}-?[0-9][[:alnum:]_-]*)\s*$';
  -- The phone-call booking's stock title, "Call Rita Moss" (bookingTitle): no separator after the
  -- word, so a tag only when who, where or nothing follows it ("Call box install" stays).
  bare_call_re constant text := '^(phone\s+)?call\s+';
  company text := btrim(regexp_replace(coalesce(p_company_name, ''), '\s+', ' ', 'g'));
  cname text := btrim(regexp_replace(coalesce(p_customer_name, ''), '\s+', ' ', 'g'));
  street_in text := btrim(regexp_replace(coalesce(p_street, ''), '\s+', ' ', 'g'));
  street text;
  unit text;
  k_name text;
  k_company text;
  k_street text;
  k_street_line text;
  which int;
  pass int;
  i int;
  raw text;
  words text;
  rest text;
  nxt text;
  k text;
  tagged boolean;
  only_who boolean;
  w_only boolean;
  work text := '';
  who text;
  head text;
  pos int;
begin
  street := btrim(split_part(street_in, ',', 1));
  k_name := regexp_replace(lower(cname), '[^a-z0-9]', '', 'g');
  k_company := regexp_replace(lower(company), '[^a-z0-9]', '', 'g');
  k_street := regexp_replace(lower(street_in), '[^a-z0-9]', '', 'g');
  k_street_line := regexp_replace(lower(street), '[^a-z0-9]', '', 'g');

  -- Which 1: the typed name. Which 2: the source's words. Each is untagged the same way
  -- (stripSourceTag on the words, pass 1, and on what follows a bare "Call", pass 2).
  for which in 1..2 loop
    raw := btrim(regexp_replace(coalesce(case when which = 1 then p_typed else p_words end, ''), '\s+', ' ', 'g'));
    continue when raw = '';
    tagged := false;
    rest := raw;
    only_who := false;
    for pass in 1..2 loop
      if pass = 1 then
        words := raw;
      elsif tagged or raw !~* bare_call_re then
        exit;
      else
        words := btrim(regexp_replace(raw, bare_call_re, '', 'i'));
      end if;
      if words ~* stock_re then
        words := '';
      else
        i := 0;
        loop
          i := i + 1;
          nxt := btrim(regexp_replace(words, tag_re, '', 'i'));
          exit when nxt = words or i > 4;
          words := nxt;
        end loop;
        if words ~* stock_re then
          words := '';
        end if;
      end if;
      -- Only who or where: the customer's name, the company, the street (or an address line on it).
      k := regexp_replace(lower(words), '[^a-z0-9]', '', 'g');
      w_only := k <> '' and (
        (k_name <> '' and k_name = k)
        or (k_company <> '' and k_company = k)
        or (k_street <> '' and k_street = k)
        or (k_street_line <> ''
            and k_street_line = regexp_replace(lower(btrim(split_part(words, ',', 1))), '[^a-z0-9]', '', 'g')));
      if pass = 1 then
        tagged := words <> raw;
        rest := words;
        only_who := w_only;
      elsif words = '' or w_only then
        -- "Call Rita Moss" / "Call Visit": the call booking's stock title.
        tagged := true;
        rest := words;
        only_who := w_only;
      end if;
    end loop;

    if which = 1 then
      -- 1. A typed name stays exactly as typed, unless it is only a tag, or a tag and who or where.
      if not tagged or (rest <> '' and not only_who) then
        return raw;
      end if;
    elsif rest <> '' and not only_who then
      work := rest;
    end if;
  end loop;

  -- 2. The street number and name, " #<unit>" with a unit (its own designator off; never twice).
  if street <> '' then
    unit := btrim(regexp_replace(btrim(regexp_replace(coalesce(p_unit, ''), '\s+', ' ', 'g')),
                                 '^(#|(unit|apt|apartment|ste|suite)\M\.?)\s*#?\s*', '', 'i'));
    if unit <> '' and right(lower(street), length(unit) + 1) <> lower('#' || unit) then
      return street || ' #' || unit;
    end if;
    return street;
  end if;

  -- 3. Who as written, then the work words cut at a word to 40 characters.
  who := case when company <> '' then company else cname end;
  if length(work) > 40 then
    head := left(work, 41);
    pos := strpos(reverse(head), ' ');
    if pos > 0 and length(head) - pos > 0 then
      work := left(work, length(head) - pos);
    else
      work := left(work, 40);
    end if;
  end if;
  work := regexp_replace(work, '[[:space:],;:.–—·|/-]+$', '');
  if who <> '' then
    return case when work <> '' then who || ' · ' || work else who end;
  end if;

  -- 4. Neither: the work alone, else "New Job · Sep 27".
  if work <> '' then
    return work;
  end if;
  return 'New Job · ' || to_char(p_today, 'Mon FMDD');
end $function$;

comment on function public.job_name_from(text, text, text, text, text, text, text, date) is
  'A new job''s name (0369): a typed name as typed unless only a source tag (or a tag and who/where); else the street number and name (" #<unit>" with a unit); else the customer as written · the source''s words with any leading source tag ("Site inspection:", "Estimate —") taken off; else "New Job · Sep 27". The SQL twin of src/lib/job-name.ts jobNameFrom; pure.';

-- Pure, but only the database's own functions need it.
revoke all on function public.job_name_from(text, text, text, text, text, text, text, date) from public, anon, authenticated;

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

  update public.quotes set status = 'accepted', accepted_at = now() where id = q.id;

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

  if q.job_id is null then
    -- WHERE THE WORK IS. One whole record wins: the quote if it has a street, else the lead.
    -- Left null when neither does, so pickSite falls through to the customer exactly as before.
    if coalesce(q.address, '') <> '' then
      site_address := q.address; site_unit := q.unit; site_city := q.city; site_state := q.state; site_zip := q.zip;
    elsif coalesce(inq.address, '') <> '' then
      site_address := inq.address; site_unit := inq.unit; site_city := inq.city; site_state := inq.state; site_zip := inq.zip;
    end if;

    -- THE NAME IS THE STREET, NEVER WHERE IT CAME FROM (0369; Erik 2026-09-28, "street number and
    -- name as always"): the street number and name (the site above, else the customer's own, as the
    -- staff path's createJobFromQuote reads it) and " #<unit>" with that street's unit; with no
    -- street, the customer as written · the estimate's own words with any source tag taken off
    -- ("Estimate — Rita Moss" is the tag and the person: no words); else "New Job · Sep 27" on the
    -- company's today. Was: the title, else 'Job from ' || quote_number.
    if q.customer_id is not null then
      select * into cust from public.customers where id = q.customer_id and org_id = q.org_id;
    end if;
    select o.settings->>'timezone' into org_tz from public.organizations o where o.id = q.org_id;
    if org_tz is null or not exists (select 1 from pg_timezone_names where name = org_tz) then
      org_tz := 'America/Los_Angeles';
    end if;

    insert into public.jobs (org_id, customer_id, inquiry_id, name, status,
                             address, unit, city, state, zip, created_by)
    values (q.org_id, q.customer_id, q.inquiry_id,
            public.job_name_from(null, q.title, cust.name, cust.company_name, cust.type::text,
                                 coalesce(nullif(site_address, ''), cust.address),
                                 case when coalesce(site_address, '') <> '' then site_unit else cust.unit end,
                                 (now() at time zone org_tz)::date),
            'to_be_scheduled',
            site_address, site_unit, site_city, site_state, site_zip,
            q.created_by)
    returning id into new_job;
    update public.quotes set job_id = new_job where id = q.id;
  end if;

  return json_build_object('ok', true);
end $function$;

-- ── THE CHECK ───────────────────────────────────────────────────────────────────────────────
do $chk$
begin
  if public.job_name_from(null, 'Site inspection: Rita Moss', 'Rita Moss', null, 'residential', '12 Elm St', null, date '2026-09-27')
       is distinct from '12 Elm St'
     or public.job_name_from(null, 'Estimate — Panel Upgrade', 'Rita Moss', null, 'residential', null, null, date '2026-09-27')
       is distinct from 'Rita Moss · Panel Upgrade'
     or public.job_name_from(null, null, null, null, null, '300 West Lake Boulevard', 'Unit 56', date '2026-09-27')
       is distinct from '300 West Lake Boulevard #56'
     or public.job_name_from('RV Inspection', null, null, null, null, '12 Elm St', null, date '2026-09-27') is distinct from 'RV Inspection'
     or public.job_name_from(null, null, null, null, null, null, null, date '2026-09-27') is distinct from 'New Job · Sep 27' then
    raise exception '0369: job_name_from does not name jobs the way src/lib/job-name.ts does. Nothing was changed.';
  end if;
end $chk$;
