-- Each person's normal daily round-trip commute (miles). Subtracted once per day-
-- driven so the tax report and timecard review show BUSINESS (reimbursable) miles —
-- home→jobsite travel net of the personal commute. Default 0 = treat all as business.
alter table public.profiles
  add column if not exists commute_baseline_miles numeric(8,2) not null default 0;
