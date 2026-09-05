-- 0245 — PROMOTE STAYS IN ITS OWN ORG (audit v921, migration finding).
--
-- promote_customer_from_lead (0228) is a SECURITY DEFINER trigger on quotes/inquiries that flips
-- the referenced customer from 'lead' to 'active' when work is won. It matched only on customer_id:
--
--   update public.customers set status='active' where id = new.customer_id and status='lead';
--
-- Because it runs SECURITY DEFINER it bypasses RLS, and customer_id is a column the writer supplies.
-- A quote inserted in org A carrying org B's lead customer_id would flip B's customer to active —
-- a cross-tenant write (tenant-isolation law: a definer that trusts an argument must scope it).
-- Add the org guard: the customer and the winning row must be the SAME org.

create or replace function public.promote_customer_from_lead()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_customer uuid;
begin
  v_customer := new.customer_id;
  if v_customer is null then return new; end if;

  -- A quote only counts once ACCEPTED — a draft/declined estimate is not a purchase.
  if tg_table_name = 'quotes' and coalesce(new.status::text, '') <> 'accepted' then
    return new;
  end if;

  update public.customers
     set status = 'active'
   where id = v_customer
     and status = 'lead'          -- lead -> active only; never touches 'inactive'
     and org_id = new.org_id;     -- 0245: never reach across orgs (audit v921)

  return new;
end $function$;

-- NOTE: no grant/RLS change — same trigger, tighter WHERE.
