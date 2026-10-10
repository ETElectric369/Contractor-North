-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0386: a task is the unit, on the estimate too
--
-- Erik (2026-10-09): "the foundation underlying the ability to estimate a project … is pretty much
-- always broken down into tasks … each task carries its own labor and materials." The Inspector now
-- asks for tasks (cn-v1073, the `tasks` playbook slot). This migration lets an ESTIMATE carry them:
--
-- 1. quote_line_items.detail — the breakdown behind a task line: HIS hours, the rate they were
--    priced at, how many units, the kit (if any) and the parts (code, name, qty, cost, sell). The
--    line's own description/quantity/unit_price stay the customer-facing numbers (line_total is
--    still GENERATED from them); detail is how the line was BUILT, so the document can print labor
--    and parts beneath the task when the company's format says so, and the job can be born with the
--    tasks and their parts (next wave). Null on every line that was not built from a task.
-- 2. kits.labor_minutes, kits.unit — a kit that is a TASK PER UNIT ("footing": 90 minutes and these
--    parts, × 7). Null = an ordinary parts kit, exactly as before. Nothing writes these yet; the
--    "Remember As A Kit" door (next waves) will.
-- 3. save_quote_draft (0211) re-created with `detail` in its hard-coded column list, else the
--    builder's autosave would drop every breakdown on the first save.
-- 4. public_quote (0239) re-created to ship a REDACTED detail with each item — hours, rate, units
--    and the parts' name/qty/sell — never the contractor's cost, the task id or the kit id. The
--    public page prints the breakdown only when the company's doc_style asks for it, but what rides
--    the anonymous wire is decided here (public-RPC projection parity).
--
-- Additive and twice-safe. Safe to apply BEFORE the code that writes detail deploys: the old
-- builder sends items without `detail` and the function stores null.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.quote_line_items add column if not exists detail jsonb;
comment on column public.quote_line_items.detail is
  'How a TASK line was built (0386): {task_id, hours, rate, units, kit_id, materials:[{code, name, qty, cost, sell}]}. hours null = he has not given them (the line prices $0 and asks). Null on a line not built from a task.';

alter table public.kits add column if not exists labor_minutes integer;
alter table public.kits add column if not exists unit text;
comment on column public.kits.labor_minutes is
  'A task-per-unit kit (0386): his labor minutes for ONE unit of it. Null = an ordinary parts kit.';
comment on column public.kits.unit is
  'The unit a task kit is counted in — "footing", "step", "opening" (0386). Null for an ordinary kit.';

-- 3. The atomic draft rewrite, with detail. Body = 0211 verbatim plus the one column.
create or replace function public.save_quote_draft(
  p_id uuid,
  p_fields jsonb,
  p_items jsonb
)
returns table (id uuid, quote_number text)
language plpgsql
security invoker
as $$
declare
  v_status text;
  v_existing integer;
begin
  select q.status into v_status from quotes q where q.id = p_id for update;
  if v_status is null then
    raise exception 'QUOTE_GONE';
  end if;
  if v_status <> 'draft' then
    raise exception 'QUOTE_NOT_DRAFT';
  end if;

  -- WIPE GUARD: replacing a populated document with ZERO lines is almost always an unhydrated
  -- caller autosaving its empty defaults (the Q-001 hazard), never a normal edit. Refuse loudly;
  -- a deliberate clear-out deletes the draft instead.
  select count(*) into v_existing from quote_line_items where quote_id = p_id;
  if v_existing > 0 and jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'EMPTY_REPLACE';
  end if;

  update quotes set
    customer_id = nullif(p_fields->>'customer_id','')::uuid,
    job_id = nullif(p_fields->>'job_id','')::uuid,
    inquiry_id = nullif(p_fields->>'inquiry_id','')::uuid,
    title = nullif(p_fields->>'title',''),
    description = nullif(p_fields->>'description',''),
    notes = nullif(p_fields->>'notes',''),
    tax_rate = coalesce((p_fields->>'tax_rate')::numeric, 0),
    subtotal = (p_fields->>'subtotal')::numeric,
    tax = (p_fields->>'tax')::numeric,
    total = (p_fields->>'total')::numeric,
    valid_until = nullif(p_fields->>'valid_until','')::date,
    doc_type = coalesce(nullif(p_fields->>'doc_type',''), 'estimate'),
    updated_at = now()
  where quotes.id = p_id;

  delete from quote_line_items where quote_id = p_id;
  insert into quote_line_items (quote_id, description, quantity, unit, unit_price, category, sort_order, detail)
  select p_id,
         x->>'description',
         coalesce((x->>'quantity')::numeric, 1),
         coalesce(nullif(x->>'unit',''), 'ea'),
         coalesce((x->>'unit_price')::numeric, 0),
         nullif(x->>'category',''),
         coalesce((x->>'sort_order')::int, 0),
         -- The breakdown rides only when it is an object; anything else (absent, null, a string) is null.
         case when jsonb_typeof(x->'detail') = 'object' then x->'detail' else null end
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x;

  return query select q.id, q.quote_number::text from quotes q where q.id = p_id;
end;
$$;

comment on function public.save_quote_draft(uuid, jsonb, jsonb) is
  'Atomic draft-quote rewrite (0211, +detail 0386): row-locked, draft-locked, header+lines in one transaction. QUOTE_GONE / QUOTE_NOT_DRAFT raise distinctly.';

-- 4. The public estimate, with a REDACTED breakdown per item. Body = 0239 verbatim plus `detail`.
--    If you re-create this function, copy THIS body.
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
      -- THE BREAKDOWN THE CUSTOMER MAY SEE (0386): his hours, the rate, the units and each part's
      -- name, count and sell. NEVER cost (the contractor's net), the task id or the kit id.
      'detail', case when jsonb_typeof(li.detail) = 'object' then jsonb_build_object(
        'hours', li.detail->'hours',
        'rate', li.detail->'rate',
        'units', li.detail->'units',
        'materials', coalesce((select jsonb_agg(jsonb_build_object(
            'name', m->'name', 'qty', m->'qty', 'sell', m->'sell'))
          from jsonb_array_elements(case when jsonb_typeof(li.detail->'materials') = 'array' then li.detail->'materials' else '[]'::jsonb end) m), '[]'::jsonb)
      ) else null end) order by li.sort_order)
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
