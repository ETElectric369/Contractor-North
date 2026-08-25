-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0228: a customer who has bought from you is not a lead
--
-- Erik, opening a contact: "why is she still a lead".
--
-- Lorraine Lim: job COMPLETE, estimate ACCEPTED, invoice PAID — $8,706.18 collected — and her
-- contact page says "Inquiry". `customers.status` was set to 'lead' when the row was created and
-- nothing has ever moved it since. Three customers in ET Electric are in that state.
--
-- THE STAMP FOLLOWS THE DEED (cn-v759's law, applied to a stamp nobody had checked). The status
-- is not decoration: it is the word on the contact header, and getting it wrong tells the office
-- that somebody who paid them eight thousand dollars is a prospect.
--
-- ── WHY A TRIGGER AND NOT A FIX IN THE APP ─────────────────────────────────────────────────
--
-- A customer becomes real through several doors — accepting a quote, a job being created against
-- them, an invoice being raised, the deferred-customer conversion at the win. Putting the
-- promotion in one of those paths makes it a convention that the other doors quietly skip, which
-- is exactly how this got out of step in the first place. At the table, every door is covered
-- including ones not written yet.
--
-- ONE DIRECTION ONLY. lead → active, never the reverse. 'inactive' is a deliberate human choice
-- (an old customer archived on purpose) and nothing here may undo it; a new invoice on an
-- archived customer is not evidence they should be un-archived, it is evidence somebody is
-- billing an archived customer, and that is the office's call to make, not a trigger's.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.promote_customer_from_lead()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_customer uuid;
begin
  v_customer := new.customer_id;
  if v_customer is null then return new; end if;

  -- A quote only counts once it is ACCEPTED — a draft or a declined estimate is not a purchase,
  -- and promoting on a draft would relabel everyone you ever priced.
  if tg_table_name = 'quotes' and coalesce(new.status::text, '') <> 'accepted' then
    return new;
  end if;

  update public.customers
     set status = 'active'
   where id = v_customer
     and status = 'lead';   -- lead → active only; never touches 'inactive'

  return new;
end $$;

drop trigger if exists promote_customer_on_job on public.jobs;
create trigger promote_customer_on_job after insert on public.jobs
  for each row execute function public.promote_customer_from_lead();

drop trigger if exists promote_customer_on_invoice on public.invoices;
create trigger promote_customer_on_invoice after insert on public.invoices
  for each row execute function public.promote_customer_from_lead();

-- Quotes fire on UPDATE too: the accept usually happens long after the row was inserted, and that
-- acceptance is the moment a prospect becomes a customer.
drop trigger if exists promote_customer_on_quote on public.quotes;
create trigger promote_customer_on_quote after insert or update of status on public.quotes
  for each row execute function public.promote_customer_from_lead();

-- ── REPAIR WHAT IS ALREADY WRONG ───────────────────────────────────────────────────────────
-- Same rule, applied backwards over the existing rows. 'inactive' is untouched.
update public.customers cu
   set status = 'active'
 where cu.status = 'lead'
   and (exists (select 1 from public.jobs j where j.customer_id = cu.id)
     or exists (select 1 from public.invoices i where i.customer_id = cu.id)
     or exists (select 1 from public.quotes q where q.customer_id = cu.id and q.status::text = 'accepted'));
