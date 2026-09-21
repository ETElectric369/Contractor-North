-- THE TWO THINGS THE PAY NOW DOORS NEED, WHICH THE PUBLIC PROJECTION DID NOT CARRY (2026-09-20).
--
-- public_invoice() is the ONE read a customer's invoice link makes, and it hands back a fixed
-- json_build_object. Two settings added this wave live behind it:
--
--   card_fee_percent       - if the page cannot read it, a fee-bearing button prints the bare
--                            balance and charges more. A surcharge nobody was shown is exactly the
--                            thing a surcharge must never be.
--   bank_transfer_enabled  - ACH settles days later on `checkout.session.async_payment_succeeded`,
--                            an event that is NOT on a connected-accounts destination by default.
--                            A bank button on an account without it takes a customer's money and
--                            never closes the invoice. So the door stays shut until Erik has done
--                            the Stripe step and turned it on, and this is how the page knows.
--
-- The projection law, on the one read a customer makes. Everything else in the function is 0247's
-- definition, unchanged.

CREATE OR REPLACE FUNCTION public.public_invoice(p_token text)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select json_build_object(
    'invoice', json_build_object(
      'invoice_number', i.invoice_number, 'status', i.status, 'title', i.title,
      'description', i.description,
      'notes', i.notes, 'tax_rate', i.tax_rate, 'subtotal', i.subtotal,
      'tax', i.tax, 'total', i.total, 'amount_paid', i.amount_paid,
      'due_date', i.due_date, 'created_at', i.created_at,
      'invoice_kind', i.invoice_kind,
      'billing_type', (select j.billing_type from public.jobs j
                        where j.id = i.job_id and j.org_id = i.org_id)),
    'items', coalesce((select json_agg(json_build_object(
      'description', it.description, 'quantity', it.quantity, 'unit', it.unit,
      'unit_price', it.unit_price, 'line_total', it.line_total,
      'import_source', it.import_source) order by it.sort_order)
      from public.invoice_items it where it.invoice_id = i.id), '[]'::json),
    -- 0247: the payment history the PDF prints. Amount + date + method only — never a note, a
    -- stripe id or a recorder, which are internal.
    'payments', coalesce((select json_agg(json_build_object(
      'amount', p.amount, 'paid_at', p.paid_at, 'method', p.method) order by p.paid_at)
      from public.payments p where p.invoice_id = i.id), '[]'::json),
    'customer', (select json_build_object('name', c.name, 'company_name', c.company_name,
      'address', c.address, 'unit', c.unit, 'city', c.city, 'state', c.state, 'zip', c.zip)
      from public.customers c where c.id = i.customer_id and c.org_id = i.org_id),
    -- An invoice owns no site; it inherits the job's. One candidate, still a list, so the caller
    -- runs the same pickSite() as everywhere else.
    'site_candidates', json_build_array(
      (select json_build_object('source', 'job', 'parts', json_build_object(
        'address', j.address, 'unit', j.unit, 'city', j.city, 'state', j.state, 'zip', j.zip))
        from public.jobs j where j.id = i.job_id and j.org_id = i.org_id)),
    'org', (select json_build_object(
      'name', o.name, 'logo_url', o.logo_url,
      'address_line1', o.address_line1, 'address_line2', o.address_line2,
      'city', o.city, 'state', o.state, 'zip', o.zip,
      'phone', o.phone, 'email', o.email, 'license', o.license,
      'brand_color', o.brand_color,
      'doc_template', o.doc_template, 'doc_templates', o.doc_templates,
      'doc_style', o.settings->'doc_style',
      -- 0247: one boolean so "Pay now" can be honest instead of dying on a 503, plus the terms
      -- and footer the downloaded PDF has always shown.
      'can_take_card', coalesce(o.stripe_charges_enabled, false),
      -- 0283: the two Pay Now doors need what the office set, or the page shows a button whose
      -- price it cannot state and a door whose settlement event may not be subscribed.
      'card_fee_percent', coalesce((o.settings->>'card_fee_percent')::numeric, 0),
      'bank_transfer_enabled', coalesce((o.settings->>'bank_transfer_enabled')::boolean, false),
      'invoice_terms', o.settings->>'invoice_terms',
      'document_footer', o.settings->>'document_footer')
      from public.organizations o where o.id = i.org_id)
  )
  from public.invoices i
  where i.public_token = p_token
    and i.status in ('sent', 'partial', 'paid', 'overdue');
$function$
;
