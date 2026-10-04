-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0379: a job is born billing the way this company bills
--
-- THE CHAIN AUDIT'S SECOND HIGH FINDING, 2026-10-03. Erik's rule: "all things pertaining to each
-- other should stay attached and when one door opens the previous closes, attaches and logs all
-- information forward." This is a CARRY-FORWARD failure, and the worst kind: what was not carried
-- silently switched off a safety net.
--
-- `jobs.billing_type` defaulted to 'fixed'. FOUR doors that make a job named it not at all:
--   createJobFromQuote (accepting an estimate), createJobFromAppointment, recurring-engine, and
--   accept_public_quote — the customer's own Accept link, in SQL, which names ten columns and not
--   this one. Only the New Job form ever asked readUsualBillingKind(). On ET's book, 27 of 36 jobs
--   are T&M, so 'fixed' is the wrong answer nearly every time.
--
-- IT IS NOT A LABEL. jobBillsItsActuals(billing_type) gates:
--   · whether the hours and receipts are OFFERED when invoicing (invoice-import-rule),
--   · the job page's Unbilled card, and the customer's portal view,
--   · and STEP 4 of completeJobWhenPaid — the guard that exists BECAUSE hours once went unbilled.
-- So a T&M job born 'fixed' completes silently the moment a customer taps Pay, and its unbilled work
-- is then invisible on every surface at once: the Unbilled card is gated on the same rule, and
-- 0371's Done, Not Billed pile excludes the job because it HAS an invoice. Money earned, never
-- billed, nobody told.
--
-- WHY THE FIX IS HERE AND NOT IN FOUR PLACES. Three of the four doors are now fixed in TypeScript,
-- and the fourth is a SQL function. Four doors forgot the same thing; a fifth will. So the rule goes
-- where no door can route around it: the column stops DEFAULTING to an answer and a trigger fills it
-- with the company's own, the same arithmetic as lib/schedule-options usualBillingKind — more fixed
-- than T&M means fixed, otherwise T&M (a tie, and an empty book, are T&M).
--
-- A door that NAMES a billing type still wins, always. This only answers when nobody said.
--
-- NOT NULL STAYS. A BEFORE INSERT trigger runs before the NOT NULL check, so dropping the DEFAULT
-- and filling in the trigger leaves the column as strict as it was. Nothing existing changes: every
-- job already written keeps the billing type it has, and this file rewrites no rows — a job already
-- born 'fixed' by the old default is a thing a person may have since confirmed, and guessing again
-- on its behalf months later is not a migration's business.
--
-- LOCKS: one default dropped (catalog only) and one trigger added on public.jobs. ACCESS EXCLUSIVE
-- for a moment. lock_timeout 15s (an ALTER on jobs wants ACCESS EXCLUSIVE and 3s lost the race on a busy database; 15s still fails fast and changes nothing). Safe to re-run. Safe before or after the code.
--
-- ORDER: after 0063 (billing_type). Additive.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '15s';
set local statement_timeout = '30s';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'jobs' and column_name = 'billing_type'
  ) then
    raise exception '0379: jobs.billing_type is not on this database. Nothing was changed.';
  end if;
end $$;

-- ── THE COMPANY'S OWN ANSWER ────────────────────────────────────────────────────────────────────
-- The SQL twin of lib/schedule-options usualBillingKind. Pinned by its own test on the app side; if
-- one of the pair changes, the other is wrong and a job is born billing the way nobody does.
create or replace function public.usual_billing_type(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
           when (select count(*) from public.jobs where org_id = p_org and billing_type = 'fixed')
              > (select count(*) from public.jobs where org_id = p_org and billing_type = 'tm')
           then 'fixed' else 'tm'
         end;
$$;

comment on function public.usual_billing_type(uuid) is
  'How this company mostly bills (0379): more fixed than T&M is ''fixed'', otherwise ''tm'' — a tie and an empty book are both T&M. The SQL twin of lib/schedule-options usualBillingKind. SECURITY DEFINER because it counts the caller''s OWN org''s jobs and is only ever called with new.org_id by the trigger below.';

-- ── A JOB NOBODY TYPED A BILLING TYPE FOR GETS THIS COMPANY'S ───────────────────────────────────
create or replace function public.fill_billing_type()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A DOOR THAT SAID SO ALWAYS WINS. This answers only where nobody did.
  if new.billing_type is null then
    new.billing_type := public.usual_billing_type(coalesce(new.org_id, public.auth_org_id()));
  end if;
  -- Its own org, never a guess: if org_id is somehow still unknown, fall to the safer of the two.
  -- T&M is safer because it OFFERS the hours and receipts rather than hiding them; a wrong 'tm'
  -- asks a question, a wrong 'fixed' swallows the answer.
  if new.billing_type is null then
    new.billing_type := 'tm';
  end if;
  return new;
end;
$$;

drop trigger if exists zz_fill_billing_type_jobs on public.jobs;
-- Named to sort LAST among this table's BEFORE INSERT triggers so org_id is already stamped by
-- stamp_org_jobs when it runs; it also falls back to auth_org_id(), so the order is belt and braces.
create trigger zz_fill_billing_type_jobs
  before insert on public.jobs
  for each row execute function public.fill_billing_type();

-- The column stops answering for itself. The trigger above answers instead, before NOT NULL is
-- checked, so the column is exactly as strict as it was.
alter table public.jobs alter column billing_type drop default;

-- ── WHAT MUST BE TRUE NOW ───────────────────────────────────────────────────────────────────────
do $$
declare d text; n text;
begin
  select column_default, is_nullable into d, n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'jobs' and column_name = 'billing_type';
  if d is not null then
    raise exception '0379: jobs.billing_type still defaults to %, so a door that says nothing still gets an answer nobody chose. Nothing was changed.', d;
  end if;
  if n <> 'NO' then
    raise exception '0379: jobs.billing_type became nullable. The trigger fills it before NOT NULL is checked, so it must stay NOT NULL. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'zz_fill_billing_type_jobs' and not tgisinternal) then
    raise exception '0379: the fill trigger is not on jobs, so an insert naming no billing type would now fail NOT NULL. Nothing was changed.';
  end if;
  if public.usual_billing_type('00000000-0000-0000-0000-000000000000'::uuid) <> 'tm' then
    raise exception '0379: an empty book does not answer T&M. Nothing was changed.';
  end if;
  raise notice '0379: a job is born billing the way this company bills.';
end $$;
