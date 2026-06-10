-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0037: document numbers unique PER ORG
-- The number counters are per-org, but the unique constraints were GLOBAL —
-- so a second organization's very first job (J-00001) collided with the
-- first org's J-00001 and creation failed. Found while testing with a second
-- org. Numbers are now unique within an organization, as multi-tenancy
-- requires. Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.jobs            drop constraint if exists jobs_job_number_key;
alter table public.quotes          drop constraint if exists quotes_quote_number_key;
alter table public.invoices        drop constraint if exists invoices_invoice_number_key;
alter table public.work_orders     drop constraint if exists work_orders_wo_number_key;
alter table public.change_orders   drop constraint if exists change_orders_co_number_key;
alter table public.purchase_orders drop constraint if exists purchase_orders_po_number_key;

create unique index if not exists jobs_org_number_key            on public.jobs(org_id, job_number);
create unique index if not exists quotes_org_number_key          on public.quotes(org_id, quote_number);
create unique index if not exists invoices_org_number_key        on public.invoices(org_id, invoice_number);
create unique index if not exists work_orders_org_number_key     on public.work_orders(org_id, wo_number);
create unique index if not exists change_orders_org_number_key   on public.change_orders(org_id, co_number);
create unique index if not exists purchase_orders_org_number_key on public.purchase_orders(org_id, po_number);
