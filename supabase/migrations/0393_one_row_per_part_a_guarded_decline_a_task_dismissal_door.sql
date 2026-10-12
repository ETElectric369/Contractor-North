-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0393: one row per part, a guarded Decline, and a task dismissal door
--
-- Four small things audit v1085's second verify round (2026-10-11) left for a migration:
--
--  1. ONE ROW PER PART. 0390 indexed material_list_items (list_id, source_key) but did not make it
--     unique: the customer's Accept and the office's accept in the same second each wrote the
--     estimate's parts onto the one list, and the crew bought twice. Every key is unique by
--     construction (keyParts numbers twins, a tombstone carries "gone:"), and production holds no
--     keyed rows yet (a read-only count on the day: 0 in every company), so the unique index goes on
--     clean. The 0390 twin is dropped — the unique one answers the same lookups. The app reads 23505
--     at both batch inserts as "the other door wrote them" (lib/estimate/take-off-from-quote,
--     lib/estimate/sync-job-materials) and on a visit's row as "already listed".
--
--  2. A GUARDED DECLINE. decline_public_quote (0089) flipped the status with no guard: a customer's
--     Decline that read 'sent' just before the office accepted the estimate (or a revision superseded
--     it) wrote 'declined' over it, and the job lost its price. Redefined from the LIVE 0089 body
--     (never edited; applied migrations are immutable) with 0392's guard: `and status = 'sent'` on the
--     flip, and when no row moved the row is read again and answered as it is. Grants are untouched
--     (create or replace keeps them: anon and authenticated, the public door 0182 kept open).
--
--  3. A TASK DISMISSAL DOOR. deleteTask wrote jobs.dismissed_task_keys by read-modify-write; a read
--     that failed became an empty list, and the one-entry write that followed lost every earlier
--     dismissal — the deleted tasks came back on the next sync. One SECURITY DEFINER door, the shape
--     of 0390's dismiss_material_key: this company's job, an atomic array_append guarded on the KEY
--     (an entry is "<key>" or "<key>#<title>", cn-v1084), idempotent, true when the key is dismissed.
--     Bounded to the company: a job's task may be deleted by whoever added it (0358), so the door is
--     not staff-only; a dismissal only keeps a sync from re-inserting a task.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. ONE ROW PER PART ─────────────────────────────────────────────────────────────────────────
create unique index if not exists material_items_list_source_key_uq
  on public.material_list_items (list_id, source_key)
  where source_key is not null;
drop index if exists public.material_items_list_source_key_idx;

