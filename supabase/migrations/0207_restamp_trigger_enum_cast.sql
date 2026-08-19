-- 0207 — THE RE-STAMP TRIGGER WAS BLOCKING EVERY STATUS CHANGE (my bug, 0200).
--
-- 0200 added an AFTER UPDATE trigger on quotes and invoices to keep the stored-PDF stamp honest.
-- It compared `doc_pdf_cache.doc_status` — a TEXT column — against NEW/OLD.status, which on both
-- of those tables is an ENUM (quote_status / invoice_status). Postgres has no text = enum
-- operator, so the trigger raised, and because a trigger's failure aborts the whole statement,
-- EVERY status write on a quote or an invoice failed with:
--
--     operator does not exist: text = quote_status
--
-- Which meant, live, for two days: an estimate could not be accepted or declined, an invoice
-- could not be sent, and — worst — recordPayment's insert succeeded while recalcInvoice's
-- header update was rejected, so a real payment sat in `payments` with the invoice still reading
-- as owed. Erik hit exactly that marking Lorraine Lim paid.
--
-- Why it survived review and CI: no test writes a status through the DB, and no quote or invoice
-- changed status in the hours after the deploy — the first real status change was the one that
-- broke. Casting both sides to text is the fix; the comparison was always meant to be textual.

create or replace function public.restamp_doc_pdf_on_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    update public.doc_pdf_cache
      set doc_status = new.status::text, updated_at = now()
      where doc = tg_argv[0]
        and doc_id = new.id
        and doc_status = old.status::text;
  end if;
  return new;
end;
$$;
