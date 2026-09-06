-- 0247 — THE PUBLIC DOORS CARRY WHAT THE PDF CARRIES (audit v921; the remaining "needs a
-- migration" findings on the customer-facing RPCs and the documents bucket).
--
-- Each of these is a PROJECTION-LAW failure: the page can only show what the RPC selected, and
-- these projections were missing fields the same document's PDF has had all along.
--
-- 1) public_contract dropped the customer's UNIT, so a contract's "Prepared for" address lost the
--    apartment/suite line that public_invoice already carries (it selects c.unit). A contract is
--    the document people SIGN — an incomplete address on it is the worst place for this.
--
-- 2) customer_portal's job allowlist predates 0126, which introduced 'to_be_scheduled'. A job
--    created by accepting a quote lands in exactly that status, so the customer who just accepted
--    saw their portal say nothing was happening. The allowlist stays fail-closed (no 'estimate',
--    no 'cancelled'); it just learns the status the product added underneath it.
--
-- 3) public_invoice / public_quote could not tell the page whether the org can actually TAKE a
--    card, so /i offered "Pay now" to every org and the click died on a plain-text 503. The org's
--    Stripe Connect state is one boolean; ship it so the button can be honest. Also ship the
--    terms + footer the PDF renders, so the on-page document and the downloaded one agree.
--    NOTE: only these narrow scalars — never to_jsonb(o), which would hand out settings, Stripe
--    ids and subscription state to anyone holding the link (the rule 0140 exists for).
--
-- 4) docs_path_is_staff_only missed 'bug-screenshots', so a screenshot filed with a bug report —
--    which can show anything that was on the reporter's screen, including another customer's
--    money — was readable by every member of the org. The BugReporter is staff-only in the app
--    shell, so gating insert alongside read/update/delete matches who actually files them.

-- ── 1. the contract's customer keeps its unit ────────────────────────────────────────────────
create or replace function public.public_contract(p_token text)
returns json
language sql
stable security definer
set search_path to 'public'
as $function$
  select json_build_object(
    'contract', json_build_object(
      'contract_number', c.contract_number, 'status', c.status, 'title', c.title,
      'body', c.body, 'signed_body', c.signed_body, 'signed_at', c.signed_at,
      'signed_name', c.signed_name, 'created_at', c.created_at),
    'customer', (select json_build_object('name', cu.name, 'company_name', cu.company_name,
      -- 0247: unit was missing, so a suite/apt line vanished from the signed document.
      'address', cu.address, 'unit', cu.unit, 'city', cu.city, 'state', cu.state, 'zip', cu.zip)
      from public.customers cu where cu.id = c.customer_id),
    -- Whitelist org branding/contact only — NEVER to_jsonb(org), which would leak
    -- settings, stripe ids, and subscription state to anyone with the link.
    'org', (select json_build_object(
        'name', o.name, 'logo_url', o.logo_url, 'address_line1', o.address_line1,
        'address_line2', o.address_line2, 'city', o.city, 'state', o.state, 'zip', o.zip,
        'phone', o.phone, 'email', o.email, 'license', o.license,
        'brand_color', o.brand_color, 'doc_template', o.doc_template, 'doc_templates', o.doc_templates,
        -- 0247: the same document footer the PDF renders.
        'document_footer', o.settings->>'document_footer')
      from public.organizations o where o.id = c.org_id)
  )
  -- Only a shareable contract is public: a draft (not yet sent) or a voided one
  -- returns null -> the page 404s. Mirrors the accept_public_quote status guard.
  from public.contracts c where c.public_token = p_token and c.status in ('sent', 'signed');
$function$;

-- ── 2. the portal shows a job that was just won ──────────────────────────────────────────────
create or replace function public.customer_portal(p_token text)
returns json
language sql
stable security definer
set search_path to 'public'
as $function$
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
    -- 0247: 'to_be_scheduled' (0126) added — a job created by accepting a quote lands there, and
    -- the customer who just accepted was shown nothing at all.
    'jobs', coalesce((select json_agg(json_build_object(
        'name', j.name, 'status', j.status, 'job_number', j.job_number) order by j.created_at desc)
      from public.jobs j where j.customer_id = c.id and j.status in ('to_be_scheduled', 'scheduled', 'in_progress', 'on_hold', 'complete', 'invoiced')), '[]'::json)
  )
  from public.customers c where c.portal_token = p_token;
$function$;

-- ── 3. the invoice door knows whether the org can take a card, and carries its terms ─────────
create or replace function public.public_invoice(p_token text)
returns json
language sql
stable security definer
set search_path to 'public'
as $function$
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
      'invoice_terms', o.settings->>'invoice_terms',
      'document_footer', o.settings->>'document_footer')
      from public.organizations o where o.id = i.org_id)
  )
  from public.invoices i
  where i.public_token = p_token
    and i.status in ('sent', 'partial', 'paid', 'overdue');
$function$;

-- ── 4. a bug screenshot is staff-only, like the other sensitive prefixes ─────────────────────
create or replace function public.docs_path_is_staff_only(p_name text)
returns boolean
language sql
immutable
as $function$
  -- 0247: 'bug-screenshots' added. A screenshot attached to a bug report can show whatever was on
  -- the reporter's screen — another customer's money, a pay rate — and was readable by every
  -- member of the org. The BugReporter only renders for staff, so gating insert too matches who
  -- actually files them.
  select (storage.foldername(p_name))[2] in ('employees', 'organize', 'bug-screenshots');
$function$;
