-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0356: a crew lead fills in the walk-through
--
-- Erik (2026-09-26), asked whether techs should be able to fill in walk-throughs:
--   "crew leader yes tech no".
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────────────────────
--
-- 1. NOBODY BUT THE OFFICE CAN SAVE A WALK-THROUGH. 0227 lets a tech READ the appointment he is
--    assigned to; appointments_write is still staff-only (is_org_staff). Everything the Inspector
--    saves is an UPDATE of that row: the sheet (saveInspectionAnswers: inspection_template_id and
--    inspection_answers) and the capture (saveInspectionCapture: capture, which holds the notes,
--    measurements, materials, the photo list and photo_meta). Both are requireStaff, so the person
--    standing in the crawlspace could not save a word, and Wave 0 round 1 made the Inspector
--    read-only for every tech rather than let its Save fail.
--
-- 2. THE FLAG THAT SHOULD SAY WHO MAY IS SELF-SERVICE. profiles.crew_lead (0128) is the office's
--    "this person leads a crew" switch (/team, updateMember: owner/admin only). But the database
--    lets anyone set it on their own row: profiles_update_self (0224) pins org_id, role, the two
--    pay rates, the commute baseline and active through profile_self_edit_ok, and 0141 listed
--    crew_lead among the self-service edits (it only meant "owes the evening debrief" then). So any
--    tech can PATCH /rest/v1/profiles?id=eq.<self> {"crew_lead": true} with the anon key and his own
--    session. A flag you can hand yourself is a convention, not a boundary, so before it can gate a
--    write it has to stop being yours.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────────────────────
--
-- A. guard_crew_lead (BEFORE INSERT OR UPDATE OF crew_lead ON profiles): only an owner or an admin
--    of the company (or our own server: is_privileged_writer, 0154) makes someone a crew lead or
--    stops them being one. Which rows an owner/admin may touch at all is still profiles_update_self
--    (their own company). A trigger, not a seventh pin in profile_self_edit_ok, because an admin
--    editing their OWN row takes the policy's owner/admin branch where no pin applies (0225).
--
-- B. save_walkthrough_capture(p_appointment, p_capture, p_template_id, p_answers): ONE security-
--    definer door that writes the walk-through's capture columns and nothing else: capture,
--    inspection_template_id, inspection_answers (and updated_at). It answers to:
--      · a signed-in, ACTIVE seat (auth_org_id() is null for a deactivated one, 0158),
--      · an appointment in the caller's own company,
--      · and EITHER office staff (is_org_staff) OR a crew lead (profiles.crew_lead, same company,
--        active) who is ON the appointment: assigned_to = auth.uid(), the rule 0227 reads by.
--    A crew lead's save is held to what filling in means:
--      · PRICED ANSWERS STAY THE OFFICE'S. Any key the sheet declares as a scopes question, and any
--        answer holding a price (a scope pick list is [{code, qty, price}]), is kept exactly as
--        stored whatever the payload says: he cannot add one, change one or clear one.
--      · THE SHEET: he may set it while none is stored; switching a stored sheet is the office's
--        (a switch clears every answer on the visit).
--      · PHOTOS: he adds them, each one a file HE uploaded (storage.objects.owner_id) under
--        <company>/appointments/<visit>/; every photo already on the list stays on it. Taking one
--        off is the office's, and so it STAYS off: a photo the office took off (its file is still in
--        the visit's folder) is not his to put back, whether a stale page or a direct call sends it.
--        The app sends only the photos he just took (addInspectionPhotos), never his page's list.
--      · A FILE QUESTION'S FILES (slot.type = 'file': a list of storage paths) the same way: every
--        file already on the answer stays whatever his save sends, and he adds only files he
--        uploaded himself under this visit's folder; anything else he sends for it is left out.
--    For everyone: quote_id inside capture (the write-up backlink saveQuote stamps) is never the
--    caller's to write; it is carried from the stored row. A sheet id must be one of the company's
--    walk-through sheets.
--    Called with nothing to save (p_capture and p_answers both null) it writes nothing and returns
--    the id only if the caller may fill this walk-through in: the page's probe, so the Inspector
--    never offers a Save the database would refuse.
--
--    NOT through this door, for anyone: schedule, status, assignee, the customer / lead / job
--    links, location, title, the appointment's own notes, outcome, money. The office writes those
--    exactly as before, through appointments_write, which is NOT widened: a crew lead holds no
--    UPDATE on appointments, and the only thing he can change is what this function writes.
--
-- ── STORAGE ────────────────────────────────────────────────────────────────────────────────
--
-- C. UPLOADING stays as it is: documents' docs_insert / docs_read let any active member of the
--    company write and read <company>/appointments/... (the staff-only folders are employees,
--    organize, bug-screenshots and picks: docs_path_is_staff_only). The photo lands through that,
--    as it always did for a tech; this function is what puts it on the walk-through's list.
--
--    DELETING, OVERWRITING OR MOVING a visit's file did NOT stay put, and "taking a photo off is the
--    office's" depends on it: docs_delete / docs_update (0213) let ANY active member remove, upsert
--    over or move any object under <company>/appointments/<any visit>/, so a plain tech not even on
--    the visit could empty its photos with his own session, and the list would point at dead or
--    swapped files. Now, under appointments/, only the office or the person who uploaded the file
--    deletes, overwrites or moves it. Every other folder keeps 0213's rule exactly. (No app path has
--    a non-office member delete, overwrite or move a visit's file; the storage sweep is the server.)
--
-- ── WHAT IT CHANGES TODAY (production, read 2026-09-26) ────────────────────────────────────
--
-- Two profiles carry crew_lead: ET Electric's owner and a deactivated Tahoe Deck office seat. No
-- tech is a crew lead, so nobody gains a door today; the office turns it on per person on /team.
-- That is a READ from 2026-09-26, not something this migration can take on trust: until the
-- trigger lands a tech can still hand himself the flag, and the function trusts whoever holds it.
-- So the self-check names every holder who isn't an owner or admin, as notices and as the last
-- result, for the office to confirm when the door opens.
-- No appointment holds a priced answer yet, and every stored photo path is under its own visit's
-- folder, so none of the rules above would have refused anything already written.
-- Neither function exists on production (checked), so nothing here replaces a live body.
--
-- LOCKS: CREATE TRIGGER takes SHARE ROW EXCLUSIVE on profiles for an instant, and replacing the two
--        storage policies takes ACCESS EXCLUSIVE on storage.objects for an instant (lock_timeout 3s
--        below: each waits at most that long, then fails and changes nothing). Two functions. No
--        DDL on appointments.
-- ORDER: after 0227 (appointments_select / appointments_write), 0224 (profile_self_edit_ok), 0154
--        (is_privileged_writer), 0165 (inspection_template_id / inspection_answers), 0179
--        (forms.playbook), 0213 (docs_path_is_staff_only, the documents policies). Refuses, having
--        changed nothing, if any is missing.
-- SAFE TO RE-RUN: create or replace; drop trigger / policy if exists; self-checks at the end.
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'appointments' and policyname = 'appointments_select')
     or not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'appointments' and policyname = 'appointments_write') then
    raise exception '0356: the appointments read/write split (0227) is not on this database. Apply 0227 first. Nothing was changed.';
  end if;
  if to_regprocedure('public.is_privileged_writer()') is null
     or to_regprocedure('public.auth_org_id()') is null
     or to_regprocedure('public.is_org_staff()') is null
     or to_regprocedure('public.app_user_role()') is null then
    raise exception '0356: a trust-root helper (auth_org_id, is_org_staff, app_user_role, is_privileged_writer) is missing. Nothing was changed.';
  end if;
  if to_regprocedure('public.docs_path_is_staff_only(text)') is null
     or not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'docs_update')
     or not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'docs_delete') then
    raise exception '0356: the documents bucket''s staff split (0213: docs_path_is_staff_only, docs_update, docs_delete) is not on this database. Apply 0213 first. Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'appointments' and column_name = 'inspection_answers')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'appointments' and column_name = 'inspection_template_id')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'appointments' and column_name = 'capture')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'forms' and column_name = 'playbook')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'crew_lead')
     or not exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'objects' and column_name = 'owner_id') then
    raise exception '0356: a column this needs (appointments.capture / inspection_answers / inspection_template_id, forms.playbook, profiles.crew_lead, storage.objects.owner_id) is missing. Nothing was changed.';
  end if;
