-- Customer portal: a passwordless per-customer hub at /portal/[token] that INDEXES the
-- customer's own invoices, contracts, quotes, and jobs and links to the existing public
-- /i /c /q pages. Read-only; internal drafts are never exposed. Mirrors the public_*
-- RPC pattern (whitelisted fields, anon grant, keyed by an unguessable token).

alter table public.customers add column if not exists portal_token text;
-- Backfill existing rows BEFORE the default/not-null so they each get a unique token.
update public.customers set portal_token = encode(gen_random_bytes(16), 'hex') where portal_token is null;
alter table public.customers alter column portal_token set default encode(gen_random_bytes(16), 'hex');
alter table public.customers alter column portal_token set not null;
drop index if exists customers_portal_token_idx;  -- redundant; the unique index below indexes it
create unique index if not exists customers_portal_token_key on public.customers(portal_token);

create or replace function public.customer_portal(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'customer', json_build_object('name', c.name, 'company_name', c.company_name),
    'org', (select json_build_object(
        'name', o.name, 'logo_url', o.logo_url, 'phone', o.phone, 'email', o.email,
        'brand_color', o.brand_color, 'address_line1', o.address_line1,
        'city', o.city, 'state', o.state, 'zip', o.zip, 'license', o.license)
      from public.organizations o where o.id = c.org_id),
    'invoices', coalesce((select json_agg(json_build_object(
        'invoice_number', i.invoice_number, 'status', i.status, 'total', i.total,
        'amount_paid', i.amount_paid, 'public_token', i.public_token, 'created_at', i.created_at)
        order by i.created_at desc)
      from public.invoices i where i.customer_id = c.id and i.status in ('sent', 'partial', 'paid', 'overdue')), '[]'::json),
    'contracts', coalesce((select json_agg(json_build_object(
        'contract_number', ct.contract_number, 'status', ct.status, 'title', ct.title,
        'public_token', ct.public_token, 'signed_at', ct.signed_at) order by ct.created_at desc)
      from public.contracts ct where ct.customer_id = c.id and ct.status in ('sent', 'signed')), '[]'::json),
    'quotes', coalesce((select json_agg(json_build_object(
        'quote_number', q.quote_number, 'status', q.status, 'total', q.total,
        'doc_type', q.doc_type, 'public_token', q.public_token) order by q.created_at desc)
      from public.quotes q where q.customer_id = c.id and q.status in ('sent', 'accepted')), '[]'::json),
    -- Allowlist of customer-facing statuses (fail-closed): never surface internal
    -- pre-sale 'estimate' jobs or a future internal status to the customer.
    'jobs', coalesce((select json_agg(json_build_object(
        'name', j.name, 'status', j.status, 'job_number', j.job_number) order by j.created_at desc)
      from public.jobs j where j.customer_id = c.id and j.status in ('scheduled', 'in_progress', 'on_hold', 'complete', 'invoiced')), '[]'::json)
  )
  from public.customers c where c.portal_token = p_token;
$$;
grant execute on function public.customer_portal(text) to anon, authenticated;
