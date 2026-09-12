-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0256: the invoices that already exist claim what they billed
--
-- 0255 gave every imported line a claim on its source rows (invoice_items.source_ids). Every
-- invoice built BEFORE 0255 has empty claims, so the first new invoice on any of those jobs would
-- re-import hours and bills that were already billed — the exact double 0255 exists to end. This
-- file gives those invoices their claims, once, from the evidence the rows carry:
--
--   LABOR    a labor line keyed labor:<person> claims that person's closed entries and allocations
--            on the job with clock_out <= the invoice's CUTOFF; an unkeyed labor line (pre-0175, or
--            hand-typed in hours) claims every person's rows before the cutoff, since nothing on it
--            says whose hours it billed. CUTOFF = created_at for a sent/paid invoice (Erik's
--            invoices are built at the end of the work and go out the same day; the report below
--            shows the created→updated window so a re-import-before-send is visible); updated_at
--            for a DRAFT (its last touch is its last import).
--   COSTS    a keyed line names its source exactly: po:<id>, bill:<id>, bill:<id>:remainder, co:<id>,
--            quote:<id> — and bli:<id> names the bill through bill_line_items. An unkeyed costs line
--            (pre-0175) claims the job's bills and live orders created before the cutoff.
--   ALWAYS   the EARLIEST non-void invoice wins a contested row (a cumulative draw that re-itemized
--            everything after a standard invoice does not steal the first invoice's claims), and a
--            row some invoice already claims (a post-0255 import, or a second run of this file) is
--            never reassigned. Running this twice changes nothing the first run didn't.
--
-- ── DETERMINISM BOUNDARY: PRINT IT BEFORE YOU APPLY IT ─────────────────────────────────────
-- The plan is a SELECT. The dry run below builds it as a TEMP VIEW (session-local, writes nothing)
-- and prints, per job and invoice: what would be claimed, what the lines say they billed, and what
-- is left unclaimed with dates. Read it. On J-028 the expected answer is: INV-061 claims the nine
-- July/August entries for Brian and Erik; Brian's 2026-09-10 entry and the two 2026-09-11 CED
-- bills stay free. If a line's `line_hours` and `claimed_hours` disagree by more than a quarter
-- hour, look at the `draft_window` rows for that job before applying.
--
-- ── AN HOURLY HAND LINE THAT IS NOT LABOR ──────────────────────────────────────────────────
-- The labor plan finds its lines by import_source = 'labor' OR an hourly unit OR a "Labor — "
-- description. The middle test is deliberately wide (pre-0175 lines carry no source), and it also
-- catches a hand-typed line billed in hours that is NOT labor — "Lift rental 4 hr", "Trencher
-- 6 hrs". Such a line is UNKEYED, so the plan treats it as an invoice-level labor line and hands
-- it EVERY person's entries before the cutoff: the invoice claims hours it never billed, and the
-- next invoice on that job cannot bill them. The tell is R1: `line_hours` (what the lines say)
-- against `claimed_hours` (what the plan would claim). A rental line inflates line_hours by its
-- rental hours and, when it is the only "labor" line, claimed_hours by the whole job. If the two
-- disagree by more than a quarter hour on any invoice, STOP: open that invoice, and either give
-- the line a non-hourly unit (ea / day / lot — the rental is priced per unit anyway) or set its
-- import_source to nothing hourly, then re-run the dry run. Do not apply until R1 reconciles.
--
-- ── THE MECHANICAL STOP ─────────────────────────────────────────────────────────────────────
-- The APPLY block refuses to run — `raise exception`, nothing written — while R2 would list any
-- draft_window row. The rule below ("DO NOT APPLY WHILE R2 SHOWS draft_window ROWS") used to be a
-- sentence in a comment; an operator who skipped the dry run would apply anyway and the next
-- invoice would bill those hours again. Now the same predicate is recomputed inline, first thing,
-- and the block aborts unless every such row has been dealt with: claimed by hand (the R2
-- FOLLOW-UP template — the row then no longer matches), or judged free and ASSERTED so by running
--     select set_config('cn.0256_reviewed', '1', true);
-- in the same transaction, just before the apply block. The flag is transaction-local, so it can
-- only be set by someone who has this file open and has read R2; that is the whole point of it.
--
-- ── 0258 (THE CLAIM BOUNDARY) ───────────────────────────────────────────────────────────────
-- 0258 adds a trigger that rejects a line claiming an id ANY other non-void invoice in the org
-- already holds. APPLY THIS FILE FIRST (0256, then 0258): a stamp onto the earliest invoice's
-- keyed cost line can collide with a later invoice that already carries the id through a legacy
-- bli:-only line, and under 0258 that collision aborts the backfill. Every plan here claims only
-- what no non-void invoice holds ORG-WIDE (the "already claimed" tests below used to be scoped to
-- the job — but a claim is per row, not per job: an entry billed on J-021 and moved to J-028 is
-- still billed, exactly as the app's by-id read sees it), and a keyed cost line whose id a LATER
-- invoice also carries is left unstamped (earliest invoice wins; the loser's import_key still
-- counts as its claim app-side, as it did before 0255).
--
-- The apply block re-declares the SAME view text and writes from it. Edit one, edit both.
-- ═══════════════════════════════════════════════════════════════════════════

/* ═══════════════════ DRY RUN — read-only; run this whole block by hand FIRST ═══════════════════

create temp view _labor_claim_plan as
with labor_lines as (
  select it.id as line_id, it.invoice_id, it.sort_order, it.import_key, it.quantity,
         case when it.import_key ~ '^labor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then substring(it.import_key from 7)::uuid end as person_id
    from public.invoice_items it
   where it.import_source = 'labor'
      or lower(coalesce(it.unit, '')) in ('hr','hrs','hour','hours','man-hour','man-hours','manhour','manhours')
      or it.description ~* '^labor\s*[—–-]\s'
),
li as (
  select i.id as invoice_id, i.job_id, i.invoice_number, i.status, i.created_at, i.updated_at,
         case when i.status = 'draft' then i.updated_at else i.created_at end as cutoff
    from public.invoices i
   where i.status <> 'void' and i.job_id is not null
     and exists (select 1 from labor_lines l where l.invoice_id = i.id)
),
anchor as (
  select distinct on (l.invoice_id, l.person_id) l.line_id, l.invoice_id, l.person_id
    from labor_lines l join li on li.invoice_id = l.invoice_id
   order by l.invoice_id, l.person_id, l.sort_order, l.line_id
),
src as (
  select te.job_id, te.id as source_id, 'entry'::text as kind, te.profile_id, te.clock_out,
         case when exists (select 1 from public.time_allocations a where a.time_entry_id = te.id)
              then coalesce((select sum(a.hours) from public.time_allocations a
                              where a.time_entry_id = te.id and a.job_id is null and a.job_code is null), 0)
              else round((extract(epoch from (te.clock_out - te.clock_in)) / 3600
                          - greatest(te.lunch_minutes, 0) / 60.0)::numeric, 2) end as hours
    from public.time_entries te
   where te.status = 'closed' and te.clock_out is not null and te.job_id is not null
  union all
  select a.job_id, a.id, 'alloc', te.profile_id, te.clock_out, a.hours
    from public.time_allocations a join public.time_entries te on te.id = a.time_entry_id
   where te.status = 'closed' and te.clock_out is not null and a.job_id is not null
),
cand as (
  select s.job_id, s.source_id, s.kind, s.profile_id, s.clock_out, s.hours,
         li.invoice_id, li.invoice_number, li.created_at, a.line_id, (a.person_id is null) as invoice_level
    from src s
    join li on li.job_id = s.job_id and s.clock_out <= li.cutoff
    join anchor a on a.invoice_id = li.invoice_id and (a.person_id = s.profile_id or a.person_id is null)
   where not exists (
     select 1 from public.invoice_items x join public.invoices xi on xi.id = x.invoice_id
      where xi.status <> 'void' and s.source_id = any (x.source_ids))
)
select distinct on (source_id) *
  from cand
 order by source_id, created_at, invoice_level;

create temp view _cost_claim_plan as
with cost_inv as (
  select i.id as invoice_id, i.job_id, i.invoice_number, i.status, i.created_at,
         case when i.status = 'draft' then i.updated_at else i.created_at end as cutoff
    from public.invoices i
   where i.status <> 'void' and i.job_id is not null
     and exists (select 1 from public.invoice_items it
                  where it.invoice_id = i.id and it.import_source = 'costs' and it.import_key is null)
),
anchor as (
  select distinct on (it.invoice_id) it.id as line_id, it.invoice_id
    from public.invoice_items it join cost_inv c on c.invoice_id = it.invoice_id
   where it.import_source = 'costs' and it.import_key is null
   order by it.invoice_id, it.sort_order, it.id
),
src as (
  select b.job_id, b.id as source_id, 'bill'::text as kind, b.created_at, b.amount as cost,
         coalesce(b.supplier, '') || coalesce(' #' || b.bill_number, '') as label
    from public.bills b where b.job_id is not null and b.amount > 0
  union all
  select p.job_id, p.id, 'po', p.created_at, p.total, coalesce(p.vendor, '') || ' ' || p.po_number
    from public.purchase_orders p where p.job_id is not null and p.status <> 'cancelled' and p.total > 0
),
cand as (
  select s.job_id, s.source_id, s.kind, s.created_at as source_at, s.cost, s.label,
         c.invoice_id, c.invoice_number, c.created_at, a.line_id
    from src s
    join cost_inv c on c.job_id = s.job_id and s.created_at <= c.cutoff
    join anchor a on a.invoice_id = c.invoice_id
   where not exists (
     select 1 from public.invoice_items x join public.invoices xi on xi.id = x.invoice_id
      where xi.status <> 'void'
        and (s.source_id = any (x.source_ids)
             or x.import_key in ('po:' || s.source_id, 'bill:' || s.source_id, 'bill:' || s.source_id || ':remainder')
             or (x.import_key like 'bli:%' and exists (select 1 from public.bill_line_items bli
                                                        where bli.bill_id = s.source_id and x.import_key = 'bli:' || bli.id))))
)
select distinct on (source_id) * from cand order by source_id, created_at;

-- The keyed cost / change-order / estimate lines (po:/bill:/co:/quote:/bli:): the claim IS the key,
-- but the EARLIEST non-void invoice wins an id two invoices both carry (a cumulative draw that
-- re-itemized after a standard invoice, pre-0255), and an id some invoice already holds by
-- source_ids goes to that invoice's lines only. `stamp` = this line gets the claim; `held_by` =
-- the invoice that wins it (the loser's key still counts as its claim app-side, as before 0255).
create temp view _keyed_cost_plan as
with lines as (
  select it.id as line_id, it.invoice_id, i.invoice_number, i.created_at, it.sort_order, it.import_key,
         coalesce(
           substring(it.import_key from '^(?:po|bill|co|quote):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')::uuid,
           bli.bill_id) as source_id
    from public.invoice_items it
    join public.invoices i on i.id = it.invoice_id
    left join public.bill_line_items bli on it.import_key = 'bli:' || bli.id::text
   where i.status <> 'void'
     and it.source_ids = '{}'
     and (it.import_key ~ '^(po|bill|co|quote):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
          or it.import_key ~ '^bli:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
),
holder as (
  select distinct s.source_id, x.invoice_id, xi.created_at
    from lines s
    join public.invoice_items x on x.source_ids && array[s.source_id]
    join public.invoices xi on xi.id = x.invoice_id
   where xi.status <> 'void'
),
winner as (
  select distinct on (source_id) source_id, invoice_id
    from (select source_id, invoice_id, created_at from holder
          union all
          select source_id, invoice_id, created_at from lines) c
   order by source_id, created_at, invoice_id
)
select l.line_id, l.invoice_id, l.invoice_number, l.import_key, l.source_id,
       (w.invoice_id = l.invoice_id) as stamp,
       (select xi.invoice_number from public.invoices xi where xi.id = w.invoice_id) as held_by
  from lines l
  join winner w on w.source_id = l.source_id;

-- R1 · LABOR, per invoice: what it would claim vs what its lines say it billed.
select j.job_number, i.invoice_number, i.status,
       (case when i.status = 'draft' then i.updated_at else i.created_at end)::date as cutoff,
       count(*) filter (where p.kind = 'entry')            as entries_claimed,
       count(*) filter (where p.kind = 'alloc')            as allocs_claimed,
       round(coalesce(sum(p.hours), 0), 2)                  as claimed_hours,
       (select round(sum(it.quantity), 2) from public.invoice_items it
          where it.invoice_id = i.id
            and (it.import_source = 'labor'
                 or lower(coalesce(it.unit,'')) in ('hr','hrs','hour','hours','man-hour','man-hours','manhour','manhours')
                 or it.description ~* '^labor\s*[—–-]\s')) as line_hours,
       count(*) filter (where p.invoice_level)              as via_invoice_level,
       min(p.clock_out)::date as first_claimed, max(p.clock_out)::date as last_claimed
  from public.invoices i
  join public.jobs j on j.id = i.job_id
  left join _labor_claim_plan p on p.invoice_id = i.id
 where i.id in (select distinct invoice_id from _labor_claim_plan)
    or (i.status <> 'void' and exists (select 1 from public.invoice_items it where it.invoice_id = i.id and it.import_source = 'labor'))
 group by j.job_number, i.invoice_number, i.status, i.created_at, i.updated_at, i.id
 order by j.job_number, i.created_at;

-- R2 · LABOR, per job: the rows LEFT UNCLAIMED after the plan, with dates. `draft_window` = the row
-- falls between the latest labor invoice's created_at and updated_at — the one case where the
-- created_at cutoff might be early (a re-import before sending). Eyeball those.
with rows_ as (
  select te.job_id, te.id as source_id, 'entry' as kind, te.profile_id, te.clock_out,
         round((extract(epoch from (te.clock_out - te.clock_in)) / 3600 - greatest(te.lunch_minutes,0) / 60.0)::numeric, 2) as hours
    from public.time_entries te where te.status = 'closed' and te.clock_out is not null and te.job_id is not null
  union all
  select a.job_id, a.id, 'alloc', te.profile_id, te.clock_out, a.hours
    from public.time_allocations a join public.time_entries te on te.id = a.time_entry_id
   where te.status = 'closed' and te.clock_out is not null and a.job_id is not null
),
latest as (
  select distinct on (i.job_id) i.job_id, i.invoice_number, i.status, i.created_at, i.updated_at
    from public.invoices i
   where i.status <> 'void' and exists (select 1 from public.invoice_items it where it.invoice_id = i.id and it.import_source = 'labor')
   order by i.job_id, i.created_at desc
)
select j.job_number, pr.full_name as person, r.kind, r.clock_out::date as worked, r.hours,
       l.invoice_number as latest_labor_invoice,
       (l.status <> 'draft' and r.clock_out > l.created_at and r.clock_out <= l.updated_at) as draft_window,
       -- the three ids the follow-up template below is filled in with
       r.source_id, r.job_id, r.profile_id
  from rows_ r
  join public.jobs j on j.id = r.job_id
  join latest l on l.job_id = r.job_id
  left join public.profiles pr on pr.id = r.profile_id
 where not exists (select 1 from _labor_claim_plan p where p.source_id = r.source_id)
   and not exists (select 1 from public.invoice_items x join public.invoices xi on xi.id = x.invoice_id
                    where xi.status <> 'void' and r.source_id = any (x.source_ids))
 order by j.job_number, r.clock_out;

-- R2 FOLLOW-UP · a draft_window = true row is an entry clocked AFTER the latest labor invoice was
-- created but BEFORE it was last touched — the one case the created_at cutoff can be early (a
-- re-import before sending). The plan leaves it FREE, so the next invoice would bill it again if
-- that invoice already did. Resolve every such row by hand, one of two ways:
--   * the invoice's labor line DOES include those hours (compare R1 line_hours) → claim it to the
--     latest labor invoice for that job/person with the template below;
--   * it does not → leave it free; the next invoice bills it.
-- DO NOT APPLY THIS FILE WHILE R2 SHOWS draft_window ROWS YOU HAVE NOT RESOLVED. The apply block
-- claims nothing in the window, so an unresolved row becomes a double bill on the next import —
-- and the apply block's STOP enforces this: it aborts while any such row is unclaimed unless
-- `select set_config('cn.0256_reviewed', '1', true);` was run first in the same transaction (your
-- assertion that every remaining draft_window row was judged free on purpose).
--
-- Template (fill the three ids from the R2 row; run once per row, before or after the apply block
-- — the apply unions its claims with whatever is already on the line, and the STOP no longer sees
-- a row the template has claimed). Claims the row to that person's line on the latest
-- non-void labor invoice for the job — or the invoice-level line when the invoice has no per-person
-- key — and REFUSES (0 rows) if any non-void invoice already claims the row, so it can never
-- reassign a claim:
--
--   update public.invoice_items it
--      set source_ids = (select array(select distinct unnest(it.source_ids || array['<source_id>'::uuid])))
--    where it.id = (
--            select l.id
--              from public.invoice_items l
--              join public.invoices i on i.id = l.invoice_id
--             where i.job_id = '<job_id>' and i.status <> 'void'
--               and (l.import_source = 'labor' or lower(coalesce(l.unit,'')) in ('hr','hrs','hour','hours'))
--               and (l.import_key = 'labor:<profile_id>' or l.import_key is null)
--             order by i.created_at desc, (l.import_key is null), l.sort_order
--             limit 1)
--      and not exists (select 1 from public.invoice_items x join public.invoices xi on xi.id = x.invoice_id
--                       where xi.status <> 'void' and '<source_id>'::uuid = any (x.source_ids));
--
-- Expect "UPDATE 1". "UPDATE 0" means the row is already claimed somewhere (fine — nothing to do)
-- or the invoice has no line for that person (then it did not bill those hours; leave it free).

-- R3 · COSTS: (a) keyed lines whose claim is derived from the key — per invoice, how many get
-- stamped and how many are left because an earlier invoice wins the same id (named in held_by);
-- (b) the legacy (unkeyed) plan; (c) bills/orders left unclaimed on jobs that have cost invoices.
select 'keyed' as part, coalesce(j.job_number, '(no job)') as job_number, p.invoice_number,
       count(*) filter (where p.stamp)       as lines_to_stamp,
       count(*) filter (where not p.stamp)   as lines_left_to_earlier_invoice,
       string_agg(distinct p.held_by, ', ') filter (where not p.stamp) as held_by
  from _keyed_cost_plan p
  join public.invoices i on i.id = p.invoice_id
  left join public.jobs j on j.id = i.job_id
 group by j.job_number, p.invoice_number
 order by 2, 3;

select 'legacy' as part, j.job_number, p.invoice_number, p.kind, p.label, p.cost, p.source_at::date as created
  from _cost_claim_plan p join public.jobs j on j.id = p.job_id
 order by j.job_number, p.source_at;

select 'unclaimed' as part, j.job_number, s.kind, s.label, s.cost, s.created_at::date as created
  from (
    select b.job_id, b.id, 'bill' as kind, b.created_at, b.amount as cost,
           coalesce(b.supplier,'') || coalesce(' #' || b.bill_number,'') as label from public.bills b where b.amount > 0
    union all
    select p.job_id, p.id, 'po', p.created_at, p.total, coalesce(p.vendor,'') || ' ' || p.po_number
      from public.purchase_orders p where p.status <> 'cancelled' and p.total > 0
  ) s
  join public.jobs j on j.id = s.job_id
 where exists (select 1 from public.invoices i where i.job_id = s.job_id and i.status <> 'void')
   and not exists (select 1 from _cost_claim_plan p where p.source_id = s.id)
   and not exists (select 1 from public.invoice_items x join public.invoices xi on xi.id = x.invoice_id
                    where xi.status <> 'void'
                      and (s.id = any (x.source_ids)
                           or x.import_key in ('po:' || s.id, 'bill:' || s.id, 'bill:' || s.id || ':remainder')
                           or (x.import_key like 'bli:%' and exists (select 1 from public.bill_line_items bli
                                                                      where bli.bill_id = s.id and x.import_key = 'bli:' || bli.id))))
 order by j.job_number, s.created_at;

drop view _keyed_cost_plan;
drop view _cost_claim_plan;
drop view _labor_claim_plan;

-- END OF THE DRY RUN (copy everything from the first `create temp view` down to here)
*/

-- ── APPLY ────────────────────────────────────────────────────────────────────────────────────
-- The importer flag, so the 0175 triggers read these as reconciliation, not as a person editing
-- (they compare description/quantity/unit/price, never source_ids — the flag is belt and braces).
select set_config('cn.importing', '1', true);

-- B · labor — the plan FIRST (the STOP below reads it), verbatim from the dry run.
create temp view _labor_claim_plan as
with labor_lines as (
  select it.id as line_id, it.invoice_id, it.sort_order, it.import_key, it.quantity,
         case when it.import_key ~ '^labor:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then substring(it.import_key from 7)::uuid end as person_id
    from public.invoice_items it
   where it.import_source = 'labor'
      or lower(coalesce(it.unit, '')) in ('hr','hrs','hour','hours','man-hour','man-hours','manhour','manhours')
      or it.description ~* '^labor\s*[—–-]\s'
),
li as (
  select i.id as invoice_id, i.job_id, i.invoice_number, i.status, i.created_at, i.updated_at,
         case when i.status = 'draft' then i.updated_at else i.created_at end as cutoff
    from public.invoices i
   where i.status <> 'void' and i.job_id is not null
     and exists (select 1 from labor_lines l where l.invoice_id = i.id)
),
anchor as (
  select distinct on (l.invoice_id, l.person_id) l.line_id, l.invoice_id, l.person_id
    from labor_lines l join li on li.invoice_id = l.invoice_id
   order by l.invoice_id, l.person_id, l.sort_order, l.line_id
),
src as (
  select te.job_id, te.id as source_id, 'entry'::text as kind, te.profile_id, te.clock_out,
         case when exists (select 1 from public.time_allocations a where a.time_entry_id = te.id)
              then coalesce((select sum(a.hours) from public.time_allocations a
                              where a.time_entry_id = te.id and a.job_id is null and a.job_code is null), 0)
              else round((extract(epoch from (te.clock_out - te.clock_in)) / 3600
                          - greatest(te.lunch_minutes, 0) / 60.0)::numeric, 2) end as hours
    from public.time_entries te
   where te.status = 'closed' and te.clock_out is not null and te.job_id is not null
  union all
  select a.job_id, a.id, 'alloc', te.profile_id, te.clock_out, a.hours
    from public.time_allocations a join public.time_entries te on te.id = a.time_entry_id
   where te.status = 'closed' and te.clock_out is not null and a.job_id is not null
),
cand as (
  select s.job_id, s.source_id, s.kind, s.profile_id, s.clock_out, s.hours,
         li.invoice_id, li.invoice_number, li.created_at, a.line_id, (a.person_id is null) as invoice_level
    from src s
    join li on li.job_id = s.job_id and s.clock_out <= li.cutoff
    join anchor a on a.invoice_id = li.invoice_id and (a.person_id = s.profile_id or a.person_id is null)
   where not exists (
     select 1 from public.invoice_items x join public.invoices xi on xi.id = x.invoice_id
      where xi.status <> 'void' and s.source_id = any (x.source_ids))
)
select distinct on (source_id) *
  from cand
 order by source_id, created_at, invoice_level;

-- ── THE MECHANICAL STOP (header) — R2's draft_window predicate, recomputed inline ──────────────
-- A row clocked AFTER the latest labor invoice was created but BEFORE it was last touched, that
-- neither the plan nor any non-void invoice claims. Such a row may or may not be on that invoice's
-- labor line; nothing here can tell, so nothing here may write until a person has. Abort — the
-- whole transaction, nothing written — unless every such row was claimed by hand (the R2 FOLLOW-UP
-- template) or the reviewer asserted `cn.0256_reviewed` in this transaction.
do $$
declare
  n      integer;
  sample text;
begin
  with rows_ as (
    select te.job_id, te.id as source_id, te.profile_id, te.clock_out
      from public.time_entries te
     where te.status = 'closed' and te.clock_out is not null and te.job_id is not null
    union all
    select a.job_id, a.id, te.profile_id, te.clock_out
      from public.time_allocations a join public.time_entries te on te.id = a.time_entry_id
     where te.status = 'closed' and te.clock_out is not null and a.job_id is not null
  ),
  latest as (
    select distinct on (i.job_id) i.job_id, i.invoice_number, i.status, i.created_at, i.updated_at
      from public.invoices i
     where i.status <> 'void'
       and exists (select 1 from public.invoice_items it where it.invoice_id = i.id and it.import_source = 'labor')
     order by i.job_id, i.created_at desc
  )
  select count(*),
         string_agg(coalesce(j.job_number, '?') || ' · ' || coalesce(pr.full_name, '?') || ' · ' || r.clock_out::date
                    || ' (' || coalesce(l.invoice_number, 'unnumbered invoice') || ')', '; ' order by r.clock_out)
    into n, sample
    from rows_ r
    join public.jobs j on j.id = r.job_id
    join latest l on l.job_id = r.job_id
    left join public.profiles pr on pr.id = r.profile_id
   where l.status <> 'draft' and r.clock_out > l.created_at and r.clock_out <= l.updated_at
     and not exists (select 1 from _labor_claim_plan p where p.source_id = r.source_id)
     and not exists (select 1 from public.invoice_items x join public.invoices xi on xi.id = x.invoice_id
                      where xi.status <> 'void' and r.source_id = any (x.source_ids));
  if n > 0 and coalesce(current_setting('cn.0256_reviewed', true), '') <> '1' then
    raise exception '0256 STOP — % time row(s) sit in a draft window (clocked after the latest labor invoice was created, before it was last touched) and nothing claims them. Nothing was written. Run the dry run, resolve each R2 draft_window row by hand (claim it with the R2 FOLLOW-UP template, or judge it free), then run select set_config(''cn.0256_reviewed'', ''1'', true) in this transaction and apply again. Rows: %', n, sample;
  end if;
end $$;

-- A · keyed cost / change-order / estimate lines: the claim IS the key — earliest invoice wins an
-- id two invoices carry, and an id already held by source_ids stays with its holder (0258 refuses
-- anything else; this plan is what makes the file land under it). Verbatim from the dry run.
create temp view _keyed_cost_plan as
with lines as (
  select it.id as line_id, it.invoice_id, i.invoice_number, i.created_at, it.sort_order, it.import_key,
         coalesce(
           substring(it.import_key from '^(?:po|bill|co|quote):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')::uuid,
           bli.bill_id) as source_id
    from public.invoice_items it
    join public.invoices i on i.id = it.invoice_id
    left join public.bill_line_items bli on it.import_key = 'bli:' || bli.id::text
   where i.status <> 'void'
     and it.source_ids = '{}'
     and (it.import_key ~ '^(po|bill|co|quote):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
          or it.import_key ~ '^bli:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
),
holder as (
  select distinct s.source_id, x.invoice_id, xi.created_at
    from lines s
    join public.invoice_items x on x.source_ids && array[s.source_id]
    join public.invoices xi on xi.id = x.invoice_id
   where xi.status <> 'void'
),
winner as (
  select distinct on (source_id) source_id, invoice_id
    from (select source_id, invoice_id, created_at from holder
          union all
          select source_id, invoice_id, created_at from lines) c
   order by source_id, created_at, invoice_id
)
select l.line_id, l.invoice_id, l.invoice_number, l.import_key, l.source_id,
       (w.invoice_id = l.invoice_id) as stamp,
       (select xi.invoice_number from public.invoices xi where xi.id = w.invoice_id) as held_by
  from lines l
  join winner w on w.source_id = l.source_id;

-- A bill line item's key names the LINE; its claim is the BILL (a bill is billed as a unit — every
-- row of it sums to mark(bill.amount), the anchor invariant in importCostsIntoInvoice) — the plan
-- resolved bli:<id> to its bill above, so one statement stamps every keyed kind.
update public.invoice_items it
   set source_ids = array[ p.source_id ]
  from _keyed_cost_plan p
 where it.id = p.line_id and p.stamp;

drop view _keyed_cost_plan;

-- B · labor — the update from the plan built above.
update public.invoice_items it
   set source_ids = (select array(select distinct unnest(it.source_ids || p.ids)))
  from (select line_id, array_agg(source_id) as ids from _labor_claim_plan group by line_id) p
 where it.id = p.line_id;

drop view _labor_claim_plan;

-- C · legacy (unkeyed) cost lines. The plan, verbatim from the dry run.
create temp view _cost_claim_plan as
with cost_inv as (
  select i.id as invoice_id, i.job_id, i.invoice_number, i.status, i.created_at,
         case when i.status = 'draft' then i.updated_at else i.created_at end as cutoff
    from public.invoices i
   where i.status <> 'void' and i.job_id is not null
     and exists (select 1 from public.invoice_items it
                  where it.invoice_id = i.id and it.import_source = 'costs' and it.import_key is null)
),
anchor as (
  select distinct on (it.invoice_id) it.id as line_id, it.invoice_id
    from public.invoice_items it join cost_inv c on c.invoice_id = it.invoice_id
   where it.import_source = 'costs' and it.import_key is null
   order by it.invoice_id, it.sort_order, it.id
),
src as (
  select b.job_id, b.id as source_id, 'bill'::text as kind, b.created_at, b.amount as cost,
         coalesce(b.supplier, '') || coalesce(' #' || b.bill_number, '') as label
    from public.bills b where b.job_id is not null and b.amount > 0
  union all
  select p.job_id, p.id, 'po', p.created_at, p.total, coalesce(p.vendor, '') || ' ' || p.po_number
    from public.purchase_orders p where p.job_id is not null and p.status <> 'cancelled' and p.total > 0
),
cand as (
  select s.job_id, s.source_id, s.kind, s.created_at as source_at, s.cost, s.label,
         c.invoice_id, c.invoice_number, c.created_at, a.line_id
    from src s
    join cost_inv c on c.job_id = s.job_id and s.created_at <= c.cutoff
    join anchor a on a.invoice_id = c.invoice_id
   where not exists (
     select 1 from public.invoice_items x join public.invoices xi on xi.id = x.invoice_id
      where xi.status <> 'void'
        and (s.source_id = any (x.source_ids)
             or x.import_key in ('po:' || s.source_id, 'bill:' || s.source_id, 'bill:' || s.source_id || ':remainder')
             or (x.import_key like 'bli:%' and exists (select 1 from public.bill_line_items bli
                                                        where bli.bill_id = s.source_id and x.import_key = 'bli:' || bli.id))))
)
select distinct on (source_id) * from cand order by source_id, created_at;

update public.invoice_items it
   set source_ids = (select array(select distinct unnest(it.source_ids || p.ids)))
  from (select line_id, array_agg(source_id) as ids from _cost_claim_plan group by line_id) p
 where it.id = p.line_id;

drop view _cost_claim_plan;
