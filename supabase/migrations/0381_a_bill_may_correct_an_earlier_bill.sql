-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0381: a bill may correct an earlier bill
--
-- Erik, 2026-10-04, with the supplier's invoice in hand for a counter ticket a customer had already
-- been billed for: "i cant find where to make a correction".
--
-- THE GAP. A counter ticket is filed as a bill ($613.19, five lines, one of them a fixture the counter
-- priced at $0.00). The customer's progress invoice bills it and claims it (invoice_items.source_ids
-- holds the BILL id, 0255). Then the supplier's invoice for the same purchase arrives at $709.18: the
-- fixture was $95.99 after all. Today there is no door for that. Editing the bill's amount is allowed,
-- with a warning, and reaches no invoice (a claimed id is skipped by every later import). A second bill
-- for the difference is a second purchase in the books with nothing tying it to the first (the interim
-- workaround: it has no lines and no paper). The one bill→bill column that exists, superseded_by_bill_id
-- (0271), means "not a cost" in thirty files and cannot be made to mean "corrects".
--
-- THE SHAPE (Erik, 2026-10-07, scout questions 2, 4, 5, 6). The original bill stays as filed. The
-- difference is its OWN bill row with its OWN claimable id, attached UNDER the original by this column,
-- carrying its own lines (materials itemized, never a lump) and its own paper. The pair reads as one
-- purchase: $613.19 corrected by 8802-1109100 to $709.18. The next invoice picks the correction up
-- exactly as it picks up any bill on the job, because it IS a bill on the job: no importer changes. A
-- negative correction (a credit memo) rides the supplier-return path, which already credits only the
-- lines the customer was billed for.
--
-- WHAT THIS WRITES, and the rules the database keeps from now on:
--   1. bills.corrects_bill_id → bills(id), ON DELETE RESTRICT. A correction's original cannot vanish
--      from under it: delete the correction first, and the door says so in words.
--   2. guard_bill_correction (BEFORE INSERT OR UPDATE): one level only (a correction of a correction
--      attaches to the first bill instead); never on, and never as, a bill set aside as a duplicate;
--      a bill carrying corrections cannot be set aside; same company; and ONE PURCHASE, ONE JOB, ONE
--      STATE — the correction TAKES the original's job and status when it is attached and cannot
--      leave them after (the refusal names the one action: move or mark the original).
--   3. bill_corrections_follow (AFTER UPDATE OF job_id, status): the original moves or settles, its
--      corrections move or settle with it. A claimed correction refuses the move exactly as a claimed
--      bill does — guard_bill_claim (0280) fires on the child — so the whole move fails and names the
--      invoice. That is the right answer: the claim follows the id, not the job.
--   4. guard_claimed_bill_amount (BEFORE UPDATE OF amount): THE RULE THAT ENDS THE SILENT EDIT. When an
--      invoice already bills this receipt (invoice_holding_claim, 0261), its amount stays and the
--      sentence names the door. The proof it was needed: a claimed bill on a finished job was edited in
--      place to $653.25 on 10-04 and the paid invoice that bills it never heard. Every writer of
--      bills.amount in the app is an INSERT except the Edit Bill door, which refuses first in the same
--      words (bill-claims.ts).
--
-- NOTHING IS MOVED. No row carries the column yet; the pair above is attached through the app's door
-- after this ships, by a person, not here.
--
-- LOCKS: one nullable column with no default (a catalog change), a foreign key validated against an
-- empty column, three triggers. ACCESS EXCLUSIVE on bills for a moment. lock_timeout 15s.
-- ORDER: after 0380. Safe to re-run: every step checks before it writes.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '15s';
set local statement_timeout = '60s';

-- ── 1. THE COLUMN: WHICH EARLIER BILL THIS ONE CORRECTS ─────────────────────────────────────────
alter table public.bills add column if not exists corrects_bill_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bills'::regclass and conname = 'bills_corrects_bill_id_fkey'
  ) then
    alter table public.bills
      add constraint bills_corrects_bill_id_fkey
      foreign key (corrects_bill_id) references public.bills(id) on delete restrict;
  end if;
end $$;

create index if not exists bills_corrects_bill_idx
  on public.bills (corrects_bill_id) where corrects_bill_id is not null;

comment on column public.bills.corrects_bill_id is
  'The earlier bill this one corrects (0381): the supplier''s later paper for the SAME purchase, filed as its own claimable row with its own lines and paper, attached under the original. One level only; same job and status as the original, kept by trigger. Not superseded_by_bill_id, which means "not a cost".';

-- ── 2. ONE LEVEL, SAME COMPANY, ONE PURCHASE ONE JOB ONE STATE ──────────────────────────────────
create or replace function public.guard_bill_correction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  orig    record;
  v_label text;
