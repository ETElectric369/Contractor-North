-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0405: a sent bill remembers its figure
--
-- The link a customer holds is live: the /i page and its PDF render the bill as it is NOW, so a
-- change made after the send never leaves them reading an older document. The one thing that can
-- go stale is the figure they already acted on. Erik, 2026-11-07, on the "send it again" notice:
--
--   "any change i make after its been sent reflects on the link already sent so its mostly
--    unnecessary to send it again unless they've paid and something changes and a difference
--    remains"
--
-- To know whether the money moved since the send, the row has to remember what the total WAS when
-- it went out. Until now it did not: sent_at (0267) says when, revised_at (0269) says that
-- something changed, and neither says what figure the customer was looking at.
--
-- WHAT CHANGES:
--
--   public.invoices gets one nullable column:
--     sent_total  numeric(12,2)  the invoice's total at the moment sent_at was last written: the
--                                figure the customer's copy carried when it went out. The same
--                                type as invoices.total (0003).
--
--   ONE TRIGGER, so every door that moves sent_at records the figure in the same write and no door
--   can forget to (two doors, one thing: markInvoiceSent, markInvoiceResent and the hand "Sent - I
--   Sent It Myself" all write sent_at, and none of them has to know about this column).
--   invoices_sent_total_follows_send, BEFORE INSERT OR UPDATE OF sent_at, copies new.total into
--   new.sent_total when sent_at is set to a non-null instant it did not already hold. A write that
--   lists sent_at without moving it (the same instant again) changes nothing. A payment never
--   touches total, so a payment never touches this.
--
--   NO BACKFILL. Null = sent before 0405, or never sent: a figure nobody recorded. Nothing here
--   writes a row, and the app does not guess the figure either: a bill sent before this migration
--   whose customer paid and whose money then changed keeps its notice, because the app cannot
--   prove the money did NOT move.
--
--   The readers, the day they are added (a stored answer nothing reads back is a hole):
--   the one rule customerHoldsOlderCopy in lib/invoice-revision.ts (its "did the money move since
--   the send" step), fed by the billing board's revised-invoices select (billing/page.tsx) and the
--   invoice page's row (billing/[id]/page.tsx), and Your Data's export (lib/export/registry.ts).
--
--   No RLS change: invoices keeps its policies; a member who reads total reads this. The customer
--   door (public_invoice) does not read it.
--
-- LOCKS: ALTER TABLE … ADD COLUMN takes invoices' ACCESS EXCLUSIVE lock for a moment; a nullable
-- column with no default is a catalog change. CREATE TRIGGER takes SHARE ROW EXCLUSIVE for a
-- moment. lock_timeout 3s: a busy table fails fast and changes nothing; run it again. Twice-safe:
-- the column is ADD COLUMN IF NOT EXISTS, the function is CREATE OR REPLACE, the trigger is
-- dropped if it exists and made again, and the comment is set to the same text again.
--
-- ORDER: after 0404. Apply BEFORE the deploy that carries the rule, on production AND the test
-- database: the board's select names sent_total, and a select naming a column that is not there
-- fails the whole read.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.invoices') is null then
    raise exception '0405: public.invoices is not on this database. Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'invoices' and column_name = 'sent_at'
  ) then
    raise exception '0405: invoices has no sent_at (0267, the delivery stamp). Apply 0267 first. Nothing was changed.';
  end if;
end $$;

-- ── what the send carried ───────────────────────────────────────────────────────────────────────
alter table public.invoices add column if not exists sent_total numeric(12,2);

comment on column public.invoices.sent_total is
  'The invoice''s total at the moment sent_at was last written (0405): the figure the customer''s copy carried when it went out. Kept by the trigger invoices_sent_total_follows_send on every write that moves sent_at; never written by the app. Null = sent before 0405, or never sent: an unknown figure, not zero.';

-- ── the figure follows the send ─────────────────────────────────────────────────────────────────
create or replace function public.invoices_sent_total_follows_send()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  -- Nothing to record unless this write sets a delivery instant. Clearing sent_at (nothing in the
  -- app does) leaves the last recorded figure standing beside the null, which is still the truth
  -- about the last send.
  if new.sent_at is null then
    return new;
  end if;
  -- A new row with a send on it, or a send moved to an instant the row did not already hold. The
  -- same instant written again (a write that lists sent_at without moving it) records nothing.
  if tg_op = 'INSERT' or new.sent_at is distinct from old.sent_at then
    new.sent_total := new.total;
  end if;
  return new;
end
$fn$;

drop trigger if exists invoices_sent_total_follows_send on public.invoices;
create trigger invoices_sent_total_follows_send before insert or update of sent_at on public.invoices
  for each row execute function public.invoices_sent_total_follows_send();

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'invoices' and column_name = 'sent_total'
       and data_type = 'numeric' and numeric_precision = 12 and numeric_scale = 2 and is_nullable = 'YES'
  ) then
    raise exception '0405: invoices.sent_total is missing, or is not a numeric(12,2) that may be left empty. Nothing was changed.';
  end if;
  if to_regprocedure('public.invoices_sent_total_follows_send()') is null then
    raise exception '0405: the function that records the figure a send carried is not on this database. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.invoices'::regclass and tgname = 'invoices_sent_total_follows_send' and not tgisinternal) then
    raise exception '0405: the trigger that records the figure a send carried is not on invoices. Nothing was changed.';
  end if;
  -- invoices' boundary is untouched: row level security stays on.
  if not (select relrowsecurity from pg_class where oid = 'public.invoices'::regclass) then
    raise exception '0405: row level security is off on invoices. Nothing was changed.';
  end if;
  raise notice '0405: a sent bill remembers its figure — every write that moves sent_at records the total it carried, so the office is told to send a bill again only when the customer paid against a figure that has since moved.';
end $$;
