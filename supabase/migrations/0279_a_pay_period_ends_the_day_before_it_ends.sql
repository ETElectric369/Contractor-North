-- THREE THINGS WRONG WITH THE SAME TWO LEDGER ROWS (audit of cn-v951..v966, 2026-09-20).
--
-- 0265 turned Erik's old "Mark Paid" ticks into real payments. `payroll_runs.period_end` is
-- EXCLUSIVE everywhere else in the app - markPeriodPaid's own signature says so, and periodLabel()
-- subtracts a day before it ever prints one - and 0265 used it raw. So both imported rows carry a
-- paid_on one day after the period they cover, and a sentence that names a day the period does not
-- include:
--
--   Brian, $1,360.00  paid_on 2026-06-22  "It covers Jun 8 to Jun 22, 2026."   period is Jun 8..21
--   Brian, $1,300.00  paid_on 2026-07-06  "It covers Jun 22 to Jul 6, 2026."   period is Jun 22..Jul 5
--
-- The date matters beyond tidiness: a payment dated on the boundary sits on the first day of the
-- NEXT period, so the money reads as belonging to a fortnight it was not for.
--
-- No balance moves. sumPayments is all-time and windows nothing, so the figures Erik sees for what
-- he owes Brian are identical before and after; what changes is which fortnight the payment reads
-- as belonging to, and whether its own sentence is true.
--
-- AND THE INSTRUCTION THAT OUTLIVED THE DEED. The note says "check this", and he has checked both
-- of them - needs_check is already false on both rows. The note is the only part of the row still
-- on screen once the needs-check banner is gone, so it is the part that has to stay true. It keeps
-- its provenance and loses its order. (The app half of this lives in confirmImportedPayment, so a
-- row checked off from now on rewrites its own note in the same statement that drops the flag.)
--
-- The em-dashes go too: this is user-facing copy that happens to live in a database column.
update public.pay_payments p
   set paid_on = r.period_end - 1,
       note = 'Recorded from the old Mark Paid button'
              || case when p.needs_check then ', and still needs checking' else '' end
              || '. It covers ' || to_char(r.period_start, 'Mon FMDD')
              || ' to ' || to_char(r.period_end - 1, 'Mon FMDD, YYYY') || '.'
  from public.payroll_runs r
 where r.id = p.imported_from_run
   and p.paid_on = r.period_end;

-- Any imported row somebody has already checked off, whose note still carries the instruction.
-- Separate from the statement above because a replay of 0265 on a new org would land here too.
update public.pay_payments
   set note = replace(replace(note, ' — check this.', '.'), ' - check this.', '.')
 where imported_from_run is not null
   and needs_check = false
   and note like '%check this.%';
