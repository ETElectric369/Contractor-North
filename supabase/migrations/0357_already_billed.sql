-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0357: Already Billed (a charge made by hand can hold what it charged)
--
-- THE DEFECT. Erik, 2026-09-26: "i have a bill for purple sage that was already charged and i have
-- no way to associate it to the paid invoice becuase i did it manually and that will happen for
-- people i assure you". A cost billed by typing a line ("Materials", $110 on INV-00023) is on no
-- line's claim (invoice_items.source_ids, 0255), so the job reads it as NOT BILLED forever: the
-- Overview's Open figure counts it, the Costs tab lists it under Not Billed Yet, and the next New
-- Invoice bills it again. Tonight it was fixed by hand, as Erik, three times (purple-sage-claim.sql,
-- badger-ace-on-inv060.sql, and the two "Labor - Brian" lines before them). Nothing in the app could
-- do it, and nothing could take it back.
--
-- THE FIX.
--   1. invoice_items.hand_claims uuid[]: the ids a PERSON added to a line's claim. They are a subset
--      of source_ids, so every guard that judges a claim (0258/0259/0260, 0343) judges these too. The
--      column exists so Undo removes only what a person added, never an importer's claim.
--   2. A BEFORE trigger keeps it honest, with no live function rewritten:
--        - a line typed by hand (import_source null) holds everything by hand: no importer writes it;
--        - an id that leaves source_ids leaves hand_claims (join_time_entries removes the absorbed
--          piece with array_remove, 0322; a line edit or re-import rewrites source_ids);
--        - a SPLIT PIECE FOLLOWS ITS SHIFT: a time entry a write adds to source_ids, when a piece of
--          the same shift (the family: coalesce(split_from, id), 0288) is already in hand_claims,
--          joins hand_claims. split_time_entry (0288/0313) appends the new piece to every line that
--          holds the parent; without this, Undo would release half a shift and say nothing. Only on
--          a write that leaves the line's quantity and price alone: an importer that joins a piece
--          to an edited line raises its quantity, and that piece stays the importer's claim.
--   3. mark_already_billed(line, ids) and unmark_already_billed(line, ids, whole), SECURITY INVOKER: they
--      run as the person, so RLS decides who (invoice lines are staff-only, 0056: a tech is
--      refused). Mark refuses, in words, with nothing changed:
--        another company's line or rows; a draft (Add To puts it there), void or deposit invoice; a
--        credit line (draw_credit), a contract line (milestone) or a lump line on a draw that bills
--        no rows (invoice-math lumpLineRule); a $0 line; a line filed as Other, for a charge; an
--        imported line nobody edited (the next import rewrites its claims, 0255); a return onto
--        anything but a line typed by hand that takes money off, or a purchase onto one; anything
--        that is not a live bill, a live purchase order, a closed shift (a split one WHOLE: every
--        unbilled closed piece of it on the job) or a WHOLE live take from stock on the invoice's
--        job (an invoice with no job: on one of its customer's jobs; a take
--        only ever on its own job's invoice, 0343); an id already on any live invoice, this one
--        included (0258 allows a repeat on one invoice; this does not).
--      It changes the claim lists and nothing else, and it checks: if the line's total, the
--      invoice's total or its status moved, it raises and nothing is kept. Unmark removes only ids
--      a person added (a split shift's pieces, and a take's moves, go together), with the same
--      checks, and never on a void invoice (what a void invoice held is its record: un-voiding it
--      is judged against it).
--   4. A claim that changes is something a draw's Progress Summary prints (work to date = billed
--      work lines + unbilled work), so source_ids joins the columns that un-stamp the job's stored
--      draw PDFs (0349's invoice_items_unstamp_draw_pdfs_upd, recreated with one more column).
--   5. BACKFILL, generic: every line typed by hand that holds ids (import_source null) holds them by
--      hand; an edited materials line keyed to one bill or order (bill:<id>, po:<id>) holds any OTHER
--      id by hand, because the importer only ever writes the id its key names. On production that is
--      INV-00023's Materials line (CED 8802-1101475, Purple Sage), INV-059's and INV-060's
--      "Labor - Brian" lines, and the two Ace receipts on INV-060's edited materials line; the
--      one-shot check at the end names those rows and runs only where they exist.
--
-- WHAT IT NEVER DOES: change an invoice's words, dollars or status; write a line's claim for an
-- importer; touch another company.
--
-- LOCKS: ALTER TABLE invoice_items (ADD COLUMN with a constant default: catalogue only, a brief
-- ACCESS EXCLUSIVE); CREATE TRIGGER on invoice_items (SHARE ROW EXCLUSIVE, an instant); the backfill
-- row-locks the few lines it writes. lock_timeout 3s: a busy table fails fast and changes nothing.
--
-- ORDER: after 0258/0260 (the claim boundary), 0288/0313/0322 (split and join), 0343 (stock takes)
-- and 0349 (the un-stamp triggers). Independent of 0356.
--
-- SAFE BEFORE OR AFTER THE CODE: code before this reads no hand_claims and calls neither function;
-- the new code asks for the column and the functions and, without them, says Already Billed needs an
-- update (nothing crashes, nothing is written). Safe to re-run: every step is if-not-exists / create
-- or replace / drop-and-create, and the backfill only touches lines not yet marked (a second run
-- finds none and changes nothing).
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'invoice_items' and column_name = 'source_ids') then
    raise exception '0357: invoice_items.source_ids (0255) is not on this database. Nothing was changed.';
  end if;
  if to_regprocedure('public.guard_invoice_item_claim()') is null then
    raise exception '0357: the claim boundary (0258/0260) is not on this database. Nothing was changed.';
  end if;
  if to_regprocedure('public.unstamp_job_invoice_pdfs()') is null then
    raise exception '0357: the draw PDF un-stamp (0349) is not on this database. Apply 0349 first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_moves') is null then
    raise exception '0357: stock_moves (0303) is not on this database. Nothing was changed.';
  end if;
