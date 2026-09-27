-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0358: a job has one task list
--
-- Erik, 2026-09-26: tasks are "basically useless and buried". His answers, the same night:
--   · "tasks embed with the job so if multiple people are on the job a crew leader can assign them
--     verbally" — a task belongs to the JOB. Nobody is assigned a job task; whoever is on the job
--     sees the one list and checks things off. The check-off RECORDS who did it and when.
--   · A task with no job is a REMINDER, and a Reminder is PRIVATE: only the person who made it and
--     the person it is for can see it (the morning push sends each person only their own).
--   · A tech can NOT delete a task the office added, but anyone on the job CAN check it off.
--     Delete = the office, or whoever added it (the job photos' rule, jobs/actions.ts deleteDocument).
--
-- WHAT CHANGES (the tasks table stays; nothing is migrated or deleted):
--
--   1. WHO AND WHEN ARE THE SERVER'S. New column done_by. completed_at (already there) is the
--      done-at: one column for one fact, not a second one beside it. A trigger stamps both when a
--      task goes open → done, clears both when it is reopened, and pins them otherwise; a new
--      task's created_by / created_at are stamped too. The request's values are ignored, so a
--      check-off can't be put in someone else's name and a done time can't be moved. Before this,
--      toggleTask wrote status and completed_at from the browser and nothing recorded WHO (tasks/
--      actions.ts). Old done rows keep their completed_at and have no done_by ("Done 6/17", no
--      name): who did them was never recorded, and nothing here invents it.
--
--   2. PHOTOS. photo_path (the photo the task was made from) and done_photo_path (an optional
--      photo of the finished work). Storage paths in the documents bucket, and only this
--      company's: the first folder must be the task's own org id, no "..", and never a staff-only
--      folder (docs_path_is_staff_only: organize, employees, …) — a task photo is for the crew to
--      open. Reopening a task drops its done photo (the file stays on the job's Photos tab).
--
--   3. WAVES 4-5 NEED NO SECOND MIGRATION. source_key (a walk-through to-do, an estimate line, a
--      permit: at most once per job, unique), sort_order, and jobs.dismissed_task_keys (a
--      suggestion someone answered No Thanks to stays gone, the invoices' dismissed_import_keys
--      shape). Nothing reads them yet.
--
--   4. THE ROWS (RLS). tasks_read / tasks_write were both `org_id = auth_org_id()`: any member
--      could read every Reminder in the company and delete any task. Now:
--        read    — a job task: anyone in the company (the tech-job-access law: the crew sees all
--                  pertinent job info). A Reminder: its maker and the person it is for. A Reminder
--                  with neither (one legacy row) stays the office's, so it can't become a row
--                  nobody can see or clear. A Reminder's STEP follows its Reminder: the two people
--                  on the Reminder both see, check off and clear its steps, whoever added them
--                  (task_parent_is_mine), so checking the Reminder off never strands a step one of
--                  them couldn't see.
--        insert  — a job task must name a job of the caller's own company (0173: a rule at one
--                  read path is a convention, so the policy says it, not only the app). A STEP goes
--                  only under a task the caller can READ, by the read rule above (task_is_readable):
--                  a job task of the company, or a Reminder he made or is for. Never under another
--                  person's private Reminder by its raw id: task_parent_is_mine would then show his
--                  step to that Reminder's two people, and their check-off would stop to ask about it.
--        update  — the rows you can read, and the new row still names your company's job. Putting
--                  a task under another one is a move: the trigger holds it (below).
--        delete  — a job task: the office or whoever added it. A Reminder: its maker or the person
--                  it is for. (The job's FK cascade is untouched.)
--      auth_org_id() is NULL for a deactivated seat (0158), so everything fails closed for anyone
--      the office has cut.
--
-- THE TRIGGER ALSO SAYS NO IN WORDS. The policies are the boundary; the trigger runs first and
-- refuses the same cross-company job, a teammate who isn't on the team, and a photo from another
-- company's folder with a sentence a person can read instead of "violates row-level security". It
-- also holds the delete rule's side doors: only the office or whoever added a task may MOVE it —
-- off its job (a tech turning an office task into his own Reminder would clear it off the crew's
-- list), onto another job, or under another task (a step goes when its task is deleted, so an
-- office task put under a tech's own one would go with his Delete). And a step, added or moved,
-- goes only under a task the caller can read: the insert policy says it for a new step, and the
-- trigger is where a MOVE is seen (a policy has no old row), so it says it for both, in words
-- that don't tell a private Reminder from no task at all.
--
-- PRIVILEGED WRITERS (a migration, the service role, an ops repair — is_privileged_writer, 0154)
-- keep what they write for the stamps, the way 0254 treats them, and have no "can the caller read
-- it" for a step's task (there is no caller). The company checks (job, a step's task, person, photo
-- folder) hold for every writer.
--
-- LOCKS: tasks (ALTER TABLE, brief — every column is nullable or has a constant default, so no
-- rewrite) and jobs (one nullable-array column with a constant default, no rewrite). lock_timeout 3s,
-- statement_timeout 15s: a busy table fails fast and changes nothing; run it again. It checks what
-- it needs before changing anything (0154, 0158, 0213/0300's helpers), and checks what it built at
-- the end (the trigger, the four policies, the helpers and who may call them).
--
-- ORDER: after 0355. SAFE BEFORE OR AFTER THE CODE. The app reads the new columns with a fallback
-- to the old ones (lib/job-tasks readJobTasks), so the code runs on a database without this
-- migration: the list works; photos on tasks and who-checked-it-off simply wait for it, and the
-- Tasks tab says so. Code from before this build writes status/completed_at itself — the trigger
-- stamps over it, so it keeps working. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.tasks') is null or to_regclass('public.jobs') is null or to_regclass('public.profiles') is null
     or to_regprocedure('public.auth_org_id()') is null or to_regprocedure('public.is_org_staff()') is null
     or to_regprocedure('public.is_privileged_writer()') is null
     or to_regprocedure('public.docs_path_is_staff_only(text)') is null then
    raise exception '0358: tasks (0018), the trust-root helpers (0154, 0158) or docs_path_is_staff_only (0213/0300) is not on this database. Apply them first. Nothing was changed.';
  end if;
end $$;

-- ── 1. columns ────────────────────────────────────────────────────────────────────────────────
alter table public.tasks
  add column if not exists done_by uuid references public.profiles(id) on delete set null,
  add column if not exists photo_path text,
  add column if not exists done_photo_path text,
  add column if not exists source_key text,
  add column if not exists sort_order integer not null default 0;

comment on column public.tasks.done_by is
  'Who checked the task off. Stamped by the server (stamp_task_who) on open → done, cleared on '
  'reopen; the request can''t set it. completed_at is the matching done-at (0358).';
comment on column public.tasks.photo_path is
  'The photo the task was made from: a documents-bucket path in this company''s own folder, never '
  'a staff-only folder (0358).';
comment on column public.tasks.done_photo_path is
  'An optional photo of the finished work, taken at or after check-off. Cleared on reopen (0358).';
comment on column public.tasks.source_key is
  'Where a suggested task came from (a walk-through to-do, an estimate line, a permit). At most one '
  'task per key per job (tasks_job_source_key_uq). Unused until the suggestion waves (0358).';
comment on column public.tasks.sort_order is 'The job list''s order; ties fall back to created_at (0358).';

create unique index if not exists tasks_job_source_key_uq
  on public.tasks (job_id, source_key)
  where source_key is not null;

alter table public.jobs
  add column if not exists dismissed_task_keys text[] not null default '{}'::text[];
comment on column public.jobs.dismissed_task_keys is
  'Task suggestions (tasks.source_key) someone answered No Thanks to on this job, so they stay gone. '
  'Unused until the suggestion waves (0358).';

-- ── 2. is this path one of the company's files, in a folder the crew can open ──────────────────
create or replace function public.task_photo_path_ok(p_path text, p_org uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select p_org is not null
     and p_path is not null
     and split_part(p_path, '/', 1) = p_org::text
     and split_part(p_path, '/', 2) <> ''
     and p_path !~ '(^|/)\.\.(/|$)'
     and not public.docs_path_is_staff_only(p_path);
$$;

comment on function public.task_photo_path_ok(text, uuid) is
  'A task photo must be a documents-bucket path in the task''s own company folder ({org}/…), with no '
  '"..", and not in a staff-only folder the crew can''t open (0358).';

revoke execute on function public.task_photo_path_ok(text, uuid) from public, anon;

-- ── 3. the stamps and the company checks ─────────────────────────────────────────────────────────
-- SECURITY DEFINER so the company checks read the whole jobs / profiles tables, not the caller's
-- view of them (the job_has_material_list shape, 0254). Keyed on the REQUEST (auth.uid(),
-- is_privileged_writer()), never on current_user, which is the owner for every caller in here.
create or replace function public.stamp_task_who()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := coalesce(new.org_id, public.auth_org_id());
begin
  if not public.is_privileged_writer() then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
      new.created_at := now();
      if new.status = 'done' then
        new.done_by := auth.uid();
        new.completed_at := now();
      else
        new.done_by := null;
        new.completed_at := null;
        new.done_photo_path := null;
      end if;
    else
      -- Moving a task is the delete rule's business: the office, or whoever added it. Off its job
      -- (a tech would clear an office task off the crew's list by making it a Reminder), onto
      -- another job, or under another task (parent_id cascades on delete, so an office task put
      -- under a tech's own task would go when he deletes his).
      if (new.job_id is distinct from old.job_id or new.parent_id is distinct from old.parent_id)
         and not public.is_org_staff() and old.created_by is distinct from auth.uid() then
        raise exception 'Only the office or whoever added this task can move it. You can still check it off.'
          using errcode = '42501';
      end if;
      -- Who added it and when never change.
      new.created_by := old.created_by;
      new.created_at := old.created_at;
      if new.status = 'done' and old.status is distinct from 'done' then
        -- Checked off now, by the person asking.
        new.done_by := auth.uid();
        new.completed_at := now();
      elsif new.status = 'done' then
        -- Still done: who and when stay what they were.
        new.done_by := old.done_by;
        new.completed_at := old.completed_at;
      else
        -- Open (reopened, or never done): no who, no when, no done photo.
        new.done_by := null;
        new.completed_at := null;
        new.done_photo_path := null;
      end if;
    end if;
  end if;

  -- A job task names a job of this same company.
  if new.job_id is not null
     and (tg_op = 'INSERT' or new.job_id is distinct from old.job_id or new.org_id is distinct from old.org_id) then
    if not exists (select 1 from public.jobs j where j.id = new.job_id and j.org_id = v_org) then
      raise exception 'That job isn''t one of this company''s jobs, so the task wasn''t saved.'
        using errcode = '42501';
    end if;
  end if;

  -- A step, added or moved, goes under a task the caller can READ (task_is_readable: a job task of
  -- this company, or a Reminder he made or is for), never another person's private Reminder, where
  -- task_parent_is_mine would show it to that Reminder's people. The insert policy says it too; a
  -- move is only seen here (a policy has no old row). One sentence for a task he can't see and a task
  -- that isn't there, so a raw id tells him nothing. Privileged writers: the company check below.
  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id)
     and not public.is_privileged_writer() and not public.task_is_readable(new.parent_id) then
    raise exception 'Couldn''t find that task to put the step under, so the step wasn''t saved.'
      using errcode = '42501';
  end if;

  -- A subtask sits under a task of this same company.
  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id) then
    if not exists (select 1 from public.tasks p where p.id = new.parent_id and p.org_id = v_org) then
      raise exception 'That task isn''t one of this company''s, so the step wasn''t saved.'
        using errcode = '42501';
    end if;
  end if;

  -- A Reminder is for someone on this company's team.
  if new.assigned_to is not null and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to) then
    if not exists (select 1 from public.profiles p where p.id = new.assigned_to and p.org_id = v_org) then
      raise exception 'That person isn''t on this company''s team, so the reminder wasn''t saved.'
        using errcode = '42501';
    end if;
  end if;

  -- A photo is one of this company's files, in a folder the crew can open.
  if new.photo_path is not null and (tg_op = 'INSERT' or new.photo_path is distinct from old.photo_path) then
    if not public.task_photo_path_ok(new.photo_path, v_org) then
      raise exception 'That photo isn''t in this company''s job files, so it can''t go on the task.'
        using errcode = '42501';
    end if;
  end if;
  if new.done_photo_path is not null and (tg_op = 'INSERT' or new.done_photo_path is distinct from old.done_photo_path) then
    if not public.task_photo_path_ok(new.done_photo_path, v_org) then
      raise exception 'That photo isn''t in this company''s job files, so it can''t go on the task.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end $$;

comment on function public.stamp_task_who() is
  'Tasks: who added it / who checked it off / when are the server''s (created_by, created_at, '
  'done_by, completed_at — stamped, cleared on reopen, pinned otherwise; privileged writers keep '
  'what they write). Only the office or whoever added a task moves it, and a step goes only under a '
  'task the caller can read (task_is_readable). For every writer: a job task names this company''s '
  'job, a subtask this company''s task, a Reminder this company''s person, a photo this company''s '
  'folder (0358).';

revoke execute on function public.stamp_task_who() from public, anon;

-- Named to fire AFTER stamp_org_tasks (same timing fires alphabetically), so org_id is already
-- the caller's own on insert; v_org covers it anyway.
drop trigger if exists tasks_stamp_who on public.tasks;
create trigger tasks_stamp_who
  before insert or update on public.tasks
  for each row execute function public.stamp_task_who();

-- ── 3b. a Reminder's step follows its Reminder ─────────────────────────────────────────────────
-- Is this task (a step's parent) one of the caller's Reminders: made by them, made for them, or a
-- legacy one with neither that the office keeps? SECURITY DEFINER so it reads the whole table, not
-- the caller's view of it: a policy reading its own table through the caller's policies is the
-- recursion 0254's job_has_material_list note warns about.
create or replace function public.task_parent_is_mine(p uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tasks t
     where t.id = p
       and t.org_id = public.auth_org_id()
       and (
         t.created_by = auth.uid()
         or t.assigned_to = auth.uid()
         or (t.created_by is null and t.assigned_to is null and public.is_org_staff())
       )
  );
$$;

comment on function public.task_parent_is_mine(uuid) is
  'Is this task one of the caller''s Reminders (made by them, made for them, or a legacy one with '
  'neither that the office keeps)? A Reminder''s step is read, changed and cleared by the same two '
  'people as its Reminder, whoever added the step (0358).';

-- PUBLIC and anon both (0254's note: Postgres grants PUBLIC on every new function); authenticated is
-- the role the policies call it under.
revoke execute on function public.task_parent_is_mine(uuid) from public, anon;
grant execute on function public.task_parent_is_mine(uuid) to authenticated;

-- ── 3c. a step goes under a task the caller can read ──────────────────────────────────────────
-- Can the caller READ this task, by tasks_read's rule (section 4)? Its five arms, the same order:
-- a job task of his company; a Reminder he made; one made for him; a legacy one with neither, if he
-- is the office; a step of one of his Reminders. The insert policy and stamp_task_who ask it of a
-- step's parent, so a step never lands under another person's private Reminder. SECURITY DEFINER for
-- the reason above (a policy on tasks reading tasks). Change tasks_read, change this with it.
create or replace function public.task_is_readable(p uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tasks t
     where t.id = p
       and t.org_id = public.auth_org_id()
       and (
         t.job_id is not null
         or t.created_by = auth.uid()
         or t.assigned_to = auth.uid()
         or (t.created_by is null and t.assigned_to is null and public.is_org_staff())
         or (t.parent_id is not null and public.task_parent_is_mine(t.parent_id))
       )
  );
$$;

comment on function public.task_is_readable(uuid) is
  'Can the caller read this task, by tasks_read''s rule (a job task of his company, a Reminder he '
  'made or is for, a legacy one the office keeps, a step of his Reminder)? A step''s parent must be '
  'one (tasks_insert, stamp_task_who), so a step never lands under another person''s private '
  'Reminder (0358).';

revoke execute on function public.task_is_readable(uuid) from public, anon;
grant execute on function public.task_is_readable(uuid) to authenticated;

-- ── 4. the rows ───────────────────────────────────────────────────────────────────────────────
-- tasks_read's five arms are task_is_readable's (3c): change one, change the other.
drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks
  for select
  using (
    org_id = public.auth_org_id()
    and (
      job_id is not null
      or created_by = auth.uid()
      or assigned_to = auth.uid()
      or (created_by is null and assigned_to is null and public.is_org_staff())
      or (parent_id is not null and public.task_parent_is_mine(parent_id))
    )
  );

comment on policy tasks_read on public.tasks is
  'A job task: anyone in the company. A Reminder (no job): its maker and the person it is for; one '
  'with neither stays the office''s; a Reminder''s step, the same people as its Reminder (0358).';

drop policy if exists tasks_write on public.tasks;

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert
  with check (
    org_id = public.auth_org_id()
    and (
      job_id is null
      or exists (select 1 from public.jobs j where j.id = tasks.job_id and j.org_id = public.auth_org_id())
    )
    and (parent_id is null or public.task_is_readable(parent_id))
  );

comment on policy tasks_insert on public.tasks is
  'Any active member adds a task; a job task must name a job of the caller''s own company, and a '
  'step goes only under a task the caller can read — never another person''s private Reminder (0358).';

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update
  using (
    org_id = public.auth_org_id()
    and (
      job_id is not null
      or created_by = auth.uid()
      or assigned_to = auth.uid()
      or (created_by is null and assigned_to is null and public.is_org_staff())
      or (parent_id is not null and public.task_parent_is_mine(parent_id))
    )
  )
  with check (
    org_id = public.auth_org_id()
    and (
      job_id is null
      or exists (select 1 from public.jobs j where j.id = tasks.job_id and j.org_id = public.auth_org_id())
    )
    and (
      job_id is not null
      or created_by = auth.uid()
      or assigned_to = auth.uid()
      or (created_by is null and assigned_to is null and public.is_org_staff())
      or (parent_id is not null and public.task_parent_is_mine(parent_id))
    )
  );

comment on policy tasks_update on public.tasks is
  'The tasks you can read: anyone checks off a job task (the crew works the one list); a Reminder '
  'is its maker''s and its person''s. The row must still name this company''s job (0358).';

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks
  for delete
  using (
    org_id = public.auth_org_id()
    and (
      (job_id is not null and (public.is_org_staff() or created_by = auth.uid()))
      or (
        job_id is null
        and (
          created_by = auth.uid()
          or assigned_to = auth.uid()
          or (created_by is null and assigned_to is null and public.is_org_staff())
          or (parent_id is not null and public.task_parent_is_mine(parent_id))
        )
      )
    )
  );

comment on policy tasks_delete on public.tasks is
  'A job task: the office or whoever added it (a tech checks an office task off, never deletes it). '
  'A Reminder: its maker or the person it is for; a Reminder''s step, the same people as its '
  'Reminder (0358).';

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare v_check text;
begin
  if not exists (
    select 1 from pg_trigger
     where not tgisinternal and tgname = 'tasks_stamp_who' and tgrelid = 'public.tasks'::regclass and tgenabled <> 'D'
  ) then
    raise exception '0358: the tasks_stamp_who trigger is not on tasks (or is disabled).';
  end if;
  if (select array_agg(policyname::text order by policyname::text) from pg_policies where schemaname = 'public' and tablename = 'tasks')
     is distinct from array['tasks_delete', 'tasks_insert', 'tasks_read', 'tasks_update'] then
    raise exception '0358: tasks does not carry exactly tasks_read / tasks_insert / tasks_update / tasks_delete (tasks_write was company-wide and must be gone).';
  end if;
  select with_check into v_check from pg_policies where schemaname = 'public' and tablename = 'tasks' and policyname = 'tasks_insert';
  if v_check is null or v_check not ilike '%task_is_readable(parent_id)%' or v_check not ilike '%j.org_id = %auth_org_id()%' then
    raise exception '0358: tasks_insert does not hold a step to a task the caller can read, or a job task to the company''s own job.';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.task_is_readable(uuid)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.task_parent_is_mine(uuid)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.stamp_task_who()'::regprocedure) then
    raise exception '0358: task_is_readable, task_parent_is_mine or stamp_task_who is not SECURITY DEFINER.';
  end if;
  if pg_get_functiondef('public.stamp_task_who()'::regprocedure) not ilike '%task_is_readable(new.parent_id)%' then
    raise exception '0358: stamp_task_who does not hold a moved step to a task the caller can read.';
  end if;
  if has_function_privilege('anon', 'public.task_is_readable(uuid)', 'execute')
     or has_function_privilege('anon', 'public.task_parent_is_mine(uuid)', 'execute')
     or has_function_privilege('anon', 'public.stamp_task_who()', 'execute')
     or has_function_privilege('anon', 'public.task_photo_path_ok(text, uuid)', 'execute') then
    raise exception '0358: anon can call one of the task helpers.';
  end if;
  if not has_function_privilege('authenticated', 'public.task_is_readable(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.task_parent_is_mine(uuid)', 'execute') then
    raise exception '0358: a signed-in member cannot reach task_is_readable / task_parent_is_mine, which the policies call.';
  end if;
  raise notice '0358: the server stamps who and when, a Reminder and its steps are its two people''s, a job''s list is the crew''s, and a step goes only under a task its maker can read.';
end $$;
