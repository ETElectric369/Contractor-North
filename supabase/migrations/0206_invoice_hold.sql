-- 0206 — PARK A DRAFT WITHOUT DESTROYING IT (Needs-action audit, R4).
--
-- The invoice_draft feeder is right that a built-and-unsent invoice should nag: "it either goes
-- out or gets deleted, never forgotten." But the only two exits it offers both DESTROY something:
-- Void unlinks the payment milestones behind it, and Delete throws away every line item. So a
-- draft that is deliberately waiting — on a change order, on the customer's approval, on the end
-- of the month — has no honest ending, and it sits in the inbox implying work nobody owes.
--
-- hold_until is that ending: a date the office chooses, after which the draft comes BACK. It is a
-- real domain fact on the invoice, not a hidden "dismissed" flag — the inbox stays a projection
-- of reality (nothing is ever silently hidden), and the parking is visible on the invoice itself.
--
-- Deliberately a DATE, not a boolean: "park this forever" is how a real bill gets forgotten, and
-- forgetting money is the exact failure this feeder exists to prevent.

alter table public.invoices
  add column if not exists hold_until date,
  add column if not exists hold_reason text;

comment on column public.invoices.hold_until is
  'A draft deliberately parked until this date (0206) — it leaves Needs action and returns when the date passes. NULL = live. Never set on a sent invoice; parking is a drafting decision.';
