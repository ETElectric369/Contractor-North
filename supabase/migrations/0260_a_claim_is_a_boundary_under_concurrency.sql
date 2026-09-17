-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0260: a claim is a boundary UNDER CONCURRENCY
--
-- ORDER: after 0259. Writes no data — it recreates the two claim guards in full, and adds one
-- check to the second. Re-runnable (create or replace / drop trigger if exists).
--
-- WHY. 0258 made the claim a boundary on invoice_items and 0259 made the way back from void a
-- boundary on invoices. Both are written check-then-write: a plain SELECT for an overlapping
-- claim, then the row lands. Under READ COMMITTED that is not a boundary at all — neither
-- transaction can see the other's uncommitted INSERT. Two New Invoice taps on one job in the
-- same second, which is one slow phone and one impatient thumb:
--
--   tab A  createInvoiceForJob     sees no open draft, mints INV-062
--   tab B  createInvoiceForJob     sees no open draft, mints INV-063
--   A      importLaborIntoInvoice  claimedSourcesOnJob (an app SELECT): Brian's 5.25 hr is free
--   B      importLaborIntoInvoice  the same read: still free — A has not committed
--   A      upsert_imported_invoice_items → pg_advisory_xact_lock(hashtext('<INV-062 id>:labor'))
--   B      the same lock keyed on INV-063's id: a DIFFERENT key, so the two never contend (0255:74)
--   A, B   guard_invoice_item_claim's SELECT — no FOR UPDATE, no unique constraint, nothing to
--          serialize on. Neither sees the other's row. Both pass. Both commit.
--   →      the same 5.25 hours are on two sendable invoices. The exact double 0255 exists to end.
--
-- No constraint can close this: uuid[] overlap has no EXCLUDE operator class, and the GIN index
-- (0258:49) answers reads, it does not reject writes. So the guard has to take the lock itself.
--
-- WHICH KEY. Not the invoice — 0255's key is per invoice + source, and the two racers are on two
-- invoices, which is the whole failure. Not the job either: 0258 reads ORG-WIDE and across jobs on
-- purpose (a shift billed on J-021 and moved to J-028 since is still billed), so a job-keyed lock
-- would leave most of the read it protects unguarded. And not the sorted source ids, tempting as
-- that looks: that key contends only when two racers claim exactly the SAME set, and the proven
-- race does not produce the same set. The taps are a second apart, so one read picks up an entry
-- the other missed, or one draft imports labor while the other imports labor AND costs, and
-- {e1,e2} vs {e1,e2,e3} hash to two different keys and sail past each other with e1 and e2 landing
-- on both invoices. A lock narrower than the SELECT it protects is not a lock. That leaves the ORG.
--
-- One key per org, transaction-scoped, taken only by a write that ADDS a claim — an ordinary price
-- edit returns before it. Claim writes are a handful of imports a day per org, so the cost is a
-- wait nobody can feel; what it buys is that the second racer's SELECT runs after the first has
-- committed, and sees it. (The row lock on the line being written is already held by the time a
-- BEFORE trigger runs, so the org lock is always taken second. Two transactions writing claims to
-- the SAME line can therefore deadlock; Postgres detects it and aborts one, and the import is a
-- retry away. The alternative — no lock — is a double bill, which is not.)
--
-- BOTH GUARDS TAKE THE SAME KEY. guard_invoice_unvoid has the identical shape (0259:24 reads, then
-- the status lands) and the identical race — against another un-void, and against an import, which
-- is the worse one: an invoice coming back from void while a draft imports the hours it holds puts
-- the same work on two live invoices with neither guard seeing the other. An advisory lock only
-- serializes transactions asking for the SAME key, so the two guards must share one, and do.
--
-- ── ALSO HERE: THE LEGACY LINE THE UN-VOID GUARD CANNOT SEE ────────────────────────────────────
-- 0259 can only judge a claim that was written. An invoice that was ALREADY void when 0256 ran was
-- excluded from the backfill (0256 filters status <> 'void' at 86, 127 and 491), so its imported
-- lines keep import_source set with source_ids = '{}' forever, and nothing on them says which
-- hours or bills they billed. 0259's overlap requires cardinality(mine.source_ids) > 0, finds
-- nothing, and lets such an invoice walk back out of void and stand beside a live invoice that
-- bills the same work. The app already refuses it (unvoidConflict's legacyLabor branch, billing/
-- actions.ts) with the fuller sentence; this is that rule as a boundary: an invoice carrying an
-- imported line with a claim that was never recorded may not leave void while ANY other non-void
-- invoice is live on the same job. With no other invoice on the job there is nothing to double, so
-- the way back stays open — the same call the app makes.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── THE CLAIM GUARD, serialized ───────────────────────────────────────────────────────────────
-- Verbatim 0258 but for the advisory lock below: same reads, same org scoping, same sentences,
-- same security definer + pinned search_path (it must read invoice_items a tech cannot see).
create or replace function public.guard_invoice_item_claim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_added uuid[];
  v_org   uuid;
  v_hit   record;
  v_what  text;
