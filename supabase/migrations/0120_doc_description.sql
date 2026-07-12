-- Every document gets a DESCRIPTION — a scope/summary block that reads ABOVE the line items and
-- below the header (Erik, 2026-07-12). invoices / work_orders / change_orders already have it;
-- quotes and purchase_orders were missing it. text, nullable — shown only when filled.
alter table public.quotes           add column if not exists description text;
alter table public.purchase_orders  add column if not exists description text;
