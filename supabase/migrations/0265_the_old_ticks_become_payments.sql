-- 0265 — THE OLD TICKS BECOME PAYMENTS
--
-- Erik, asked today whether every period he ticked "Mark Paid" on was money he actually handed over:
-- "Yes, import them." Without this the new Pay page opens on day one claiming he owes his crew
-- thousands he has already paid, and the first number he ever sees on it is wrong — which is exactly
-- the trust the page exists to earn.
--
-- WHAT IS IMPORTED. Every payroll_runs row with kind='base' becomes one pay_payments row:
--   amount  = the run's frozen gross (what the app said the period came to at the moment it locked)
--   paid_on = the period's last day (the tick recorded a lock, never a date; this is the honest guess)
--   method  = 'other', because nobody recorded how
--   note    = names the period it came from, so the row explains itself on screen
-- and every one of them is flagged needs_check, because an imported figure is a RECONSTRUCTION, not a
-- receipt. The Pay page carries a banner until Erik has looked at each one, and the note says so in
-- plain words rather than presenting the import as something he did.
--
-- kind='mileage' runs are NOT imported. Mileage keeps its own balance in MILES with its own
-- human-typed settlement (0095's two-lock rule) and is never summed into base pay. Importing it here
-- would put reimbursement dollars into a wages balance, which is the one thing that rule forbids.
--
-- IDEMPOTENT: imported_from_run carries the source run id and the insert skips any run already
-- imported, so re-running this file changes nothing.

insert into public.pay_payments (org_id, profile_id, amount, paid_on, method, note, needs_check, imported_from_run, created_by, created_at)
select r.org_id,
       r.profile_id,
       r.gross,
       r.period_end,
       'other',
       'Recorded from the old Mark Paid button — check this. It covers ' || to_char(r.period_start, 'Mon FMDD') || ' to ' || to_char(r.period_end, 'Mon FMDD, YYYY') || '.',
       true,
       r.id,
       r.created_by,
       r.created_at
  from public.payroll_runs r
 where r.kind = 'base'
   and coalesce(r.gross, 0) > 0
   and not exists (select 1 from public.pay_payments p where p.imported_from_run = r.id);

-- A LOOK AT WHAT LANDED (read by hand; this file writes nothing else):
--   select p.paid_on, pr.full_name, p.amount, p.needs_check, p.note
--     from pay_payments p join profiles pr on pr.id = p.profile_id
--    where p.imported_from_run is not null order by p.paid_on;