begin
  -- What this write ADDS (see 0258's header for why an edit's existing claims are not re-judged).
  if tg_op = 'INSERT' or new.invoice_id is distinct from old.invoice_id then
    v_added := coalesce(new.source_ids, '{}');
  else
    select coalesce(array_agg(s), '{}') into v_added
      from unnest(coalesce(new.source_ids, '{}')) as s
     where not (s = any (coalesce(old.source_ids, '{}')));
  end if;
  if coalesce(array_length(v_added, 1), 0) = 0 then
    return new;
  end if;

  -- The org is the invoice's, never new.org_id: the column is what the writer said, the invoice is
  -- what the row is attached to. Scoping the lookup to the org also means the invoice number in
  -- the sentence is always one of the caller's own (0173 — never another tenant's).
  select org_id into v_org from public.invoices where id = new.invoice_id;

  -- THE LOCK (0260). Everything below this line is a read, and a read cannot refuse a row that is
  -- not committed yet: without this, two drafts built in the same second each find the hours free
  -- and each keep them. One key for the whole org, because the read below spans the whole org and
  -- every job. Same key as guard_invoice_unvoid, so an import and an un-void racing each other
  -- contend instead of passing in the dark.
  --
  -- The coalesce is not decoration. pg_advisory_xact_lock is STRICT: a null key takes no lock at
  -- all, silently, and the guard would be a convention again. An invoice with no org falls back to
  -- its own id — the same fallback guard_invoice_unvoid uses, so the two still meet on one key.
  perform pg_advisory_xact_lock(hashtext('cn.invoice_claim:' || coalesce(v_org::text, new.invoice_id::text)));

  -- The earliest OTHER non-void invoice holding any of these ids, and which ids it holds.
  select xi.invoice_number,
         (select array_agg(s) from unnest(x.source_ids) as s where s = any (v_added)) as ids
    into v_hit
    from public.invoice_items x
    join public.invoices xi on xi.id = x.invoice_id
   where x.invoice_id <> new.invoice_id
     and xi.status <> 'void'
     and xi.org_id is not distinct from v_org
     and x.source_ids && v_added
   order by xi.created_at, xi.id
   limit 1;
  if not found then
    return new;
  end if;

  -- Name the thing in the office's word for it: a time row is hours, a bill or order is
  -- materials, anything else (a change order, an estimate line) is work.
  v_what := case
    when exists (select 1 from public.time_entries te where te.id = any (v_hit.ids))
      or exists (select 1 from public.time_allocations ta where ta.id = any (v_hit.ids)) then 'hours'
    when exists (select 1 from public.bills b where b.id = any (v_hit.ids))
      or exists (select 1 from public.purchase_orders p where p.id = any (v_hit.ids)) then 'materials'
    else 'work'
  end;
  raise exception '% already billed on %', v_what, coalesce(v_hit.invoice_number, 'another invoice')
    using errcode = 'P0001',
          hint = 'A row is billed on one invoice at a time. Void or adjust that invoice first.';
end $$;

comment on function public.guard_invoice_item_claim() is
  'The claim boundary (0258, serialized 0260): a source id in invoice_items.source_ids may be held by ONE non-void invoice in the org, on any job. Takes a transaction-scoped advisory lock on the ORG before its overlap read, so two drafts built in the same second cannot both find the same hours free. Same-invoice repeats are allowed (a bill is stamped on every row of that bill). An UPDATE is judged on the ids it adds. Raises "hours|materials|work already billed on INV-0xx".';

drop trigger if exists invoice_items_claim_is_a_boundary on public.invoice_items;
create trigger invoice_items_claim_is_a_boundary
  before insert or update of source_ids, invoice_id on public.invoice_items
  for each row
  execute function public.guard_invoice_item_claim();

-- ── THE UN-VOID GUARD: the same lock, plus the legacy line ────────────────────────────────────
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
  'BEFORE UPDATE OF status on invoices: a void invoice may not come back while another non-void invoice in the org holds any of its lines'' source_ids (0259), nor while it carries an imported line whose claim was never recorded (0256 skipped invoices that were already void) and ANY other non-void invoice is live on the same job (0260). Takes the same org-keyed advisory lock as guard_invoice_item_claim, so an un-void and an import cannot race. The app''s unvoidConflict is the same rule with a longer sentence; this is the boundary.';

drop trigger if exists invoices_unvoid_is_a_boundary on public.invoices;
create trigger invoices_unvoid_is_a_boundary
  before update of status on public.invoices
  for each row execute function public.guard_invoice_unvoid();

-- ── PROVE IT ──────────────────────────────────────────────────────────────────────────────────
-- A · the lock serializes two racing claims. Two psql sessions, one org, two invoices on one job,
--     <SRC> = any time_entry / time_allocation / bill id that no non-void invoice claims yet:
--
--   session 1:  begin;
--               update invoice_items set source_ids = source_ids || '{<SRC>}'::uuid[]
--                where id = '<a line on INV-062>';          -- succeeds, NOT committed
--   session 2:  begin;
--               update invoice_items set source_ids = source_ids || '{<SRC>}'::uuid[]
--                where id = '<a line on INV-063>';          -- BLOCKS here (before 0260: passed)
--   session 1:  commit;
--   session 2:  → ERROR: hours already billed on INV-062      (before 0260: both committed)
--               rollback;
--
--   That the lock is held at all, from inside session 1's open transaction:
--     select count(*) from pg_locks where locktype = 'advisory' and pid = pg_backend_pid();  -- 1
--
-- B · the legacy un-void refusal. On a VOID invoice with a job and an imported line whose
--     source_ids = '{}' and whose import_key is null (or not po:/bill:/co:/quote:<uuid>), with any
--     other non-void invoice on the same job:
--
--   update public.invoices set status = 'sent' where id = '<that void invoice>';
--   → ERROR: nothing on this invoice records what it billed, and INV-0xx is live on the same job
--
--   Void every other invoice on that job and the same statement succeeds — nothing left to double.
