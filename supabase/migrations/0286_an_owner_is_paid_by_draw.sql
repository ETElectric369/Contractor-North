-- 0286 - AN OWNER IS PAID BY DRAW, NOT WAGES.
--
-- Erik, 2026-09-23: "get rid of the owners wages and make everything not a cost part of the owners
-- draw". ET Electric is a sole proprietorship. The owner is not on payroll: whatever the business
-- has left after its real costs is his, and what he takes out is a draw, which is equity and not an
-- expense.
--
-- WHAT BROKE. The app had one pay column for everybody. Erik's profiles.hourly_rate is 125 and so is
-- his bill_rate, so every hour he worked was billed to the customer at $125 AND costed to the job at
-- $125. Each of his hours netted exactly $0, and because he works most of the hours (80.5% of all job
-- labour cost over the last 90 days), all-time job profit read about -$1,085 when the business had
-- actually cleared about +$35,847. The Pay board listed him as owed $42,640 (341 h x $125), money
-- nobody ever owed anyone. None of it was a wage: he has 0 pay_payments rows, 0 payroll_runs rows and 0
-- rate_override values. It was a costing assumption, and every reader that multiplied by hourly_rate
-- repeated it.
--
-- WHY HERE. There are more than a dozen readers of the pay rate (job hub, /analytics, Nort, the Pay
-- board, Timecards, the budget-vs-actual rows...). A rule written in each of them is a convention,
-- and the one that forgets it quietly puts the wage back. So the rule lives at the ONE door every one
-- of them already reads rates through: profile_pay (0215, read-only since 0218).
--
-- WHAT THIS DOES.
--   1. profile_pay.hourly_rate reads 0 for an owner. Zero, not null: payRateForEntry falls back to a
--      caller's fallback rate when the rate is null, and 0 ?? fallback stays 0. So a reader that
--      never heard of any of this still costs the owner at $0, never at $125.
--   2. profile_pay.bill_rate reads coalesce(bill_rate, hourly_rate) for an owner, so what a customer is
--      billed for his hours never depends on the pay column going to zero (0054 made bill_rate fall
--      back to hourly_rate; this keeps that fallback alive for the owner).
--   3. A new last column, paid_by_draw, says so out loud for readers that need to tell the owner's
--      hours apart (they are billed, they are counted as hours, they are never a cost).
--   4. pay_payments and payroll_runs refuse an owner, and a time entry refuses a pay-rate override on
--      an owner's shift. Recording what the owner takes out is reconciliation, and it belongs in the
--      accountant's software, not in a wages ledger.
--   5. Nothing already stored is rewritten. No time entry, payment or payroll run changes; past hours
--      simply stop costing the next time a page reads them.
--
-- Every owner, every org: there is no per-person or per-org switch (Tahoe Deck is dormant, and a sole
-- proprietor's owner is never an employee).

-- ── 1-3. THE ONE DOOR ────────────────────────────────────────────────────────────────────────────
-- Same columns, same order, same types as 0215 (hourly_rate is numeric(10,2) from 0001, bill_rate is
-- bare numeric from 0054; the casts pin them so the replace cannot change a column type), the same
-- security_barrier and the same WHERE clause. Only the two expressions change, and one column is
-- appended at the end, which is the only kind of change CREATE OR REPLACE VIEW allows.
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
       -- 0286: the owner is paid by owner's draw. His hours are billed and counted, never costed.
       (p.role = 'owner') as paid_by_draw
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
  'The pay/address spine, staff-scoped and READ-ONLY (0215; writes revoked in 0218). Office staff see their whole org; everyone else only their own row. 0286: an owner is paid by owner''s draw, so hourly_rate reads 0 for an owner (never null, so no fallback can restore a wage), bill_rate reads coalesce(bill_rate, hourly_rate) so billing is unchanged, and paid_by_draw says which rows those are.';

-- ── BACKFILL (safety; 0 rows expected) ──────────────────────────────────────────────────────────
-- An owner billed only through the old hourly_rate fallback keeps being billed at that rate once
-- this ships. The view already covers it (coalesce), so this just writes the fact down where the
-- Team page's Bill box reads it back.
update public.profiles
   set bill_rate = hourly_rate
 where role = 'owner'
   and bill_rate is null
   and hourly_rate is not null;

-- ── 4. THE WAGE DOORS REFUSE AN OWNER ───────────────────────────────────────────────────────────
-- pay_payments (0264) records money handed to a person for wages. payroll_runs (0062/0095) holds the
-- frozen snapshot of a locked pay period (kind 'base') and a human-typed mileage settlement (kind
-- 'mileage'). Neither is how an owner is paid. Crew members are never touched by this: it fires only
-- when the row's person is an owner, so markPeriodPaid, settleMileage, unsettleMileage and
-- unmarkPeriodPaid (whose rollbacks re-insert the rows they deleted) keep working for Brian and Jimmy
-- exactly as before. Only INSERT and a change of profile_id are checked, so an old row that already
-- belongs to an owner (0 in ET's books; counted below) can still be read and deleted.
create or replace function public.refuse_wages_for_an_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if new.profile_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.profile_id is not distinct from old.profile_id then
    return new;
  end if;
  select coalesce(nullif(btrim(p.full_name), ''), 'This person')
    into v_name
    from public.profiles p
   where p.id = new.profile_id
     and p.role = 'owner';
  if found then
    raise exception '% is the owner and is paid by owner''s draw, not wages.', v_name;
  end if;
  return new;
end $$;

drop trigger if exists refuse_wages_for_an_owner on public.pay_payments;
create trigger refuse_wages_for_an_owner
  before insert or update of profile_id on public.pay_payments
  for each row execute function public.refuse_wages_for_an_owner();

drop trigger if exists refuse_wages_for_an_owner on public.payroll_runs;
create trigger refuse_wages_for_an_owner
  before insert or update of profile_id on public.payroll_runs
  for each row execute function public.refuse_wages_for_an_owner();

-- A pay-rate override on an owner's shift is a wage by another name. Refused only when the override
-- is being SET or CHANGED to something above zero, or the shift is being MOVED onto an owner while it
-- carries one: the time-entry editor round-trips rate_override on every save, so an unrelated edit to
-- an existing row (notes, job, times) must never start failing because of a value that was already
-- there. But a crew shift at $40 reassigned to the owner would otherwise keep a pay rate nobody can
-- see or clear (the editor hides Rate on his shifts), and it would be live pay again the moment the
-- shift moved back. The editor drops the override on that move. Clearing one (null or 0) is always
-- allowed.
create or replace function public.refuse_pay_rate_on_owner_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if coalesce(new.rate_override, 0) <= 0 then
    return new;
  end if;
  -- Unchanged override on the SAME person: an unrelated edit, never refused. A shift MOVED onto the
  -- owner is checked even when its override did not change: otherwise a crew shift carrying $40
  -- reassigned to him would keep a pay rate nobody can see (the editor hides Rate for his shifts).
  if tg_op = 'UPDATE'
     and new.rate_override is not distinct from old.rate_override
     and new.profile_id is not distinct from old.profile_id then
    return new;
  end if;
  select coalesce(nullif(btrim(p.full_name), ''), 'This person')
    into v_name
    from public.profiles p
   where p.id = new.profile_id
     and p.role = 'owner';
  if found then
    raise exception '% is the owner and is paid by owner''s draw, so a shift of his has no pay rate. Leave the rate blank.', v_name;
  end if;
  return new;
end $$;

drop trigger if exists refuse_pay_rate_on_owner_entry on public.time_entries;
create trigger refuse_pay_rate_on_owner_entry
  before insert or update of rate_override, profile_id on public.time_entries
  for each row execute function public.refuse_pay_rate_on_owner_entry();

-- ── WHO MAY HIDE "LEFT FOR YOU" FROM THE OFFICE ─────────────────────────────────────────────────
-- organizations.settings.office_sees_owner_money (default on, read by lib/org-settings) decides
-- whether office staff see the owner's Left For You card on /analytics. It is the owner's call, and
-- an admin can write organizations.settings directly (organizations_update is owner/admin), so the
-- server action's owner check alone would be a convention. This makes it a boundary: only an owner,
-- or the server itself, may change that one key. Every other settings write is untouched, including
-- an admin's ordinary save that carries the key through unchanged.
create or replace function public.guard_owner_money_visibility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.settings -> 'office_sees_owner_money') is not distinct from (old.settings -> 'office_sees_owner_money') then
    return new;
  end if;
  if public.is_privileged_writer() then
    return new;
  end if;
  if public.app_user_role() is distinct from 'owner' then
    raise exception 'Only the owner can change whether the office sees what is left for the owner.';
  end if;
  return new;
end $$;

drop trigger if exists guard_owner_money_visibility on public.organizations;
create trigger guard_owner_money_visibility
  before update of settings on public.organizations
  for each row execute function public.guard_owner_money_visibility();

-- ── ASSERT WHAT CAN BE ASSERTED ─────────────────────────────────────────────────────────────────
do $$
declare
  r record;
  v_bad integer;
  v_crew_changed integer;
begin
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'public.profile_pay'::regclass
       and attname = 'paid_by_draw'
       and not attisdropped
  ) then
    raise exception '0286: profile_pay has no paid_by_draw column';
  end if;

  -- The view filters on the caller's org, so read it AS each org's owner in turn (the claims
  -- auth.uid() reads under PostgREST), then put the connection back the way it was.
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
       and (v.hourly_rate <> 0 or v.bill_rate is distinct from coalesce(p.bill_rate, p.hourly_rate));
    if v_bad > 0 then
      raise exception '0286: % owner row(s) in org % do not read hourly_rate 0 with the bill rate kept', v_bad, r.org_id;
    end if;

    select count(*) into v_crew_changed
      from public.profile_pay v
      join public.profiles p on p.id = v.id
     where not v.paid_by_draw
       and (v.hourly_rate is distinct from p.hourly_rate or v.bill_rate is distinct from p.bill_rate);
    if v_crew_changed > 0 then
      raise exception '0286: % crew row(s) in org % changed rate through profile_pay', v_crew_changed, r.org_id;
    end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);

  -- Owner rows the new triggers would refuse today, by org. Counts only, never money: these are
  -- left exactly as they are (nothing stored is rewritten) and every reader already ignores them.
  for r in
    select o.id as org_id,
           o.name,
           (select count(*) from public.pay_payments x join public.profiles p on p.id = x.profile_id
             where x.org_id = o.id and p.role = 'owner') as payments,
           (select count(*) from public.payroll_runs x join public.profiles p on p.id = x.profile_id
             where x.org_id = o.id and p.role = 'owner') as runs,
           (select count(*) from public.time_entries x join public.profiles p on p.id = x.profile_id
             where x.org_id = o.id and p.role = 'owner' and x.rate_override is not null) as overrides
      from public.organizations o
     order by o.name
  loop
    raise notice '0286: % (%): owner pay_payments %, owner payroll_runs %, owner rate_override %',
      r.name, r.org_id, r.payments, r.runs, r.overrides;
  end loop;
end $$;
