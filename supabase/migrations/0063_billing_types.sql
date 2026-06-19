-- Contractor North — migration 0063: billing types
-- Jobs can be Fixed-price or Time & Material (the estimate is a cap vs a
-- reference). Invoices are "draws" tagged deposit / progress / final / standard
-- so deposits, progress payments and the final all flow through one billing path.
-- Both columns inherit their table's org-scoped RLS; no new policies/triggers.

alter table public.jobs add column if not exists billing_type text not null default 'fixed';
alter table public.jobs drop constraint if exists jobs_billing_type_check;
alter table public.jobs add constraint jobs_billing_type_check check (billing_type in ('fixed', 'tm'));

alter table public.invoices add column if not exists invoice_kind text not null default 'standard';
alter table public.invoices drop constraint if exists invoices_invoice_kind_check;
alter table public.invoices add constraint invoices_invoice_kind_check check (invoice_kind in ('deposit', 'progress', 'final', 'standard'));
