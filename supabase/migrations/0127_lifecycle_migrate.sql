-- LIFECYCLE REWORK step 2/2 (Erik's yellow pad, 2026-07). The new job lifecycle:
--   to_be_scheduled → scheduled → in_progress → on_hold → complete / cancelled
-- "estimate" is no longer a job status (an estimate is a QUOTE; on accept it files away
-- and the job it spawns starts life to_be_scheduled). "invoiced" is no longer a job
-- status (money owed lives in Accounts Receivable, fed by invoices). Postgres can't
-- drop enum values, so the retired ones stay in the type — rows just move off them
-- and the app spine (src/lib/job-status.ts) no longer offers them.

-- Move every row off the retired statuses.
update jobs set status = 'to_be_scheduled' where status = 'estimate';
update jobs set status = 'complete'        where status = 'invoiced';

-- A hand-created job defaults to In Progress (Erik: you make a job when you're working it).
alter table jobs alter column status set default 'in_progress';

-- The public quote-accept path births the job "to_be_scheduled" (was 'scheduled' — it has
-- no dates yet; the schedule promotion flips it to scheduled when a date actually lands).
-- Full function re-created from the LIVE definition (0119 lineage) with that one change.
CREATE OR REPLACE FUNCTION public.accept_public_quote(p_token text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  q public.quotes;
  inq public.inquiries;
  cust_id uuid;
  new_job uuid;
  inq_phone text;
  inq_email text;
  inq_name text;
begin
  select * into q from public.quotes where public_token = p_token;
  if q.id is null then
    return json_build_object('ok', false, 'error', 'Quote not found.');
  end if;

  -- Already accepted → idempotent success (re-tapping the button is harmless).
  if q.status = 'accepted' then
    return json_build_object('ok', true);
  end if;

  -- Only a SENT quote can be accepted. draft/declined/expired/void are not offers.
  if q.status <> 'sent' then
    return json_build_object('ok', false, 'error', 'This quote is no longer available to accept.');
  end if;

  update public.quotes set status = 'accepted', accepted_at = now() where id = q.id;

  -- Deferred-customer estimate → born a Contact now. Crosscheck the book first (same phone / email /
  -- normalized name → link the existing customer, never duplicate), else auto-fill from the inquiry.
  if q.customer_id is null and q.inquiry_id is not null then
    select * into inq from public.inquiries where id = q.inquiry_id;
    if inq.id is not null then
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
                                      address, city, state, zip, notes, created_by)
        values (q.org_id, inq.name, inq.company_name,
                (coalesce(inq.type, 'residential'))::customer_type, 'active'::customer_status,
                inq.email, inq.phone, inq.address, inq.city, inq.state, inq.zip,
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
  end if;

  if q.job_id is null then
    insert into public.jobs (org_id, customer_id, name, status, created_by)
    values (q.org_id, q.customer_id,
            coalesce(nullif(q.title, ''), 'Job from ' || q.quote_number),
            'to_be_scheduled', q.created_by)
    returning id into new_job;
    update public.quotes set job_id = new_job where id = q.id;
  end if;

  return json_build_object('ok', true);
end $function$;
