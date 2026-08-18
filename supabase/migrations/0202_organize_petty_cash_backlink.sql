-- 0202 — THE PETTY-CASH ROW ORGANIZE CREATED, REMEMBERED (audit 9).
--
-- Filing a receipt to petty cash INSERTS a petty_cash row and then forgets it: organized_items
-- carries bill_id for the bill branch but nothing for this one. So the two operations a person
-- naturally performs both go wrong with real dollars:
--   · RE-FILE (wrong destination, fixed) → a second petty_cash row, the first still standing:
--     the same receipt counted twice in the cash drawer.
--   · UNFILE/DELETE the item → the petty_cash row is orphaned, spend with nothing behind it.
--
-- ON DELETE SET NULL, not CASCADE: the money row is the record of a real disbursement and must
-- outlive the filing that created it — the link is provenance, not ownership.

alter table public.organized_items
  add column if not exists petty_cash_id uuid references public.petty_cash(id) on delete set null;

comment on column public.organized_items.petty_cash_id is
  'The petty_cash row this filing created (0202) — so a re-file replaces it instead of double-counting, and an unfile can take it back down.';
