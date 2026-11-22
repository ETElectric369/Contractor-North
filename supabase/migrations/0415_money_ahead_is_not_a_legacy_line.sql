-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0415: money ahead is not a legacy line (cn-v1177)
--
-- WHY. 0414 gave the books two lines that bill no work: a payment request's own line (import_source
-- 'prepayment') and the line that takes a request off a later bill ('prepaid_credit'). Both carry an
-- import source and no source_ids BY DESIGN: neither came from an importer, neither bills an hour or
-- a receipt, and each is held by 0414's own boundary. An older guard reads exactly that shape as
-- something else. guard_invoice_unvoid (0259, last made by 0260) calls a line with an import source
-- and no recorded claim "a claim that was never recorded": a line from before 0255, whose hours
-- nothing can check, on a bill that must not come back from void beside any other live bill. So a
-- voided bill carrying a "Less deposit" line could never come back, not even as a draft, because its
-- own request is always another live bill on the same job; and a voided request could not come back
-- beside any bill. The refusal said the bill was built before lines recorded what they bill, which is
-- untrue of a bill made yesterday, and it named the request as the bill it might double.
--
-- HOW IT WAS FOUND. Not by a reader. src/lib/payment-request.integration.test.ts ran against the
-- test database as the first step of cn-v1177's release, and one of its cases (a bill carrying a
-- credit comes back from void as a draft) was refused by 0260's guard, in 0260's words, before 0414's
-- trigger was ever asked. The release stopped there; nothing had reached production. The app's twin
-- of the rule (unvoidConflict, src/app/(app)/billing/actions.ts) had the same blind spot and its unit
-- test had passed only because the in-memory database it runs on did not hand the door a bill's
-- lines; both are corrected in the same commit, and both ask ONE predicate
-- (src/lib/prepayments.ts isMoneyAheadLine).
--
-- WHAT THIS FILE DOES. One thing: public.guard_invoice_unvoid() is re-made from the body 0260 left,
-- with ONE predicate added to its first read (the legacy read) and nothing else, so that read no
-- longer counts a 'prepayment' or a 'prepaid_credit' line. tests/migration-0415.test.ts proves it by
-- cutting the six added lines out of this file's body and comparing what is left with 0260's body,
-- byte for byte. Everything else the guard does is as it was: the claim lock, the legacy refusal for
-- every other imported line with no claim (production holds such lines from before 0255, and they
-- still close the way back), and 0259's overlap read.
--
-- WHAT IT DOES NOT DO. It does not open the way back for a draw's "Less previous billings" line
-- ('draw_credit'): nothing re-resolves that line, and the older rule still decides it. It does not
-- touch the two other un-void guards (0343's stock guard, 0361's person guard) or the trigger, which
-- stays BEFORE UPDATE OF status on invoices and fires before 0414's AFTER trigger. What holds a
-- credit line on a bill coming back is 0414: back as a draft its lines are derived again; back as
-- anything else each line is checked, and refused when it would take more than its request has left.
--
-- ORDER. AFTER 0414 (it refuses without it) and BEFORE the deploy. Applied first, the app that is
-- running names neither line, so nothing it does changes.
--
-- LOCKS. None on a table: one function is replaced. lock_timeout 3s and statement_timeout 15s, the
-- house's. ONE TRANSACTION: the runners wrap the file. TWICE-SAFE: the ground check takes the guard
-- as 0260 left it OR as this file leaves it, so a second run writes the same text again and passes;
-- any other body is a newer migration's, and this file refuses rather than put its text back over it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

-- ── The ground it stands on ─────────────────────────────────────────────────────────────────────
do $$
declare
  v_src text;
  v_md5 text;
begin
  if to_regclass('public.invoices') is null or to_regclass('public.invoice_items') is null then
    raise exception '0415: public.invoices and public.invoice_items are not both on this database. Nothing was changed.';
  end if;
  -- 0414 is here: the kind, and its boundary on the table this guard also watches.
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.invoices'::regclass and c.conname = 'invoices_invoice_kind_check'
       and pg_get_constraintdef(c.oid) like '%''prepayment''%'
  ) then
    raise exception '0415: invoices_invoice_kind_check does not take ''prepayment''. Apply 0414 first. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.invoices'::regclass and t.tgname = 'invoices_prepayment_boundary' and not t.tgisinternal
  ) then
    raise exception '0415: 0414''s trigger invoices_prepayment_boundary is not on public.invoices. Apply 0414 first. Nothing was changed.';
  end if;
  -- THE GUARD AND ITS TRIGGER, as 0260 left them.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'guard_invoice_unvoid') <> 1 then
    raise exception '0415: there is not exactly one public.guard_invoice_unvoid on this database. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.invoices'::regclass and t.tgname = 'invoices_unvoid_is_a_boundary' and not t.tgisinternal
       and t.tgfoid = 'public.guard_invoice_unvoid()'::regprocedure
  ) then
    raise exception '0415: the trigger invoices_unvoid_is_a_boundary does not run public.guard_invoice_unvoid() on public.invoices. Nothing was changed.';
  end if;
  select p.prosrc into v_src from pg_proc p where p.oid = 'public.guard_invoice_unvoid()'::regprocedure;
  v_md5 := coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '');
  if v_md5 not in ('caed11ee9d052b02a27e554fefd49cf8', '214d24034d24389b70ce94f6c2def1af') then
    raise exception '0415: public.guard_invoice_unvoid() is neither the body 0260 left nor this file''s (its statements read %). A newer migration re-made it, and this file would put older text back over it. Nothing was changed.', v_md5;
  end if;
