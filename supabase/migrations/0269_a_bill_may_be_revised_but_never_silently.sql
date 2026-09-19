-- A BILL GETS REVISED. THAT IS THE JOB (Erik, 2026-09-18).
--
-- cn-v961 taught the row what "sent" means. It still refused to let a sent invoice be edited at
-- all, and Erik answered that directly:
--
--   "even if i did sent it ill always need to be able to go back and make changes as per a
--    client's request or my own review catches errors"
--
-- He is right, and the same night proved it twice. A client of his emailed asking for an invoice
-- to be in the property owner's name rather than the agent's, months after it was paid. And the
-- invoice that started this whole wave had his own Smartwater on it, which he only caught on
-- review. A contractor revises bills. An app that forbids it is not protecting anyone, it is
-- just making him fight it.
--
-- What the old refusal was really protecting against is narrower than it was written: a bill
-- changing without the customer ever learning it changed. So the lock comes off and the RECORD
-- goes on. `revised_at` is stamped whenever the money on a live, already-delivered invoice moves
-- — a line added, edited, removed, reordered, a tax rate changed. Compared against `sent_at`
-- (0267) it answers the one question that actually matters after an edit:
--
--     revised_at > sent_at  ->  the customer is holding an older bill than this one.
--
-- That is a sentence the invoice page can say out loud, next to the button that fixes it. Nothing
-- silent: not a refusal, not a quiet divergence either.
--
-- NULL is the normal state and means "never revised since it went out". A draft is never stamped
-- — editing a draft is just building it, which is what a draft is for. Re-sending does not clear
-- the stamp; sent_at moves forward instead, which makes the comparison true again and keeps the
-- fact that a revision happened.

alter table public.invoices
  add column if not exists revised_at timestamptz;

comment on column public.invoices.revised_at is
  'When the money on this invoice last changed AFTER it had been delivered (sent_at). Compare the two: revised_at > sent_at means the customer holds an older copy than this one. NULL = never revised since it went out. Drafts are never stamped.';

-- The "needs re-sending" question is asked per org on the billing board, and only ever about
-- rows that carry a revision at all.
create index if not exists invoices_revised_at_idx
  on public.invoices (org_id, revised_at)
  where revised_at is not null;