end $$;

-- ── 1. The column ────────────────────────────────────────────────────────────────────────────────
alter table public.invoice_items
  add column if not exists hand_claims uuid[] not null default '{}'::uuid[];

comment on column public.invoice_items.hand_claims is
  'The ids of source_ids a person added by hand (Already Billed, 0357); on a line typed by hand, all of them. Always a subset of source_ids (trigger invoice_items_hand_claims_follow); Undo (unmark_already_billed) removes only these.';

-- ── 2. The trigger that keeps it honest ──────────────────────────────────────────────────────────
create or replace function public.keep_hand_claims_honest()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_added uuid[];
  v_roots uuid[];
  v_carry uuid[];
begin
  new.hand_claims := coalesce(new.hand_claims, '{}'::uuid[]);

  -- A LINE TYPED BY HAND HOLDS EVERYTHING BY HAND: no importer ever writes it, so whatever it claims
  -- a person put there (the Already Billed door, or a claim written by hand like tonight's).
  if new.import_source is null then
    new.hand_claims := coalesce(new.source_ids, '{}'::uuid[]);
  end if;

  -- A SPLIT PIECE FOLLOWS ITS SHIFT. Only on an update that adds ids to a line holding something by
  -- hand (an importer's line holds nothing by hand, so an import pays one empty check), and only
  -- when the line's charge stays put: split_time_entry appends the new piece and changes nothing
  -- else. An importer that joins a piece to an edited line (joinLaborHours) raises its quantity with
  -- it: those hours are the import's, charged by the line now, so they stay the import's claim and
  -- Not Billed After All never releases hours the line still charges for.
  if tg_op = 'UPDATE' and cardinality(new.hand_claims) > 0
     and new.quantity is not distinct from old.quantity
     and new.unit_price is not distinct from old.unit_price then
    select coalesce(array_agg(s), '{}'::uuid[]) into v_added
      from unnest(coalesce(new.source_ids, '{}'::uuid[])) as s
     where not (s = any (coalesce(old.source_ids, '{}'::uuid[])));
    if cardinality(v_added) > 0 then
      select coalesce(array_agg(distinct coalesce(t.split_from, t.id)), '{}'::uuid[]) into v_roots
        from public.time_entries t
       where t.id = any (new.hand_claims) and t.org_id = new.org_id;
      if cardinality(v_roots) > 0 then
        select coalesce(array_agg(t.id order by t.clock_in, t.id), '{}'::uuid[]) into v_carry
          from public.time_entries t
         where t.id = any (v_added)
           and t.org_id = new.org_id
           and coalesce(t.split_from, t.id) = any (v_roots)
           and not (t.id = any (new.hand_claims));
        new.hand_claims := new.hand_claims || v_carry;
      end if;
    end if;
  end if;

  -- A HAND CLAIM IS A CLAIM: only ids the line still holds, each once, in the order they came.
  new.hand_claims := coalesce((
    select array_agg(x.h order by x.o)
      from (select u.h, min(u.o) as o
              from unnest(new.hand_claims) with ordinality as u(h, o)
             where u.h = any (coalesce(new.source_ids, '{}'::uuid[]))
             group by u.h) x
  ), '{}'::uuid[]);
  return new;
end;
$$;

comment on function public.keep_hand_claims_honest() is
  'Keeps invoice_items.hand_claims a subset of source_ids, and carries a split shift''s new piece into hand_claims when a piece of the same shift is there (0357).';

drop trigger if exists invoice_items_hand_claims_follow on public.invoice_items;
create trigger invoice_items_hand_claims_follow
  before insert or update of source_ids, hand_claims on public.invoice_items
  for each row execute function public.keep_hand_claims_honest();

-- ── 3. Mark and unmark ───────────────────────────────────────────────────────────────────────────
create or replace function public.mark_already_billed(p_line uuid, p_ids uuid[])
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org     uuid := public.auth_org_id();
  v_line    record;
  v_inv     record;
  v_ids     uuid[];
  v_jobs    uuid[];
  v_id      uuid;
  v_b       record;
  v_p       record;
  v_t       record;
  v_m       record;
  v_hit     record;
  v_after   record;
  v_num     text;
  v_neg     boolean;
  v_n       integer;
  v_itemized constant text[] := array['labor', 'costs', 'change_orders', 'quote'];
begin
  if v_org is null or not public.is_org_staff() then
    raise exception 'Only the office can mark something as already billed. Nothing was changed.' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_ids from unnest(coalesce(p_ids, '{}'::uuid[])) as x where x is not null;
  if cardinality(v_ids) = 0 then
    raise exception 'Pick what that line already charged for. Nothing was changed.' using errcode = '22023';
  end if;
  if cardinality(v_ids) > 500 then
    raise exception 'That is more than 500 things for one line. Mark them in smaller batches. Nothing was changed.' using errcode = '22023';
  end if;

  -- THE CLAIM LOCK (0260's org key) before any claim is read: an import or a split racing this waits.
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || v_org::text));

  select ii.id, ii.invoice_id, ii.org_id, ii.description, ii.line_total, ii.import_source, ii.import_key,
         ii.edited, ii.line_kind, ii.source_ids, ii.hand_claims
    into v_line
    from public.invoice_items ii
   where ii.id = p_line
   for update;
  if not found or v_line.org_id is distinct from v_org then
    raise exception 'That invoice line was not found. Nothing was changed.' using errcode = 'P0002';
  end if;
  select i.id, i.org_id, i.invoice_number, i.status::text as status, coalesce(i.invoice_kind, 'standard') as kind,
         i.job_id, i.customer_id, i.total
    into v_inv
    from public.invoices i
   where i.id = v_line.invoice_id
   for update;
  if not found or v_inv.org_id is distinct from v_org then
    raise exception 'That invoice line was not found. Nothing was changed.' using errcode = 'P0002';
  end if;
  v_num := coalesce(v_inv.invoice_number, 'That invoice');

  -- THE INVOICE.
  if v_inv.status = 'draft' then
    raise exception '% is still a draft: Add To % puts it there. Nothing was changed.', v_num, v_num using errcode = 'P0001';
  elsif v_inv.status = 'void' then
    raise exception '% is void, so it bills nothing. Nothing was changed.', v_num using errcode = 'P0001';
  elsif v_inv.kind = 'deposit' then
    raise exception '% is a deposit: it bills a part of the job up front, not this. Pick a line on another invoice. Nothing was changed.', v_num using errcode = 'P0001';
  end if;

  -- THE LINE.
  if v_line.import_source = 'draw_credit' then
    raise exception 'That line is the credit for earlier payments, not a charge. Nothing was changed.' using errcode = 'P0001';
  end if;
  if v_line.import_source = 'milestone'
     or (v_inv.kind <> 'standard'
         and not (coalesce(v_line.import_source, '') = any (v_itemized))
         and not exists (select 1 from public.invoice_items x where x.invoice_id = v_inv.id and x.import_source = any (v_itemized))) then
    raise exception 'That line bills a set part of the contract, not work item by item. Nothing was changed.' using errcode = 'P0001';
  end if;
  if coalesce(v_line.line_total, 0) = 0 then
    raise exception 'That line is $0.00, so it charged for nothing. Nothing was changed.' using errcode = 'P0001';
  end if;
  v_neg := v_line.line_total < 0;
  if v_line.import_source is not null and v_line.edited is not true then
    raise exception 'That line came from an import and nobody has changed it, so the next import rewrites what it holds. Pick a line you typed or changed. Nothing was changed.' using errcode = 'P0001';
  end if;
  if not v_neg and v_line.line_kind = 'other' then
    raise exception 'That line is filed as Other (a fee, a referral, a discount), not work. Nothing was changed.' using errcode = 'P0001';
  end if;
  if v_neg and v_line.import_source is not null then
    raise exception 'A return goes on a line you typed that takes money off. Nothing was changed.' using errcode = 'P0001';
  end if;

  -- WHERE THE ROWS MAY COME FROM: the invoice's job, or, for an invoice with no job, its customer's jobs.
  if v_inv.job_id is not null then
    v_jobs := array[v_inv.job_id];
  elsif v_inv.customer_id is not null then
    select coalesce(array_agg(j.id), '{}'::uuid[]) into v_jobs
      from public.jobs j where j.customer_id = v_inv.customer_id and j.org_id = v_org;
  else
    v_jobs := '{}'::uuid[];
  end if;

  -- WHAT: each id, in the office's words when it is refused.
  foreach v_id in array v_ids loop
    select b.id, b.org_id, b.job_id, b.amount, b.superseded_by_bill_id into v_b from public.bills b where b.id = v_id;
    if found then
      if v_b.org_id is distinct from v_org then
        raise exception 'That receipt isn''t in your company''s books. Nothing was changed.' using errcode = '42501';
      elsif v_b.superseded_by_bill_id is not null then
        raise exception 'That receipt was set aside as a copy of another one, so it is not a cost. Nothing was changed.' using errcode = 'P0001';
      elsif v_b.job_id is null or not (v_b.job_id = any (v_jobs)) then
        raise exception 'That receipt is on another job, not on %''s. Nothing was changed.', v_num using errcode = 'P0001';
      elsif coalesce(v_b.amount, 0) = 0 then
        raise exception 'That receipt is $0.00, so there is nothing of it to bill. Nothing was changed.' using errcode = 'P0001';
      elsif v_b.amount < 0 and not v_neg then
        raise exception 'That is a return: it takes money off, so it goes on a line you typed that takes money off. Nothing was changed.' using errcode = 'P0001';
      elsif v_b.amount > 0 and v_neg then
        raise exception 'That line takes money off, so only a return goes on it. Nothing was changed.' using errcode = 'P0001';
      end if;
      continue;
    end if;

    select p.id, p.org_id, p.job_id, p.total, p.status::text as status into v_p from public.purchase_orders p where p.id = v_id;
    if found then
      if v_p.org_id is distinct from v_org then
        raise exception 'That order isn''t in your company''s books. Nothing was changed.' using errcode = '42501';
      elsif v_p.job_id is null or not (v_p.job_id = any (v_jobs)) then
        raise exception 'That order is on another job, not on %''s. Nothing was changed.', v_num using errcode = 'P0001';
      elsif v_p.status in ('draft', 'cancelled') then
        raise exception 'That order was never placed (it is a draft or cancelled), so it is not a cost. Nothing was changed.' using errcode = 'P0001';
      elsif exists (select 1 from public.bills b where b.po_id = v_p.id and b.org_id = v_org and b.superseded_by_bill_id is null) then
        raise exception 'The supplier''s bill for that order is in your books, so the bill is the cost now. Mark the bill instead. Nothing was changed.' using errcode = 'P0001';
      elsif coalesce(v_p.total, 0) <= 0 then
        raise exception 'That order is $0.00, so there is nothing of it to bill. Nothing was changed.' using errcode = 'P0001';
      elsif v_neg then
        raise exception 'That line takes money off, so only a return goes on it. Nothing was changed.' using errcode = 'P0001';
      end if;
      continue;
    end if;

    select t.id, t.org_id, t.job_id, t.status::text as status, t.clock_out into v_t from public.time_entries t where t.id = v_id;
    if found then
      if v_t.org_id is distinct from v_org then
        raise exception 'That shift isn''t in your company''s books. Nothing was changed.' using errcode = '42501';
      elsif v_t.job_id is null or not (v_t.job_id = any (v_jobs)) then
        raise exception 'That shift is on another job, not on %''s. Nothing was changed.', v_num using errcode = 'P0001';
      elsif v_t.status <> 'closed' or v_t.clock_out is null then
        raise exception 'That shift is still running. Clock it out first. Nothing was changed.' using errcode = 'P0001';
      elsif v_neg then
        raise exception 'That line takes money off, so only a return goes on it. Nothing was changed.' using errcode = 'P0001';
      end if;
      continue;
    end if;

    select m.id, m.org_id, m.job_id, m.kind, m.undone_at, m.draw_group into v_m from public.stock_moves m where m.id = v_id;
    if found then
      if v_m.org_id is distinct from v_org then
        raise exception 'Those pieces aren''t on your company''s shelf record. Nothing was changed.' using errcode = '42501';
      elsif v_inv.job_id is null then
        raise exception 'Pieces taken from stock are billed on their job''s invoice. Nothing was changed.' using errcode = 'P0001';
      elsif v_m.kind <> 'draw' or v_m.draw_group is null then
        raise exception 'Only pieces taken onto a job are billed. That entry is a count, a write-off, a return or a short. Nothing was changed.' using errcode = 'P0001';
      elsif v_m.undone_at is not null then
        raise exception 'That take was undone, so its pieces are back on the shelf. Nothing was changed.' using errcode = 'P0001';
      elsif v_m.job_id is distinct from v_inv.job_id then
        raise exception 'Those pieces were taken for another job, not for %''s. Nothing was changed.', v_num using errcode = 'P0001';
      elsif v_neg then
        raise exception 'That line takes money off, so only a return goes on it. Nothing was changed.' using errcode = 'P0001';
      end if;
      continue;
    end if;

    raise exception 'One of those isn''t a receipt, an order, a shift or a take from stock in your books. Nothing was changed.' using errcode = 'P0002';
  end loop;

  -- A TAKE IS BILLED WHOLE: every live draw of each take named here, or none of it.
  if exists (
    select 1
      from public.stock_moves m
     where m.draw_group in (select d.draw_group from public.stock_moves d where d.id = any (v_ids) and d.draw_group is not null)
       and m.org_id = v_org
       and m.kind = 'draw'
       and m.undone_at is null
       and not (m.id = any (v_ids))
  ) then
    raise exception 'A take from stock is billed whole: mark every piece of it, or none. Nothing was changed.' using errcode = 'P0001';
  end if;

  -- A SPLIT SHIFT IS BILLED WHOLE: every piece of each shift named here that is on the same job,
  -- closed, billable, of some length and on no live invoice (every piece the sheet lists), or none.
  -- Then the only piece that joins a hand claim later is one split_time_entry cuts from a piece
  -- already held (the trigger's carry), never a free piece an importer bills on the same line.
  if exists (
    select 1
      from public.time_entries t
      join public.time_entries m
        on m.id = any (v_ids)
       and m.org_id = v_org
       and coalesce(t.split_from, t.id) = coalesce(m.split_from, m.id)
       and t.job_id = m.job_id
     where t.org_id = v_org
       and not (t.id = any (v_ids))
       and t.status = 'closed'
       and t.clock_out is not null
       and extract(epoch from (t.clock_out - t.clock_in)) / 3600.0 - greatest(coalesce(t.lunch_minutes, 0), 0) / 60.0 > 0
       and not (t.job_code is not null and exists (
             select 1 from public.job_codes jc
              where jc.org_id = v_org and jc.billable = false and btrim(jc.code) = btrim(t.job_code)))
       and not exists (
             select 1
               from public.invoice_items x
               join public.invoices xi on xi.id = x.invoice_id
              where xi.org_id = v_org and xi.status <> 'void' and x.source_ids @> array[t.id])
  ) then
    raise exception 'A split shift is billed whole: tick every part of it, or none. Nothing was changed.' using errcode = 'P0001';
  end if;

  -- NEVER TWICE: not on any live invoice, this one included.
  select xi.invoice_number, (x.invoice_id = v_inv.id) as same
    into v_hit
    from public.invoice_items x
    join public.invoices xi on xi.id = x.invoice_id
   where xi.org_id = v_org
     and xi.status <> 'void'
     and x.source_ids && v_ids
   order by (x.invoice_id = v_inv.id) desc, xi.created_at, xi.id
   limit 1;
  if found then
    if v_hit.same then
      raise exception '% already holds that. Nothing was changed.', v_num using errcode = 'P0001';
    end if;
    raise exception 'That is already billed on %. Nothing was changed.', coalesce(v_hit.invoice_number, 'another invoice') using errcode = 'P0001';
  end if;

  -- THE WRITE: the claim lists, nothing else. 0258/0260 and 0343 judge the new ids as they judge any.
  update public.invoice_items
     set source_ids  = source_ids || v_ids,
         hand_claims = hand_claims || v_ids
   where id = v_line.id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'That line could not be marked just now. Nothing was changed.' using errcode = 'P0001';
  end if;

  -- NOTHING ON THE BILL MOVED, or nothing is kept.
  select ii.line_total, i.total, i.status::text as status
    into v_after
    from public.invoice_items ii join public.invoices i on i.id = ii.invoice_id
   where ii.id = v_line.id;
  if v_after.line_total is distinct from v_line.line_total
     or v_after.total is distinct from v_inv.total
     or v_after.status is distinct from v_inv.status then
    raise exception 'Marking that would have changed %''s total or status, so nothing was changed.', v_num using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'line_id', v_line.id,
    'invoice_id', v_inv.id,
    'invoice_number', v_inv.invoice_number,
    'description', v_line.description,
    'line_total', v_line.line_total,
    'added', to_jsonb(v_ids));
end;
$$;

comment on function public.mark_already_billed(uuid, uuid[]) is
  'Already Billed (0357): a line on a sent invoice claims receipts, orders, shifts or whole takes it already charged for by hand. Claim lists only; refuses anything that would move a total or status. SECURITY INVOKER: RLS decides who.';

-- One signature: an earlier copy of this migration made it (uuid, uuid[]), and a call naming only
-- p_line and p_ids would find both.
drop function if exists public.unmark_already_billed(uuid, uuid[]);
create or replace function public.unmark_already_billed(p_line uuid, p_ids uuid[], p_whole boolean default true)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org    uuid := public.auth_org_id();
  v_line   record;
  v_inv    record;
  v_ids    uuid[];
  v_remove uuid[];
  v_after  record;
  v_num    text;
  v_n      integer;
begin
  if v_org is null or not public.is_org_staff() then
    raise exception 'Only the office can change what an invoice line holds. Nothing was changed.' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct x), '{}'::uuid[]) into v_ids from unnest(coalesce(p_ids, '{}'::uuid[])) as x where x is not null;
  if cardinality(v_ids) = 0 then
    raise exception 'Pick what should come off that line. Nothing was changed.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || v_org::text));

  select ii.id, ii.invoice_id, ii.org_id, ii.line_total, ii.source_ids, ii.hand_claims
    into v_line
    from public.invoice_items ii
   where ii.id = p_line
   for update;
  if not found or v_line.org_id is distinct from v_org then
    raise exception 'That invoice line was not found. Nothing was changed.' using errcode = 'P0002';
  end if;
  select i.id, i.invoice_number, i.status::text as status, i.total into v_inv
    from public.invoices i where i.id = v_line.invoice_id and i.org_id = v_org
   for update;
  if not found then
    raise exception 'That invoice line was not found. Nothing was changed.' using errcode = 'P0002';
  end if;
  v_num := coalesce(v_inv.invoice_number, 'that invoice');
  -- A VOID INVOICE'S LINES NEVER CHANGE: what it held is its record, and 0259 reads it when the
  -- invoice is un-voided. Erasing it would let the un-void land beside a live bill of the same cost.
  if v_inv.status = 'void' then
    raise exception '% is void: what it held stays as its record. Nothing was changed.', v_num using errcode = 'P0001';
  end if;

  -- ONLY WHAT A PERSON ADDED.
  if exists (select 1 from unnest(v_ids) as x where not (x = any (v_line.hand_claims))) then
    raise exception 'Only what was marked as already billed by hand comes off here; the rest is on % from an import. Nothing was changed.', v_num using errcode = 'P0001';
  end if;
  -- A SPLIT SHIFT COMES OFF WHOLE: every piece of the same shift this line holds by hand goes with it
  -- (Not Billed After All). p_whole false is a mark's own Undo: exactly what that mark added, so an
  -- earlier, separate mark of another piece of the same shift stays on.
  -- A TAKE FROM STOCK COMES OFF WHOLE, always, as it went on (0343 judges only ids that are added, so
  -- a take left half on would read as billed and its other half would never be).
  select coalesce(array_agg(distinct h), '{}'::uuid[]) into v_remove
    from (
      select unnest(v_ids) as h
      union
      select t.id
        from public.time_entries t
       where coalesce(p_whole, true)
         and t.id = any (v_line.hand_claims)
         and t.org_id = v_org
         and coalesce(t.split_from, t.id) in (select coalesce(t2.split_from, t2.id) from public.time_entries t2 where t2.id = any (v_ids) and t2.org_id = v_org)
      union
      select m.id
        from public.stock_moves m
       where m.id = any (v_line.hand_claims)
         and m.org_id = v_org
         and m.draw_group in (select m2.draw_group from public.stock_moves m2 where m2.id = any (v_ids) and m2.org_id = v_org and m2.draw_group is not null)
    ) s;

  update public.invoice_items
     set source_ids  = coalesce((select array_agg(s order by o) from unnest(source_ids) with ordinality as u(s, o) where not (s = any (v_remove))), '{}'::uuid[]),
         hand_claims = coalesce((select array_agg(s order by o) from unnest(hand_claims) with ordinality as u(s, o) where not (s = any (v_remove))), '{}'::uuid[])
   where id = v_line.id;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'That line could not be changed just now. Nothing was changed.' using errcode = 'P0001';
  end if;

  select ii.line_total, i.total, i.status::text as status
    into v_after
    from public.invoice_items ii join public.invoices i on i.id = ii.invoice_id
   where ii.id = v_line.id;
  if v_after.line_total is distinct from v_line.line_total
     or v_after.total is distinct from v_inv.total
     or v_after.status is distinct from v_inv.status then
    raise exception 'Taking that off would have changed %''s total or status, so nothing was changed.', v_num using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'line_id', v_line.id,
    'invoice_id', v_inv.id,
    'invoice_number', v_inv.invoice_number,
    'removed', to_jsonb(v_remove));