-- ── 2. A GUARDED DECLINE (the live 0089 body + the guard) ───────────────────────────────────────
create or replace function public.decline_public_quote(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  select * into q from public.quotes where public_token = p_token;
  if q.id is null then
    return json_build_object('ok', false, 'error', 'Quote not found.');
  end if;

  -- Already declined → idempotent success.
  if q.status = 'declined' then
    return json_build_object('ok', true);
  end if;

  -- Only a SENT quote is a live offer that can be declined.
  if q.status <> 'sent' then
    return json_build_object('ok', false, 'error', 'This quote is no longer available.');
  end if;

  -- 0393: the flip is guarded on the status just read — an accept or a supersede that landed between
  -- the read and this write is not overwritten; the row is read again and answered as it is.
  update public.quotes set status = 'declined', declined_at = now() where id = q.id and status = 'sent';
  if not found then
    select * into q from public.quotes where id = q.id;
    if q.status = 'declined' then
      return json_build_object('ok', true);
    end if;
    return json_build_object('ok', false, 'error', 'This quote is no longer available.');
  end if;
  return json_build_object('ok', true);
end $$;

-- ── 3. A TASK DISMISSAL DOOR ────────────────────────────────────────────────────────────────────
create or replace function public.dismiss_task_key(p_job_id uuid, p_entry text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  k text;
begin
  -- An entry is a key and a task's title: a longer string is not one (the door is open to the company).
  if p_job_id is null or p_entry is null or btrim(p_entry) = '' or length(p_entry) > 400 then
    return false;
  end if;
  -- The KEY half ("line:<id>" / "task:<id>"): everything before the first '#'. A title may hold '#'.
  k := split_part(p_entry, '#', 1);
  if btrim(k) = '' then
    return false;
  end if;
  update public.jobs
     set dismissed_task_keys = array_append(dismissed_task_keys, p_entry)
   where id = p_job_id
     and org_id = public.auth_org_id()
     and not exists (
       select 1 from unnest(dismissed_task_keys) e
        where e = k or left(e, length(k) + 1) = k || '#'
     );
  if found then
    return true;
  end if;
  return exists (
    select 1 from public.jobs
     where id = p_job_id
       and org_id = public.auth_org_id()
       and exists (
         select 1 from unnest(dismissed_task_keys) e
          where e = k or left(e, length(k) + 1) = k || '#'
       )
  );
end;
$$;
comment on function public.dismiss_task_key(uuid, text) is
  'Mark a task key ("line:<id>" / "task:<id>", with its title after a #) as deleted by hand on this job, so '
  'the estimate sync never re-inserts it. This company''s job; atomic and idempotent; true when the key is '
  'dismissed (0393; the shape of dismiss_material_key, 0390).';
revoke execute on function public.dismiss_task_key(uuid, text) from public, anon;

-- ── 4. A RENAMED LINE'S DISMISSAL FOLLOWS, ATOMICALLY ──────────────────────────────────────────
-- A task he deleted left "line:<id>#<old title>" on the job; renaming the line in the builder and a
-- rebuild then brought the same task back under the new title. The office's rename door moves the
-- entry — in ONE statement (array_replace), so a dismissal another door appends meanwhile is never
-- written over by a stale read. True when an entry moved; false when none matched (the common case:
-- the task is there, or was never deleted). Staff only: the rename door is the office's.
create or replace function public.retitle_task_dismissal(p_job_id uuid, p_key text, p_from text, p_to text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_job_id is null or coalesce(btrim(p_key), '') = '' or p_from is null or p_to is null
     or btrim(p_to) = '' or btrim(p_from) = btrim(p_to) or length(p_key || '#' || p_to) > 400 then
    return false;
  end if;
  update public.jobs
     set dismissed_task_keys = array_replace(dismissed_task_keys, p_key || '#' || btrim(p_from), p_key || '#' || btrim(p_to))
   where id = p_job_id
     and org_id = public.auth_org_id()
     and public.is_org_staff()
     and (p_key || '#' || btrim(p_from)) = any(dismissed_task_keys);
  return found;
end;
$$;
comment on function public.retitle_task_dismissal(uuid, text, text, text) is
  'Move a task dismissal ("<key>#<old title>") to the line''s new title in one statement, so a rename in '
  'the builder keeps a deleted task gone through a rebuild (0393). Staff, this company''s job.';
revoke execute on function public.retitle_task_dismissal(uuid, text, text, text) from public, anon;

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare src text;
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'material_list_items'
       and indexname = 'material_items_list_source_key_uq' and indexdef like 'CREATE UNIQUE INDEX%'
  ) then
    raise exception '0393: material_items_list_source_key_uq is missing or not unique';
  end if;
  select pg_get_functiondef('public.decline_public_quote(text)'::regprocedure) into src;
  if position('where id = q.id and status = ''sent''' in src) = 0 then
    raise exception '0393: decline_public_quote flips the status without a guard';
  end if;
  if not exists (select 1 from pg_proc where proname = 'dismiss_task_key') then
    raise exception '0393: dismiss_task_key is missing';
  end if;
  if not exists (select 1 from pg_proc where proname = 'retitle_task_dismissal') then
    raise exception '0393: retitle_task_dismissal is missing';
  end if;
end $$;
