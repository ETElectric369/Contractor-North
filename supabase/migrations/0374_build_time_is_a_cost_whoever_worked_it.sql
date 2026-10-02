-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0373: build time is a cost, whoever worked it
--
-- Erik, 2026-10-01: "build time, including my build time is considered COGS, so it would be considered
-- a direct cost and should be counted that way." And: "lets get rid of the terminology owners draw and
-- use only net profit however, in my case as a sole proprietor, Im the owner taking home the net
-- profit ... an actual draw from the owner is considered equity and should be a line item below net
-- profit stating what Ive taken out this month."
--
-- ── WHAT WAS WRONG, AND WHAT 0286 GOT RIGHT ────────────────────────────────────────────────────────
--
-- 0286 made profile_pay.hourly_rate read 0 for an owner. It was written for a real defect: Erik's pay
-- rate was 125 and his BILL rate was also 125, so every hour he worked netted exactly $0, and because
-- he works about 80% of all job labour, all-time job profit read about -$1,085 when the business had
-- cleared about +$35,847. The Pay board listed him as owed $42,640 that nobody owed anyone.
--
-- The defect was never "his time is a cost". It was that his COST equalled his PRICE. Zeroing the cost
-- overshot the other way and now INFLATES every job he works. The right answer is a real cost rate,
-- separate from the bill rate, with the margin on his labour being the gap between them.
--
-- 0286 IS RIGHT ABOUT WAGES AND IS NOT WEAKENED HERE. A sole proprietor cannot be an employee of his
-- own sole proprietorship: no W-2, no withholding, no pay period, nothing a wages ledger can hold, and
-- no owner wage expense on the profit and loss - every dollar of profit is already his personal income
-- on Schedule C. So refuse_wages_for_an_owner (pay_payments, payroll_runs) and
-- refuse_pay_rate_on_owner_entry (time_entries) are left EXACTLY as 0286 wrote them. Costing an hour
-- and paying someone for it are different questions, and the answer is still no to the second.
--
-- ── WHAT THIS DOES ─────────────────────────────────────────────────────────────────────────────────
--
--   1. profiles.cost_rate: what an hour of this person's BUILD TIME costs the business, where that is a
--      different figure from what it pays them. NULLABLE WITH NO DEFAULT AND NO BACKFILL: null means
--      nobody has said yet, which is the only true state today. Erik has not given this number and it
--      is NOT his $125 bill rate - at the bill rate his labour earns zero margin, which is 0286's
--      original defect rebuilt. The app never reads null as $0 in silence: it says so in words and
--      points at the box (lib/build-time-cost.ts).
--
--   2. profile_pay gains cost_rate as its LAST column, which is the only kind of change CREATE OR
--      REPLACE VIEW allows. Every existing expression is byte-identical to 0286's, FROM ITS LIVE BODY.
--
--      hourly_rate STILL READS 0 FOR AN OWNER, deliberately, and this is the most important decision in
--      this file. The obvious shape - make hourly_rate read coalesce(cost_rate, 0) for an owner - would
--      put a WAGE figure back in front of three readers that have no idea it is a cost:
--        · app/(app)/timeclock/page.tsx selects (home_address, hourly_rate) WITHOUT paid_by_draw, feeds
--          it to aggregatePayrollEntries as fallbackRate and prints formatCurrency(myPeriod.gross).
--          Only `!isStaff` hides it, so any owner who is not office staff would start seeing a wage for
--          himself on his own clock.
--        · the Pay board and Timecards' You Owe read the same view.
--        · profile_pay reads an owner's BILL rate as coalesce(bill_rate, hourly_rate) (0286 kept 0054's
--          fallback alive), so a cost rate living in hourly_rate becomes his BILL rate the moment his
--          bill rate is blank - the original bug, on a customer's invoice.
--      A cost is its own question, so it gets its own column and its own reader. One rule, one place.
--
--   3. refuse_wages_for_an_owner_rate: the SQL TWIN the app rule at settings/actions.ts has never had.
--      That action refuses writing profiles.hourly_rate when role='owner'; an admin with the REST API
--      could always write the column directly, which made 0286's intent a convention at the write side
--      however firm it was at the read side. Now the database refuses it. Clearing to null or 0 is still
--      allowed (that is what an owner has anyway), and crew rows are never touched.
--
-- ── ROWS TOUCHED: ZERO ─────────────────────────────────────────────────────────────────────────────
--
-- A nullable column add (no table rewrite: Postgres 11+ adds a null-defaulted column as metadata only),
-- a view replace, and one trigger. NOTHING STORED IS REWRITTEN - no profile, no time entry, no payment,
-- no payroll run. 0286's backfill is NOT repeated. Every figure in the app reads exactly what it read
-- before this ran, because cost_rate is null for everybody until somebody types one. The DO blocks below
-- count what they find and raise rather than change anything.
--
-- WHAT THIS MIGRATION DOES NOT DO, AND CANNOT. It is necessary and nowhere near sufficient: the app
-- short-circuits the owner to $0 in TypeScript before it ever reads a rate (payroll-math.ts's
-- payRateForEntry, and labor-billing/owner-money's own tests of paid_by_draw). Those are changed in the
-- same commit as this file. A database with 0373 applied and the old app deployed behaves exactly as it
-- does today; an app with this commit and the view not yet replaced falls back one column at a time
-- (profile-columns.ts) and keeps 0286's answer. Neither half breaks on its own.
--
-- NO CHART OF ACCOUNTS HERE. Erik also asked that "each company should be able to upload their own
-- chart of accounts from their accountant as its always different". Today's default chart is
-- src/lib/business-cost-buckets.ts (BUSINESS_COST_BUCKETS + BUCKET_SECTION), a typed exhaustive Record.
-- Per-org charts are a table, a CSV importer and a change to every reader of BUCKET_SECTION: its own
-- wave, and nothing here pre-empts it.
--
-- ORDER: after 0286 (whose view body this starts from) and 0363 (bank_lines, where the Owner's Draw
-- equity figure is read from - no change needed there: choice='draw' has been written since it shipped
-- and nothing read it until now).
-- Safe to run twice: add column if not exists, create or replace, drop trigger if exists.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- ── THE STATE THIS EXPECTS, OR NOTHING HAPPENS ──────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception '0373: public.profiles is not on this database. Nothing was changed.';
  end if;
  if to_regclass('public.profile_pay') is null then
    raise exception '0373: public.profile_pay (0215) is not on this database. Nothing was changed.';
  end if;
  -- 0286 must already be here: this replaces ITS view body and relies on paid_by_draw existing. Without
  -- it the replace below would silently install a view with a different rule for an owner's pay.
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'public.profile_pay'::regclass and attname = 'paid_by_draw' and not attisdropped
  ) then
    raise exception '0373: profile_pay has no paid_by_draw column, so migration 0286 has not been applied. Nothing was changed.';
  end if;
  -- The wage refusals this must NOT weaken. If they are gone, something else has already changed the
  -- rule and this file's reasoning no longer holds.
  if not exists (select 1 from pg_trigger where tgname = 'refuse_wages_for_an_owner' and tgrelid = 'public.pay_payments'::regclass) then
    raise exception '0373: refuse_wages_for_an_owner is not on pay_payments. 0286 is the ground this stands on. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'refuse_pay_rate_on_owner_entry' and tgrelid = 'public.time_entries'::regclass) then
    raise exception '0373: refuse_pay_rate_on_owner_entry is not on time_entries. Nothing was changed.';
  end if;
