-- 0211: ATOMIC DRAFT REWRITE for the estimate builder's autosave (review of cn-v796,
-- 3 confirmed HIGHs): the JS update -> delete-lines -> insert-lines ran as three REST calls
-- with no transaction, so two writers could interleave into doubled line items under a
-- single-set header total, and a failed insert left a zero-line draft with a nonzero total.
-- One transaction, SECURITY INVOKER (RLS is the tenant boundary; a foreign id reads as
-- absent), row-locked, draft-locked, distinct error tokens so the action can tell
-- "gone" (fall through to a fresh insert) from "sent" (hard stop).
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
begin
  select q.status into v_status from quotes q where q.id = p_id for update;
  if v_status is null then
    raise exception 'QUOTE_GONE';
  end if;
  if v_status <> 'draft' then
    raise exception 'QUOTE_NOT_DRAFT';
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
  insert into quote_line_items (quote_id, description, quantity, unit, unit_price, category, sort_order)
  select p_id,
         x->>'description',
         coalesce((x->>'quantity')::numeric, 1),
         coalesce(nullif(x->>'unit',''), 'ea'),
         coalesce((x->>'unit_price')::numeric, 0),
         nullif(x->>'category',''),
         coalesce((x->>'sort_order')::int, 0)
  from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x;

  return query select q.id, q.quote_number::text from quotes q where q.id = p_id;
end;
$$;

comment on function public.save_quote_draft(uuid, jsonb, jsonb) is
  'Atomic draft-quote rewrite (0211): row-locked, draft-locked, header+lines in one transaction. QUOTE_GONE / QUOTE_NOT_DRAFT raise distinctly.';
