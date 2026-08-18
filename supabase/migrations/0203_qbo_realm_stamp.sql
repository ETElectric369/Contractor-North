-- 0203 — A QUICKBOOKS ID BELONGS TO ONE COMPANY FILE (audit 9).
--
-- customers.qbo_id / invoices.qbo_id record "this record exists in QuickBooks as N" — but N is
-- only meaningful inside the REALM it was created in. Reconnect the org to a different QuickBooks
-- company (a new book for the new year, a bookkeeper's sandbox, an acquired entity) and every
-- stored id silently points at a stranger's record in the new file: the next push does a SPARSE
-- UPDATE against whatever invoice happens to hold that id, overwriting someone else's document.
--
-- Stamping the realm lets a read decide honestly: same realm ⇒ the mapping is real; different
-- realm ⇒ treat it as not-yet-pushed and create fresh. DISCONNECT DELIBERATELY LEAVES THESE
-- ALONE — disconnect→reconnect to the SAME company is how a person re-auths an expired grant,
-- and clearing mappings there would duplicate every customer and invoice in a live book.

alter table public.customers add column if not exists qbo_realm_id text;
alter table public.invoices  add column if not exists qbo_realm_id text;

comment on column public.customers.qbo_realm_id is
  'The QuickBooks company file qbo_id belongs to (0203). A mismatch with the live connection means the mapping is from another book and must not be reused.';
comment on column public.invoices.qbo_realm_id is
  'The QuickBooks company file qbo_id belongs to (0203). A mismatch means "not pushed to THIS book" — never sparse-update across realms.';
