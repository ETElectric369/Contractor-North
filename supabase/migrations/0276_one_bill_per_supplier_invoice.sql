-- TWO TAPS MUST NOT MAKE TWO BILLS (review of the "Record It As A Bill" door, 2026-09-19).
--
-- The action reads "is there already a bill carrying this invoice number?" and then writes one.
-- Between those two statements there is a window, and the button is on a phone, where a slow
-- response is answered by pressing again. Two bills for one CED invoice is a double job cost and,
-- once imported, a double charge to a customer - the Tao Zhu shape that 0271's duplicate finder
-- exists to clean up after.
--
-- A read-then-write check is a convention. This is the boundary.
--
-- PARTIAL, twice over. Most bills have no supplier invoice number at all (a store receipt, a hand
-- entry, a statement covering several invoices), and null is not a duplicate of null. And a
-- SUPERSEDED copy keeps its number: 0271's duplicate resolver sets the pointer rather than
-- deleting the row, so the set-aside copy has to be allowed to go on carrying the number it was
-- scanned with.
create unique index if not exists bills_one_per_supplier_invoice
  on public.bills (org_id, supplier_invoice_number)
  where supplier_invoice_number is not null and superseded_by_bill_id is null;