end;
$$;

comment on function public.unmark_already_billed(uuid, uuid[], boolean) is
  'Not Billed After All (0357): takes ids a person marked as already billed back off a line (a split shift''s pieces together unless p_whole is false, a mark''s own Undo; a take''s moves together always). Never an importer''s claim; refuses anything that would move a total or status. SECURITY INVOKER.';

revoke all on function public.mark_already_billed(uuid, uuid[]) from public;
revoke all on function public.unmark_already_billed(uuid, uuid[], boolean) from public;
revoke all on function public.keep_hand_claims_honest() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.mark_already_billed(uuid, uuid[]) from anon';
    execute 'revoke all on function public.unmark_already_billed(uuid, uuid[], boolean) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.mark_already_billed(uuid, uuid[]) to authenticated';
    execute 'grant execute on function public.unmark_already_billed(uuid, uuid[], boolean) to authenticated';
  end if;
end $$;

-- ── 4. A claim that changes un-stamps the job's stored draw PDFs (0349, one more column) ───────────
drop trigger if exists invoice_items_unstamp_draw_pdfs_upd on public.invoice_items;
create trigger invoice_items_unstamp_draw_pdfs_upd
  -- line_total is generated from quantity and unit_price, so those are the columns a write names.
  -- source_ids (0357): what a line claims is what the Progress Summary's work to date counts.
  after update of invoice_id, quantity, unit_price, line_kind, import_source, unit, description, source_ids on public.invoice_items
  for each row
  when ((old.invoice_id, old.quantity, old.unit_price, old.line_kind, old.import_source, old.unit, old.description, old.source_ids)
        is distinct from
        (new.invoice_id, new.quantity, new.unit_price, new.line_kind, new.import_source, new.unit, new.description, new.source_ids))
  execute function public.unstamp_job_invoice_pdfs('draws');

