-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 0056: lock financial/sales READS to staff (owner/admin/office).
-- 0004's generic loop made these tables org-wide readable, so a TECH could read
-- every invoice/payment/quote/lead via the API even though the UI hid them.
-- Writes were already staff-gated; this gates reads to is_org_staff() too.
-- Atomic (runner wraps in a txn) so there's never a no-policy window.
-- Owner/admin/office reads are unchanged. customers/jobs/materials/work_orders
-- stay readable (techs need them for assigned work — scoping is a later phase).
-- ═══════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array[
    'invoices','invoice_items','payments',
    'quotes','quote_line_items',
    'change_orders',
    'purchase_orders','purchase_order_items',
    'bills','customer_credits','petty_cash','inquiries'
  ] loop
    execute format('drop policy if exists %1$s_read on public.%1$s;', t);
    execute format(
      'create policy %1$s_read on public.%1$s for select
         using (org_id = public.auth_org_id() and public.is_org_staff());', t);
  end loop;
end $$;

-- price_list_items uses a non-standard read-policy name.
drop policy if exists price_list_read on public.price_list_items;
create policy price_list_read on public.price_list_items
  for select using (org_id = public.auth_org_id() and public.is_org_staff());
