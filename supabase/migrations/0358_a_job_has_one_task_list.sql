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
--                  nobody can see or clear.
--        insert  — a job task must name a job of the caller's own company (0173: a rule at one
--                  read path is a convention, so the policy says it, not only the app).
--        update  — the rows you can read, and the new row still names your company's job.
--        delete  — a job task: the office or whoever added it. A Reminder: its maker or the person
--                  it is for. (The job's FK cascade is untouched.)
--      auth_org_id() is NULL for a deactivated seat (0158), so everything fails closed for anyone
--      the office has cut.
--
-- THE TRIGGER ALSO SAYS NO IN WORDS. The policies are the boundary; the trigger runs first and
-- refuses the same cross-company job, a teammate who isn't on the team, and a photo from another
-- company's folder with a sentence a person can read instead of "violates row-level security". It
-- also holds the delete rule's side door: only the office or whoever added a task may take it OFF
-- its job (a tech turning an office task into his own Reminder would clear it off the crew's list).
--
-- PRIVILEGED WRITERS (a migration, the service role, an ops repair — is_privileged_writer, 0154)
-- keep what they write for the stamps, the way 0254 treats them. The company checks (job, person,
-- photo folder) hold for every writer.
--
-- LOCKS: tasks (ALTER TABLE, brief — every column is nullable or has a constant default, so no
-- rewrite) and jobs (one nullable-array column with a constant default, no rewrite). lock_timeout 3s.
--
-- ORDER: after 0355. SAFE BEFORE OR AFTER THE CODE. The app reads the new columns with a fallback
-- to the old ones (lib/job-tasks readJobTasks), so the code runs on a database without this
-- migration: the list works; photos on tasks and who-checked-it-off simply wait for it, and the
-- Tasks tab says so. Code from before this build writes status/completed_at itself — the trigger
-- stamps over it, so it keeps working. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '60s';

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
      -- Taking a task off its job is the delete rule's business: the office, or whoever added it.
      -- (Otherwise a tech could clear an office task off the crew's list by making it a Reminder.)
      if old.job_id is not null and new.job_id is null
         and not public.is_org_staff() and old.created_by is distinct from auth.uid() then
        raise exception 'Only the office or whoever added this task can take it off the job. You can still check it off.'
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
  'what they write). For every writer: a job task names this company''s job, a subtask this '
  'company''s task, a Reminder this company''s person, a photo this company''s folder (0358).';

revoke execute on function public.stamp_task_who() from public, anon;

-- Named to fire AFTER stamp_org_tasks (same timing fires alphabetically), so org_id is already
-- the caller's own on insert; v_org covers it anyway.
drop trigger if exists tasks_stamp_who on public.tasks;
create trigger tasks_stamp_who
  before insert or update on public.tasks
  for each row execute function public.stamp_task_who();

-- ── 4. the rows ───────────────────────────────────────────────────────────────────────────────
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
    )
  );

comment on policy tasks_read on public.tasks is
  'A job task: anyone in the company. A Reminder (no job): its maker and the person it is for; one '
  'with neither stays the office''s (0358).';

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
  );

comment on policy tasks_insert on public.tasks is
  'Any active member adds a task; a job task must name a job of the caller''s own company (0358).';

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
        )
      )
    )
  );

comment on policy tasks_delete on public.tasks is
  'A job task: the office or whoever added it (a tech checks an office task off, never deletes it). '
  'A Reminder: its maker or the person it is for (0358).';
