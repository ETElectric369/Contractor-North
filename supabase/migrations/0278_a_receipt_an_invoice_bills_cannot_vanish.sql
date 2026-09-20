-- THE MATERIALS HALF OF 0261, WHICH WAS NEVER BUILT (audit of cn-v951..v966, 2026-09-20).
--
-- 0261 gave TIME a database ceiling: "hours that are billed cannot vanish", a BEFORE DELETE
-- trigger that refuses when invoice_items.source_ids claims the row. The identical failure on the
-- MATERIALS side had no boundary at all. `bills` carried exactly two triggers, stamp_org_bills and
-- touch_bills, and three doors deleted a bill without ever reading a claim:
--
--   organize/actions.ts fileItem          re-filing a receipt tears its bill down and builds a new one
--   organize/actions.ts deleteOrganizedItem
--   jobs/actions.ts     deleteBill        wired to a bare trash icon
--
-- all three discarding the result, so an RLS refusal was a 204 that read as success.
--
-- WHAT IT COSTS. bill_line_items cascades on delete; invoice_items has NO foreign key to bills,
-- because a claim is a uuid inside an array. So the invoice lines survive the delete intact and go
-- on charging the customer for a receipt that is gone, while the job's cost drops by the same
-- amount and its margin jumps. Re-filing is worse than deleting: the replacement bill gets a new
-- id that no claim covers, so the next invoice bills the same purchase to a second customer.
--
-- 26 of the 30 receipts in his Organize archive back a live invoice line today. Bill c0535cdb,
-- $467.87 of CED on J-046, is claimed by eight lines of INV-069 - which Jason has already part
-- paid.
--
-- The escape hatch is 0261's, word for word: void the invoice, or take its materials lines off,
-- and the claim is released and the delete goes through. No role exemption, for 0261's reason -
-- the owner is exactly the person who can do this by accident at speed.
create or replace function public.guard_billed_bill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_holder text;
begin
  v_holder := public.invoice_holding_claim(array[old.id], old.org_id);
  if v_holder is not null then
    raise exception '% already bills this receipt. Void that invoice, or take its materials lines off, then delete this receipt.', v_holder
      using errcode = 'P0001';
  end if;
  return old;
end $$;

drop trigger if exists guard_billed_bill on public.bills;
create trigger guard_billed_bill
  before delete on public.bills
  for each row execute function public.guard_billed_bill();

-- ──────────────────────────────────────────────────────────────────────────────────────────────
-- TWO SHIFTS FOR ONE PERSON AT THE SAME TIME IS ONE SHIFT COUNTED TWICE.
--
-- 0214/0217's guard refuses only a row whose clock_in AND clock_out are EXACTLY another row's.
-- Overlap was never tested, and payroll's aggregator buckets by person and sums every row it is
-- handed, with no identity or overlap check anywhere above it - so two rows describing the same
-- afternoon are both earned, both owed, and both paid. Brian Taylor has two overlapping pairs in
-- the ledger right now, and both are still UNPAID, which is the only reason this is a fix and not
-- an apology.
--
-- It rides inside 0217's existing `v_times_changed` gate, which is load-bearing twice over: the
-- rows already overlapping stay editable (a note, a job, a mileage or split correction saves
-- untouched), and shortening one off the overlap passes, which is exactly the move being asked
-- for. A minute of tolerance, the same slack 0248 uses, so a clock-out-and-straight-back-in is
-- never called a double shift.
create or replace function public.guard_time_entry_sanity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_span interval;
  v_times_changed boolean;
  v_clash record;
begin
  -- The whole point: judge the CHANGE. On INSERT everything is new; on UPDATE, only act when
  -- a time actually moved. An allocation, job, note, mileage or rate correction rides free.
  v_times_changed := tg_op = 'INSERT'
    or new.clock_in is distinct from old.clock_in
    or new.clock_out is distinct from old.clock_out
    or new.profile_id is distinct from old.profile_id;

  if not v_times_changed then
    return new;
  end if;

  -- ── 1. NEVER TWO IDENTICAL ENTRIES ──────────────────────────────────────────────────────
  if new.clock_in is not null and new.clock_out is not null then
    if exists (
      select 1 from public.time_entries t
       where t.profile_id = new.profile_id
         and t.id is distinct from new.id
         and t.clock_in = new.clock_in
         and t.clock_out = new.clock_out
    ) then
      raise exception 'Those exact times are already recorded for this person on another entry — change the times, or edit that entry instead.';
    end if;

    -- ── 1b. AND NEVER TWO THAT OVERLAP ────────────────────────────────────────────────────
    -- A person cannot be on two jobs at once, and payroll pays for both when they are.
    select t.id, t.clock_in, t.clock_out
      into v_clash
      from public.time_entries t
     where t.profile_id = new.profile_id
       and t.id is distinct from new.id
       and t.clock_out is not null
       and t.clock_in < new.clock_out
       and new.clock_in < t.clock_out
       and least(t.clock_out, new.clock_out) - greatest(t.clock_in, new.clock_in) > interval '1 minute'
     order by t.clock_in
     limit 1;

    if found then
      raise exception 'Those hours overlap a shift already recorded for this person on % (% to %) — edit that entry instead, or move these times clear of it.',
        to_char(v_clash.clock_in at time zone 'America/Los_Angeles', 'Mon FMDD'),
        to_char(v_clash.clock_in at time zone 'America/Los_Angeles', 'FMHH12:MIam'),
        to_char(v_clash.clock_out at time zone 'America/Los_Angeles', 'FMHH12:MIam');
    end if;
  end if;

  -- ── 2. A SHIFT LONGER THAN 18 HOURS IS A FORGOTTEN PUNCH, WHOEVER RECORDED IT ────────────
  if new.clock_in is not null and new.clock_out is not null then
    v_span := new.clock_out - new.clock_in;
    if v_span > interval '18 hours' and coalesce(new.auto_closed_reason, '') = '' then
      raise exception 'That shift is % hours long — a punch was probably forgotten. Fix the times, or add a note saying what happened.',
        round(extract(epoch from v_span) / 3600.0, 1);
    end if;
    if v_span < interval '0' then
      raise exception 'That shift ends before it starts.';
    end if;
  end if;

  return new;
end $$;

-- ──────────────────────────────────────────────────────────────────────────────────────────────
-- A HELPER BUILT FOR TRIGGERS IS NOT A READ ANYONE MAY RUN.
--
-- 0261's invoice_holding_claim is SECURITY DEFINER, so it answers from behind RLS - and it was
-- granted to `authenticated`, which means any signed-in user, including a tech, could ask it which
-- invoice bills a given row and read back the invoice NUMBER. Nothing in the app calls it over
-- PostgREST; every caller is a trigger, and a trigger runs as the function's owner. Taking the
-- grant away costs nothing and closes the read.
revoke execute on function public.invoice_holding_claim(uuid[], uuid) from public;
revoke execute on function public.invoice_holding_claim(uuid[], uuid) from anon;
revoke execute on function public.invoice_holding_claim(uuid[], uuid) from authenticated;
