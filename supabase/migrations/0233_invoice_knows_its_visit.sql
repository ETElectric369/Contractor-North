-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0233: an invoice born from a visit knows which visit
--
-- Two problems, one column.
--
-- IDEMPOTENCY. "Done & paid" is used from a truck on flaky LTE — the exact case where a tap seems
-- to fail, gets tapped again, and both writes land. Without an anchor, that is two invoices with
-- two $150 payments: $300 of revenue recorded for $150 of work, quietly inflating the books. The
-- quote-born path has this guard (createInvoiceFromQuote returns the existing invoice for its
-- quote_id); the visit-born path had nothing to key on. The partial unique index makes the DB the
-- boundary — same law as tenant isolation: an app-level check is a convention, an index is a rule.
--
-- DETECTABILITY. The sweep found that a completed service call with no billing vanishes from every
-- follow-the-money surface — nothing could even ASK "was this visit ever billed?" because nothing
-- linked an invoice back to the visit it settled. Now the inbox can: completed visit, no anchored
-- invoice → "unbilled work" item. The $150 Erik happened to collect in cash would otherwise be the
-- $150 the next guy never collects at all.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.invoices add column if not exists appointment_id uuid references public.appointments(id) on delete set null;

-- One LIVE invoice per visit. Void ones don't count — voiding a mistake must not brick the retry.
create unique index if not exists invoices_one_per_appointment
  on public.invoices (appointment_id)
  where appointment_id is not null and status <> 'void';

create index if not exists invoices_appointment_idx on public.invoices (appointment_id) where appointment_id is not null;

comment on column public.invoices.appointment_id is
  'The visit this invoice settles (settleUp writes it). Unique per non-void invoice: the DB-level '
  'guard against a double-tapped "Done & paid" minting two bills, and the link that lets the inbox '
  'ask "was this completed visit ever billed?".';
