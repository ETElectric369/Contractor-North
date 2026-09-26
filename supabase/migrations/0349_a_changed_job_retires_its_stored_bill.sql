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
--
-- NEVER COSTS THE WRITE (0207: a failing trigger blocked every status change for two days). The
-- un-stamp runs in its own sub-block; any error there is a WARNING and the time, stock or job write
-- goes through. The copy is a shortcut, the write is the job.
--
-- SECURITY DEFINER because doc_pdf_cache is deny-all under RLS (0199) and the person clocking out
-- must not need (or get) access to it. search_path pinned.
--
-- LOCKS: CREATE TRIGGER takes a brief SHARE ROW EXCLUSIVE on time_entries, stock_moves and jobs
-- (blocks their writes for the instant it takes, not reads). lock_timeout 3s: a busy table fails fast
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
  v_jobs uuid[];
begin
  if tg_table_name = 'jobs' then
    v_jobs := array[new.id];
  elsif tg_op = 'INSERT' then
    v_jobs := array[new.job_id];
  elsif tg_op = 'DELETE' then
    v_jobs := array[old.job_id];
  else
    v_jobs := array[old.job_id, new.job_id];
  end if;

  begin
    update public.doc_pdf_cache c
       set doc_status = '', updated_at = now()
      from public.invoices i
     where c.doc = 'invoice'
       and c.doc_id = i.id
       and c.org_id = i.org_id
       and c.doc_status <> ''
       and i.job_id = any (v_jobs)
       and (tg_argv[0] = 'every' or i.invoice_kind in ('deposit', 'progress', 'final'));
  exception when others then
    raise warning '0349 unstamp_job_invoice_pdfs on %: % (%). The stored copy was left as it was; the write went through.',
      tg_table_name, sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

comment on function public.unstamp_job_invoice_pdfs() is
  'Un-stamps (doc_status = '''') the stored customer PDFs of a job''s invoices when what they print changes (0349): draws on time/stock, every invoice on a job site or billing model change. Never fails the write.';

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
                      'stock_moves_unstamp_draw_pdfs', 'jobs_unstamp_invoice_pdfs');
  if n <> 4 then
    raise exception '0349: expected 4 un-stamp triggers, found %. Nothing was changed.', n;
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.unstamp_job_invoice_pdfs()'::regprocedure and prosecdef) then
    raise exception '0349: unstamp_job_invoice_pdfs is not SECURITY DEFINER; it could not reach doc_pdf_cache. Nothing was changed.';
  end if;
  raise notice '0349: a changed job retires its bills'' stored PDFs.';
end $$;
