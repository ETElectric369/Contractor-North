-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0387: the public estimate ships a task's breakdown only when the
-- company's format prints it
--
-- 0386 put a REDACTED breakdown (his hours, the rate, the parts' name/qty/sell) on every public_quote
-- item. The document prints it only under doc_style.estimate_format = 'detailed', but the ANONYMOUS
-- RESPONSE carried it either way — so a company on the default "Tasks Only" format, whose rate card
-- is meant to stay its own, still handed its $/h and part prices to anyone holding a share token
-- (skeptic review of the wave-2 change, 2026-10-09). What rides the wire is decided here, by the
-- same key the document reads: no format, no breakdown.
--
-- Also: the parts come back in the order they were stored (WITH ORDINALITY); 0386 left jsonb_agg's
-- order to chance.
--
-- Body = 0386's verbatim except the `detail` branch. If you re-create this function, copy THIS body.
-- Additive and twice-safe (CREATE OR REPLACE; ownership and grants are preserved).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.public_quote(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'quote', json_build_object(
      'quote_number', q.quote_number, 'status', q.status, 'title', q.title,
      'description', q.description,
      'notes', q.notes, 'tax_rate', q.tax_rate, 'subtotal', q.subtotal,
      'tax', q.tax, 'total', q.total, 'valid_until', q.valid_until,
      'circuits', q.circuits,
      'doc_type', q.doc_type, 'created_at', q.created_at),
    'items', coalesce((select json_agg(json_build_object(
      'description', li.description, 'quantity', li.quantity, 'unit', li.unit,
      'unit_price', li.unit_price, 'line_total', li.line_total,
      -- THE BREAKDOWN THE CUSTOMER MAY SEE (0386/0387): only when the company's format prints it,
      -- and then only his hours, the rate, the units and each part's name, count and sell. NEVER cost
      -- (the contractor's net), the task id, the kit id or a book code.
      'detail', case
        when jsonb_typeof(li.detail) = 'object'
         and (select o.settings->'doc_style'->>'estimate_format' from public.organizations o where o.id = q.org_id) = 'detailed'
        then jsonb_build_object(
          'hours', li.detail->'hours',
          'rate', li.detail->'rate',
          'units', li.detail->'units',
          'materials', coalesce((select jsonb_agg(jsonb_build_object(
              'name', m->'name', 'qty', m->'qty', 'sell', m->'sell') order by ord)
            from jsonb_array_elements(case when jsonb_typeof(li.detail->'materials') = 'array' then li.detail->'materials' else '[]'::jsonb end) with ordinality as mats(m, ord)), '[]'::jsonb))
        else null end) order by li.sort_order)
      from public.quote_line_items li where li.quote_id = q.id), '[]'::json),
    'customer', coalesce(
      (select json_build_object('name', c.name, 'company_name', c.company_name,
        'address', c.address, 'unit', c.unit, 'city', c.city, 'state', c.state, 'zip', c.zip)
        from public.customers c where c.id = q.customer_id and c.org_id = q.org_id),
      (select json_build_object('name', i.name, 'company_name', i.company_name,
        'address', i.address, 'unit', i.unit, 'city', i.city, 'state', i.state, 'zip', i.zip)
        from public.inquiries i where i.id = q.inquiry_id and i.org_id = q.org_id)),
    -- RAW CANDIDATES, most specific first. No precedence here — see pickSite().
    'site_candidates', json_build_array(
      json_build_object('source', 'quote', 'parts', json_build_object(
        'address', q.address, 'unit', q.unit, 'city', q.city, 'state', q.state, 'zip', q.zip)),
      (select json_build_object('source', 'job', 'parts', json_build_object(
        'address', j.address, 'unit', j.unit, 'city', j.city, 'state', j.state, 'zip', j.zip))
        from public.jobs j where j.id = q.job_id and j.org_id = q.org_id),
      (select json_build_object('source', 'lead', 'parts', json_build_object(
        'address', i.address, 'unit', i.unit, 'city', i.city, 'state', i.state, 'zip', i.zip))
        from public.inquiries i where i.id = q.inquiry_id and i.org_id = q.org_id)),
    -- LETTERHEAD ONLY (0059's list) + the doc_style layout sub-key (0239). Never to_jsonb(o):
    -- organizations carries the settings jsonb (markup, labor rate, playbook,
    -- lead_inbound_secret) and the Stripe/subscription columns. If you re-create this
    -- function, copy THIS body.
    'org', (select json_build_object(
      'name', o.name, 'logo_url', o.logo_url,
      'address_line1', o.address_line1, 'address_line2', o.address_line2,
      'city', o.city, 'state', o.state, 'zip', o.zip,
      'phone', o.phone, 'email', o.email, 'license', o.license,
      'brand_color', o.brand_color,
      'doc_template', o.doc_template, 'doc_templates', o.doc_templates,
      'doc_style', o.settings->'doc_style')
      from public.organizations o where o.id = q.org_id)
  )
  from public.quotes q
  where q.public_token = p_token
    and q.status in ('sent', 'accepted', 'declined', 'expired');
$$;
