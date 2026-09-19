-- A SUPPLIER INVOICE IS COVERED BY AT MOST ONE BILL (review of the Record button, 2026-09-19).
--
-- 0273 made `bill_supplier_invoices` unique on (bill_id, supplier_invoice_id), which only stops
-- ONE bill claiming the same invoice twice. The shape that doubles a job's cost is the other one:
-- TWO bills claiming ONE invoice. recordSupplierInvoiceAsBill reads "is this already in the
-- books?" and then writes, and two taps in the same second both read nothing and both insert.
-- The card's own disabled-while-pending is per-component state: it does nothing across two tabs,
-- two devices, or Erik on a phone and the office on a laptop.
--
-- A read-then-write check is a convention. This is the boundary. 0276 put one under
-- `bills.supplier_invoice_number`, which closes the same window for the one action that writes
-- that column; this puts it under the CLAIM itself, which is what every reader actually counts
-- (supplier-reconcile.ts drops an invoice from "Purchases Not In Your Books" on billCount alone).
--
-- The key is supplier_invoice_id ALONE, not (org_id, supplier_invoice_id): the invoice row already
-- carries the org, and a key that includes an org_id the client supplies is a key the client can
-- step around. A statement is unaffected - one bill covering several invoices is several rows with
-- different supplier_invoice_id, which is exactly what this permits.
create unique index if not exists bill_supplier_invoices_one_bill_per_invoice
  on public.bill_supplier_invoices (supplier_invoice_id);

-- The non-unique index 0273 created for the same lookup is now redundant.
drop index if exists public.bill_supplier_invoices_inv_idx;