end $$;

-- ── A. only the owner or an admin makes a crew lead ───────────────────────────────────────────
create or replace function public.guard_crew_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Our own server (the service key, or a direct connection with no claims): createEmployee,
  -- imports, the test fixtures. Same trust gate as the time-entry guards (0154).
  if public.is_privileged_writer() then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.crew_lead is not distinct from old.crew_lead then
    return new; -- named in the SET list (updateMember sends the whole patch) but not changed
  end if;
  if tg_op = 'INSERT' and not coalesce(new.crew_lead, false) then
    return new; -- a new sign-in's row (handle_new_user) is never a crew lead
  end if;
  -- app_user_role() is null for a deactivated seat, so a cut owner is nobody here too.
  if coalesce(public.app_user_role()::text, '') in ('owner', 'admin') then
    return new;
  end if;
  raise exception 'Only the owner or an admin can make someone a crew lead.' using errcode = '42501';
end $$;

comment on function public.guard_crew_lead() is
  'Only an owner or admin (or the server) sets or clears profiles.crew_lead (0356). crew_lead is what lets a person fill in the walk-through on a visit they are on (save_walkthrough_capture), so it cannot be self-service.';

drop trigger if exists guard_crew_lead on public.profiles;
create trigger guard_crew_lead
  before insert or update of crew_lead on public.profiles
  for each row execute function public.guard_crew_lead();

