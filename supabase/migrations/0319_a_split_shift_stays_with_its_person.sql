-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0319: a split shift stays with its person (audit v994 SW7)
--
-- 0288's split-link guard fires `before insert or update of split_from, split_how`, and its "a piece
-- has to come from the same person's shift" check lives inside it. A PROFILE-ONLY update never fired
-- it: the office splits Brian's Tuesday, then moves the 2-5 PM piece to Jimmy in the editor, and
-- Timecards brackets Jimmy's row with Brian's under "Split from one shift" with a combined total,
-- with no Join Back and no Move The Split (both refuse two people). Adding the column to the trigger
-- list alone does nothing: the body's early return only compared the two split columns.
--
-- So:
--   a) the trigger also fires on a profile_id change;
--   b) the early return also requires an unchanged profile_id;
--   c) a profile change on a row that is part of a split (it points at a first entry, or other rows
--      point at it) is refused in plain words: "Join the split back first, then move the shift to
--      someone else." The app says the same before it tries (updateTimeEntry).
-- A privileged writer (a migration, an ops repair) is not judged by (c), as every time guard does.
--
-- Read-only check 2026-09-24 (ET Electric, TAHOE DECK, Vivian Builders): 0 split pieces belong to a
-- different person than their first entry, so this traps nothing already stored. Production's
-- guard_time_entry_split_link body matches 0288's byte for byte (md5 669c3187...).
--
-- ORDER: after 0288. ONE TRANSACTION, AND ONLY IF THE RUNNER MAKES IT ONE (0290's note applies):
-- scripts/run-one-migration.mjs, `psql -1 -f`, or the Supabase SQL editor. Writes no data.
-- Re-runnable.

create or replace function public.guard_time_entry_split_link()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.split_from is not distinct from old.split_from
     and new.split_how is not distinct from old.split_how
     and new.profile_id is not distinct from old.profile_id then
    return new;
  end if;

  -- (c) A SPLIT SHIFT IS ONE PERSON'S. Moving one piece (or the first entry) to somebody else leaves
  -- one family across two people. Checked before the FK carve-out below: a profile change is never
  -- the FK's own ON DELETE SET NULL.
  if tg_op = 'UPDATE'
     and new.profile_id is distinct from old.profile_id
     and not public.is_privileged_writer()
     and (old.split_from is not null
          or new.split_from is not null
          or exists (select 1 from public.time_entries t where t.split_from = old.id)) then
    raise exception 'This shift was split into parts. Join the split back first, then move the shift to someone else.';
  end if;

  -- The FK's own ON DELETE SET NULL, when the first entry is joined away or deleted: always fine.
  if tg_op = 'UPDATE' and new.split_from is null and old.split_from is not null
     and new.split_how is not distinct from old.split_how
     and new.profile_id is not distinct from old.profile_id
     and not exists (select 1 from public.time_entries t where t.id = old.split_from) then
    return new;
  end if;

  if new.split_from is not null and not exists (
       select 1 from public.time_entries t
        where t.id = new.split_from
          and t.profile_id = new.profile_id
          and t.org_id = new.org_id) then
    raise exception 'A split piece has to come from the same person''s shift.';
  end if;

  -- A profile-only change on an ordinary entry (no family) is not this guard's business: 0143's pay
  -- guard decides who may reassign an entry.
  if tg_op = 'UPDATE'
     and new.split_from is not distinct from old.split_from
     and new.split_how is not distinct from old.split_how then
    return new;
  end if;

  if not public.is_org_staff() and not public.is_privileged_writer() then
    if tg_op = 'UPDATE' then
      raise exception 'Only office staff can change how a shift was split.';
    end if;
    -- A tech's only door is Switch Job, which opens the next piece as 'live'.
    if new.split_how is distinct from 'live' and (new.split_how is not null or new.split_from is not null) then
      raise exception 'Only office staff can split a shift after the fact.';
    end if;
  end if;
  return new;
end $$;

revoke execute on function public.guard_time_entry_split_link() from public, anon;

comment on function public.guard_time_entry_split_link() is
  'A piece points only at the same person''s shift in the same org; only the office rewrites the link (a tech''s own insert may only be a live Switch Job piece); and a piece of a split shift, or its first entry, is never moved to another person (join it back first). 0288, 0319.';

drop trigger if exists guard_time_entry_split_link on public.time_entries;
create trigger guard_time_entry_split_link
  before insert or update of split_from, split_how, profile_id on public.time_entries
  for each row execute function public.guard_time_entry_split_link();

-- ── THE CHECK ───────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_cols text;
begin
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.time_entries'::regclass
       and t.tgname = 'guard_time_entry_split_link'
       and t.tgfoid = to_regprocedure('public.guard_time_entry_split_link()')
       and t.tgenabled <> 'D') then
    raise exception '0319: guard_time_entry_split_link is missing or disabled. Nothing was changed.';
  end if;

  select string_agg(a.attname, ',' order by a.attname) into v_cols
    from pg_trigger t
    join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
   where t.tgrelid = 'public.time_entries'::regclass
     and t.tgname = 'guard_time_entry_split_link';
  if v_cols is distinct from 'profile_id,split_from,split_how' then
    raise exception '0319: the split-link guard fires on (%), not on profile_id, split_from, split_how. Nothing was changed.', v_cols;
  end if;

  if (select prosrc from pg_proc where oid = 'public.guard_time_entry_split_link()'::regprocedure)
       not ilike '%Join the split back first%' then
    raise exception '0319: the split-link guard does not refuse a split piece moved to another person. Nothing was changed.';
  end if;
end $$;
