-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0315: a customer never reads a supplier's name
--
-- Audit v994 PL1. The J-002 customer opens /portal/<token>/jobs/<id> and reads
-- "Materials — Consolidated Electrical Distributors, Inc. (CED)" on the ledger and on the bill;
-- /i and its PDF have printed the same words on paid invoices for months (INV-00022, -00028,
-- -00029, INV-035), and a supplier return imported into a live draft reaches the customer's page
-- the moment it is written: "Returned: materials — Consolidated Electrical Dist. (bill #8802-…)".
-- Only the "Supplies & tax — <supplier>" rows were ever reworded, and only in the app.
--
-- Erik's standing law decides it: SCRUB ON READ (sanitize-on-read). Every customer-facing door
-- shows "Materials" (no supplier's name, no supplier bill or PO number), including invoices that
-- already went out, and no stored row is rewritten: the office's own screens keep the full wording,
-- which is how a line is traced back to its paper.
--
-- THREE THINGS:
--
--  1. customer_supplier_key(text): a supplier name as the scrub compares it (whitespace collapsed,
--     trimmed, lower case). src/lib/invoice-math.ts supplierKey is the same expression.
--
--  2. customer_line_words(org, description, import_source, import_key, edited): the words a
--     customer reads for one invoice line. The TS twin is customerLineWords (invoice-math.ts) and a
--     DB test holds the two to the same answer on every live line. Only an imported materials row
--     (import_source 'costs') is reworded, and only in the importer's own shapes:
--       "Supplies & tax …"            → "Supplies & Tax"
--       "Returned: other items — …"   → "Returned: Other Items"
--       "Materials — X"               → "Materials"            } when X is the supplier: the row is
--       "Returned: materials — X"     → "Returned: Materials"  } the importer's untouched lump
--         (key bill:<id> / po:<id>, not edited), or X ends in the paper's number ("(bill #…)",
--         "(PO …)"), or X is one of the org's supplier names (bills.supplier,
--         purchase_orders.vendor, supplier_accounts.name, supplier_aliases.alias).
--     Anything else prints as written: "Materials — Ground rod" typed by hand, or INV-060's lump
--     the office rewrote into the list of what was in the box. Callable by the definer functions
--     and the service role only (it answers "is this one of org X's suppliers").
--
--  3. invoice_document_projection (/i, and every invoice on the portal) and portal_job_view (the
--     portal's ledger lines) read a line's description through it. Both are rewritten FROM THEIR
--     LIVE DEFINITIONS by replacing the one expression that projects the description, so nothing
--     else in either function can be reverted by this file, whatever landed after 0301. The
--     rewrite refuses unless the expression appears exactly once.
--
-- SELF-CHECK: every non-void invoice's document is snapshotted before and compared after. The
-- only thing allowed to change is a line's description, and only to one of the four labels.
-- Everything else (totals, quantities, prices, the order of lines, payments) is byte-for-byte what
-- it was, or nothing is changed.
--
-- NOT COVERED HERE: a PDF already stored for a sent invoice (doc_pdf_cache, 0198) keeps the words
-- it was rendered with until the office next opens its PDF, which re-renders it (the print page
-- scrubs in the app). /api/share-pdf serves that stored copy to the customer.
--
-- ORDER: after 0301. Deploy-safe either way: the app scrubs the portal and the print page itself,
-- and /i keeps its current words until this is applied.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. the key a supplier name is compared by ───────────────────────────────────────────────────
create or replace function public.customer_supplier_key(p_name text)
returns text language sql immutable set search_path = public as $$
  select nullif(lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'))), '')
$$;
comment on function public.customer_supplier_key(text) is
  'A supplier name as the customer-copy scrub compares it (0315). Twin of supplierKey in src/lib/invoice-math.ts.';

-- ── 2. the words a customer reads for one line ──────────────────────────────────────────────────
create or replace function public.customer_line_words(
  p_org uuid, p_description text, p_import_source text, p_import_key text, p_edited boolean)
returns text language plpgsql stable set search_path = public as $$
declare
  d text := coalesce(p_description, '');
  m text[];
  rest text;
  who text;
begin
  if p_import_source is distinct from 'costs' then
    return p_description;
  end if;
  if d ~* '^\s*supplies\s*&\s*tax\M' then
    return 'Supplies & Tax';
  end if;
  if d ~* '^\s*returned:\s*other\s+items\s*[—–-]' then
    return 'Returned: Other Items';
  end if;
  m := regexp_match(d, '^\s*(returned:\s*)?materials\s*[—–-]\s*(.*)$', 'i');
  if m is null then
    return p_description;
  end if;
  rest := coalesce(m[2], '');
  who := public.customer_supplier_key(regexp_replace(rest, '\s*\((bill\s*#|po\s)[^)]*\)\s*$', '', 'i'));
  if (coalesce(p_import_key, '') ~ '^(bill|po):[^:]+$' and p_edited is not true)
     or rest ~* '\s*\((bill\s*#|po\s)[^)]*\)\s*$'
     or (who is not null and (
          exists (select 1 from public.bills b
                   where b.org_id = p_org and public.customer_supplier_key(b.supplier) = who)
          or exists (select 1 from public.purchase_orders po
                      where po.org_id = p_org and public.customer_supplier_key(po.vendor) = who)
          or exists (select 1 from public.supplier_accounts sa
                      where sa.org_id = p_org and public.customer_supplier_key(sa.name) = who)
          or exists (select 1 from public.supplier_aliases al
                      where al.org_id = p_org and public.customer_supplier_key(al.alias) = who))) then
    return case when m[1] is null then 'Materials' else 'Returned: Materials' end;
  end if;
  return p_description;
end $$;
comment on function public.customer_line_words(uuid, text, text, text, boolean) is
  'The words a customer reads for one invoice line (0315): an imported materials row never names the supplier or the supplier''s paper. Twin of customerLineWords in src/lib/invoice-math.ts. The stored row is never rewritten.';
revoke execute on function public.customer_line_words(uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.customer_line_words(uuid, text, text, text, boolean) to service_role;

-- ── 3. the two customer projections read through it ─────────────────────────────────────────────
-- Every non-void invoice's document as it reads TODAY (the portal shows drafts; /i shows the rest).
create temp table _0315_before as
select i.id, public.invoice_document_projection(i.id)::jsonb as j
  from public.invoices i
 where i.status <> 'void';

do $$
declare
  v_def text;
  v_n int;
  v_old text;
  v_new text;
begin
  -- invoice_document_projection: the items' description.
  v_def := pg_get_functiondef('public.invoice_document_projection(uuid)'::regprocedure);
  if position('customer_line_words' in v_def) = 0 then
    v_old := '''description'', it.description, ''quantity''';
    v_new := '''description'', public.customer_line_words(i.org_id, it.description, it.import_source, it.import_key, it.edited), ''quantity''';
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception '0315: invoice_document_projection projects a line''s description % time(s), not once. Nothing was changed.', v_n;
    end if;
    execute replace(v_def, v_old, v_new);
  end if;

  -- portal_job_view: the ledger lines' description.
  v_def := pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure);
  if position('customer_line_words' in v_def) = 0 then
    v_old := '''sort_order'', it.sort_order, ''description'', it.description,';
    v_new := '''sort_order'', it.sort_order, ''description'', public.customer_line_words(a.org_id, it.description, it.import_source, it.import_key, it.edited),';
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception '0315: portal_job_view projects a line''s description % time(s), not once. Nothing was changed.', v_n;
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end $$;

-- ── self-check ───────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_bad int;
begin
  -- Nothing outside the lines moved, and no line was added, dropped or reordered.
  select count(*) into v_bad
    from _0315_before b
   where (b.j - 'items') is distinct from (public.invoice_document_projection(b.id)::jsonb - 'items')
      or jsonb_array_length(coalesce(b.j->'items', '[]'::jsonb))
         <> jsonb_array_length(coalesce(public.invoice_document_projection(b.id)::jsonb->'items', '[]'::jsonb));
  if v_bad > 0 then
    raise exception '0315: % invoice document(s) would change outside their line words. Nothing was changed.', v_bad;
  end if;

  -- Within the lines, only a description changed, and only to one of the four labels.
  select count(*) into v_bad
    from _0315_before b
   cross join lateral jsonb_array_elements(b.j->'items') with ordinality x(item, n)
    join lateral jsonb_array_elements(public.invoice_document_projection(b.id)::jsonb->'items') with ordinality y(item, n)
      on y.n = x.n
   where (x.item - 'description') is distinct from (y.item - 'description')
      or (x.item->>'description' is distinct from y.item->>'description'
          and y.item->>'description' not in ('Materials', 'Returned: Materials', 'Supplies & Tax', 'Returned: Other Items'));
  if v_bad > 0 then
    raise exception '0315: % invoice line(s) would change in some way other than their words. Nothing was changed.', v_bad;
  end if;

  if has_function_privilege('anon', 'public.customer_line_words(uuid, text, text, text, boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.customer_line_words(uuid, text, text, text, boolean)', 'execute') then
    raise exception '0315: customer_line_words is callable without the service role. Nothing was changed.';
  end if;
  -- The doors keep the grants they had.
  if not has_function_privilege('anon', 'public.public_invoice(text)', 'execute') then
    raise exception '0315: /i lost its door. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public.portal_job_view(text, uuid)', 'execute')
     or has_function_privilege('anon', 'public.invoice_document_projection(uuid)', 'execute') then
    raise exception '0315: a portal read became callable without the service role. Nothing was changed.';
  end if;
end $$;
drop table _0315_before;