-- ── B. the walk-through's one door for the crew lead ──────────────────────────────────────────
create or replace function public.save_walkthrough_capture(
  p_appointment uuid,
  p_capture     jsonb default null,
  p_template_id uuid  default null,
  p_answers     jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_org     uuid := public.auth_org_id();          -- null for a deactivated seat (0158)
  v_staff   boolean := coalesce(public.is_org_staff(), false);
  v_lead    boolean := false;
  v_appt    public.appointments%rowtype;
  v_capture jsonb;
  v_answers jsonb;
  v_old     jsonb;
  v_stored  jsonb;                                   -- the stored photo list
  v_prefix  text;
  v_scopes  text[];
  v_keep    text[];
  v_files   text[];                                  -- the sheet's file questions
  v_k       text;
  v_had     jsonb;
  v_sent    jsonb;
  v_list    jsonb;
  v_id      uuid;
begin
  if v_uid is null or v_org is null then
    raise exception 'Sign in with an active seat to fill in the walk-through.' using errcode = '42501';
  end if;

  -- The probe reads; a save locks the row it read, so two saves can't interleave their read of
  -- quote_id / the stored photos / the stored answers with each other's write.
  if p_capture is null and p_answers is null then
    select * into v_appt from public.appointments a where a.id = p_appointment and a.org_id = v_org;
  else
    select * into v_appt from public.appointments a where a.id = p_appointment and a.org_id = v_org for update;
  end if;
  if not found then
    raise exception 'That walk-through isn''t one of this company''s.' using errcode = '42501';
  end if;

  if not v_staff then
    select coalesce(p.crew_lead, false) into v_lead
      from public.profiles p
     where p.id = v_uid and p.org_id = v_org and coalesce(p.active, true);
    if not coalesce(v_lead, false) or v_appt.assigned_to is distinct from v_uid then
      raise exception 'Only the office, or the crew lead on this visit, can fill in the walk-through.' using errcode = '42501';
    end if;
  end if;

  -- Nothing to save: the answer to "may I?" is the id.
  if p_capture is null and p_answers is null then
    return v_appt.id;
  end if;

  -- ── capture: notes, measurements, materials, photos, photo_meta ──
  if p_capture is not null then
    if jsonb_typeof(p_capture) <> 'object' then
      raise exception 'The walk-through''s notes and photos didn''t arrive in a shape that can be saved.' using errcode = '22023';
    end if;
    if octet_length(p_capture::text) > 1000000 then
      raise exception 'The walk-through''s notes are too long to save in one go.' using errcode = '22023';
    end if;
    -- The write-up backlink is saveQuote's, never the caller's (for anyone).
    v_capture := p_capture - 'quote_id';
    if jsonb_typeof(v_appt.capture) = 'object' and v_appt.capture ? 'quote_id' then
      v_capture := v_capture || jsonb_build_object('quote_id', v_appt.capture -> 'quote_id');
    end if;

    if not v_staff then
      v_stored := case when jsonb_typeof(v_appt.capture -> 'photos') = 'array' then v_appt.capture -> 'photos' else '[]'::jsonb end;
      if jsonb_typeof(coalesce(v_capture -> 'photos', '[]'::jsonb)) <> 'array' then
        raise exception 'The walk-through''s photo list didn''t arrive in a shape that can be saved.' using errcode = '22023';
      end if;
      -- Every photo already on the list stays on it.
      if exists (
        select 1 from jsonb_array_elements(v_stored) s(p)
         where not (coalesce(v_capture -> 'photos', '[]'::jsonb) @> jsonb_build_array(s.p))
      ) then
        raise exception 'Only the office can take a photo off the walk-through.' using errcode = '42501';
      end if;
      -- And every new one is this visit's own AND his: a file he uploaded himself. The prefix alone
      -- isn't enough: a photo the office took off keeps its file in the visit's folder, so a stale
      -- list (or a direct call) could otherwise put it straight back.
      v_prefix := v_org::text || '/appointments/' || v_appt.id::text || '/';
      if exists (
        select 1 from jsonb_array_elements(coalesce(v_capture -> 'photos', '[]'::jsonb)) n(p)
         where not (v_stored @> jsonb_build_array(n.p))
           and (jsonb_typeof(n.p) <> 'string'
                or left(n.p #>> '{}', length(v_prefix)) <> v_prefix
                or position('..' in (n.p #>> '{}')) > 0
                or not exists (
                  select 1 from storage.objects o
                   where o.bucket_id = 'documents' and o.name = n.p #>> '{}' and o.owner_id = v_uid::text))
      ) then
        raise exception 'A photo you put on the walk-through has to be one you took for this visit.' using errcode = '42501';
      end if;
    end if;
  end if;

  -- ── the sheet and its answers ──
  if p_answers is not null then
    if jsonb_typeof(p_answers) <> 'object' then
      raise exception 'The walk-through''s answers didn''t arrive in a shape that can be saved.' using errcode = '22023';
    end if;
    if octet_length(p_answers::text) > 1000000 then
      raise exception 'The walk-through''s answers are too long to save in one go.' using errcode = '22023';
    end if;
    if p_template_id is not null and not exists (
      select 1 from public.forms f where f.id = p_template_id and f.org_id = v_org and f.is_inspection
    ) then
      raise exception 'That sheet isn''t one of this company''s walk-through sheets.' using errcode = '42501';
    end if;
    v_answers := p_answers;

    if not v_staff then
      if v_appt.inspection_template_id is not null and p_template_id is distinct from v_appt.inspection_template_id then
        raise exception 'Only the office can switch the walk-through to a different sheet.' using errcode = '42501';
      end if;
      v_old := case when jsonb_typeof(v_appt.inspection_answers) = 'object' then v_appt.inspection_answers else '{}'::jsonb end;

      -- The sheet's scopes questions (a written playbook's needs with slot.type = 'scopes'; the key
      -- is read the way parsePlaybook reads it: trimmed, 80 characters, trimmed).
      select coalesce(array_agg(distinct btrim(left(btrim(n ->> 'key'), 80))), '{}'::text[]) into v_scopes
        from public.forms f
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(f.playbook) = 'array' then f.playbook
            when jsonb_typeof(f.playbook -> 'needs') = 'array' then f.playbook -> 'needs'
            else '[]'::jsonb
          end) n
       where f.org_id = v_org
         and f.id in (p_template_id, v_appt.inspection_template_id)
         and jsonb_typeof(n) = 'object'
         and n -> 'slot' ->> 'type' = 'scopes';

      -- Every key that is a scopes question, or holds a price on either side, keeps what is stored.
      select coalesce(array_agg(distinct kv.k), '{}'::text[]) into v_keep
        from (
          select o.k, v_old -> o.k as v from jsonb_object_keys(v_old) o(k)
          union all
          select n.k, p_answers -> n.k from jsonb_object_keys(p_answers) n(k)
        ) kv
       where kv.k = any (v_scopes)
          or case jsonb_typeof(kv.v)
               when 'object' then kv.v ? 'price'
               when 'array' then exists (
                 select 1 from jsonb_array_elements(kv.v) e where jsonb_typeof(e) = 'object' and e ? 'price')
               else false
             end;
      v_answers := (p_answers - v_keep)
        || coalesce((select jsonb_object_agg(k, v_old -> k) from unnest(v_keep) k where v_old ? k), '{}'::jsonb);

      -- A FILE QUESTION'S FILES are held like the photos: every file already on the answer stays
      -- (whatever his payload says: a stale page, a Remove, a branch his answer turned off), and he
      -- adds only files he uploaded himself under this visit's folder. Anything else he sends for
      -- that question (a file the office took off, someone else's upload) is left out, the office's
      -- answer standing, the same way a priced answer keeps what is stored.
      v_prefix := v_org::text || '/appointments/' || v_appt.id::text || '/';
      select coalesce(array_agg(distinct btrim(left(btrim(n ->> 'key'), 80))), '{}'::text[]) into v_files
        from public.forms f
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(f.playbook) = 'array' then f.playbook
            when jsonb_typeof(f.playbook -> 'needs') = 'array' then f.playbook -> 'needs'
            else '[]'::jsonb
          end) n
       where f.org_id = v_org
         and f.id in (p_template_id, v_appt.inspection_template_id)
         and jsonb_typeof(n) = 'object'
         and n -> 'slot' ->> 'type' = 'file';
      foreach v_k in array v_files loop
        continue when v_k = any (v_keep);
        v_had := case jsonb_typeof(v_old -> v_k) when 'array' then v_old -> v_k when 'string' then jsonb_build_array(v_old -> v_k) else '[]'::jsonb end;
        v_sent := case jsonb_typeof(v_answers -> v_k) when 'array' then v_answers -> v_k when 'string' then jsonb_build_array(v_answers -> v_k) else '[]'::jsonb end;
        select v_had || coalesce(jsonb_agg(x.p order by x.i), '[]'::jsonb) into v_list
          from (
            select distinct on (e.p) e.p, e.i
              from jsonb_array_elements(v_sent) with ordinality e(p, i)
             where jsonb_typeof(e.p) = 'string'
               and not (v_had @> jsonb_build_array(e.p))
               and left(e.p #>> '{}', length(v_prefix)) = v_prefix
               and position('..' in (e.p #>> '{}')) = 0
               and exists (
                 select 1 from storage.objects o
                  where o.bucket_id = 'documents' and o.name = e.p #>> '{}' and o.owner_id = v_uid::text)
             order by e.p, e.i
          ) x;
        v_answers := case when jsonb_array_length(v_list) = 0 then v_answers - v_k
                          else v_answers || jsonb_build_object(v_k, v_list) end;
      end loop;
    end if;
  end if;

  update public.appointments a
     set capture = coalesce(v_capture, a.capture),
         inspection_template_id = case when p_answers is not null then p_template_id else a.inspection_template_id end,
         inspection_answers = coalesce(v_answers, a.inspection_answers),
         updated_at = now()
   where a.id = v_appt.id
     and a.org_id = v_org
  returning a.id into v_id;
  if v_id is null then
    raise exception 'The walk-through didn''t save. Reload and try again.';
  end if;
  return v_id;
end $$;

comment on function public.save_walkthrough_capture(uuid, jsonb, uuid, jsonb) is
  'The walk-through''s capture columns (capture, inspection_template_id, inspection_answers) for the office or the crew lead ON the visit (0356). A crew lead cannot touch a priced answer, switch a stored sheet, or take a photo or a file-question file off (he adds only his own uploads). quote_id is never the caller''s. With nothing to save it only answers whether the caller may.';

revoke execute on function public.save_walkthrough_capture(uuid, jsonb, uuid, jsonb) from public, anon;
grant execute on function public.save_walkthrough_capture(uuid, jsonb, uuid, jsonb) to authenticated, service_role;

-- ── C. a visit's files: only the office or their uploader deletes, overwrites or moves them ──
-- 0213's policies word for word, plus one clause: under <company>/appointments/, the office or the
-- file's own uploader (storage.objects.owner_id). docs_update has no WITH CHECK, so the same rule
-- holds for where a move lands.
drop policy if exists docs_update on storage.objects;
create policy docs_update on storage.objects for update
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (public.auth_org_id())::text
    and (not public.docs_path_is_staff_only(name) or public.is_org_staff())
    and (coalesce((storage.foldername(name))[2], '') <> 'appointments' or public.is_org_staff() or owner_id = (auth.uid())::text)
  );

drop policy if exists docs_delete on storage.objects;
create policy docs_delete on storage.objects for delete
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (public.auth_org_id())::text
    and (not public.docs_path_is_staff_only(name) or public.is_org_staff())
    and (coalesce((storage.foldername(name))[2], '') <> 'appointments' or public.is_org_staff() or owner_id = (auth.uid())::text)
  );

-- ── Self-check ──────────────────────────────────────────────────────────────────────────────────
do $$
declare
  r record;
  n int := 0;
begin
  if not exists (
    select 1 from pg_trigger t
     where t.tgname = 'guard_crew_lead' and t.tgrelid = 'public.profiles'::regclass and not t.tgisinternal
       and t.tgfoid = 'public.guard_crew_lead()'::regprocedure
       and (t.tgtype & 2) = 2      -- BEFORE
       and (t.tgtype & 4) = 4      -- INSERT
       and (t.tgtype & 16) = 16    -- UPDATE
  ) then
    raise exception '0356: guard_crew_lead is not attached to profiles before insert and update. Nothing was changed.';
  end if;
  if not exists (
    select 1 from pg_proc
     where oid = 'public.save_walkthrough_capture(uuid, jsonb, uuid, jsonb)'::regprocedure
       and prosecdef and coalesce(proconfig::text, '') like '%search_path=public%'
  ) or has_function_privilege('anon', 'public.save_walkthrough_capture(uuid, jsonb, uuid, jsonb)', 'execute')
    or not has_function_privilege('authenticated', 'public.save_walkthrough_capture(uuid, jsonb, uuid, jsonb)', 'execute') then
    raise exception '0356: save_walkthrough_capture is not the signed-in, definer-owned door it should be. Nothing was changed.';
  end if;
  -- The appointments write policy is exactly as 0227 left it: the office only.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'appointments' and policyname = 'appointments_write'
       and qual = '((org_id = auth_org_id()) AND is_org_staff())'
       and with_check = '((org_id = auth_org_id()) AND is_org_staff())'
  ) or exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'appointments' and cmd in ('UPDATE', 'INSERT', 'DELETE')
  ) then
    raise exception '0356: the appointments write policy is not the office-only one 0227 made. Nothing was changed.';
  end if;
  -- A visit's files: delete and update (overwrite, move) are the office's or the uploader's.
  if (select count(*) from pg_policies
       where schemaname = 'storage' and tablename = 'objects' and policyname in ('docs_update', 'docs_delete')
         and qual like '%''appointments''%' and qual like '%owner_id%' and qual like '%is_org_staff()%'
         and qual like '%docs_path_is_staff_only(name)%' and qual like '%auth_org_id()%') <> 2 then
    raise exception '0356: docs_update / docs_delete do not hold a visit''s files to the office or their uploader. Nothing was changed.';
  end if;
  raise notice '0356: a crew lead on the visit fills in the walk-through through save_walkthrough_capture; only an owner or admin makes a crew lead; only the office or the uploader deletes, overwrites or moves a visit''s file.';
  -- WHO HOLDS THE FLAG AS THE DOOR OPENS. guard_crew_lead stops changes from here on; until this
  -- ran, any tech could set crew_lead on his own row, and the function trusts whatever it holds now.
  -- So every holder who isn't an owner or admin is named here (and in the result below) for the
  -- office to confirm on /team; one nobody meant to make a crew lead gets the box unticked there.
  for r in
    select o.name as company, p.full_name, p.role::text as role, p.active, p.id
      from public.profiles p join public.organizations o on o.id = p.org_id
     where p.crew_lead and coalesce(p.role::text, '') not in ('owner', 'admin')
     order by o.name, p.full_name
  loop
    n := n + 1;
    raise notice '0356: CONFIRM this crew lead on /team: % at % (role %, %, profile %)',
      coalesce(r.full_name, '(no name)'), r.company, r.role, case when r.active then 'active' else 'deactivated' end, r.id;
  end loop;
  raise notice '0356: % crew lead(s) who aren''t an owner or admin hold the flag now.', n;
end $$;

-- The same list as a result, so it is on screen whichever way this was run (the SQL editor shows the
-- last result, not the notices). Empty = nobody but an owner or admin holds crew_lead.
select o.name as company, p.full_name, p.role::text as role, p.active, p.id as profile_id
  from public.profiles p join public.organizations o on o.id = p.org_id
 where p.crew_lead and coalesce(p.role::text, '') not in ('owner', 'admin')
 order by o.name, p.full_name;
