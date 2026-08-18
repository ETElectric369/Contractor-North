-- 0201 — ORGANIZE HOLDS MONEY, SO IT ANSWERS TO THE MONEY BOUNDARY (audit 9).
--
-- /organize files RECEIPTS: vendor, dollar amount, the AI's full line-item transcription, and a
-- thumbnail that resolves to a signed URL of the photo. Migration 0056 re-gated bills, petty_cash,
-- invoices, payments, quotes and purchase_orders to is_org_staff() precisely because "a TECH could
-- read every invoice" — and this table, which holds the same numbers before they become a bill,
-- was left org-wide. A tech tapping Organize → Archive saw the whole company's spend, including
-- overhead that has nothing to do with any job they work.
--
-- TWO POLICIES, NOT ONE. 0035 shipped `organized_items_read` (FOR SELECT) *and*
-- `organized_items_write` (FOR ALL) — and FOR ALL covers SELECT. PostgreSQL OR-combines
-- permissive policies, so re-gating only the read policy would have changed nothing at all while
-- looking like a fix. Both are replaced here.
--
-- A TECH KEEPS THEIR OWN PILE. The point of Organize for a field user is snapping a receipt from
-- the truck and having it filed — so they keep full access to the rows THEY created (that is the
-- work), and lose the rest of the company's. Staff (owner/admin/office) keep the org-wide view
-- the feature is designed around.

drop policy if exists organized_items_read on public.organized_items;
drop policy if exists organized_items_write on public.organized_items;

create policy organized_items_read on public.organized_items
  for select
  using (
    org_id = public.auth_org_id()
    and (public.is_org_staff() or created_by = auth.uid())
  );

create policy organized_items_write on public.organized_items
  for all
  using (
    org_id = public.auth_org_id()
    and (public.is_org_staff() or created_by = auth.uid())
  )
  with check (
    org_id = public.auth_org_id()
    and (public.is_org_staff() or created_by = auth.uid())
  );

comment on table public.organized_items is
  'Receipts/notes filed through Organize. Staff see the org; a non-staff user sees only what they created (0201) — the rows carry vendor, amount and a receipt image, which is the same money surface 0056 gated everywhere else.';
