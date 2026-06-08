-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0012: public share links for quotes & invoices
-- Adds a random public_token + read-only RPCs so a customer can view a quote or
-- invoice from a texted/emailed link without logging in. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.quotes   add column if not exists public_token text;
alter table public.invoices add column if not exists public_token text;

update public.quotes   set public_token = encode(gen_random_bytes(16), 'hex') where public_token is null;
update public.invoices set public_token = encode(gen_random_bytes(16), 'hex') where public_token is null;

alter table public.quotes   alter column public_token set default encode(gen_random_bytes(16), 'hex');
alter table public.invoices alter column public_token set default encode(gen_random_bytes(16), 'hex');

create unique index if not exists quotes_public_token_idx   on public.quotes(public_token);
create unique index if not exists invoices_public_token_idx on public.invoices(public_token);

-- ── Public read RPCs (SECURITY DEFINER; callable by anon via a valid token) ──
create or replace function public.public_quote(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'quote', json_build_object(
      'quote_number', q.quote_number, 'status', q.status, 'title', q.title,
      'notes', q.notes, 'tax_rate', q.tax_rate, 'subtotal', q.subtotal,
      'tax', q.tax, 'total', q.total, 'valid_until', q.valid_until,
      'created_at', q.created_at),
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

create or replace function public.public_invoice(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'invoice', json_build_object(
      'invoice_number', i.invoice_number, 'status', i.status, 'title', i.title,
      'notes', i.notes, 'tax_rate', i.tax_rate, 'subtotal', i.subtotal,
      'tax', i.tax, 'total', i.total, 'amount_paid', i.amount_paid,
      'due_date', i.due_date, 'created_at', i.created_at),
    'items', coalesce((select json_agg(json_build_object(
      'description', it.description, 'quantity', it.quantity, 'unit', it.unit,
      'unit_price', it.unit_price, 'line_total', it.line_total) order by it.sort_order)
      from public.invoice_items it where it.invoice_id = i.id), '[]'::json),
    'customer', (select json_build_object('name', c.name, 'company_name', c.company_name,
      'address', c.address, 'city', c.city, 'state', c.state, 'zip', c.zip)
      from public.customers c where c.id = i.customer_id),
    'org', (select to_jsonb(o) from public.organizations o where o.id = i.org_id)
  )
  from public.invoices i where i.public_token = p_token;
$$;

grant execute on function public.public_quote(text)   to anon, authenticated;
grant execute on function public.public_invoice(text) to anon, authenticated;
