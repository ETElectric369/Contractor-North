-- Migration 0156: make an import's replace-in-place ATOMIC and serialized.
--
-- THE RACE. replaceImportedItems ran as three separate statements:
--   1. read the ids of this invoice's rows for this source   (a SNAPSHOT)
--   2. insert the fresh rows
--   3. delete the ids read in step 1
-- Two overlapping imports of the same source (double-click on "Materials From
-- Costs"; the markup-change effect re-firing while a manual import is in flight;
-- Nort and the office both importing) each delete only the ids THEY saw, so
-- writer A's freshly-inserted rows survive writer B's delete — both sets remain
-- and the draft is billed twice for the same materials. The anchor invariant
-- (rows sum exactly to the marked bill total) holds per writer and is silently
-- doubled in aggregate.
--
-- THE FIX: one transaction, one lock. pg_advisory_xact_lock keyed on
-- (invoice, source) serializes concurrent imports of the same set; the delete
-- targets `import_source = p_source` rather than a pre-read id list, so the
-- second writer removes whatever the first one left. Insert-before-delete is no
-- longer needed to protect the old rows — a failed insert now rolls the delete
-- back with it.
--
-- SECURITY INVOKER (the default — deliberately NOT a definer): RLS must keep
-- governing these writes, exactly as it does for the statement-by-statement
-- version this replaces. The caller's own policies decide what they may touch.
--
-- line_total is a generated column (round(quantity * unit_price, 2)) and org_id
-- is stamped by the stamp_org_invoice_items trigger, so neither is passed in.

create or replace function public.replace_imported_invoice_items(
  p_invoice_id uuid,
  p_source     text,
  p_rows       jsonb
)
returns integer
language plpgsql
as $$
declare
  v_org       uuid;
  v_next_sort integer;
  v_inserted  integer;
begin
  if p_source is null or p_source = '' then
    raise exception 'An import source is required.';
  end if;

  -- Serialize same-(invoice, source) imports for the rest of this transaction.
  -- Different invoices, and different sources on one invoice (labor vs costs),
  -- never contend.
  perform pg_advisory_xact_lock(hashtext(p_invoice_id::text || ':' || p_source));

  delete from public.invoice_items
   where invoice_id = p_invoice_id
     and import_source = p_source;

  -- Append after whatever hand-entered / other-source rows remain.
  select coalesce(max(sort_order), -1) + 1
    into v_next_sort
    from public.invoice_items
   where invoice_id = p_invoice_id;

  -- org_id comes from the PARENT INVOICE rather than the auth context: it is correct by
  -- definition (an item belongs to its invoice's org) and doesn't depend on the caller's
  -- session shape. The stamp trigger would infer the same value for a normal app call.
  select org_id into v_org from public.invoices where id = p_invoice_id;
  if v_org is null then
    raise exception 'Invoice not found.';
  end if;

  insert into public.invoice_items (invoice_id, org_id, import_source, sort_order, description, quantity, unit, unit_price)
  select
    p_invoice_id,
    v_org,
    p_source,
    v_next_sort + (row_number() over (order by ord))::int - 1,
    r->>'description',
    coalesce((r->>'quantity')::numeric, 1),
    coalesce(r->>'unit', 'ea'),
    coalesce((r->>'unit_price')::numeric, 0)
  from jsonb_array_elements(p_rows) with ordinality as t(r, ord);

  get diagnostics v_inserted = row_count;
  return v_inserted;
end $$;

comment on function public.replace_imported_invoice_items(uuid, text, jsonb) is
  'Atomically replace an invoice''s imported rows for one source (labor/costs/…). '
  'Advisory-locked per (invoice, source) so two overlapping imports cannot leave BOTH '
  'row sets behind — the double-billed-draft race. SECURITY INVOKER on purpose: RLS '
  'still governs every write (0156).';

grant execute on function public.replace_imported_invoice_items(uuid, text, jsonb) to authenticated;
