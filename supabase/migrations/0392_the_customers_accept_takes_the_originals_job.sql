-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0392: the customer's own Accept on a revision takes the original's job
--
-- 0391 let an estimate be REVISED, and the office door (createJobFromQuote) pins an accepted revision
-- to the job its original already has. The customer's own Accept link runs accept_public_quote
-- instead, and that function (0369) knew nothing of revises_quote_id: a revision born while the
-- original was only sent (job_id null), accepted through its link after the original had been
-- accepted in between, made a SECOND job for the same work (audit v1085, class 6).
--
-- This redefines accept_public_quote from its LIVE body (0369 — never edited; applied migrations are
-- immutable) with two additions, nothing else changed:
--   1. the status flip is guarded on the status just read (`and status = 'sent'`), so an Accept or a
--      supersede that landed between the read and the write is answered as it is, not overwritten;
--   2. before a job is born, a revision with no job takes the job of the estimate it revises (the
--      company's own row; only while its own job_id is still null) — the SQL twin of the office pin.
-- finishPublicAcceptance (src/app/q/[token]/actions.ts) then supersedes the original and brings the
-- one job in step, exactly as on the office door.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

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
    -- ("Estimate — Rita Moss" is the tag and the person: no words; the lead door's "New deck — Rita
    -- Moss" is "New deck", and the lead's own spelling, inq.name, counts as the person too); else
    -- "New Job · Sep 27" on the company's today. Was: the title, else 'Job from ' || quote_number.
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
                                 inq.name,
                                 (now() at time zone org_tz)::date),
            'to_be_scheduled',
            site_address, site_unit, site_city, site_state, site_zip,
            q.created_by)
    returning id into new_job;
    update public.quotes set job_id = new_job where id = q.id;
  end if;

  return json_build_object('ok', true);
end $function$;

-- Self-check: the function body carries both additions (a catalog read).
do $$
declare src text;
begin
  select pg_get_functiondef('public.accept_public_quote(text)'::regprocedure) into src;
  if position('revises_quote_id' in src) = 0 then
    raise exception '0392: accept_public_quote does not read revises_quote_id';
  end if;
  if position('and status = ''sent''' in src) = 0 then
    raise exception '0392: accept_public_quote flips the status without a guard';
  end if;
end $$;
