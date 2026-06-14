-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0048: expose doc_type on the public quote RPC
-- The customer-facing shared link must show the right word — a time-&-materials
-- "Estimate" vs a fixed-price "Quote" — so the anon RPC now returns doc_type.
-- ═══════════════════════════════════════════════════════════════════════════

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
    'customer', (select json_build_object('name', c.name, 'company_name', c.company_name,
      'address', c.address, 'city', c.city, 'state', c.state, 'zip', c.zip)
      from public.customers c where c.id = q.customer_id),
    'org', (select to_jsonb(o) from public.organizations o where o.id = q.org_id)
  )
  from public.quotes q where q.public_token = p_token;
$$;
