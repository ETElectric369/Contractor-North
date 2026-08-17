-- 0200 — A STATUS FLIP RE-STAMPS THE STORED PDF, AT THE BOUNDARY (audit 7).
--
-- The customer door (share-pdf) only serves a stored copy whose doc_status equals the doc's
-- CURRENT status. Status flips happen from many places — the office dropdown, sends, and
-- accept_public_quote, which a CUSTOMER invokes with no staff session for any app-side hook to
-- ride. A rule at one app path is a convention, not a boundary — so the re-stamp lives here,
-- on the tables themselves.
--
-- CONDITIONAL on the pre-flip status: a row still stamped with the OLD status was
-- fingerprint-fresh as of its stamping, and every content write busts rows outright — so
-- advancing only the matching stamp can never revive bytes from an earlier era. SECURITY
-- DEFINER because doc_pdf_cache is deny-all under RLS (0199) and the flipping user must not
-- need (or get) direct access to it.
--
-- SAFE ONLY WHILE THE PRINT TEMPLATES RENDER NO STATUS. They don't today (verified: neither
-- print/invoice nor print/quote shows a status badge). If a template ever grows one, a status
-- flip changes the HTML, the fingerprint moves, and the staff door re-renders anyway — but
-- this trigger must then also be revisited.

create or replace function public.restamp_doc_pdf_on_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    update public.doc_pdf_cache
      set doc_status = new.status, updated_at = now()
      where doc = tg_argv[0] and doc_id = new.id and doc_status = old.status;
  end if;
  return new;
end;
$$;

drop trigger if exists quotes_restamp_pdf on public.quotes;
create trigger quotes_restamp_pdf
  after update of status on public.quotes
  for each row execute function public.restamp_doc_pdf_on_status('quote');

drop trigger if exists invoices_restamp_pdf on public.invoices;
create trigger invoices_restamp_pdf
  after update of status on public.invoices
  for each row execute function public.restamp_doc_pdf_on_status('invoice');
