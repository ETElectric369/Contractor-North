-- 0243 — A TAX RATE KEEPS ITS THIRD DECIMAL (audit v921 high).
--
-- Two representations of the same thing disagreed on precision:
--   tax_rates.rate            numeric(7,4)  — a PERCENT, so 7.375 fits exactly (0019_settings)
--   quotes.tax_rate           numeric(6,4)  — a FRACTION, so 0.07375 lands as 0.0738
--   invoices.tax_rate         numeric(6,4)  — same
--   recurring_templates.tax_rate numeric(6,4)
--   organizations.default_tax_rate numeric(6,4)
--
-- A fraction with 4 decimals can only carry a 2-decimal percent. Every California district rate
-- with a third decimal — 7.375%, 8.375%, 9.125% — was silently rounded on the way in:
--   * the builder computed tax at 0.07375 but the row stored 0.0738, so the next recalc moved
--     the total (on $10,000: $737.50 -> $738.00) with no line changed;
--   * setInvoiceTaxRate stored 0.0738 and the invoice then collected 7.38% — over-charging sales
--     tax against the rate the office actually configured;
--   * the invoice tax picker matches on an exact fraction, so a taxed draft read "No tax" (and a
--     mis-glance re-save zeroed the tax);
--   * the filing report grouped by rate and lost the jurisdiction name — "7.380%" with no county.
--
-- Widen to numeric(8,6): six decimals of fraction = four decimals of percent (99.9999% max),
-- comfortably more than any real rate needs. Nothing to backfill — verified 2026-09-05 that no
-- org has configured a tax rate and no quote or invoice carries a nonzero tax_rate, so this lands
-- before the first wrong number instead of after it.

alter table public.quotes               alter column tax_rate         type numeric(8,6);
alter table public.invoices             alter column tax_rate         type numeric(8,6);
alter table public.recurring_templates  alter column tax_rate         type numeric(8,6);
alter table public.organizations        alter column default_tax_rate type numeric(8,6);

comment on column public.quotes.tax_rate is
  'Sales tax as a FRACTION (0.07375 = 7.375%). numeric(8,6) so a 3-decimal percent survives; tax_rates.rate is the same number as a percent.';
comment on column public.invoices.tax_rate is
  'Sales tax as a FRACTION (0.07375 = 7.375%). numeric(8,6) — see 0243.';
comment on column public.organizations.default_tax_rate is
  'Default sales tax as a FRACTION (0.07375 = 7.375%). numeric(8,6) — see 0243.';

-- NOTE: no RLS change — widening a column inherits every existing policy.
