-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0349: a job that changes retires its bills' stored PDFs
--
-- Audit v1018 (links-docs-1, class 15). A sent bill's customer link (/i) and portal draw the
-- document live, and a draw (deposit / progress / final) carries a live Progress Summary: its work
-- to date counts the job's hours and stock takes, and every bill prints the job's site and billing
-- model. The link's Download PDF button serves the STORED copy (doc_pdf_cache, 0198), which the
-- customer door checks only by status. Nothing retired that copy when the crew clocked hours, took
-- stock, or the office changed the job's address or billing model, so one bill could show two
-- different Work To Date figures (the page and the file), or a PDF named for the new street with
-- the old one printed on it.
--
-- THE RULE, AT THE BOUNDARY (the way 0200 re-stamps a status flip): these writes happen from many
-- doors (the clock, the office's time edits, a split, Nort, the text doors, the auto clock-out, a
-- take and its undo, a job save), so the rule lives on the tables, not at one app path.
--
-- WHAT IT DOES: it UN-STAMPS the job's stored invoice copies (doc_status = ''), it deletes nothing.
--   - The customer door (share-pdf, sharePdfAvailable) serves a copy only when its stamp equals the
--     invoice's current status, so an un-stamped copy is refused: no Download PDF button until a
--     fresh copy exists. The live page is always there.
--   - The office door (/api/pdf) fingerprints the print page's HTML on every open. If the change
--     moved nothing on the bill (a SHOP-code hour), the fingerprint matches and the HIT re-stamps the
--     copy to the current status (its existing rule); if it moved something, it re-renders and
--     stores a fresh copy. Either way the next staff open or send heals it. No stored bytes are
--     orphaned (the row and the object stay together).
--   - 0200's status re-stamp only advances a copy stamped with the OLD status, so '' is never
--     revived by a status flip.
--
-- WHICH BILLS:
--   time_entries (a shift's job, code, times, lunch, person or status) and stock_moves (any take,
--     return or undo on a job): the job's DRAW invoices (deposit / progress / final), the ones that
--     print the Progress Summary. A standard invoice prints only its own lines, which bust their
--     own copy when they change (billing/actions, recalcInvoice).
--   jobs (billing_type, address, unit, city, state, zip): EVERY invoice on the job, since every one
--     prints the job site and the billing model.
--   EVERYTHING ELSE THE PROGRESS SUMMARY READS (review of this migration): its Estimate, Work To Date
--   and Received To Date (jobProgressFinancials) also move with the job's OTHER bills, its quotes,
--   receipts and orders, and the rates the unbilled hours are priced at. Each un-stamps the draws:
--     invoice_items (any line on any invoice of the job: a T&M job's work to date is its billed
--       lines at the price billed, billedWorkOnInvoices), keyed through the line's invoice;
--     invoices (status, amount_paid, job_id, invoice_kind: a void drops its lines and its payments,
--       a payment is Received To Date), a sibling's draws only: the bill's OWN copy is 0200's to
--       re-stamp on a status flip and recalcInvoice's to bust on a payment; a deleted invoice too;
--     quotes (the Estimate), bills and bill_line_items (receipts, keyed through the bill),
--       purchase_orders (orders): on the row's job;
--     customers.pricing_level_id: the draws on that customer's jobs;
--     pricing_levels (labor_rate, markup_pct), profiles (bill_rate, hourly_rate, role: payViewRow
--       prices an owner's hours at his figure) and job_codes (billable, code): every draw in the
--       org, since any job may be priced by them. Rare writes; an un-stamped copy only costs a
--       re-render.
--   The org's own settings (default labor rate, markup) are busted by the app (bustOrgPdfs).

-- NEVER COSTS THE WRITE (0207: a failing trigger blocked every status change for two days). The
-- un-stamp runs in its own sub-block; any error there is a WARNING and the time, stock or job write
-- goes through. The copy is a shortcut, the write is the job.
--
-- SECURITY DEFINER because doc_pdf_cache is deny-all under RLS (0199) and the person clocking out
-- must not need (or get) access to it. search_path pinned.
--
-- LOCKS: CREATE TRIGGER takes a brief SHARE ROW EXCLUSIVE on each table it names (time_entries,
-- stock_moves, jobs, invoice_items, invoices, quotes, bills, bill_line_items, purchase_orders,
-- customers, pricing_levels, profiles, job_codes): it blocks their writes for the instant it takes,
-- not reads. lock_timeout 3s: a busy table fails fast
-- and changes nothing; run it again.
--
-- ORDER: any time after 0198 and 0303 (stock_moves). No code depends on it: before it is applied the
-- stored copy simply is not retired, as today (doc_pdf_cache held 0 rows on 2026-09-26). Safe to
-- re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.doc_pdf_cache') is null then
    raise exception '0349: doc_pdf_cache (0198) is not on this database. Apply 0198 first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_moves') is null then
    raise exception '0349: stock_moves (0303) is not on this database. Apply 0303 first. Nothing was changed.';
  end if;
