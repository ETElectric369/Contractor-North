-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0302: techs see the shelf, not its prices (Shop Stock, Phase 0)
--
-- THE LEAK. inventory_items has been readable by EVERY member of the org since 0004: its read policy
-- is `org_id = auth_org_id()` with no staff check, while its write policy is staff-only. The table
-- carries unit_cost and vendor, so Brian or Jimmy could read what a roll of wire cost the company
-- by pointing their own session at /rest/v1/inventory_items. Nothing in the app shows a tech that
-- page (the dock hides it), which is exactly the kind of boundary that is really a convention:
-- a hidden link, not a refusal. The table has zero rows in every org today, so nothing has leaked
-- yet; the shelf is about to start holding real costs (0303), so this closes first.
--
-- TWO CHANGES:
--
--  1. inventory_items_read becomes staff-only, the same shape as bills, bill_line_items and
--     purchase_orders (0056's law for money tables). Tenant isolation stays inside the policy.
--
--  2. shelf_for_crew(): what a tech DOES need from the shelf, and nothing else: each active item's
--     id, name, unit and how many are on hand. No cost, no vendor, no part number, no location.
--     SECURITY DEFINER with search_path pinned; it answers only for an ACTIVE member (auth_org_id()
--     refuses a deactivated seat, 0158) and only for that member's own org. Execute is revoked from
--     anon: a customer or a stranger gets nothing.
--
-- ORDER: before any shelf code (0303). Safe to apply before or after the Phase 0 code: the Inventory
-- page is office-only on the server in the same release, and no crew screen reads the table.
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists inventory_items_read on public.inventory_items;
create policy inventory_items_read on public.inventory_items
  for select
  using (org_id = public.auth_org_id() and public.is_org_staff());

create or replace function public.shelf_for_crew()
returns table (id uuid, name text, unit text, on_hand numeric)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, i.name, i.unit, i.quantity_on_hand as on_hand
    from public.inventory_items i
   where i.org_id = public.auth_org_id()
     and public.auth_org_id() is not null
     and i.active
   order by i.name, i.id;
$$;

comment on function public.shelf_for_crew() is
  'What the crew may read from the shelf (0302): id, name, unit, on hand. Never a cost, vendor or part number. Active members of the caller''s own org only.';

revoke execute on function public.shelf_for_crew() from public, anon;
grant execute on function public.shelf_for_crew() to authenticated, service_role;

-- ── Self-check: the policy that shipped is the policy described above ──────────────────────────
do $$
declare v_qual text;
begin
  select qual into v_qual from pg_policies
   where schemaname = 'public' and tablename = 'inventory_items' and policyname = 'inventory_items_read';
  if v_qual is null or v_qual not ilike '%is_org_staff()%' or v_qual not ilike '%auth_org_id()%' then
    raise exception '0302: inventory_items_read is not staff-only after the change (%).', v_qual;
  end if;
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'inventory_items' and cmd in ('SELECT', 'ALL')
       and qual not ilike '%is_org_staff()%'
  ) then
    raise exception '0302: another policy still lets a non-staff member read inventory_items.';
  end if;
  raise notice '0302: inventory_items is staff-only to read; shelf_for_crew() carries no cost.';
end $$;
