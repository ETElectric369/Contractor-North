-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0412: a bug report carries its picture in the row, and can wait for later
--
-- The owner, 2026-11-21, when the seven field reports of that week were first read without their
-- screenshots: "if you cant open screenshots from the bug reports then that needs to be fixed right?".
-- And, on hearing the row would keep a reduced version of it: "i thought we had the screenshot in the
-- bug report from the start only for your eyes so it seems strange to me that hasnt been working this
-- whole time and now its a provisional tiny versions of it, just sayin".
--
-- WHY. A report's screenshot is a file in the private documents bucket, and the row keeps only its
-- path (0084's screenshot_path). Opening it takes a signed link made with a key, so a person or a
-- tool reading the row itself, with nothing but a read of the table, sees a path and no picture.
--
-- And on Bug Watch, the same day: "can we have the bug reports with checked off automatically as they
-- are fixed vs me having to do it so the bug report can always stay current with the newest report
-- only to remove all clutter"; and "go for the later list we might as well build it". A report that is
-- an idea or a request nobody is building now is filed as LATER, so the Open list holds only what is
-- new or waiting on a fix. Later is not open (no count on Bug Watch's door, no line in the Monday
-- digest, no "your report was resolved" to the person who filed it) and not closed (its picture stays).
--
-- WHAT, four things, nothing else:
--
--  1. bug_reports.screenshot_copy: the same screenshot, written as a JPEG data URL, so the row alone
--     shows the picture: paste it into a browser. It is the picture, as good as the file: the phone
--     draws it at the capture's own width first and narrower only when it would not fit the cap.
--     Null is a real answer: no screenshot, a capture the phone could not fit under the cap, or one
--     the server refused. The report is never refused over it.
--  2. THE RULE, a named check: null, or a JPEG data URL (it starts with the prefix the app writes)
--     of no more than 300,000 characters, about 220 KB. The app checks the same two things first and
--     drops a copy that fails them, so this check is the floor under it, never the first answer.
--  3. THE STATUS CHECK allows 'later': bug_reports_status_check (made outside the migrations, on
--     production as "status is null or one of open, fixed, wontfix") is replaced by the same rule with
--     'later' added. It is dropped and added again only while its definition does not name 'later',
--     and a row whose status is none of the four stops the file before anything changes. The check is
--     found by that name only; so the self-check also stops the file when ANY OTHER check on the table
--     names status without 'later' (a differently named status check would leave Later dead).
--  4. platform_set_bug_status (0354), Bug Watch's one door for a status, whitelists the statuses in
--     SQL: it is replaced with 0354's body word for word, with 'later' added to that list and nothing
--     else changed (same signature, security definer, search_path, grants and revoke).
--
-- Safe to run twice: the column is added if it is not there, each check added if it is not there (or,
-- for the status, while it lacks 'later'), and the function replaced with the same text.
-- NOT TOUCHED: no row's status (which reports move to Later is a person's step), row level security
-- and its two policies, bug_reports_insert (0135) and
-- bug_reports_staff (0176). The column is read under the row's own policy: the company's staff and
-- North's own team, exactly who could already sign the file. The self-check at the end says so.
--
-- THE WRITERS AND THE READERS, named the day the column is added: src/components/bug-reporter.tsx
-- makes the copy from the screenshot it already takes; src/app/(app)/bug-report-actions.ts
-- createBugReport checks it (src/lib/bug-shot-copy.ts) and writes it; src/lib/storage-sweep.ts clears
-- it with the file, once the report is closed (fixed or won't fix: a Later report keeps it) and the
-- screenshot is more than 7 days old. No list,
-- digest, count or message reads it: Bug Watch keeps signing the stored file. The company export
-- leaves it out (src/lib/export/registry.ts, with its why): the file itself is already in the zip.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.bug_reports') is null then
    raise exception '0412: public.bug_reports is not on this database (0082). Nothing was changed.';
  end if;
  if to_regprocedure('public.platform_set_bug_status(uuid, text)') is null
     or to_regprocedure('public.is_platform_admin()') is null then
    raise exception '0412: platform_set_bug_status (0354) or is_platform_admin (0176) is missing. Nothing was changed.';
  end if;
  if exists (
    select 1 from public.bug_reports
     where status is not null and status not in ('open', 'later', 'fixed', 'wontfix')
  ) then
    raise exception '0412: a bug report has a status that is none of open, later, fixed, wontfix. Nothing was changed.';
  end if;
end $$;

-- 1. The picture, in the row.
alter table public.bug_reports
  add column if not exists screenshot_copy text;

comment on column public.bug_reports.screenshot_copy is
  'The report''s screenshot as a JPEG data URL (0412), at most 300,000 characters (about 220 KB), so the row alone shows the picture. Null: none. The file is at screenshot_path.';

-- 2. Its one rule.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.bug_reports'::regclass
       and conname = 'bug_reports_screenshot_copy_shape'
  ) then
    alter table public.bug_reports
      add constraint bug_reports_screenshot_copy_shape
      check (
        screenshot_copy is null
        or (left(screenshot_copy, 23) = 'data:image/jpeg;base64,' and char_length(screenshot_copy) <= 300000)
      );
  end if;
