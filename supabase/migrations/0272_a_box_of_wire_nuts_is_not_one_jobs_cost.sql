-- A BOX OF WIRE NUTS IS NOT ONE JOB'S COST (Erik, 2026-09-19).
--
-- Reading his own invoice he stopped on a line and worked out what it actually was:
--
--   "the Twister box i was confused about and i remebered that is a whole ccontainer of wire nuts
--    that we uses some of but is certainly stock and shouldnt be charged to the customer in full
--    however necessary for the job"
--
-- IDEAL 30641, 500 Twister wire nuts, $108.36 - 21.7 cents each. A residential panel-and-devices
-- job eats forty or fifty of them. Jason Waldow was being billed $135.00 for the whole box, and
-- the next three jobs would have used nuts they never paid for. The same receipt carries a second
-- one nobody had noticed: an 8-ounce jar of IDEAL anti-oxidant at $20.65, billed in full, used a
-- dab at a time.
--
-- 0268 gave a receipt line two states - billed to the customer, or the company's own (the snacks).
-- This is the third, and it is the one a supply house actually creates: bought whole, consumed in
-- pieces, across jobs.
--
-- WHY THERE IS NO AUTO-DETECTION HERE, which Erik reached for himself ("qtys of 100s might give it
-- away") and which his own example refutes. The quantity on that Twister line reads 500, and the
-- scanner took that from the PRODUCT NAME - "500/5000" - not from a quantity column. So the one
-- signal worth reaching for is already wrong on the exact line that prompted the idea. Counts hide
-- inside names (/C, BX, 100PK), and a bag of 100 connectors genuinely used up on one job looks
-- identical to a box of nuts that lives in the truck. Same rule as the snacks, for the same reason:
-- guessing wrong costs him money silently and guessing right only saves a tap, so the app suggests
-- and a person decides.
--
-- PRECEDENCE, so three flags never argue:
--   billable = false                          -> bills nothing. The snacks.
--   billable = true,  billed_amount is null    -> bills the whole line. Today's behaviour, unchanged.
--   billable = true,  billed_amount = X        -> bills X; the rest is the company's stock.
-- billed_amount is a DOLLAR figure because that is the unit the importer trues up in and the unit
-- Erik reached for ("just modify the number to 20"). A card may still ask "how many did you use?"
-- and multiply - that is presentation, and the stored answer stays one number the money can trust.

alter table public.bill_line_items
  -- What THIS job used, in dollars of cost, when the purchase was a container. NULL = all of it,
  -- which is what every existing row means and keeps meaning.
  add column if not exists billed_amount numeric(12,2),
  -- Marks the line as shop stock even before a portion is chosen, so a card can say what it is and
  -- so "what did we spend on stock this month" is answerable later.
  add column if not exists is_stock boolean not null default false;

alter table public.bill_line_items
  -- Never negative, and never more than the line cost: billing more of a box than the box cost is
  -- not a partial bill, it is a markup, and markup belongs to the importer where it can be seen.
  add constraint bill_line_items_billed_amount_sane
    check (billed_amount is null or (billed_amount >= 0 and billed_amount <= abs(coalesce(amount, unit_price * coalesce(quantity, 1), 0)) + 0.005))
    not valid;

comment on column public.bill_line_items.billed_amount is
  'Dollars of THIS line the current job used, when the purchase was a container (a 500ct box of wire nuts, an 8oz jar of compound). NULL = bill the whole line. 0 is expressible but `billable = false` is the clearer way to say it.';

comment on column public.bill_line_items.is_stock is
  'This line is shop stock - bought whole, used in pieces across jobs. Set by a person, never inferred: the one signal worth guessing from (a big quantity) is unreliable, because scanners read counts out of product names.';

-- NOT DONE HERE, ON PURPOSE, AND IT NEEDS ERIK'S WORD FIRST:
-- job cost still reads bills.amount - the WHOLE receipt - in lib/job-financials.ts, so the unused
-- $88 of that box remains on Waldow's job until the profit math is taught about this column. That
-- is a change to what every job's margin says, which is not a thing to alter inside a migration at
-- half past midnight. The column exists so the invoice can be right now, and so the profit side can
-- follow deliberately.
