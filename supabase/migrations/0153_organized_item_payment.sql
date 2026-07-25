-- Organize My reads a receipt and classifies HOW it was paid (tender shown vs ON ACCT /
-- net terms). billJobReceipt already threads that into the bill's paid/unpaid status
-- (cn-v544), but analyzeAndFile's auto-file and the manual tray-file path fell back to
-- billStatusFor(category), a name heuristic that calls anything not "bill/invoice" PAID —
-- so a supply-house ON-ACCT ticket filed through Organize My vanished from payables until
-- the monthly statement arrived. Persist the classification on the item so the manual file
-- action can honor it instead of re-guessing from the category.
--
-- Values: 'paid_at_purchase' | 'on_account' | 'unknown' (null = never classified).

alter table public.organized_items add column if not exists payment text;

comment on column public.organized_items.payment is
  'How the receipt was paid, read off the document: paid_at_purchase | on_account | unknown. Drives the created bill''s paid/unpaid status; unknown settles to UNPAID (a debt you forget costs money, one you already paid is a harmless reconcile).';