end $$;

-- ── 1. THE COST RATE ────────────────────────────────────────────────────────────────────────────────
-- numeric(10,2), the same type and precision as hourly_rate (0001), so no reader has to widen. Null =
-- nobody has said. A positive check, because $0 an hour is not an answer, it is the absence of one, and
-- a stored 0 would be indistinguishable from null to every reader that coalesces.
alter table public.profiles add column if not exists cost_rate numeric(10,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_cost_rate_positive' and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles add constraint profiles_cost_rate_positive check (cost_rate is null or cost_rate > 0);
  end if;
end $$;

comment on column public.profiles.cost_rate is
  'What an hour of this person''s BUILD TIME costs the business (0373). For an OWNER this is the only rate he has: he is paid no wage at all (0286), and his hours on a job are still a direct cost of that job - Erik, 2026-10-01, "build time, including my build time is considered COGS". It is NOT bill_rate: a cost equal to the price makes every hour he works net exactly $0, which is the defect 0286 was written to fix. It is NOT hourly_rate: that column is a wage, and for an owner it reads 0 through profile_pay. NULL means nobody has said yet, and no reader may treat that as $0 without saying so (lib/build-time-cost.ts).';

-- NO GRANT IS NEEDED, AND THAT IS THE SAFE DIRECTION. 0216 revoked table-level SELECT on profiles from
-- `authenticated` and re-granted an explicit WHITELIST of columns, so a column added here is private to
-- that role until somebody names it in that list. cost_rate is deliberately never named: profile_pay
-- (staff-or-self) is the only door, exactly as hourly_rate and bill_rate are. A tech reading profiles
-- directly through PostgREST gets a permission error, not a rate.

-- ── 2. THE ONE DOOR, WITH ONE COLUMN APPENDED ───────────────────────────────────────────────────────
-- 0286's body, verbatim, plus cost_rate at the end. hourly_rate's expression is UNCHANGED and reads 0
-- for an owner: see WHAT THIS DOES (2) above for the three readers that would break otherwise.
create or replace view public.profile_pay
with (security_barrier = true)
as
select p.id,
       p.org_id,
       p.full_name,
       (case when p.role = 'owner' then 0 else p.hourly_rate end)::numeric(10,2) as hourly_rate,
       (case when p.role = 'owner' then coalesce(p.bill_rate, p.hourly_rate) else p.bill_rate end)::numeric as bill_rate,
       p.home_address,
       p.commute_baseline_miles,
       -- not sensitive; carried so crew pickers can keep filtering on it without a second read
       p.active,
       -- 0286: the owner is paid by owner's draw. He is not on payroll; his hours are billed and counted.
       (p.role = 'owner') as paid_by_draw,
       -- 0373: what an hour of this person's own build time COSTS. Read straight through - no case, no
       -- coalesce, no default. Null reaches the app as null, so the app can say "nobody has set this"
       -- instead of printing a figure built on a guess.
       p.cost_rate
  from public.profiles p
 where p.org_id = public.auth_org_id()
   and (public.is_org_staff() or p.id = auth.uid());

-- 0218's read-only law, restated: a replaced view keeps its grants, but a SECURITY DEFINER view that
-- is auto-updatable would let a member write to profiles as the view owner, so this is not left to
-- memory.
revoke insert, update, delete, truncate, references, trigger on public.profile_pay from anon;
revoke insert, update, delete, truncate, references, trigger on public.profile_pay from authenticated;
revoke all on public.profile_pay from public;
grant select on public.profile_pay to authenticated;

comment on view public.profile_pay is
  'The pay/address spine, staff-scoped and READ-ONLY (0215; writes revoked in 0218). Office staff see their whole org; everyone else only their own row. 0286: an owner is paid by owner''s draw, so hourly_rate reads 0 for an owner (never null, so no fallback can restore a wage), bill_rate reads coalesce(bill_rate, hourly_rate) so billing is unchanged, and paid_by_draw says which rows those are. 0373: cost_rate is what an hour of that person''s BUILD TIME costs the business - read through unchanged, null when nobody has said. It is deliberately NOT folded into hourly_rate: the timeclock selects hourly_rate without paid_by_draw and prints it as a gross, and an owner''s bill rate falls back to hourly_rate, so a cost figure there becomes a wage on his clock and a price on a customer''s invoice.';

-- ── 3. THE WAGE DOOR'S SQL TWIN ─────────────────────────────────────────────────────────────────────
-- app/(app)/settings/actions.ts refuses writing hourly_rate for an owner in two places (updateMember,
-- updateMemberRate). Until now that was the only guard on the WRITE side, and an admin can reach
-- profiles through PostgREST. The read side (the view's case) meant a stored wage was ignored rather
-- than used - but it sat there, it showed in the Team page's boxes before 0286, and audit v994 MR7 had
-- to clear it by hand when an owner's bill rate was cleared. Refusing the write closes the loop.
--
-- Clearing is ALWAYS allowed (null or 0): that is what an owner has. Only setting or raising a positive
-- wage is refused, and only when the row IS an owner - a crew member's rate is untouched, and so is a
-- row changing role (role changes do not fire this; it watches hourly_rate).
create or replace function public.refuse_wages_for_an_owner_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if coalesce(new.hourly_rate, 0) <= 0 then
    return new;
  end if;
  -- An unchanged rate on an UPDATE is never refused: the Team page and the member editor round-trip
  -- their whole patch, so an unrelated edit (a name, an address, a commute baseline) must not start
  -- failing because of a value that was already stored. Only a rate being SET or CHANGED is checked.
  if tg_op = 'UPDATE' and new.hourly_rate is not distinct from old.hourly_rate then
    return new;
  end if;
  if new.role is distinct from 'owner' then
    return new;
  end if;
  v_name := coalesce(nullif(btrim(new.full_name), ''), 'This person');
  raise exception '% is the owner and is paid by owner''s draw, not wages, so there is no pay rate to set. What an hour of the owner''s build time COSTS goes in cost_rate.', v_name;
end $$;

drop trigger if exists refuse_wages_for_an_owner_rate on public.profiles;
create trigger refuse_wages_for_an_owner_rate
  before insert or update of hourly_rate on public.profiles
  for each row execute function public.refuse_wages_for_an_owner_rate();

-- ── ASSERT WHAT CAN BE ASSERTED, AND CHANGE NOTHING ─────────────────────────────────────────────────
do $$
declare
  r record;
  v_bad integer;
  v_set integer;
  v_stuck integer;
begin
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'public.profile_pay'::regclass and attname = 'cost_rate' and not attisdropped
  ) then
    raise exception '0373: profile_pay has no cost_rate column';
  end if;

  -- NOBODY HAS A COST RATE YET, and that is the point: this migration sets none. If some already
  -- exist, this is a re-run and the figure is whatever a person typed, which is also fine - the count
  -- is printed so a re-run is visible rather than silent.
  select count(*) into v_set from public.profiles where cost_rate is not null;
  raise notice '0373: profiles with a build-time cost rate set: % (0 on the first run; nothing here sets one)', v_set;

  -- The view still reads an owner's pay as 0 and his bill rate unchanged: 0286's own assertion, re-run
  -- against the replaced body, per org, as that org's owner (the view filters on the caller).
  for r in
    select distinct on (p.org_id) p.org_id, p.id
      from public.profiles p
     where p.role = 'owner' and p.active and p.org_id is not null
     order by p.org_id, p.created_at
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.id, 'role', 'authenticated')::text, true);

    select count(*) into v_bad
      from public.profile_pay v
      join public.profiles p on p.id = v.id
     where v.paid_by_draw
       and (v.hourly_rate <> 0
            or v.bill_rate is distinct from coalesce(p.bill_rate, p.hourly_rate)
            or v.cost_rate is distinct from p.cost_rate);
    if v_bad > 0 then
      raise exception '0373: % owner row(s) in org % do not read hourly_rate 0, the bill rate kept and cost_rate straight through', v_bad, r.org_id;
    end if;

    select count(*) into v_bad
      from public.profile_pay v
      join public.profiles p on p.id = v.id
     where not v.paid_by_draw
       and (v.hourly_rate is distinct from p.hourly_rate
            or v.bill_rate is distinct from p.bill_rate
            or v.cost_rate is distinct from p.cost_rate);
    if v_bad > 0 then
      raise exception '0373: % crew row(s) in org % changed through profile_pay', v_bad, r.org_id;
    end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);

  -- OWNER ROWS THE NEW TRIGGER WOULD REFUSE A WAGE EDIT ON. Counts only, never money, and nothing is
  -- rewritten: a stored wage on an owner's row is already read as 0 by the view, and the trigger only
  -- refuses the NEXT attempt to set or change one. Named so the number is seen rather than assumed.
  select count(*) into v_stuck
    from public.profiles
   where role = 'owner' and coalesce(hourly_rate, 0) > 0;
  raise notice '0373: owner rows carrying a stored wage (read as 0 since 0286; left exactly as they are): %', v_stuck;

  -- WHAT THE EQUITY LINE WILL BE ABLE TO SEE, per company, before anyone looks at it. The Owner's Draw
  -- line reads bank_lines sorted as 'draw' (0363) and needs no migration of its own - the answer has
  -- been written since 0363 shipped and nothing read it. A draw taken in CASH is in none of these
  -- counts, which is why the card and the accountant's Summary say so in words.
  if to_regclass('public.bank_lines') is null then
    raise notice '0373: no bank_lines table (pre-0363): the Owner''s Draw line will read $0 and say it can see nothing yet';
  else
    for r in
      select o.id as org_id,
             o.name,
             (select count(*) from public.profiles p where p.org_id = o.id and p.role = 'owner') as owners,
             (select count(*) from public.bank_lines b where b.org_id = o.id and b.choice = 'draw') as draw_lines
        from public.organizations o
       order by o.name
    loop
      raise notice '0373: % (%): owners %, bank lines already sorted as Owner''s Draw %', r.name, r.org_id, r.owners, r.draw_lines;
    end loop;
  end if;
end $$;