end $$;

-- 3. The status check allows 'later'.
do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.bug_reports'::regclass and contype = 'c'
     and conname = 'bug_reports_status_check';
  if v_def is not null and position('later' in v_def) = 0 then
    alter table public.bug_reports drop constraint bug_reports_status_check;
    v_def := null;
  end if;
  if v_def is null then
    alter table public.bug_reports
      add constraint bug_reports_status_check
      check (status is null or status in ('open', 'later', 'fixed', 'wontfix'));
  end if;
end $$;

-- 4. Bug Watch's one door for a status takes 'later' (0354's body, the list the only change).
create or replace function public.platform_set_bug_status(p_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not public.is_platform_admin() then
    raise exception 'Only North''s own team can mark a bug report.' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('open', 'later', 'fixed', 'wontfix') then
    raise exception 'That isn''t a bug report status.' using errcode = '22023';
  end if;
  update public.bug_reports set status = p_status where id = p_id;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

comment on function public.platform_set_bug_status(uuid, text) is
  'Bug Watch''s Mark Fixed / Won''t Fix / Later / Reopen for North''s own team, on ANY company''s report (0354; Later 0412). Status only; platform admins only (is_platform_admin, 0176), checked inside. Returns true when the report was there.';

revoke execute on function public.platform_set_bug_status(uuid, text) from public, anon;
grant execute on function public.platform_set_bug_status(uuid, text) to authenticated;

-- The self-check: what this file made is there, what it left is as it was.
do $$
declare
  v_def text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'bug_reports'
       and column_name = 'screenshot_copy' and data_type = 'text' and is_nullable = 'YES'
  ) then
    raise exception '0412: bug_reports.screenshot_copy is not a nullable text column. Nothing was changed.';
  end if;
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.bug_reports'::regclass and contype = 'c'
     and conname = 'bug_reports_screenshot_copy_shape';
  if v_def is null or position('data:image/jpeg;base64,' in v_def) = 0 or position('300000' in v_def) = 0 then
    raise exception '0412: the check bug_reports_screenshot_copy_shape is not "null, or a JPEG data URL of at most 300000 characters". Nothing was changed.';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.bug_reports'::regclass) then
    raise exception '0412: row level security is off on bug_reports. Nothing was changed.';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'bug_reports'
         and policyname in ('bug_reports_insert', 'bug_reports_staff')) <> 2 then
    raise exception '0412: bug_reports_insert or bug_reports_staff is missing. Nothing was changed.';
  end if;
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.bug_reports'::regclass and contype = 'c'
     and conname = 'bug_reports_status_check';
  if v_def is null or position('later' in v_def) = 0 or position('wontfix' in v_def) = 0 then
    raise exception '0412: the check bug_reports_status_check does not allow later. Nothing was changed.';
  end if;
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.bug_reports'::regclass and contype = 'c'
       and conname <> 'bug_reports_status_check'
       and position('status' in pg_get_constraintdef(oid)) > 0
       and position('later' in pg_get_constraintdef(oid)) = 0
  ) then
    raise exception '0412: another check on bug_reports names status without later. Nothing was changed.';
  end if;
  if exists (
    select 1 from public.bug_reports
     where status is not null and status not in ('open', 'later', 'fixed', 'wontfix')
  ) then
    raise exception '0412: a bug report breaks the status check. Nothing was changed.';
  end if;
  if position('later' in pg_get_functiondef('public.platform_set_bug_status(uuid, text)'::regprocedure)) = 0
     or not (select prosecdef from pg_proc where oid = 'public.platform_set_bug_status(uuid, text)'::regprocedure) then
    raise exception '0412: platform_set_bug_status is not a security definer that takes later. Nothing was changed.';
  end if;
  if has_function_privilege('anon', 'public.platform_set_bug_status(uuid, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.platform_set_bug_status(uuid, text)', 'execute') then
    raise exception '0412: platform_set_bug_status is open to anon or closed to authenticated. Nothing was changed.';
  end if;
end $$;