end $$;

create or replace function public.unstamp_job_invoice_pdfs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_keys uuid[];
  v_jobs uuid[];
  v_org uuid;
  v_self uuid;
begin
  begin
    -- The row's key, before and after (a row moved between jobs retires both jobs' copies).
    v_keys := array_remove(array[
      (v_old ->> case tg_table_name when 'jobs' then 'id' when 'customers' then 'id'
                                    when 'invoice_items' then 'invoice_id' when 'bill_line_items' then 'bill_id'
                                    else 'job_id' end)::uuid,
      (v_new ->> case tg_table_name when 'jobs' then 'id' when 'customers' then 'id'
                                    when 'invoice_items' then 'invoice_id' when 'bill_line_items' then 'bill_id'
                                    else 'job_id' end)::uuid
    ], null);

    if tg_table_name in ('pricing_levels', 'profiles', 'job_codes') then
      -- A rate or a code: every draw in the org may be priced by it.
      v_org := coalesce(v_new ->> 'org_id', v_old ->> 'org_id')::uuid;
    elsif tg_table_name = 'invoice_items' then
      select array_agg(distinct i.job_id) into v_jobs from public.invoices i where i.id = any (v_keys);
    elsif tg_table_name = 'bill_line_items' then
      select array_agg(distinct b.job_id) into v_jobs from public.bills b where b.id = any (v_keys);
    elsif tg_table_name = 'customers' then
      select array_agg(j.id) into v_jobs from public.jobs j where j.customer_id = any (v_keys);
    else
      v_jobs := v_keys;
      -- A bill's own copy is 0200's (status) and recalcInvoice's (payments) to keep: siblings only.
      if tg_table_name = 'invoices' then
        v_self := coalesce(v_new ->> 'id', v_old ->> 'id')::uuid;
      end if;
    end if;

    if v_org is not null or coalesce(array_length(v_jobs, 1), 0) > 0 then
      update public.doc_pdf_cache c
         set doc_status = '', updated_at = now()
        from public.invoices i
       where c.doc = 'invoice'
         and c.doc_id = i.id
         and c.org_id = i.org_id
         and c.doc_status <> ''
         and (case when v_org is not null then i.org_id = v_org else i.job_id = any (v_jobs) end)
         and i.id is distinct from v_self
         and (tg_argv[0] = 'every' or i.invoice_kind in ('deposit', 'progress', 'final'));
    end if;
  exception when others then
    raise warning '0349 unstamp_job_invoice_pdfs on %: % (%). The stored copy was left as it was; the write went through.',
      tg_table_name, sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