end $$;

-- ── 1. The un-void guard, with money ahead left out of its legacy read ──────────────────────────
create or replace function public.guard_invoice_unvoid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  holder text;
  live   text;
begin
  if old.status = 'void' and new.status <> 'void' then
    -- THE LOCK (0260) — the same key guard_invoice_item_claim takes, so an un-void and an import
    -- of the same hours cannot both read "free" and both commit. Taken before either read below.
    perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || coalesce(new.org_id::text, new.id::text)));

    -- (1) A CLAIM THAT WAS NEVER RECORDED (0260). An invoice already void when 0256 ran carries
    -- imported lines with source_ids = '{}': nothing says what they billed, so the overlap read
    -- below is blind to them and would wave this invoice back out of void beside a live one. The
    -- app's unvoidConflict refuses exactly this shape; here it is as a boundary. An import_key
    -- that names its own source row (po:/bill:/co:/quote:<uuid>) is NOT legacy — that key IS the
    -- claim, and the read below sees it through the app's claimedIdsOfLines.
    if new.job_id is not null and exists (
         select 1
           from public.invoice_items li
          where li.invoice_id = new.id
            and coalesce(li.import_source, '') <> ''
            and coalesce(cardinality(li.source_ids), 0) = 0
            and coalesce(li.import_key, '') !~* '^(po|bill|co|quote):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
            -- 0415: MONEY AHEAD IS NOT A LEGACY LINE. A payment request's own line ('prepayment') and the
            -- line that takes a request off a later bill ('prepaid_credit') came from no importer and bill
            -- no hour and no receipt, so there is no claim they failed to record. 0414's own boundary
            -- holds them: every credit line is checked when its bill goes out, or comes back from void as
            -- anything but a draft (guard_prepayment_bill).
            and coalesce(li.import_source, '') not in ('prepayment', 'prepaid_credit')
       ) then
      select coalesce(i.invoice_number, 'another invoice')
        into live
        from public.invoices i
       where i.job_id = new.job_id
         and i.id <> new.id
         and i.status <> 'void'
         and i.org_id is not distinct from new.org_id
       order by i.created_at, i.id
       limit 1;
      if live is not null then
        raise exception 'nothing on this invoice records what it billed, and % is live on the same job', live
          using errcode = 'P0001',
                hint = 'It was built before a line recorded which hours and bills it bills, so nothing can check it against ' || live || ' and un-voiding it could bill the same work twice. Leave it void and bill the work on a fresh invoice instead. New Invoice on the job pulls in only the hours and bills nobody has billed yet.';
      end if;
    end if;

    -- (2) 0259, unchanged: a recorded claim this invoice holds that another live invoice now holds.
    select coalesce(i.invoice_number, 'another invoice')
      into holder
      from public.invoice_items mine
      join public.invoice_items theirs
        on theirs.invoice_id <> mine.invoice_id
       and theirs.source_ids && mine.source_ids
      join public.invoices i on i.id = theirs.invoice_id
     where mine.invoice_id = new.id
       and i.org_id = new.org_id
       and i.status <> 'void'
       and cardinality(mine.source_ids) > 0
     order by i.created_at
     limit 1;
    if holder is not null then
      raise exception 'work already billed on %', holder
        using errcode = 'P0001',
              hint = 'This invoice cannot come back from void while ' || holder || ' bills the same hours or materials. Void that one first, or leave this one void.';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_invoice_unvoid() from public, anon;
comment on function public.guard_invoice_unvoid() is
  'BEFORE UPDATE OF status on invoices: a void invoice may not come back while another non-void invoice in the org holds any of its lines'' source_ids (0259), nor beside any live invoice on its job when one of its imported lines records no claim at all (0260). A payment request''s own line and the line that takes a request off a bill are not such lines (0415): they bill no work, and 0414''s boundary holds them.';

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_src text;
  v_md5 text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = 'public.guard_invoice_unvoid()'::regprocedure;
  v_md5 := coalesce(md5(translate(regexp_replace(v_src, E'-{2}[^\n]*', '', 'g'), E' \t\n\r', '')), '');
  if v_md5 <> '214d24034d24389b70ce94f6c2def1af' then
    raise exception '0415 self-check: public.guard_invoice_unvoid() reads %, not this file''s body. Rolled back.', v_md5;
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = 'public.guard_invoice_unvoid()'::regprocedure) then
    raise exception '0415 self-check: public.guard_invoice_unvoid() is no longer security definer. Rolled back.';
  end if;
  if (select p.proconfig::text from pg_proc p where p.oid = 'public.guard_invoice_unvoid()'::regprocedure) is distinct from '{search_path=public}' then
    raise exception '0415 self-check: public.guard_invoice_unvoid() no longer pins its search path. Rolled back.';
  end if;
  if has_function_privilege('anon', 'public.guard_invoice_unvoid()', 'execute') then
    raise exception '0415 self-check: anon can call public.guard_invoice_unvoid(). Rolled back.';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.invoices'::regclass and t.tgname = 'invoices_unvoid_is_a_boundary' and not t.tgisinternal
       and t.tgfoid = 'public.guard_invoice_unvoid()'::regprocedure
  ) then
    raise exception '0415 self-check: the trigger invoices_unvoid_is_a_boundary is gone from public.invoices. Rolled back.';
  end if;
end $$;
