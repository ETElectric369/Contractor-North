-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0259: leaving void is a boundary, not a convention
--
-- ORDER: after 0258 (it uses the same claim reading; nothing here depends on 0256's data).
--
-- WHY. setInvoiceStatus (billing/actions.ts unvoidConflict) refuses to bring an invoice back
-- from void while another non-void invoice holds any of the hours / bills its lines claim —
-- un-voiding would put the same work on two live invoices. That refusal is a READ in the app
-- (0173: a rule at one path is a convention). A PATCH to invoices.status through PostgREST with a
-- staff token, or a Nort verb that grows a new path, would walk straight past it. 0258 made the
-- CLAIM a boundary on invoice_items; this makes the WAY BACK a boundary on invoices: a row may
-- not leave 'void' while any of its lines' source_ids overlap a line on another non-void invoice
-- in the same org. Legacy lines (empty source_ids) are the app guard's job — nothing here can
-- see a claim that was never written, and 0256 stamps non-void invoices only.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.guard_invoice_unvoid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  holder text;
begin
  if old.status = 'void' and new.status <> 'void' then
    select coalesce(i.invoice_number, 'another invoice')
      into holder
      from public.invoice_items mine
      join public.invoice_items theirs
        on theirs.invoice_id <> mine.invoice_id
       and theirs.source_ids && mine.source_ids
      join public.invoices i on i.id = theirs.invoice_id
     where mine.invoice_id = new.id
       and i.org_id = new.org_id
       and i.status <> 'void'
       and cardinality(mine.source_ids) > 0
     order by i.created_at
     limit 1;
    if holder is not null then
      raise exception 'work already billed on %', holder
        using errcode = 'P0001',
              hint = 'This invoice cannot come back from void while ' || holder || ' bills the same hours or materials. Void that one first, or leave this one void.';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_invoice_unvoid() from public, anon;
comment on function public.guard_invoice_unvoid() is
  'BEFORE UPDATE OF status on invoices: a void invoice may not come back while another non-void invoice in the org holds any of its lines'' source_ids (0259). The app''s unvoidConflict is the same rule with a sentence; this is the boundary.';

drop trigger if exists invoices_unvoid_is_a_boundary on public.invoices;
create trigger invoices_unvoid_is_a_boundary
  before update of status on public.invoices
  for each row execute function public.guard_invoice_unvoid();
