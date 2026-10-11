-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0390: a part remembers its line
--
-- W3 (cn-v1075) put each task line's parts on the crew's materials list, and cn-v1079 made the
-- job's TASKS follow the estimate after birth — but a materials row remembered nothing about where
-- it came from (description, part number, quantity, unit, vendor, cost, bought, tool), so a task
-- line deleted from an accepted estimate left its parts on the buy list with nothing to connect
-- them, and a rebuilt estimate (new line ids) could only add. Two columns, no backfill owed: every
-- row on production today came from a plain line or a hand (0 task-line rows), and the sync treats a
-- row without a key as his.
--
--   material_list_items.source_key   "line:<quote_line_items.id>#<CODE or slug(name)>" for a part the
--                                    take-off wrote from an estimate's task line; "task:<id>#…" for a
--                                    visit's part (born-with-tasks); null = typed by hand, or born
--                                    before 0390. Several parts share a line, so the index is not
--                                    unique. Read by lib/estimate/sync-job-materials.
--   material_lists.dismissed_keys    parts he deleted by hand (their keys), so a later sync never
--                                    puts them back — the shape of jobs.dismissed_task_keys (0358).
--
-- Idempotent: add column if not exists, index if not exists. RLS unchanged (0254).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

alter table public.material_list_items
  add column if not exists source_key text;
comment on column public.material_list_items.source_key is
  'The estimate line and part this row was taken off from ("line:<quote_line_items.id>#<CODE|slug>"), '
  'or a visit''s task part ("task:<id>#…"); null = typed by hand or born before 0390. The materials '
  'sync (lib/estimate/sync-job-materials) keeps keyed rows in step with the accepted estimates (0390).';

create index if not exists material_items_list_source_key_idx
  on public.material_list_items (list_id, source_key)
  where source_key is not null;

alter table public.material_lists
  add column if not exists dismissed_keys text[] not null default '{}'::text[];
comment on column public.material_lists.dismissed_keys is
  'Keys (material_list_items.source_key) of parts someone deleted from this list by hand, so a later '
  'sync with the estimate never puts them back (0390; the shape of jobs.dismissed_task_keys).';

-- ── 2. A PART HE DELETED STAYS GONE — for the crew too ────────────────────────────────────────────
-- deleteMaterialItem writes the row's key to its list's dismissed_keys. 0254 lets the crew delete a
-- line on a job's list, but material_lists itself is staff-writable only (0004) — so a tech's dismissal
-- would match zero rows and the part would be born again by the next sync. One SECURITY DEFINER door,
-- bounded exactly as 0254 bounds a crew write (this company's list, on a job), atomic (no read-modify-
-- write race), idempotent (an already-dismissed key is "done"). Returns whether the key is dismissed.
create or replace function public.dismiss_material_key(p_list_id uuid, p_key text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_list_id is null or p_key is null or btrim(p_key) = '' then
    return false;
  end if;
  update public.material_lists
     set dismissed_keys = array_append(dismissed_keys, p_key)
   where id = p_list_id
     and org_id = public.auth_org_id()
     and (public.is_org_staff() or job_id is not null)
     and not (p_key = any(dismissed_keys));
  if found then
    return true;
  end if;
  return exists (
    select 1 from public.material_lists
     where id = p_list_id
       and org_id = public.auth_org_id()
       and (public.is_org_staff() or job_id is not null)
       and p_key = any(dismissed_keys)
  );
end;
$$;
comment on function public.dismiss_material_key(uuid, text) is
  'Mark a part key (material_list_items.source_key) as deleted by hand on this list, so the estimate '
  'sync never re-inserts it. Bounded as 0254 bounds a crew write: this company''s list, on a job (staff: '
  'any of the company''s lists). Atomic and idempotent; true when the key is dismissed (0390).';
revoke execute on function public.dismiss_material_key(uuid, text) from public, anon;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'material_list_items' and column_name = 'source_key'
  ) then
    raise exception '0390: material_list_items.source_key is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'material_lists' and column_name = 'dismissed_keys'
  ) then
    raise exception '0390: material_lists.dismissed_keys is missing';
  end if;
  if not exists (select 1 from pg_proc where proname = 'dismiss_material_key') then
    raise exception '0390: dismiss_material_key is missing';
  end if;
end $$;
