-- public_quote: expose the quote's description so the customer-facing /q page shows the scope block
-- above the line items too (cn — doc description feature). Adds 'description' to the quote json;
-- everything else identical to 0119.
create or replace function public.public_quote(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'quote', json_build_object(
      'quote_number', q.quote_number, 'status', q.status, 'title', q.title,
      'description', q.description,
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