comment on function public.unstamp_job_invoice_pdfs() is
  'Un-stamps (doc_status = '''') the stored customer PDFs of a job''s invoices when what they print changes (0349): draws on time, stock, sibling bills, quotes, receipts, orders and rates; every invoice on a job site or billing model change. Never fails the write.';

-- ── The hours ────────────────────────────────────────────────────────────────────────────────────
drop trigger if exists time_entries_unstamp_draw_pdfs on public.time_entries;
create trigger time_entries_unstamp_draw_pdfs
  after insert or delete on public.time_entries
  for each row execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists time_entries_unstamp_draw_pdfs_upd on public.time_entries;
create trigger time_entries_unstamp_draw_pdfs_upd
  after update of job_id, job_code, clock_in, clock_out, lunch_minutes, profile_id, status on public.time_entries
  for each row
  when ((old.job_id, old.job_code, old.clock_in, old.clock_out, old.lunch_minutes, old.profile_id, old.status)
        is distinct from
        (new.job_id, new.job_code, new.clock_in, new.clock_out, new.lunch_minutes, new.profile_id, new.status))
  execute function public.unstamp_job_invoice_pdfs('draws');

-- ── The pieces taken from stock ──────────────────────────────────────────────────────────────────
drop trigger if exists stock_moves_unstamp_draw_pdfs on public.stock_moves;
create trigger stock_moves_unstamp_draw_pdfs
  after insert or update or delete on public.stock_moves
  for each row execute function public.unstamp_job_invoice_pdfs('draws');

-- ── The job's site and billing model ─────────────────────────────────────────────────────────────
drop trigger if exists jobs_unstamp_invoice_pdfs on public.jobs;
create trigger jobs_unstamp_invoice_pdfs
  after update of billing_type, address, unit, city, state, zip on public.jobs
  for each row
  when ((old.billing_type, old.address, old.unit, old.city, old.state, old.zip)
        is distinct from
        (new.billing_type, new.address, new.unit, new.city, new.state, new.zip))
  execute function public.unstamp_job_invoice_pdfs('every');

-- ── The job's other bills (a T&M job's work to date, and Received To Date) ──────────────────────
drop trigger if exists invoice_items_unstamp_draw_pdfs on public.invoice_items;
create trigger invoice_items_unstamp_draw_pdfs
  after insert or delete on public.invoice_items
  for each row execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists invoice_items_unstamp_draw_pdfs_upd on public.invoice_items;
create trigger invoice_items_unstamp_draw_pdfs_upd
  -- line_total is generated from quantity and unit_price, so those are the columns a write names.
  after update of invoice_id, quantity, unit_price, line_kind, import_source, unit, description on public.invoice_items
  for each row
  when ((old.invoice_id, old.quantity, old.unit_price, old.line_kind, old.import_source, old.unit, old.description)
        is distinct from
        (new.invoice_id, new.quantity, new.unit_price, new.line_kind, new.import_source, new.unit, new.description))
  execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists invoices_unstamp_sibling_draw_pdfs on public.invoices;
create trigger invoices_unstamp_sibling_draw_pdfs
  after update of status, amount_paid, job_id, invoice_kind on public.invoices
  for each row
  when ((old.status, old.amount_paid, old.job_id, old.invoice_kind)
        is distinct from
        (new.status, new.amount_paid, new.job_id, new.invoice_kind))
  execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists invoices_unstamp_sibling_draw_pdfs_del on public.invoices;
create trigger invoices_unstamp_sibling_draw_pdfs_del
  after delete on public.invoices
  for each row execute function public.unstamp_job_invoice_pdfs('draws');

-- ── The Estimate, the receipts and the orders ────────────────────────────────────────────────────
drop trigger if exists quotes_unstamp_draw_pdfs on public.quotes;
create trigger quotes_unstamp_draw_pdfs
  after insert or delete on public.quotes
  for each row execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists quotes_unstamp_draw_pdfs_upd on public.quotes;
create trigger quotes_unstamp_draw_pdfs_upd
  after update of job_id, status, total, doc_type on public.quotes
  for each row
  when ((old.job_id, old.status, old.total, old.doc_type) is distinct from (new.job_id, new.status, new.total, new.doc_type))
  execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists bills_unstamp_draw_pdfs on public.bills;
create trigger bills_unstamp_draw_pdfs
  after insert or delete on public.bills
  for each row execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists bills_unstamp_draw_pdfs_upd on public.bills;
create trigger bills_unstamp_draw_pdfs_upd
  after update of job_id, amount, po_id, superseded_by_bill_id on public.bills
  for each row
  when ((old.job_id, old.amount, old.po_id, old.superseded_by_bill_id)
        is distinct from
        (new.job_id, new.amount, new.po_id, new.superseded_by_bill_id))
  execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists bill_line_items_unstamp_draw_pdfs on public.bill_line_items;
create trigger bill_line_items_unstamp_draw_pdfs
  after insert or delete on public.bill_line_items
  for each row execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists bill_line_items_unstamp_draw_pdfs_upd on public.bill_line_items;
create trigger bill_line_items_unstamp_draw_pdfs_upd
  after update of bill_id, description, quantity, unit_price, amount, category, billable, billed_amount on public.bill_line_items
  for each row
  when ((old.bill_id, old.description, old.quantity, old.unit_price, old.amount, old.category, old.billable, old.billed_amount)
        is distinct from
        (new.bill_id, new.description, new.quantity, new.unit_price, new.amount, new.category, new.billable, new.billed_amount))
  execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists purchase_orders_unstamp_draw_pdfs on public.purchase_orders;
create trigger purchase_orders_unstamp_draw_pdfs
  after insert or delete on public.purchase_orders
  for each row execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists purchase_orders_unstamp_draw_pdfs_upd on public.purchase_orders;
create trigger purchase_orders_unstamp_draw_pdfs_upd
  after update of job_id, status, total on public.purchase_orders
  for each row
  when ((old.job_id, old.status, old.total) is distinct from (new.job_id, new.status, new.total))
  execute function public.unstamp_job_invoice_pdfs('draws');

-- ── The rates the unbilled hours and materials are priced at ─────────────────────────────────────
drop trigger if exists customers_unstamp_draw_pdfs on public.customers;
create trigger customers_unstamp_draw_pdfs
  after update of pricing_level_id on public.customers
  for each row
  when (old.pricing_level_id is distinct from new.pricing_level_id)
  execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists pricing_levels_unstamp_draw_pdfs on public.pricing_levels;
create trigger pricing_levels_unstamp_draw_pdfs
  after update of labor_rate, markup_pct on public.pricing_levels
  for each row
  when ((old.labor_rate, old.markup_pct) is distinct from (new.labor_rate, new.markup_pct))
  execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists profiles_unstamp_draw_pdfs on public.profiles;
create trigger profiles_unstamp_draw_pdfs
  after update of bill_rate, hourly_rate, role on public.profiles
  for each row
  when ((old.bill_rate, old.hourly_rate, old.role) is distinct from (new.bill_rate, new.hourly_rate, new.role))
  execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists job_codes_unstamp_draw_pdfs on public.job_codes;
create trigger job_codes_unstamp_draw_pdfs
  after insert or delete on public.job_codes
  for each row execute function public.unstamp_job_invoice_pdfs('draws');

drop trigger if exists job_codes_unstamp_draw_pdfs_upd on public.job_codes;
create trigger job_codes_unstamp_draw_pdfs_upd
  after update of code, billable on public.job_codes
  for each row
  when ((old.code, old.billable) is distinct from (new.code, new.billable))
  execute function public.unstamp_job_invoice_pdfs('draws');

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  n int;
begin
  select count(*) into n
    from pg_trigger t
   where not t.tgisinternal
     and t.tgfoid = 'public.unstamp_job_invoice_pdfs()'::regprocedure
     and t.tgname in ('time_entries_unstamp_draw_pdfs', 'time_entries_unstamp_draw_pdfs_upd',
                      'stock_moves_unstamp_draw_pdfs', 'jobs_unstamp_invoice_pdfs',
                      'invoice_items_unstamp_draw_pdfs', 'invoice_items_unstamp_draw_pdfs_upd',
                      'invoices_unstamp_sibling_draw_pdfs', 'invoices_unstamp_sibling_draw_pdfs_del',
                      'quotes_unstamp_draw_pdfs', 'quotes_unstamp_draw_pdfs_upd',
                      'bills_unstamp_draw_pdfs', 'bills_unstamp_draw_pdfs_upd',
                      'bill_line_items_unstamp_draw_pdfs', 'bill_line_items_unstamp_draw_pdfs_upd',
                      'purchase_orders_unstamp_draw_pdfs', 'purchase_orders_unstamp_draw_pdfs_upd',
                      'customers_unstamp_draw_pdfs', 'pricing_levels_unstamp_draw_pdfs',
                      'profiles_unstamp_draw_pdfs', 'job_codes_unstamp_draw_pdfs', 'job_codes_unstamp_draw_pdfs_upd');
  if n <> 21 then
    raise exception '0349: expected 21 un-stamp triggers, found %. Nothing was changed.', n;
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.unstamp_job_invoice_pdfs()'::regprocedure and prosecdef) then
    raise exception '0349: unstamp_job_invoice_pdfs is not SECURITY DEFINER; it could not reach doc_pdf_cache. Nothing was changed.';
  end if;
  raise notice '0349: a changed job retires its bills'' stored PDFs.';
end $$;
