-- SENT MUST MEAN DELIVERED, NOT "A DOOR WAS OPENED" (Erik, INV-069, 2026-09-18).
--
-- `status = 'sent'` has been carrying two different meanings. One is the true one: the bill went
-- to the customer by email, by text, or by handing over the link. The other is an accident of
-- plumbing — Pay Now promoted a DRAFT to 'sent' the moment it built the card door, before any card
-- was tapped (tap-actions.ts). Erik pressed it on a $6,412 invoice he was still building, no card
-- was ever presented, and the invoice was promoted for good:
--
--   "its not sent its in draft mode thats partially why this is confusing"
--
-- The trap then closed. setInvoiceStatus refuses a return to Draft whenever amount_paid > 0 (audit
-- v921 — right, for an invoice the customer really has). His own $200 cash deposit, recorded on the
-- draft exactly as the app invites, became the lock on his own work.
--
-- So the row learns the difference. `sent_at` is stamped ONLY where a bill actually leaves the
-- building — emailInvoice, textInvoice, shareInvoice's explicit yes, and the manual "I sent it
-- myself" status choice. A pay door never stamps it. The demotion guard then reads delivery
-- instead of guessing from money: payments on a DELIVERED invoice still bar the way back; payments
-- on something that never left the desk do not.
--
-- BACKFILL, deliberately narrow. Anything that reached 'partial', 'paid' or 'overdue' moved money
-- through a bill the customer was looking at, so it is stamped from updated_at — the closest
-- honest timestamp we hold — and behaves exactly as it does today. Plain 'sent' rows are left NULL
-- because that is the one status a pay door can have manufactured, and there is no evidence in the
-- database either way. Today that distinction frees exactly one row (INV-069, the only invoice in
-- the table whose stored status disagrees with paidStatus) and changes nothing else: every other
-- 'sent' row carries amount_paid = 0, which the guard never looks at.
--
-- 'void' and 'draft' stay NULL: neither is a delivery.

alter table public.invoices
  add column if not exists sent_at timestamptz;

comment on column public.invoices.sent_at is
  'When this bill actually reached the customer (email, text, or the share link handed over). NULL means it never left the desk, whatever the status says. A pay door must never set this.';

update public.invoices
   set sent_at = updated_at
 where sent_at is null
   and status in ('partial', 'paid', 'overdue');

-- The demotion guard and the AR views both ask "was this delivered?" on live rows.
create index if not exists invoices_sent_at_idx
  on public.invoices (org_id, sent_at)
  where sent_at is not null;
