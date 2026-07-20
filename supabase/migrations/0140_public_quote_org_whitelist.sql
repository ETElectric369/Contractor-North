-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0140: RE-fix the public_quote org leak (CRITICAL)
--
-- Deep-dive audit 2026-07-20. 0059_public_share_safe_org replaced `to_jsonb(o)`
-- with a letterhead whitelist in BOTH public_quote and public_invoice, naming the
-- leak in its header. Three later migrations re-created public_quote by copying
-- the PRE-0059 body forward and silently restored it:
--     0119_deferred_quote_customer  → to_jsonb(o)
--     0121_public_quote_description → to_jsonb(o)
--     0124_public_quote_circuits    → to_jsonb(o)   ← the definition live in prod
-- public_invoice and public_contract kept their whitelists, so this was
-- quote-only and clearly accidental — but public_quote is SECURITY DEFINER and
-- granted to anon, so ANY holder of a texted /q/<token> link could POST the token
-- to /rest/v1/rpc/public_quote (anon key is in the public bundle) and read the
-- ENTIRE organizations row: settings.default_markup_pct + default_labor_rate
-- (→ back-computes true cost on every line they were quoted), quote_playbook,
-- material_buffer_percent, **lead_inbound_secret** (the bearer for
-- POST /api/inbound/lead), plus stripe_customer_id / stripe_subscription_id /
-- subscription_status / plan + trial dates.
--
-- This migration restores 0059's exact 13-field letterhead projection onto the
-- CURRENT (0124) body — keeping q.description, q.circuits and the inquiry-fallback
-- customer that the later migrations legitimately added. No app change needed:
-- src/app/q/[token]/page.tsx consumes only companyFromOrg(org)/templateFor(org),
-- which read exactly these fields.
--
-- lead_inbound_secret must be treated as DISCLOSED for both orgs and rotated
-- (guarded setter — it is in PROTECTED_SETTINGS_KEYS).
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
      'unit_price', li.unit_price, 'line_total', li.line_total) order by li.sort_order)
      from public.quote_line_items li where li.quote_id = q.id), '[]'::json),
    'customer', coalesce(
      (select json_build_object('name', c.name, 'company_name', c.company_name,
        'address', c.address, 'city', c.city, 'state', c.state, 'zip', c.zip)
        from public.customers c where c.id = q.customer_id),
      (select json_build_object('name', i.name, 'company_name', i.company_name,
        'address', i.address, 'city', i.city, 'state', i.state, 'zip', i.zip)
        from public.inquiries i where i.id = q.inquiry_id)),
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
  from public.quotes q where q.public_token = p_token;
$$;

grant execute on function public.public_quote(text) to anon, authenticated;
