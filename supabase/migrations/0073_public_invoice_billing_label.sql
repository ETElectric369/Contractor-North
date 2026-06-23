-- The invoice document now shows a clear "Time & Material vs Fixed-Price" statement.
-- Expose invoice_kind + the job's billing_type through the public_invoice RPC so the
-- customer's online/print view shows the SAME label as the in-app print (no drift).
-- Still whitelisted — no full-row / org-settings exposure.
CREATE OR REPLACE FUNCTION public.public_invoice(p_token text)
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select json_build_object(
    'invoice', json_build_object(
      'invoice_number', i.invoice_number, 'status', i.status, 'title', i.title,
      'notes', i.notes, 'tax_rate', i.tax_rate, 'subtotal', i.subtotal,
      'tax', i.tax, 'total', i.total, 'amount_paid', i.amount_paid,
      'due_date', i.due_date, 'created_at', i.created_at,
      'invoice_kind', i.invoice_kind,
      'billing_type', (select j.billing_type from public.jobs j where j.id = i.job_id)),
    'items', coalesce((select json_agg(json_build_object(
      'description', it.description, 'quantity', it.quantity, 'unit', it.unit,
      'unit_price', it.unit_price, 'line_total', it.line_total) order by it.sort_order)
      from public.invoice_items it where it.invoice_id = i.id), '[]'::json),
    'customer', (select json_build_object('name', c.name, 'company_name', c.company_name,
      'address', c.address, 'city', c.city, 'state', c.state, 'zip', c.zip)
      from public.customers c where c.id = i.customer_id),
    'org', (select json_build_object(
      'name', o.name, 'logo_url', o.logo_url,
      'address_line1', o.address_line1, 'address_line2', o.address_line2,
      'city', o.city, 'state', o.state, 'zip', o.zip,
      'phone', o.phone, 'email', o.email, 'license', o.license,
      'brand_color', o.brand_color,
      'doc_template', o.doc_template, 'doc_templates', o.doc_templates)
      from public.organizations o where o.id = i.org_id)
  )
  from public.invoices i where i.public_token = p_token;
$function$;
