-- 0262 — DELETING A JOB IS NOT MOVING ITS HOURS
--
-- Found by testing 0261 against production the night it shipped, before anyone hit it.
--
-- 0261 stopped a claimed allocation being MOVED to another job, because re-pointing a row an
-- invoice bills makes the invoice say something untrue. It judged a move as "job_id changed",
-- and that caught one write nobody intended: `time_allocations.job_id` is ON DELETE **SET NULL**,
-- so deleting a job asks the database to null that column on every allocation the job carried.
-- On a claimed row 0261 read that as a move and refused, and the whole job delete failed with
--
--     INV-068 already bills these hours
--     Void or adjust INV-068 before moving them to another job.
--
-- which is wrong twice: nobody is moving anything, and there is no other job. A staff member
-- deleting a finished job got a refusal naming an invoice, with an instruction that does not
-- apply to what they did — a dead end, in the exact place 0261 was supposed to add safety.
--
-- AND THE REFUSAL WAS NOT EARNED. The point of 0261 is that hours an invoice bills must not
-- VANISH. A SET NULL deletes nothing: the allocation row survives with its hours, its entry and
-- its id, so the invoice's claim still points at a real row and the same hours still cannot be
-- billed twice. Losing the job link costs the row its job, not its existence — and the job it
-- pointed at is being deleted anyway. There is nothing here to protect.
--
-- So: moving a claimed row to ANOTHER job stays refused, which is the case that lies. Nulling
-- the job — which only the delete cascade does — is allowed through. Money is unaffected either
-- way; deleting a job that carries real money is refused a layer above by guard_money_delete
-- ("This job has 1 payment(s) recorded against its invoices"), which is the sentence a person
-- deleting a paid job should read, and it still fires first.
--
-- The verb is fixed too, so no refusal from this guard can describe an act nobody performed.

create or replace function public.guard_billed_time_allocation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_holder text;
  v_verb   text;
begin
  if tg_op = 'UPDATE' then
    -- Only a MOVE is judged. Hours, code, description and sort order stay the office's to correct
    -- on a billed shift (0261's header), and so does losing the job link: `new.job_id is null` is
    -- the delete cascade's own write (jobs.id ON DELETE SET NULL), which takes nothing away from
    -- the invoice because the row and its hours remain.
    if new.time_entry_id is not distinct from old.time_entry_id
       and (new.job_id is not distinct from old.job_id or new.job_id is null) then
      return new;
    end if;
    v_verb := case when new.time_entry_id is distinct from old.time_entry_id
                   then 'moving them to another shift'
                   else 'moving them to another job' end;
  else
    v_verb := 'removing them from the split';
  end if;

  v_holder := public.invoice_holding_claim(array[old.id], old.org_id);
  if v_holder is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  raise exception '% already bills these hours', v_holder
    using errcode = 'P0001',
          hint = 'Void or adjust ' || v_holder || ' before ' || v_verb || '. Nothing was changed.';
end $$;

comment on function public.guard_billed_time_allocation() is
  'BEFORE DELETE OR UPDATE OF time_entry_id, job_id on time_allocations (0261, corrected 0262): a row a non-void invoice claims may not be deleted, nor moved to another shift or another job. Hours stay editable (the C7 trim), and job_id -> NULL is allowed because that is the job-delete cascade, which removes no hours. Raises "INV-0xx already bills these hours".';

-- PROVE IT (run by hand; every branch rolls back):
--   do $$ declare a uuid; j uuid; m1 text := 'ALLOWED'; m2 text := 'ALLOWED'; begin
--     select ta.id into a from time_allocations ta where ta.job_id is not null
--       and exists (select 1 from invoice_items it join invoices i on i.id = it.invoice_id
--                    where it.source_ids && array[ta.id] and i.status <> 'void') limit 1;
--     -- (1) the cascade's write is allowed through
--     begin update time_allocations set job_id = null where id = a;
--     exception when others then get stacked diagnostics m1 = message_text; end;
--     -- (2) a real move to another job is still refused
--     select id into j from jobs where id <> (select job_id from time_allocations where id = a) limit 1;
--     begin update time_allocations set job_id = j where id = a;
--     exception when others then get stacked diagnostics m2 = message_text; end;
--     raise exception 'null: % || move: %', m1, m2;   -- expect: null: ALLOWED || move: INV-0xx already bills these hours
--   end $$;
