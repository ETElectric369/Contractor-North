-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0226: a delete can no longer erase money that was received
--
-- Demonstrated against production and rolled back: acting as a normal staff user, a plain
-- `delete from invoices where id = …` through PostgREST SUCCEEDS on an invoice that has payments,
-- and `payments.invoice_id → invoices ON DELETE CASCADE` takes the payment rows with it. $150 of
-- recorded cash vanished from the books with nothing left to reconcile against.
--
-- deleteInvoice (billing/actions.ts) already refuses this, counts payments first, and even fails
-- CLOSED on a transient count error — audit 8 fixed exactly that. But it is APP-LAYER, and the
-- table is writable straight through PostgREST by anyone with a staff session. That is the
-- project's own law: a rule at one path is a convention, not a boundary. This is the boundary.
--
-- WHAT IS ACTUALLY AT RISK TODAY (counted live before writing this):
--     17  invoices carry payments
--     15  jobs have invoices that carry payments  ← job → invoices → payments, a TRIPLE cascade
--      0  jobs carry a signed contract (contracts.job_id also CASCADEs — guarded now, before it matters)
--
-- The job case is the dangerous one and nothing anywhere guards it: deleting a job is an ordinary
-- tidy-up action, and it silently takes every invoice on that job and every payment on those
-- invoices with it. There is no undo and no trace.
--
-- ── WHY A TRIGGER AND NOT `ON DELETE RESTRICT` ─────────────────────────────────────────────
--
-- RESTRICT would raise a raw foreign-key error naming a constraint, which is exactly the
-- "unexplainable error the user cannot resolve" this project treats as a dead end. A trigger says
-- what happened and what to do instead, in the same words the app uses.
--
-- Service role passes. The app never deletes these rows with the service key, so this stays a
-- deliberate out-of-band act rather than something a normal session can do by accident — and
-- keeping it possible means a real cleanup is never wedged.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.guard_money_delete()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_service boolean := false;
  v_pays    int;
  v_signed  int;
begin
  begin
    v_service := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '') = 'service_role';
  exception when others then
    v_service := false;
  end;
  if v_service then return old; end if;

  if tg_table_name = 'invoices' then
    select count(*) into v_pays from public.payments p where p.invoice_id = old.id;
    if v_pays > 0 then
      raise exception 'This invoice has % recorded payment(s) — deleting it would erase them. Void the invoice instead, or delete the payments first.', v_pays;
    end if;

  elsif tg_table_name = 'jobs' then
    -- The triple cascade: job → invoices → payments. Nothing guarded this at all.
    select count(*) into v_pays
      from public.payments p join public.invoices i on i.id = p.invoice_id
     where i.job_id = old.id;
    if v_pays > 0 then
      raise exception 'This job has % payment(s) recorded against its invoices — deleting it would erase them. Close the job instead.', v_pays;
    end if;
    select count(*) into v_signed
      from public.contracts k where k.job_id = old.id and k.status = 'signed';
    if v_signed > 0 then
      raise exception 'This job has a signed contract — deleting it would destroy an executed agreement. Close the job instead.';
    end if;
  end if;

  return old;
end $$;

drop trigger if exists guard_invoice_money_delete on public.invoices;
create trigger guard_invoice_money_delete before delete on public.invoices
  for each row execute function public.guard_money_delete();

drop trigger if exists guard_job_money_delete on public.jobs;
create trigger guard_job_money_delete before delete on public.jobs
  for each row execute function public.guard_money_delete();
