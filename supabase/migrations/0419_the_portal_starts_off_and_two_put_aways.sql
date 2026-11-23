-- 0419: a customer's own page starts OFF, and two notices can be put away.
--
-- WHERE IT STARTED (2026-11-22, the owner's three reports in one evening). From a customer's page:
-- "lets set the customer portal to default as OFF and then we can turn it on when needed for who
-- needs it only". From the Invoices page, of a bill in the send-again lane: "I know its been revised
-- and I don't want to send it again, can we put a dismiss button on those please and same with the
-- double billed in reconcile, im not going to change my mind, dismiss please". And seven minutes
-- later: "For Revised, lets mark it Sent - Revised with the send again alarm dismissible".
--
-- 1. THE LINK STARTS OFF. 0298 makes a link for every customer the moment the customer exists and
--    made it ON (enabled boolean not null default true), so every customer had a working page and
--    every invoice email carried a link to it, asked for or not. The default becomes false. The row
--    and its token are still made at creation, so Turn On is one write and the link it turns on is
--    the one the office already sees.
--    THE LINKS THAT EXIST: one that nobody has ever used goes off: never recorded as opened, no
--    customer session, no sign-in code ever asked for. A link somebody has used stays exactly as it
--    is. Read on production before this was written: one link in the whole database had ever been
--    opened.
--    TWICE-SAFE, AND THAT MATTERS HERE: the sweep runs only while the column's default is still
--    true, which is only the first time. A second run would otherwise switch off a link the office
--    turned on yesterday for a customer who has not opened it yet.
--    The trigger of 0331 (a link turned off ends its sessions) fires on each row the sweep turns off;
--    by the sweep's own rule those rows have no customer session and no code to end.
--
-- 2. invoices.resend_dismissed_at: when the office put the send-again notice away. The notice
--    (lib/invoice-revision, narrowed to the money by 0405) had one way out: send the bill again, or
--    say you had. A dismissal counts only while it is LATER than sent_at, so the next real send
--    re-arms the notice without anything having to clear this column.
--
-- 3. bills.duplicate_dismissed_at: when the office put an ANSWERED same-ticket pair away. It is
--    written on the copy that was set aside (the one carrying superseded_by_bill_id); the pick
--    itself is untouched. An answered pair kept its row on the Reconcile page for good, so that the
--    pick could be changed; this is how it leaves. An OPEN pair never reads this column.
--
-- NO KEY, NO TRIGGER, NO POLICY. Both new columns are plain stamps on rows their tables' own policies
-- already guard (neither table has column-level grants), and neither is a foreign key: one key
-- between two tables the app embeds (0418).
--
-- LOCKS: the two `add column` take ACCESS EXCLUSIVE on invoices and on bills for a moment, and the
-- sweep updates each never-used link once. lock_timeout 3s, statement_timeout 15s, the house's. ONE
-- TRANSACTION: the runners wrap the file.

set local lock_timeout = '3s';
set local statement_timeout = '15s';

-- ── 1. the link starts off ──────────────────────────────────────────────────────────────────────
do $$
declare
  v_default text;
begin
  select column_default into v_default
    from information_schema.columns
   where table_schema = 'public' and table_name = 'customer_portal_access' and column_name = 'enabled';
  if v_default is distinct from 'false' then
    update public.customer_portal_access a
       set enabled = false, disabled_at = now(), disabled_by = null
     where a.enabled
       and a.last_opened_at is null
       and not exists (
         select 1 from public.customer_portal_sessions s
          where s.customer_id = a.customer_id and s.kind = 'customer')
       and not exists (
         select 1 from public.customer_portal_codes k
          where k.customer_id = a.customer_id);
    alter table public.customer_portal_access alter column enabled set default false;
  end if;
end $$;

comment on column public.customer_portal_access.enabled is
  'Whether this customer''s own page opens. OFF until the office turns it on (0419; it was on from creation under 0298). Written by portal_link_set_enabled and portal_link_rotate.';

-- ── 2. the send-again notice can be put away ────────────────────────────────────────────────────
alter table public.invoices add column if not exists resend_dismissed_at timestamptz null;

comment on column public.invoices.resend_dismissed_at is
  'When the office dismissed the send-again notice on this invoice (0419). It counts only while it is later than sent_at: the next send re-arms the notice. Null = never dismissed, or brought back.';

-- ── 3. an answered same-ticket pair can be put away ─────────────────────────────────────────────
alter table public.bills add column if not exists duplicate_dismissed_at timestamptz null;

comment on column public.bills.duplicate_dismissed_at is
  'When the office dismissed an ANSWERED same-ticket pair from the Reconcile page (0419). Written on the copy that was set aside (superseded_by_bill_id is set); the pick itself is untouched. An open pair never reads it.';

-- ── 4. self-check ───────────────────────────────────────────────────────────────────────────────
do $$
begin
  if (select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'customer_portal_access' and column_name = 'enabled')
     is distinct from 'false' then
    raise exception '0419: customer_portal_access.enabled should default to false';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'invoices' and column_name = 'resend_dismissed_at') then
    raise exception '0419: invoices.resend_dismissed_at is missing';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'bills' and column_name = 'duplicate_dismissed_at') then
    raise exception '0419: bills.duplicate_dismissed_at is missing';
  end if;
end $$;

notify pgrst, 'reload schema';