-- ── 5. Backfill: the claims people already made by hand ──────────────────────────────────────────
-- Lines typed by hand: everything they hold was put there by a person (the trigger keeps it so).
update public.invoice_items
   set hand_claims = source_ids
 where import_source is null
   and cardinality(source_ids) > 0
   and not (source_ids <@ hand_claims);

-- An edited materials line keyed to ONE bill or order: any other id on it was put there by a person.
update public.invoice_items ii
   set hand_claims = coalesce((
         select array_agg(u.s order by u.o)
           from unnest(ii.source_ids) with ordinality as u(s, o)
          where u.s <> substring(ii.import_key from '^(?:po|bill):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')::uuid
       ), '{}'::uuid[])
 where ii.import_source = 'costs'
   and ii.edited
   and ii.import_key ~* '^(po|bill):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
   and cardinality(ii.hand_claims) = 0
   and exists (select 1 from unnest(ii.source_ids) as s
                where s <> substring(ii.import_key from '^(?:po|bill):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')::uuid);

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  n int;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'invoice_items' and column_name = 'hand_claims') then
    raise exception '0357: invoice_items.hand_claims did not land. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'invoice_items_hand_claims_follow' and tgrelid = 'public.invoice_items'::regclass
                    and tgfoid = 'public.keep_hand_claims_honest()'::regprocedure) then
    raise exception '0357: the hand-claims trigger is missing. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.keep_hand_claims_honest()'::regprocedure and prosecdef) then
    raise exception '0357: keep_hand_claims_honest must be SECURITY DEFINER (it reads a split shift''s pieces). Nothing was changed.';
  end if;
  if exists (select 1 from pg_proc where oid in ('public.mark_already_billed(uuid, uuid[])'::regprocedure,
                                                 'public.unmark_already_billed(uuid, uuid[], boolean)'::regprocedure) and prosecdef) then
    raise exception '0357: mark/unmark_already_billed must run as the person (SECURITY INVOKER), so RLS refuses a tech. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'invoice_items_unstamp_draw_pdfs_upd' and tgrelid = 'public.invoice_items'::regclass
                    and tgfoid = 'public.unstamp_job_invoice_pdfs()'::regprocedure
                    and pg_get_triggerdef(oid) like '%source_ids%') then
    raise exception '0357: the draw PDF un-stamp trigger does not watch source_ids. Nothing was changed.';
  end if;
  select count(*) into n from public.invoice_items where not (hand_claims <@ source_ids);
  if n > 0 then
    raise exception '0357: % line(s) hold by hand an id they do not claim. Nothing was changed.', n;
  end if;
  select count(*) into n from public.invoice_items
   where import_source is null and cardinality(source_ids) > 0 and not (source_ids <@ hand_claims);
  if n > 0 then
    raise exception '0357: % line(s) typed by hand hold ids that are not marked as held by hand. Nothing was changed.', n;
  end if;

  -- ONE-SHOT, PRODUCTION'S OWN ROWS (read on 2026-09-26, SELECT only; runs only where they exist):
  -- the four lines Erik's by-hand claims sit on, now held by hand.
  if exists (select 1 from public.invoice_items where id = '4ea8032c-677c-4d12-af5f-937154806c48') then
    -- INV-00023 "Materials" $110 (Purple Sage J-010): CED 8802-1101475, bill 52462c4b.
    if not exists (select 1 from public.invoice_items where id = '4ea8032c-677c-4d12-af5f-937154806c48'
                      and hand_claims @> array['52462c4b-bbac-4865-9050-4af6e90dec45']::uuid[]) then
      raise exception '0357: INV-00023''s Materials line does not hold the Purple Sage bill by hand. Nothing was changed.';
    end if;
  end if;
  if exists (select 1 from public.invoice_items where id = 'eb78ed71-4dfc-4eac-807e-471ce6a8eb87') then
    -- INV-060's edited materials line (Badger J-039): the two 8/17 Ace receipts, never the Home Depot bill its key names.
    if not exists (select 1 from public.invoice_items where id = 'eb78ed71-4dfc-4eac-807e-471ce6a8eb87'
                      and hand_claims @> array['5b12146d-514a-4f7c-a34b-a68ad292dbda', 'd66d55a9-5b45-42d4-a68f-66f996509a32']::uuid[]
                      and not (hand_claims @> array['5e1b0b67-f0f3-4ee6-b420-004413d79a48']::uuid[])) then
      raise exception '0357: INV-060''s materials line does not hold exactly the two Ace receipts by hand. Nothing was changed.';
    end if;
  end if;
  if exists (select 1 from public.invoice_items where id in ('6180893e-7767-4ed5-a1db-c542cc2430e8', '5b25245c-50fe-4666-b90f-44e4063213a1')) then
    -- INV-059's and INV-060's "Labor - Brian", typed by hand.
    select count(*) into n from public.invoice_items
     where id in ('6180893e-7767-4ed5-a1db-c542cc2430e8', '5b25245c-50fe-4666-b90f-44e4063213a1')
       and cardinality(source_ids) > 0 and source_ids <@ hand_claims;
    if n <> (select count(*) from public.invoice_items where id in ('6180893e-7767-4ed5-a1db-c542cc2430e8', '5b25245c-50fe-4666-b90f-44e4063213a1')) then
      raise exception '0357: a "Labor - Brian" line typed by hand does not hold its shifts by hand. Nothing was changed.';
    end if;
  end if;

  select count(*) into n from public.invoice_items where cardinality(hand_claims) > 0;
  raise notice '0357: Already Billed is on. % line(s) hold something by hand.', n;
end $$;
