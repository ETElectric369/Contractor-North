-- Migration 0054: a separate "charge rate" per employee. hourly_rate stays the
-- PAY rate (job cost); bill_rate is what the customer is charged for that
-- person's labor (invoice labor import). Falls back to hourly_rate when unset.
alter table public.profiles add column if not exists bill_rate numeric;
