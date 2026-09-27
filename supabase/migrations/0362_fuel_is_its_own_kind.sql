-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0362: fuel is its own kind
--
-- Erik, 2026-09-27, after we sorted his checking download together: "ok so how much fuel am i
-- burning is the main one i want to evaluate and put into the app". Fuel and the truck (parts,
-- repairs, registration) share ONE business-cost bucket, Gas & Truck (0285: six buckets, never a
-- seventh), so the bucket alone can't answer "how much fuel". A kind inside the bucket can:
--
--   bills.cost_kind   text, null = not said. 'fuel' or 'truck', and only on a Gas & Truck business
--                     cost (no job). It is a tag inside the bucket, never a seventh list: every
--                     reader that sums buckets reads the bucket exactly as before.
--
-- WHO WRITES IT: the bank download's Apply (0363) when a person taps Fuel or Truck (or a rule the
-- company made from such a tap), and a private one-off data script that tags the 47 Gas & Truck
-- rows ET loaded from its bank export on 2026-09-27 (kept outside the repo; it carries ET's own
-- rows). Nothing guesses it on its own.
--
-- ONLY ON GAS & TRUCK, WITHOUT BREAKING AN EDIT. A CHECK that tied the kind to the category would
-- make every door that re-files a bill (the bill editor, Organize's Undo, Nort) fail the moment one
-- moved a tagged bill to another bucket or onto a job. Instead a BEFORE trigger clears the kind
-- when the bill stops being a Gas & Truck business cost: a bill that is no longer Gas & Truck is no
-- longer fuel. The CHECK pins the two words.
--
-- LOCKS: bills gets one nullable column (catalog only, no rewrite) and one CHECK on it that is
-- trivially true for every existing row (all null), plus a trigger. ACCESS EXCLUSIVE on bills for
-- a moment; lock_timeout 3s means a busy table fails fast and changes nothing. Run it again.
--
-- UNCHANGED: RLS on bills (staff only, 0017/0340). A tech never reads a business cost.
--
-- ORDER: after 0285 (the six buckets). Safe before or after the code: the fuel trend reads this
-- column and shows nothing (never an error) until it exists, and the bank download writes it only
-- when it is there. Additive only. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.bills') is null then
    raise exception '0362: bills is not on this database. Nothing was changed.';
  end if;
end $$;

alter table public.bills add column if not exists cost_kind text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.bills'::regclass and conname = 'bills_cost_kind_words') then
    alter table public.bills add constraint bills_cost_kind_words check (cost_kind is null or cost_kind in ('fuel', 'truck'));
  end if;
end $$;

comment on column public.bills.cost_kind is
  'Inside the Gas & Truck bucket: fuel or truck (0362). NULL = not said. Only on a Gas & Truck business cost with no job; the trigger clears it the moment the bill is anything else. The fuel trend on Analytics reads it.';

create or replace function public.cost_kind_rides_gas_and_truck()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.cost_kind is not null and (new.category is distinct from 'Gas & Truck' or new.job_id is not null) then
    new.cost_kind := null;
  end if;
  return new;
end $$;

comment on function public.cost_kind_rides_gas_and_truck() is
  'Clears bills.cost_kind when the bill is not a Gas & Truck business cost (0362): fuel is a kind inside that bucket only.';

drop trigger if exists cost_kind_rides_gas_and_truck on public.bills;
create trigger cost_kind_rides_gas_and_truck
  before insert or update of cost_kind, category, job_id on public.bills
  for each row execute function public.cost_kind_rides_gas_and_truck();

-- An internal trigger function is nobody's to call (0182's law: Postgres grants EXECUTE to PUBLIC).
revoke execute on function public.cost_kind_rides_gas_and_truck() from public, anon, authenticated;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bills' and column_name = 'cost_kind' and data_type = 'text' and is_nullable = 'YES'
  ) then
    raise exception '0362: bills.cost_kind is not a nullable text column. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.bills'::regclass and conname = 'bills_cost_kind_words' and convalidated) then
    raise exception '0362: the fuel/truck check on bills.cost_kind is missing. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_trigger where tgrelid = 'public.bills'::regclass and tgname = 'cost_kind_rides_gas_and_truck' and not tgisinternal
  ) then
    raise exception '0362: the trigger that keeps cost_kind on Gas & Truck is missing. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'bills' and c.relrowsecurity
  ) then
    raise exception '0362: bills has row level security switched off. Nothing was changed.';
  end if;
  raise notice '0362: fuel is its own kind inside Gas & Truck.';
end $$;
