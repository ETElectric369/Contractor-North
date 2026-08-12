-- 0192 — ACCEPTING A QUOTE STOPS LOSING THE JOB SITE AND STOPS MISLABELLING THE CUSTOMER'S.
--
-- Audit 6, two findings in one function.
--
-- (a) THE JOB IS BORN WITH NO ADDRESS AT ALL. The insert names five columns — org_id, customer_id,
--     name, status, created_by — and no address. So a customer who taps Accept on the emailed
--     /q/<token> link creates a job that pickSite can only render by falling through to the
--     CUSTOMER's address. For Tahoe Tavern that is 300 W Lake Blvd with no unit, i.e. the building
--     instead of the dwelling, on every document from then on. The staff-side accept path was
--     given the site in cn-v613; this, the customer-facing branch of the same fork, never was.
--
-- (b) THE CUSTOMER RECORD GETS THE JOB SITE. `inq.address` is THE SITE (0189 said so out loud) and
--     it is written straight into customers.address. Migration 0189 added contact_address for
--     exactly this, and lib/inquiries/lead-address.ts made customerAddressFrom the one rule — but
--     this function predates it and still reads the wrong column. A lead who lives at 12 Elm St
--     and is building on a bare lot ends up as a customer who lives on the lot.
--
-- ── ALL-OR-NOTHING, NEVER A PER-FIELD COALESCE ──────────────────────────────────────────────
--
-- Both halves resolve a WHOLE record, exactly as lib/site-address.ts pickSite and
-- lead-address.ts customerAddressFrom do. `coalesce(q.address, inq.address, cust.address)` per
-- column is the tempting version and it is forbidden: it merges one record's street with another
-- record's city and produces an address that exists on no record and in no town. That failure has
-- already been paid for once in this codebase.
--
-- Site candidates, most specific first: the quote, then the lead. (quotes.address exists and is
-- empty on all 21 live rows, but it is the most specific thing there is, so it goes first and
-- costs nothing.) The lead is now loaded REGARDLESS of whether q.customer_id was already set — a
-- repeat customer skips the whole contact branch below, and the job still needs the site.
--
-- Also carried: `unit` (0187 — the dwelling, which is the entire point for TTP) and `inquiry_id`,
-- so a job born this way keeps the lead provenance the staff path preserves.
--
-- Everything else is the live 0127 body, verbatim. Not editing 0119 or 0127: both are applied.

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

    insert into public.jobs (org_id, customer_id, inquiry_id, name, status,
                             address, unit, city, state, zip, created_by)
    values (q.org_id, q.customer_id, q.inquiry_id,
            coalesce(nullif(q.title, ''), 'Job from ' || q.quote_number),
            'to_be_scheduled',
            site_address, site_unit, site_city, site_state, site_zip,
            q.created_by)
    returning id into new_job;
    update public.quotes set job_id = new_job where id = q.id;
  end if;

  return json_build_object('ok', true);
end $function$;
