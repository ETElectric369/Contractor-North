-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0362: fuel is its own bucket
--
-- Erik, 2026-09-27, after we sorted his checking download together: "ok so how much fuel am i
-- burning is the main one i want to evaluate and put into the app", then "lets make fuel stand out
-- from business costs", then "so the Gas & Truck turns into Auto and Fuel is separate, right?" Yes.
-- For EVERY company, the business-cost buckets (0285, src/lib/business-cost-buckets.ts) are now:
--
--   Fuel · Auto · Tools & Supplies · Phone & Office · Insurance & Licenses · Fees · Other
--
-- Fuel is new and its own. Auto is Gas & Truck renamed: what the truck costs that isn't fuel
-- (parts, repairs, tires, registration, a truck payment).
--
-- WHAT THIS DOES: data only. Every stored "Gas & Truck" (any letter case, stray spaces) becomes
-- "Auto", in every company, wherever a bucket is stored:
--
--   bills.category                 a business cost's bucket (a job bill never carried it, but a
--                                  row that does is renamed too: the word only ever meant the bucket)
--   bills.supplier                 on a business cost only, where it is exactly "Gas & Truck": Add
--                                  Business Cost saves a blank Where as the bucket's own name
--   recurring_templates.category   a recurring expense writes a no-job bill in its bucket
--   petty_cash.category            a no-job petty cash row is counted in bucketOf(category)
--   organized_items.category       a paper filed as a business cost carries its bucket
--   organized_items.proposal       the tray's bucket guess (bucket), the company-use word's bucket
--                                  (companyUse.bucket), and a filed paper's own pick (filed.paperPick
--                                  "cost:Gas & Truck") and kept category (filed.category)
--
-- WHY EVERYTHING TO AUTO, NONE TO FUEL: the old bucket held fill-ups and repairs alike, and nothing
-- stored says which a row was. A person (or a company's own private data script) moves a fill-up to
-- Fuel; this never guesses. Until it runs, the app reads a stored "Gas & Truck" as Auto (bucketOf),
-- so nothing breaks between the deploy and this.
--
-- NO NEW COLUMN, NO KIND. An earlier draft of 0362 (never applied to production) tagged fuel as a
-- kind INSIDE Gas & Truck (bills.cost_kind). A Fuel bucket says it with the word every reader
-- already sums by, so a Fuel answer on a bank download (0363) is simply the Fuel bucket.
--
-- NOTHING ELSE MOVES: no amount, date, job or status changes, so every total the app shows is the
-- same money, only named Auto instead of Gas & Truck. The bill triggers that guard money
-- (freeze_used_stock_bill, guard_bill_claim, guard_shelf_credit_bill) pass a category-only change;
-- touch_updated_at stamps updated_at on the rows it renames, as 0285 did.
--
-- LOCKS: row locks on the rows it renames (a few dozen on production at writing), nothing on a
-- table. lock_timeout 3s: a busy row fails fast and changes nothing. Run it again.
--
-- ORDER: after 0285 (the six buckets), before 0363 (whose bank_lines/bank_rules checks name the
-- buckets above), and AFTER THE CODE DEPLOYS: the new code reads a stored Gas & Truck as Auto, but
-- code from before this reads "Auto" as Other (the money is the same, the card names it wrong until
-- the deploy). A Gas & Truck row the old code writes in between is Auto to the new code; running
-- this again renames it. IDEMPOTENT: a second run finds no "Gas & Truck" and changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.bills') is null or to_regclass('public.recurring_templates') is null
     or to_regclass('public.petty_cash') is null or to_regclass('public.organized_items') is null then
    raise exception '0362: bills, recurring_templates, petty_cash or organized_items is not on this database. Nothing was changed.';
  end if;
end $$;

do $$
declare
  v_bills integer;
  v_places integer;
  v_templates integer;
  v_petty integer;
  v_items integer;
  v_proposals integer := 0;
  v_n integer;
begin
  update public.bills
     set category = 'Auto'
   where lower(btrim(category)) = 'gas & truck';
  get diagnostics v_bills = row_count;

  -- Add Business Cost saves a blank Where as the bucket's own name (one placeholder per bucket,
  -- add-business-cost.tsx), so a business cost may carry "Gas & Truck" as its supplier too.
  update public.bills
     set supplier = 'Auto'
   where job_id is null
     and btrim(supplier) = 'Gas & Truck';
  get diagnostics v_places = row_count;

  update public.recurring_templates
     set category = 'Auto'
   where lower(btrim(category)) = 'gas & truck';
  get diagnostics v_templates = row_count;

  update public.petty_cash
     set category = 'Auto'
   where lower(btrim(category)) = 'gas & truck';
  get diagnostics v_petty = row_count;

  update public.organized_items
     set category = 'Auto'
   where lower(btrim(category)) = 'gas & truck';
  get diagnostics v_items = row_count;

  -- The tray's words inside a paper's proposal, each only where it says exactly the old bucket.
  update public.organized_items
     set proposal = jsonb_set(proposal, '{bucket}', '"Auto"')
   where jsonb_typeof(proposal) = 'object'
     and lower(btrim(proposal ->> 'bucket')) = 'gas & truck';
  get diagnostics v_n = row_count;
  v_proposals := v_proposals + v_n;

  update public.organized_items
     set proposal = jsonb_set(proposal, '{companyUse,bucket}', '"Auto"')
   where jsonb_typeof(proposal) = 'object'
     and jsonb_typeof(proposal -> 'companyUse') = 'object'
     and lower(btrim(proposal -> 'companyUse' ->> 'bucket')) = 'gas & truck';
  get diagnostics v_n = row_count;
  v_proposals := v_proposals + v_n;

  update public.organized_items
     set proposal = jsonb_set(proposal, '{filed,paperPick}', '"cost:Auto"')
   where jsonb_typeof(proposal) = 'object'
     and jsonb_typeof(proposal -> 'filed') = 'object'
     and lower(btrim(proposal -> 'filed' ->> 'paperPick')) = 'cost:gas & truck';
  get diagnostics v_n = row_count;
  v_proposals := v_proposals + v_n;

  update public.organized_items
     set proposal = jsonb_set(proposal, '{filed,category}', '"Auto"')
   where jsonb_typeof(proposal) = 'object'
     and jsonb_typeof(proposal -> 'filed') = 'object'
     and lower(btrim(proposal -> 'filed' ->> 'category')) = 'gas & truck';
  get diagnostics v_n = row_count;
  v_proposals := v_proposals + v_n;

  raise notice '0362: Gas & Truck is Auto now: % bills (% with the bucket as their supplier), % recurring expenses, % petty cash rows, % papers and % words in paper proposals renamed.',
    v_bills, v_places, v_templates, v_petty, v_items, v_proposals;