begin
  -- A bill carrying corrections cannot be set aside as a duplicate: its corrections would be left
  -- correcting "not a cost". Asked only when superseded_by_bill_id is being set.
  if new.superseded_by_bill_id is not null
     and (tg_op = 'INSERT' or new.superseded_by_bill_id is distinct from old.superseded_by_bill_id)
     and exists (select 1 from public.bills b where b.corrects_bill_id = new.id) then
    raise exception 'This bill carries a correction, so it cannot be set aside as a duplicate. Delete the correction first. Nothing was changed.'
      using errcode = 'P0001';
  end if;

  if new.corrects_bill_id is null then
    return new;
  end if;

  if new.corrects_bill_id = new.id then
    raise exception 'A bill cannot correct itself. Nothing was changed.' using errcode = 'P0001';
  end if;
  if new.superseded_by_bill_id is not null then
    raise exception 'A correction cannot be set aside as a duplicate: it belongs to the bill it corrects. Nothing was changed.'
      using errcode = 'P0001';
  end if;

  select b.id, b.org_id, b.job_id, b.status, b.corrects_bill_id, b.superseded_by_bill_id, b.bill_number
    into orig
    from public.bills b
   where b.id = new.corrects_bill_id;
  if not found or orig.org_id is distinct from new.org_id then
    raise exception 'The bill this corrects is not on the books. Nothing was changed.' using errcode = 'P0001';
  end if;
  v_label := coalesce(nullif(orig.bill_number, ''), 'that bill');

  if orig.corrects_bill_id is not null then
    raise exception '% is itself a correction. Attach this one to the bill it corrects. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  if orig.superseded_by_bill_id is not null then
    raise exception '% was set aside as a duplicate. Correct the bill that was kept. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' or new.corrects_bill_id is distinct from old.corrects_bill_id then
    -- Attached: the correction takes the original's job and state, whatever the caller sent.
    new.job_id := orig.job_id;
    new.status := orig.status;
    return new;
  end if;
  if new.job_id is distinct from orig.job_id then
    raise exception 'A correction stays on the job of the bill it corrects (%). Move that bill and this one follows. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  if new.status is distinct from orig.status then
    raise exception 'A correction is settled with the bill it corrects (%). Mark that bill and this one follows. Nothing was changed.', v_label
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists guard_bill_correction on public.bills;
create trigger guard_bill_correction
  before insert or update on public.bills
  for each row execute function public.guard_bill_correction();

-- ── 3. THE ORIGINAL MOVES OR SETTLES; ITS CORRECTIONS FOLLOW ────────────────────────────────────
create or replace function public.bill_corrections_follow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bills b
     set job_id = new.job_id,
         status = new.status
   where b.corrects_bill_id = new.id
     and (b.job_id is distinct from new.job_id or b.status is distinct from new.status);
  return null;
end $$;

drop trigger if exists bill_corrections_follow on public.bills;
create trigger bill_corrections_follow
  after update of job_id, status on public.bills
  for each row
  when (old.job_id is distinct from new.job_id or old.status is distinct from new.status)
  execute function public.bill_corrections_follow();

-- ── 4. A RECEIPT AN INVOICE BILLS KEEPS ITS FIGURE ──────────────────────────────────────────────
create or replace function public.guard_claimed_bill_amount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_holder text;
begin
  if new.amount is not distinct from old.amount then
    return new;
  end if;
  v_holder := public.invoice_holding_claim(array[new.id], new.org_id);
  if v_holder is not null then
    raise exception '% already bills this receipt at $%. Its figure stays. Put the difference on a correction (Correct This Bill) and the next invoice carries it. Nothing was changed.',
      v_holder, to_char(old.amount, 'FM999,999,990.00')
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists guard_claimed_bill_amount on public.bills;
create trigger guard_claimed_bill_amount
  before update of amount on public.bills
  for each row execute function public.guard_claimed_bill_amount();

-- ── 5. VERIFY, OR FAIL THE RUN ──────────────────────────────────────────────────────────────────
do $$
declare
  v_del char;
  n     int;
  t     text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bills' and column_name = 'corrects_bill_id' and data_type = 'uuid'
  ) then
    raise exception '0381: bills.corrects_bill_id is missing after the run.';
  end if;
  select confdeltype into v_del from pg_constraint
   where conrelid = 'public.bills'::regclass and conname = 'bills_corrects_bill_id_fkey';
  if v_del is distinct from 'r' then
    raise exception '0381: the corrects foreign key is not ON DELETE RESTRICT (%).', coalesce(v_del::text, 'missing');
  end if;
  foreach t in array array['guard_bill_correction', 'bill_corrections_follow', 'guard_claimed_bill_amount', 'guard_bill_claim'] loop
    if not exists (select 1 from pg_trigger where tgrelid = 'public.bills'::regclass and tgname = t and not tgisinternal) then
      raise exception '0381: trigger % is not on bills (guard_bill_claim is 0280''s; the follow rule leans on it).', t;
    end if;
  end loop;
  -- The rules hold on every correction row there is (none today; this is the tripwire for a re-run later).
  select count(*) into n
    from public.bills c
    join public.bills o on o.id = c.corrects_bill_id
   where o.corrects_bill_id is not null
      or o.superseded_by_bill_id is not null
      or c.superseded_by_bill_id is not null
      or c.org_id is distinct from o.org_id
      or c.job_id is distinct from o.job_id
      or c.status is distinct from o.status;
  if n > 0 then
    raise exception '0381: % correction row(s) break the rules this file keeps. Nothing more was changed.', n;
  end if;
  select count(*) into n from public.bills where corrects_bill_id is not null;
  raise notice '0381 OK: bills.corrects_bill_id, FK on delete restrict, 3 triggers; % correction row(s) checked.', n;
end $$;
