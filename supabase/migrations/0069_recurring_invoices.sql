-- Recurring INVOICES: a third recurring-template kind that auto-generates a customer
-- invoice on a cadence (service agreements / maintenance retainers), optionally
-- emailing it. Extends 0044's recurring_templates (reuses customer_id, title, amount,
-- frequency, next_date) with a tax rate and an auto-send flag.

alter table public.recurring_templates drop constraint if exists recurring_templates_kind_check;
alter table public.recurring_templates
  add constraint recurring_templates_kind_check check (kind in ('job', 'expense', 'invoice'));

alter table public.recurring_templates add column if not exists tax_rate numeric(6,4) not null default 0;
alter table public.recurring_templates add column if not exists auto_send boolean not null default false;
