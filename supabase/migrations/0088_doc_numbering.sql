-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0088: owner-configurable document numbering
-- The number PREFIX (J-, Q-, INV-, …) was hardcoded in the per-doc triggers and
-- the per-org NEXT NUMBER lived in doc_counters behind a deny-all RLS policy
-- (doc_counters_none) — so neither was reachable from the app. This:
--   1) teaches next_doc_number() to read the prefix from
--      organizations.settings -> 'doc_prefixes' -> <doc_type>, falling back to the
--      built-in prefix the trigger passes (so untouched orgs are unchanged);
--   2) adds a staff-gated, org-scoped READER for the counters (the "next #" pre-fill);
--   3) adds a staff-gated, org-scoped SETTER for the next number.
-- Counters stay PER-ORG (the multi-tenancy invariant from 0037). Run AFTER 0004.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Prefix now comes from org settings (per doc_type), with the trigger's prefix as the
--    fallback. Counter logic is byte-for-byte unchanged from 0004.
create or replace function public.next_doc_number(p_org uuid, p_type text, p_prefix text)
returns text language plpgsql security definer set search_path = public as $$
declare n int; v_prefix text;
begin
  insert into public.doc_counters (org_id, doc_type, current)
  values (p_org, p_type, 1)
  on conflict (org_id, doc_type)
  do update set current = public.doc_counters.current + 1
  returning current into n;
  select nullif(o.settings -> 'doc_prefixes' ->> p_type, '')
    into v_prefix
    from public.organizations o
    where o.id = p_org;
  return coalesce(v_prefix, p_prefix) || lpad(n::text, 5, '0');
end $$;

-- 2) Read the caller's per-org counters → { "job": 11, "invoice": 7, … }. The UI shows
--    next = current + 1. doc_counters is deny-all under RLS, so this security-definer
--    reader is the only org-scoped way in.
create or replace function public.get_doc_counters()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_org uuid; result jsonb;
begin
  v_org := public.auth_org_id();
  if v_org is null then return '{}'::jsonb; end if;
  select coalesce(jsonb_object_agg(doc_type, current), '{}'::jsonb)
    into result
    from public.doc_counters
    where org_id = v_org;
  return result;
end $$;

-- 3) Set the NEXT number for a doc type (counter := next - 1). Staff-gated (owner/admin/
--    office) + scoped to the caller's org. The per-org unique index on the number string
--    is the backstop if a too-low value would collide with an existing document.
create or replace function public.set_doc_counter(p_type text, p_next int)
returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_role text;
begin
  v_org := public.auth_org_id();
  if v_org is null then raise exception 'No organization for the current user.'; end if;
  select role into v_role from public.profiles where id = auth.uid();
  if v_role is null or v_role not in ('owner', 'admin', 'office') then
    raise exception 'Only office staff can change document numbering.';
  end if;
  if p_next is null or p_next < 1 then raise exception 'Next number must be 1 or greater.'; end if;
  insert into public.doc_counters (org_id, doc_type, current)
  values (v_org, p_type, p_next - 1)
  on conflict (org_id, doc_type) do update set current = p_next - 1;
end $$;

grant execute on function public.get_doc_counters() to authenticated;
grant execute on function public.set_doc_counter(text, int) to authenticated;
