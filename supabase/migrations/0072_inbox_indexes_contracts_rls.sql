-- The "Needs action" inbox now surfaces money/legal items, and its badge count derives
-- from the same projection (so it runs the inbox queries on every page). Index the new
-- hot filters, and lock contract reads to staff — contracts carry pricing/scope, the
-- same reason financial tables were staff-read-locked in 0056.

-- Index the overdue-invoice and unsigned-contract inbox queries (partial = small/cheap).
create index if not exists invoices_overdue_idx
  on public.invoices(org_id, due_date)
  where status in ('sent', 'partial', 'overdue');

create index if not exists contracts_sent_idx
  on public.contracts(org_id)
  where status = 'sent';

-- Contracts are staff-only to READ. Their only in-app surface is the job's Invoices tab,
-- which is already staff-gated; the public signing page reads via the public_contract
-- SECURITY DEFINER RPC (bypasses RLS), so customer signing is unaffected.
drop policy if exists contracts_read on public.contracts;
create policy contracts_read on public.contracts
  for select using (org_id = public.auth_org_id() and public.is_org_staff());
