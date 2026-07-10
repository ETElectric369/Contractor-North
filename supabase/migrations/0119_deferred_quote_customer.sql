-- Deferred-customer estimates (cn-v477). Erik's lead flow: a prospect becomes a saved Contact ONLY
-- when the estimate is APPROVED, not when it's drafted — so an estimate can carry inquiry_id with a
-- NULL customer_id. Two prospect-facing SECURITY DEFINER RPCs must learn about that state:
--
--   1. public_quote      — the estimate a prospect views. When there's no customer yet, fall back to
--                          the linked inquiry's name/address so the "To:" block isn't blank.
--   2. accept_public_quote — the prospect's online "Accept". At the win, materialize the Contact from
--                          the inquiry (CROSSCHECKING the book by phone/email/name so an existing
--                          customer is LINKED, never duplicated), stamp the lead won, THEN spin up the
--                          job with that customer. Mirrors the staff-side materializeQuoteCustomer().
--
-- Both remain byte-for-byte compatible for the normal case (quote already has a customer_id).

-- 1 ── public_quote: customer falls back to the inquiry when no Contact exists yet.
create or replace function public.public_quote(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'quote', json_build_object(
      'quote_number', q.quote_number, 'status', q.status, 'title', q.title,
      'notes', q.notes, 'tax_rate', q.tax_rate, 'subtotal', q.subtotal,
      'tax', q.tax, 'total', q.total, 'valid_until', q.valid_until,
      'doc_type', q.doc_type, 'created_at', q.created_at),
    'items', coalesce((select json_agg(json_build_object(
      'description', li.description, 'quantity', li.quantity, 'unit', li.unit,
      'unit_price', li.unit_price, 'line_total', li.line_total) order by li.sort_order)
      from public.quote_line_items li where li.quote_id = q.id), '[]'::json),
    'customer', coalesce(
      (select json_build_object('name', c.name, 'company_name', c.company_name,
        'address', c.address, 'city', c.city, 'state', c.state, 'zip', c.zip)
        from public.customers c where c.id = q.customer_id),
      (select json_build_object('name', i.name, 'company_name', i.company_name,
        'address', i.address, 'city', i.city, 'state', i.state, 'zip', i.zip)
        from public.inquiries i where i.id = q.inquiry_id)),
    'org', (select to_jsonb(o) from public.organizations o where o.id = q.org_id)
  )
  from public.quotes q where q.public_token = p_token;
$$;

-- 2 ── accept_public_quote: materialize the Contact (dedup) at the win, then create the job.
create or replace function public.accept_public_quote(p_token text)
returns json language plpgsql security definer set search_path = public as $$
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
            'scheduled', q.created_by)
    returning id into new_job;
    update public.quotes set job_id = new_job where id = q.id;
  end if;

  return json_build_object('ok', true);
end $$;

grant execute on function public.accept_public_quote(text) to anon, authenticated;
