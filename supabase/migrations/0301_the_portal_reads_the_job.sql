-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0301: the portal reads the job, through one door with the gate inside
--
-- Erik, 2026-09-24: "He should see everything the invoice shows and everything related for the job
-- in an interactive UI" and "Update everything right away yes always". So /portal/<token>/jobs/<id>
-- reads the job LIVE on every load (no snapshot, no publish button) and shows: the stretches with
-- each day's people, hours and dollars as billed, the materials at the customer's price, the
-- payments and the running balance after each stretch; every non-void invoice on the job exactly
-- as /i shows it; the saved picks; the photos the office chose; and the work not on a bill yet.
--
-- THREE CHANGES:
--
--  1. invoice_document_projection(invoice_id): the document projection public_invoice has always
--     returned, moved into its own function so the portal renders an invoice from the SAME
--     projection /i does (public-rpc-projection-parity: a second hand-written projection is the
--     one that silently drops a column the document classifies on). public_invoice is rebuilt
--     from its LIVE definition (2026-09-24, 0247 + 0283) to call it, and a self-check below proves
--     every existing /i link returns byte-for-byte what it returned before. Nobody but the
--     definer functions can call the projection directly: it takes an id, not a token, so it is
--     not a door.
--
--  2. customer_portal: each job now carries its id, so the list can link to the job page. Rebuilt
--     from the LIVE definition (0298). Nothing else in it changes.
--
--  3. portal_job_view(token, job_id): SECURITY DEFINER, service role ONLY. The gate is inside:
--       - the token names an access row that is switched on (a turned-off or replaced link gets
--         {disabled, org name} and nothing else, exactly as customer_portal answers it);
--       - the job is in the token's org AND belongs to the token's customer AND has a
--         customer-facing status (the customer_portal allowlist);
--       - invoices are the job's non-void ones billed to THAT customer (an invoice on the same job
--         billed to someone else is someone else's paper);
--       - labor sources are read in the token's org only, and only as a name and the clock times
--         (never GPS, notes, pay rates, rate overrides, mileage);
--       - material sources give only their dates (never the supplier, the amount or the lines);
--       - picks are the job's live ones (never a price: the table has none);
--       - photos are those with a job_shared_photos row, category Photo, on this job, in the job's
--         own folder, whose documents.file_url still equals the file the office shared AND whose
--         stored object is still the version the office shared (an upload over the same path is a
--         different file). Never a folder listing.
--     It returns raw building blocks plus a `scope` the server uses to sign files and read the
--     unbilled work, and the server (src/lib/portal/job-view.ts) turns them into the allowlisted
--     page payload. A customer never reaches any of this through RLS.
--
-- ORDER: after 0300. Deploy-safe either way: the portal job page reads "not ready" until this is
-- applied, and nothing else calls these functions.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the invoice document, one projection for every door ────────────────────────────────────
-- What /i (public_invoice) returns TODAY, keyed by invoice for the self-check below.
create temp table _0301_public_invoice_before as
select i.public_token, public.public_invoice(i.public_token)::text as j
  from public.invoices i
 where i.public_token is not null
   and i.status in ('sent', 'partial', 'paid', 'overdue');

create or replace function public.invoice_document_projection(p_invoice_id uuid)
returns json language sql stable security definer set search_path = public as $$
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
  where i.id = p_invoice_id;
$$;
comment on function public.invoice_document_projection(uuid) is
  'The invoice document as every customer-facing door shows it (0301): /i via public_invoice, the portal via portal_job_view. Takes an id, so it is not a door itself: callable by the definer functions and the service role only.';
revoke execute on function public.invoice_document_projection(uuid) from public, anon, authenticated;
grant execute on function public.invoice_document_projection(uuid) to service_role;

-- /i: the same token gate, the same statuses, the projection above.
create or replace function public.public_invoice(p_token text)
returns json language sql stable security definer set search_path = public as $$
  select public.invoice_document_projection(i.id)
    from public.invoices i
   where i.public_token = p_token
     and i.status in ('sent', 'partial', 'paid', 'overdue');
$$;

do $$
declare n int;
begin
  select count(*) into n
    from _0301_public_invoice_before b
   where b.j is distinct from public.public_invoice(b.public_token)::text;
  if n > 0 then
    raise exception '0301: % invoice link(s) would show something different after the move. Nothing was changed.', n;
  end if;
end $$;
drop table _0301_public_invoice_before;

-- ── 2. the portal's job list links to each job ─────────────────────────────────────────────────
-- Rebuilt from the LIVE pg_get_functiondef (0298, 2026-09-24). One change: 'id' on each job.
create or replace function public.customer_portal(p_token text)
returns json language plpgsql stable security definer set search_path = public as $$
declare
  a public.customer_portal_access%rowtype;
  v_org uuid;
