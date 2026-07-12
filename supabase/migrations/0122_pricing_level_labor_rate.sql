-- A pricing level already carries a material markup; give it an optional labor rate too, so a
-- level like "Local" can mean BOTH "15% on materials" AND "$125/hr labor" (Erik's mental model).
-- NULL = fall back to the org's default_labor_rate, so existing levels are unaffected.
alter table pricing_levels add column if not exists labor_rate numeric;

comment on column pricing_levels.labor_rate is
  'Optional per-level labor rate ($/hr) the estimator uses for a customer on this level; NULL = org default_labor_rate.';

-- Seed the existing "Local" level (Andrew Cohen) at the $125/hr Erik quotes locally.
update pricing_levels set labor_rate = 125 where name = 'Local' and labor_rate is null;