end $$;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from public.bills where lower(btrim(category)) = 'gas & truck') then
    raise exception '0362: a bill still says Gas & Truck. Nothing was changed.';
  end if;
  if exists (select 1 from public.bills where job_id is null and btrim(supplier) = 'Gas & Truck') then
    raise exception '0362: a business cost still has Gas & Truck as its supplier. Nothing was changed.';
  end if;
  if exists (select 1 from public.recurring_templates where lower(btrim(category)) = 'gas & truck') then
    raise exception '0362: a recurring expense still says Gas & Truck. Nothing was changed.';
  end if;
  if exists (select 1 from public.petty_cash where lower(btrim(category)) = 'gas & truck') then
    raise exception '0362: a petty cash row still says Gas & Truck. Nothing was changed.';
  end if;
  if exists (select 1 from public.organized_items where lower(btrim(category)) = 'gas & truck') then
    raise exception '0362: a paper still says Gas & Truck. Nothing was changed.';
  end if;
  if exists (
    select 1 from public.organized_items
     where jsonb_typeof(proposal) = 'object'
       and (lower(btrim(proposal ->> 'bucket')) = 'gas & truck'
            or lower(btrim(proposal -> 'companyUse' ->> 'bucket')) = 'gas & truck'
            or lower(btrim(proposal -> 'filed' ->> 'paperPick')) = 'cost:gas & truck'
            or lower(btrim(proposal -> 'filed' ->> 'category')) = 'gas & truck')
  ) then
    raise exception '0362: a paper''s proposal still names Gas & Truck. Nothing was changed.';
  end if;
  raise notice '0362: fuel is its own bucket, and Gas & Truck is Auto.';
end $$;
