-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0258: a claim is a boundary
--
-- ORDER. Apply 0256 (the backfill) BEFORE this file — the numbered order, and not optional: 0256
-- stamps source_ids on the EARLIEST invoice's keyed cost line, and a later non-void invoice that
-- already carries that id (reachable through a pre-0255 bli:-only line, or a direct write) would
-- make that stamp trip this file's trigger and abort the whole backfill. 0256's own plans are
-- org-wide and earliest-wins, so once it has landed, this boundary starts clean (the DO block at
-- the end says so, naming any overlapping pair it finds).
--
-- WHY. 0255 moved the "never bill the same hour twice" invariant onto the row: a labor line claims
-- the time_entry / time_allocation ids it bills (invoice_items.source_ids), a cost line claims its
-- bill / order / change order, and the importers skip anything another non-void invoice claims.
-- That skip is a READ in the app — claimedSourcesOnJob, run just before the write. A rule at one
-- read path is a convention, not a boundary (0173). Three ways round it exist tonight:
--
--   • TWO DRAFTS IMPORTING AT ONCE. The office opens New Invoice on a job in two tabs, or a
--     progress draw and a standard draft are built within the same second. Both reads see the
--     rows free, both RPCs write the claim, and 85 Whitney's 5.25 hours go out on INV-062 and
--     INV-063 alike. The RPC's advisory lock is per invoice+source, so it does not see this.
--   • A DIRECT WRITE. invoice_items is writable through RLS (PostgREST PATCH / INSERT); a line
--     posted with someone else's ids bills them again with no importer in the loop.
--   • A CLAIM CARRIED BY HAND. carryEntryClaim (timeclock/actions.ts) and 0256's follow-up
--     template append ids to a line; a mistaken id there is a double bill.
--
-- THE RULE, enforced where the write lands: a source id may be held by ONE non-void invoice in the
-- org. The same invoice may hold an id on several of its lines — importCostsIntoInvoice stamps a
-- bill's id on every row of that bill (the itemized lines and the "Supplies & tax" remainder; a
-- bill is billed as a unit — the anchor invariant), so a same-invoice rule would reject every
-- itemized bill. Void invoices hold nothing (voiding IS the release, 0255). Any job: a shift
-- billed on J-021 and moved to J-028 since is still billed.
--
-- WHAT IS CHECKED. An INSERT (or a line moved to another invoice) puts every id on the table. An
-- UPDATE checks only the ids the edit ADDS: a claim the line already carries is history this
-- trigger does not rewrite — so 0256's stamps, a price edit on a line that already overlaps, and
-- the importer's in-place refresh all land, and a pre-existing overlap (two drafts that raced
-- before tonight) is REPORTED at the end of this file, not frozen. The app's earliest-claimant
-- rule (foldClaims / claimsOnSources) keeps covering those until one side is voided.
--
-- THE SENTENCE. The importers hand an RPC error to dbError, which passes an unrecognised message
-- through verbatim, so the exception text is the office's sentence: "hours already billed on
-- INV-061" / "materials already billed on INV-061" / "work already billed on INV-061".
--
-- Idempotent: create or replace / drop if exists / if not exists throughout.
-- ═══════════════════════════════════════════════════════════════════════════

-- The overlap read (`x.source_ids && …`) runs on every claim write; without this it is a scan of
-- every line in the org. GIN is the index type that answers array-overlap.
create index if not exists invoice_items_source_ids_gin
  on public.invoice_items using gin (source_ids);

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
  -- What this write ADDS (see the header for why an edit's existing claims are not re-judged).
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
  'The claim boundary (0258): a source id in invoice_items.source_ids may be held by ONE non-void invoice in the org, on any job. Same-invoice repeats are allowed (a bill is stamped on every row of that bill). An UPDATE is judged on the ids it adds. Raises "hours|materials|work already billed on INV-0xx".';

drop trigger if exists invoice_items_claim_is_a_boundary on public.invoice_items;
create trigger invoice_items_claim_is_a_boundary
  before insert or update of source_ids, invoice_id on public.invoice_items
  for each row
  execute function public.guard_invoice_item_claim();

-- ── WHAT THE BOUNDARY INHERITS ─────────────────────────────────────────────────────────────────
-- Overlaps that already exist are not this trigger's to undo (an UPDATE is judged on what it adds,
-- so they neither block nor get fixed here). They are counted and named for whoever applies this,
-- so the office can void or adjust one side — the app keeps billing each such row once, to the
-- earliest claimant, in the meantime.
do $$
declare
  n      integer;
  sample text;
begin
  select count(*), string_agg(pair, '; ' order by pair)
    into n, sample
    from (
      select distinct coalesce(ai.invoice_number, '(no number)') || ' & ' || coalesce(bi.invoice_number, '(no number)') as pair
        from public.invoice_items a
        join public.invoices ai on ai.id = a.invoice_id
        join public.invoice_items b on b.invoice_id <> a.invoice_id and b.source_ids && a.source_ids
        join public.invoices bi on bi.id = b.invoice_id
       where ai.status <> 'void' and bi.status <> 'void'
         and ai.org_id is not distinct from bi.org_id
         and a.invoice_id < b.invoice_id
    ) q;
  if n > 0 then
    raise notice '0258: % invoice pair(s) already hold the same source row — void or adjust one side of each: %', n, sample;
  else
    raise notice '0258: no cross-invoice claim overlaps exist — the boundary starts clean.';
  end if;
end $$;
