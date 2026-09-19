-- NOT EVERYTHING ON THE RECEIPT IS THE CUSTOMER'S (Erik, 2026-09-18).
--
-- A Home Depot run puts the panel, the wire, the drill bit, the gloves and the Smartwater on ONE
-- piece of paper. The importer bills all of it: the only thing it holds back from the itemised
-- lines is Tax (billing/actions.ts), and even that is still CHARGED — it lands inside the
-- per-bill "Supplies & tax" remainder row, because the importer's anchor invariant is that a
-- bill's rows sum to the marked-up bill TOTAL. So Erik's customer paid for his Smartwater, his
-- BodyArmor, a ten cent bottle deposit and a pair of cut-resistant gloves on INV-069.
--
-- The cost of that reaches further than eight dollars. He stopped scanning receipts to avoid it:
--
--   "i have another receipt that i didnt scan specifically because it was mostly snacks and a $3
--    part"
--
-- — so the $3 part never became a job cost and the snacks never became a deduction. The app was
-- quietly teaching him to keep worse books.
--
-- `billable` is the switch. FALSE means the line is a real cost of doing business that the
-- customer does not pay for: it is kept out of the itemisation AND subtracted from the bill's
-- billable total, so it can never reappear inside the remainder row. Job cost and profitability
-- are untouched either way — those read bills.amount, the whole receipt (lib/job-financials.ts).
--
-- DEFAULT TRUE, deliberately. Erik chose "food and drink only" when asked what should stop being
-- billed without him saying so, and nothing a customer is charged today may change on its own.
-- Tools, bits, blades and gloves keep billing exactly as they do; the switch is there per line
-- when he wants it, and the receipt reader defaults new Food & Drink lines to false.
--
-- TAX IS NOT TOUCHED. Sales tax he paid on the customer's materials is a pass-through cost and
-- stays billed, inside the remainder row, exactly as it is today. "Not itemised" and "not billed"
-- are two different ideas and this column is only the second one.

alter table public.bill_line_items
  add column if not exists billable boolean not null default true;

comment on column public.bill_line_items.billable is
  'false = the company eats this line (snacks, a tool, anything bought on the same receipt that is not the customer''s). Kept out of the invoice AND subtracted from the bill''s billable total so the remainder row cannot re-bill it. Job cost still counts it.';

-- The existing receipts keep their behaviour: every line stays billable. Erik flips what he wants
-- per line, and the snack lines on already-sent invoices are a credit decision, not a backfill —
-- rewriting history under a bill someone has already been handed is exactly what this app refuses
-- to do everywhere else.

-- The importer reads a bill's lines and needs the non-billable sum per bill in the same pass.
create index if not exists bill_line_items_bill_billable_idx
  on public.bill_line_items (bill_id, billable);
