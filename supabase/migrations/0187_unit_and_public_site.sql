-- 0187 — A DWELLING IS NOT A STREET, and a draft is not a published document.
--
-- Erik: "yes for unit field for TTP, that is key for us and them."
--
-- ── WHY A UNIT COLUMN ────────────────────────────────────────────────────────────────────────
-- Customer "Doe Renee Tolle / Tahoe Tavern Properties" has FOUR jobs at one street address:
--   J-009 "TTP #11"   J-013 "TTP #56"   J-017 "TTP #224"   J-035 "TTP 11 - garbage disposal"
-- all at 300 W Lake Blvd, Tahoe City, CA 96145. The unit number exists ONLY inside jobs.name, so
-- every document any of them produces states an address that identifies the building and not the
-- dwelling — and two of those four are already PAID invoices with live public tokens. No parser,
-- resolver or geocode recovers a unit from "300 W Lake Blvd". It has to be a field.
--
-- The five tables are the ones 0177 treated as the address spine, and for the same reasons:
-- jobs (the site), quotes (createJobFromQuote reads quotes.address FIRST, so a quote that can
-- hold a street but not a unit hands the job a half-address), inquiries (the only correct capture
-- in the chain, and the public intake door), appointments (linkAppointmentTo copies parts down and
-- createJobFromAppointment pushes them into the job — a gap here drops the unit on every job born
-- from a walk-through, and the crew drives to the appointment), customers (a mailing address has
-- apartments too). NOT invoices: an invoice has no site of its own, it inherits through job_id,
-- and a second column set is a second truth that can disagree with the job the crew worked.
--
-- ── THE BACKFILL, AND THE ESCAPE THAT ALMOST ATE IT ──────────────────────────────────────────
-- The first draft of this migration used \b as a word boundary. In PostgreSQL's ARE dialect \b is
-- a character-entry escape meaning BACKSPACE (U+0008) — the word-boundary constraint escapes are
-- \y, \m, \M. So the guard required a literal backspace after the digits, matched NOTHING, and the
-- migration reported success: the silent-write law reproduced one layer down, inside the migration
-- whose entire purpose is to write those four rows. Verified against production before writing
-- this file: \y matches 4 rows and extracts 11 / 56 / 224 / 11; \b matches 0.
--
-- This is not a parser inventing a city. The digits are verbatim in a string a human typed, the
-- destination column is empty, and the whole thing reverses with one UPDATE. jobs.name is NOT
-- touched: Erik typed "TTP #11", jobLabel() prints it on every board both owners navigate by, and
-- two of the four are on paper a customer is already holding.

alter table public.jobs         add column if not exists unit text;
alter table public.quotes       add column if not exists unit text;
alter table public.inquiries    add column if not exists unit text;
alter table public.appointments add column if not exists unit text;
alter table public.customers    add column if not exists unit text;

-- Narrow on purpose: only where the unit is still empty, only on that street, only a leading
-- "TTP <digits>". \y, not \b.
update public.jobs
   set unit = (regexp_match(name, '^\s*TTP\s*#?\s*([0-9]{1,4})\y', 'i'))[1]
 where unit is null
   and name ~* '^\s*TTP\s*#?\s*[0-9]{1,4}\y'
   and address ~* 'lake\s*(blvd|boulevard)';

-- ── THE PUBLIC DOCUMENT RPCs ─────────────────────────────────────────────────────────────────
-- Recreated whole, because a re-created function that copies an old body forward is exactly how a
-- projection regression ships. Both bodies below start from `pg_get_functiondef` of the LIVE
-- functions, not from an older migration file. Three changes each:
--
--   1. A STATUS ALLOWLIST. public_quote selected `where q.public_token = p_token` with no status
--      filter, so a DRAFT estimate — internal pricing, unsent — was readable by anyone holding
--      the token. Live right now: 11 draft quotes, every one with a token. Nothing in the app
--      links a draft's /q URL, emailQuote flips draft→sent on send, and customer_portal (0070)
--      has filtered to ('sent','accepted') since it shipped. So this closes a hole rather than
--      changing a workflow: to publish an estimate, send it. Same shape for invoices.
--
--   2. AN ORG FILTER ON EVERY SUB-SELECT. These are SECURITY DEFINER with search_path=public, so
--      RLS is OFF inside them and a matching id is not a matching tenant. quotes.customer_id is
--      `references customers(id)` with no org constraint, so a cross-org id set through a direct
--      PostgREST PATCH would have rendered another tenant's name and mailing address on an
--      anon-readable page. The org sub-select had this all along; the customer one never did.
--
--   3. SITE CANDIDATES, RAW. The quote's own address, the linked job's, the linked lead's —
--      handed over as-is, in that order, with NO precedence applied in SQL. pickSite() in
--      src/lib/site-address.ts is the single implementation of "which address wins", and the
--      office print page and this public page must agree to the character or the same
--      QuoteDocument renders two different documents.

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
      'unit_price', li.unit_price, 'line_total', li.line_total) order by li.sort_order)
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
    -- LETTERHEAD ONLY (0059's list). Never to_jsonb(o): organizations carries the
    -- settings jsonb (markup, labor rate, playbook, lead_inbound_secret) and the
    -- Stripe/subscription columns. If you re-create this function, copy THIS body.
    'org', (select json_build_object(
      'name', o.name, 'logo_url', o.logo_url,
      'address_line1', o.address_line1, 'address_line2', o.address_line2,
      'city', o.city, 'state', o.state, 'zip', o.zip,
      'phone', o.phone, 'email', o.email, 'license', o.license,
      'brand_color', o.brand_color,
      'doc_template', o.doc_template, 'doc_templates', o.doc_templates)
      from public.organizations o where o.id = q.org_id)
  )
  from public.quotes q
  where q.public_token = p_token
    and q.status in ('sent', 'accepted', 'declined', 'expired');
$$;

create or replace function public.public_invoice(p_token text)
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
      'doc_template', o.doc_template, 'doc_templates', o.doc_templates)
      from public.organizations o where o.id = i.org_id)
  )
  from public.invoices i
  where i.public_token = p_token
    and i.status in ('sent', 'partial', 'paid', 'overdue');
$$;
