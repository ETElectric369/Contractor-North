-- 0263 — A NULL JOB MUST MEAN THE JOB IS GONE
--
-- 0262 let `job_id -> NULL` through the billed-hours guard so that deleting a job, which asks
-- Postgres to null that column on every allocation the job carried (jobs.id ON DELETE SET NULL),
-- would stop failing with a refusal about "moving them to another job". That was right about the
-- cascade and too generous about everything else: a BEFORE trigger cannot see WHO asked, so the
-- exemption also covered a writer sending `job_id: null` directly.
--
-- RLS on time_allocations lets the shift's own tech write his own rows, so the exemption handed
-- any crew member a way to quietly cut a billed allocation loose from its job through a plain
-- PostgREST call. Nothing is double-billed by that — the row and its hours survive, which is why
-- this is not the emergency 0261 was — but the invoice still names a job the hours no longer
-- point at, and the job's own unbilled picture changes with nothing recorded and nobody told.
--
-- The cascade is distinguishable after all, and cheaply: when the FK fires, the job row is
-- ALREADY GONE. A BEFORE trigger on the child runs inside the delete's own transaction, after the
-- parent row has been removed, so `not exists (select 1 from jobs where id = old.job_id)` is true
-- for the cascade and false for every ordinary write. That is the whole fix.

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
    -- Unchanged job and shift: an ordinary edit (hours, code, description, order). Always fine.
    if new.time_entry_id is not distinct from old.time_entry_id
       and new.job_id is not distinct from old.job_id then
      return new;
    end if;

    -- THE CASCADE, AND ONLY THE CASCADE (0263). job_id going to NULL is allowed when the job it
    -- pointed at no longer exists — which is true inside a job delete and false for a client
    -- that simply sent null. The row keeps its hours either way, so the claim stays honest.
    if new.time_entry_id is not distinct from old.time_entry_id
       and new.job_id is null
       and old.job_id is not null
       and not exists (select 1 from public.jobs j where j.id = old.job_id) then
      return new;
    end if;

    v_verb := case
      when new.time_entry_id is distinct from old.time_entry_id then 'moving them to another shift'
      when new.job_id is null then 'taking them off the job'
      else 'moving them to another job'
    end;
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
  'BEFORE DELETE OR UPDATE OF time_entry_id, job_id on time_allocations (0261, corrected 0262/0263): a row a non-void invoice claims may not be deleted, moved to another shift, moved to another job, or taken off its job — EXCEPT when the job itself has just been deleted, which the guard proves by finding no such job row. Hours stay editable (the C7 trim). Raises "INV-0xx already bills these hours".';

-- PROVE IT (by hand; each branch rolls back):
--   (1) a client nulling a claimed row's job is refused:
--       update time_allocations set job_id = null where id = '<claimed id>';   -- expect P0001
--   (2) deleting the job still works (the cascade's own null passes):
--       delete from jobs where id = '<that row''s job, no payments>';          -- expect success
--   (3) a real move is still refused:
--       update time_allocations set job_id = '<other job>' where id = '<claimed id>';  -- expect P0001