begin
  if p_token is null or length(p_token) < 32 then
    return null;
  end if;

  select * into a from public.customer_portal_access where token = p_token;
  if not found then
    -- A link the office replaced: say it was turned off, never what it used to show.
    select r.org_id into v_org from public.customer_portal_retired_links r where r.token = p_token;
    if v_org is null then
      return null;
    end if;
    return json_build_object('disabled', true,
      'org', (select json_build_object('name', o.name) from public.organizations o where o.id = v_org));
  end if;

  if not a.enabled then
    return json_build_object('disabled', true,
      'org', (select json_build_object('name', o.name) from public.organizations o where o.id = a.org_id));
  end if;

  return (
    select json_build_object(
      'customer', json_build_object('name', c.name, 'company_name', c.company_name),
      'org', (select json_build_object(
          'name', o.name, 'logo_url', o.logo_url, 'phone', o.phone, 'email', o.email,
          'brand_color', o.brand_color, 'license', o.license)
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
      -- 0301: 'id', so the list links to /portal/<token>/jobs/<id>. portal_job_view re-checks that
      -- the job is this customer's on every read; the id is an address, never a key.
      'jobs', coalesce((select json_agg(json_build_object(
          'id', j.id, 'name', j.name, 'status', j.status, 'job_number', j.job_number) order by j.created_at desc)
        from public.jobs j where j.customer_id = c.id and j.org_id = c.org_id
          and j.status in ('to_be_scheduled', 'scheduled', 'in_progress', 'on_hold', 'complete', 'invoiced')), '[]'::json)
    )
    from public.customers c
   where c.id = a.customer_id and c.org_id = a.org_id
  );
end $$;
revoke execute on function public.customer_portal(text) from public, anon, authenticated;
grant execute on function public.customer_portal(text) to service_role;

-- ── 3. one job, for the customer holding the link ──────────────────────────────────────────────
create or replace function public.portal_job_view(p_token text, p_job_id uuid)
returns json language plpgsql stable security definer set search_path = public as $$
declare
  a public.customer_portal_access%rowtype;
  v_org uuid;
  j public.jobs%rowtype;
  v_inv uuid[];
begin
  if p_token is null or length(p_token) < 32 or p_job_id is null then
    return null;
  end if;

  select * into a from public.customer_portal_access where token = p_token;
  if not found then
    select r.org_id into v_org from public.customer_portal_retired_links r where r.token = p_token;
    if v_org is null then
      return null;
    end if;
    return json_build_object('disabled', true,
      'org', (select json_build_object('name', o.name) from public.organizations o where o.id = v_org));
  end if;
  if not a.enabled then
    return json_build_object('disabled', true,
      'org', (select json_build_object('name', o.name) from public.organizations o where o.id = a.org_id));
  end if;

  -- The job must be this customer's, in this org, and in a status a customer is shown.
  select jb.* into j
    from public.jobs jb
    join public.customers c on c.id = jb.customer_id and c.org_id = jb.org_id
   where jb.id = p_job_id
     and jb.org_id = a.org_id
     and jb.customer_id = a.customer_id
     and jb.status in ('to_be_scheduled', 'scheduled', 'in_progress', 'on_hold', 'complete', 'invoiced');
  if not found then
    return null;
  end if;

  -- The job's paper that is THIS customer's: non-void, billed to them.
  select coalesce(array_agg(i.id order by i.created_at), '{}') into v_inv
    from public.invoices i
   where i.job_id = j.id and i.org_id = a.org_id and i.customer_id = a.customer_id and i.status <> 'void';

  return json_build_object(
    -- For the server only (signing files, reading the unbilled work); never rendered.
    'scope', json_build_object('org_id', a.org_id, 'job_id', j.id, 'customer_id', a.customer_id),
    'org', (select json_build_object(
        'name', o.name, 'logo_url', o.logo_url, 'phone', o.phone, 'email', o.email,
        'license', o.license, 'brand_color', o.brand_color,
        'glass_tint', o.settings->>'glass_tint', 'timezone', o.settings->>'timezone')
      from public.organizations o where o.id = a.org_id),
    'customer', (select json_build_object('name', c.name, 'company_name', c.company_name)
      from public.customers c where c.id = a.customer_id and c.org_id = a.org_id),
    'job', json_build_object(
      'id', j.id, 'name', j.name, 'job_number', j.job_number, 'status', j.status,
      'address', j.address, 'unit', j.unit, 'city', j.city, 'state', j.state, 'zip', j.zip),
    -- Which way the job bills (the Unbilled card's rule, applied by the server: jobBillsItsActuals).
    'billing', json_build_object(
      'billing_type', j.billing_type,
      'quote_statuses', coalesce((select json_agg(q.status) from public.quotes q
                       where q.job_id = j.id and q.org_id = a.org_id), '[]'::json),
      'milestones', (select count(*) from public.payment_milestones m where m.job_id = j.id and m.org_id = a.org_id)),
    'stretches', coalesce((select json_agg(json_build_object(
        'id', s.id, 'label', s.label, 'starts_on', s.starts_on, 'ends_on', s.ends_on, 'sort', s.sort)
        order by s.starts_on, s.sort, s.created_at)
      from public.job_stretches s
     where s.job_id = j.id and s.org_id = a.org_id and s.removed_at is null), '[]'::json),
    'invoices', coalesce((select json_agg(json_build_object(
        'id', i.id, 'invoice_number', i.invoice_number, 'status', i.status, 'invoice_kind', i.invoice_kind,
        'subtotal', i.subtotal, 'tax', i.tax, 'total', i.total, 'amount_paid', i.amount_paid,
        'created_at', i.created_at, 'sent_at', i.sent_at,
        -- The pay door (/i/<token>) exists only for a bill that was sent. A draft has none.
        'public_token', case when i.status in ('sent', 'partial', 'paid', 'overdue') then i.public_token end,
        'doc', public.invoice_document_projection(i.id))
        order by i.created_at)
      from public.invoices i where i.id = any(v_inv)), '[]'::json),
    'lines', coalesce((select json_agg(json_build_object(
        'invoice_id', it.invoice_id, 'sort_order', it.sort_order, 'description', it.description,
        'quantity', it.quantity, 'unit', it.unit, 'unit_price', it.unit_price, 'line_total', it.line_total,
        'import_source', it.import_source,
        -- The hours a labor line bills: who, and the clock. Nothing else about the entry.
        'entries', case when it.import_source = 'labor' then coalesce((select json_agg(json_build_object(
            'person', coalesce(nullif(btrim(p.full_name), ''), 'Crew'),
            'clock_in', t.clock_in, 'clock_out', t.clock_out, 'lunch_minutes', t.lunch_minutes)
            order by t.clock_in, t.id)
          from public.time_entries t
          left join public.profiles p on p.id = t.profile_id and p.org_id = t.org_id
         where t.id = any(it.source_ids) and t.org_id = a.org_id), '[]'::json) end,
        -- When a material line's purchase happened: the bill's date (or when it was filed), the
        -- order's date. Never who sold it or what it cost.
        'sources', case when it.import_source = 'costs' then coalesce((
          select json_agg(x.src order by x.at) from (
            select json_build_object('date', b.bill_date, 'at', b.created_at) as src, b.created_at as at
              from public.bills b where b.id = any(it.source_ids) and b.org_id = a.org_id
            union all
            select json_build_object('date', null, 'at', coalesce(po.ordered_at, po.created_at)), po.created_at
              from public.purchase_orders po where po.id = any(it.source_ids) and po.org_id = a.org_id
          ) x), '[]'::json) end)
        order by it.invoice_id, it.sort_order)
      from public.invoice_items it where it.invoice_id = any(v_inv) and it.org_id = a.org_id), '[]'::json),
    'payments', coalesce((select json_agg(json_build_object(
        'invoice_id', p.invoice_id, 'amount', p.amount, 'paid_at', p.paid_at, 'method', p.method)
        order by p.paid_at, p.created_at)
      from public.payments p where p.invoice_id = any(v_inv) and p.org_id = a.org_id), '[]'::json),
    'picks', coalesce((select json_agg(json_build_object(
        'id', k.id, 'category', k.category, 'brand', k.brand, 'name', k.name, 'code', k.code,
        'location', k.location, 'note', k.note, 'color_hex', k.color_hex, 'link_url', k.link_url,
        'file_path', k.file_path, 'file_kind', k.file_kind, 'updated_at', k.updated_at)
        order by k.sort, k.created_at)
      from public.job_picks k
     where k.job_id = j.id and k.org_id = a.org_id and k.removed_at is null), '[]'::json),
    'photos', coalesce((select json_agg(json_build_object(
        'id', d.id, 'file_path', d.file_url, 'added_at', d.created_at)
        order by d.created_at desc, d.id)
      from public.job_shared_photos s
      join public.documents d on d.id = s.document_id
     where s.job_id = j.id and s.org_id = a.org_id
       and d.job_id = j.id and d.org_id = a.org_id
       and d.category = 'Photo'
       and d.file_url = s.file_url_at_share
       and d.file_url like (a.org_id::text || '/' || j.id::text || '/%')
       and public.documents_object_version(d.file_url) is not distinct from s.object_version_at_share), '[]'::json)
  );
end $$;
comment on function public.portal_job_view(text, uuid) is
  'The customer portal''s job page (0301). Service role only; the gate (link on, job is this customer''s in this org, customer-facing status) is inside. Returns building blocks the server turns into the allowlisted page payload (src/lib/portal/job-view.ts).';
revoke execute on function public.portal_job_view(text, uuid) from public, anon, authenticated;
grant execute on function public.portal_job_view(text, uuid) to service_role;

-- ── self-check ─────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('anon', 'public.portal_job_view(text, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.portal_job_view(text, uuid)', 'execute')
     or has_function_privilege('anon', 'public.invoice_document_projection(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.invoice_document_projection(uuid)', 'execute')
     or has_function_privilege('anon', 'public.customer_portal(text)', 'execute')
     or has_function_privilege('authenticated', 'public.customer_portal(text)', 'execute') then
    raise exception '0301: a portal read is callable without the service role. Nothing was changed.';
  end if;
  -- /i stays the open token door it has always been.
  if not has_function_privilege('anon', 'public.public_invoice(text)', 'execute') then
    raise exception '0301: /i lost its door. Nothing was changed.';
  end if;
end $$;
