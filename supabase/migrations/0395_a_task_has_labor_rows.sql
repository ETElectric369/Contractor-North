-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0395: a task has labor rows, an estimate may name its own paper
-- format, and the job's tasks carry their minutes (cn-v1131)
--
-- THREE SMALL THINGS, ONE WAVE.
--
--  1. AN ESTIMATE'S OWN FORMAT. quotes.estimate_format ('tasks' | 'detailed' | null). The company's
--     Doc Studio choice (settings->doc_style->estimate_format, 0386) stays the default; an estimate
--     may say otherwise for itself (the builder's and the quote page's Paper Format switch). Null =
--     the company's. The app resolves it in ONE place (lib/doc-style estimateFormatFor) and this
--     function's coalesce is that reader's twin on the public wire, so the paper and the /q link
--     never disagree about one estimate.
--
--  2. A TASK'S MINUTES ON THE JOB. tasks.planned_minutes (integer, null = he gave no hours). A task
--     line's labor is one or more rows now (quote_line_items.detail->'labor', each {label,
--     person_id, hours, rate, rate_from}); the job's task is born with their hours summed in minutes
--     (lib/estimate/born-with-tasks), the job's own planned_minutes (0229) stays the whole sum, and
--     the sync keeps a task's figure in step with its line only while it is still the line's figure
--     (lib/estimate/sync-job-tasks). No check: the job's 0229 bound is the schedule's, a task's
--     minutes are a sum the app writes. No data step: the column fills as estimates are accepted.
--
--  3. THE PUBLIC ESTIMATE SHIPS THE LABOR ROWS. public_quote's detail object gains 'labor': one
--     {label, hours, rate} per row, in stored order — NEVER person_id (a Team member's id is the
--     company's), never cost, task_id or kit_id (0386/0387's rule, unchanged). The old hours / rate /
--     units / materials keys stay so a line saved before cn-v1131 still reads on the customer's
--     page (coerceTaskDetail reads an empty labor array beside the old hours as the old shape). The
--     format test becomes the coalesce above: the estimate's own word, else the company's.
--
-- Body = 0387's verbatim except the format test and the 'labor' key. If you re-create this function,
-- copy THIS body. Additive and twice-safe (add column if not exists; CREATE OR REPLACE keeps
-- ownership and grants — the grant is re-stated below all the same).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

alter table public.quotes add column if not exists estimate_format text null check (estimate_format in ('tasks','detailed'));

alter table public.tasks add column if not exists planned_minutes integer null;

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
      -- THE BREAKDOWN THE CUSTOMER MAY SEE (0386/0387/0395): only when the estimate's own format,
      -- else the company's, prints it — and then only his hours, the rate, the units, each labor row's
      -- label / hours / rate and each part's name, count and sell. NEVER cost (the contractor's net),
      -- the task id, the kit id, a book code or a person's id.
      'detail', case
        when jsonb_typeof(li.detail) = 'object'
         and coalesce(q.estimate_format, (select o.settings->'doc_style'->>'estimate_format' from public.organizations o where o.id = q.org_id)) = 'detailed'
        then jsonb_build_object(
          'hours', li.detail->'hours',
          'rate', li.detail->'rate',
          'units', li.detail->'units',
          'labor', coalesce((select jsonb_agg(jsonb_build_object(
              'label', l->'label', 'hours', l->'hours', 'rate', l->'rate') order by ord)
            from jsonb_array_elements(case when jsonb_typeof(li.detail->'labor') = 'array' then li.detail->'labor' else '[]'::jsonb end) with ordinality as lab(l, ord)), '[]'::jsonb),
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

grant execute on function public.public_quote(text) to anon, authenticated;
