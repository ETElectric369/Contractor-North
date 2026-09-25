-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0326: the customer sees the plans and drawings, and only the latest
--
-- Erik, 2026-09-24: "ill have a new circuit map to update the one made from the plan scans that
-- should post on the portal too", "Lidar scans and renderingings will go there too when we build
-- that" and "so inspector/plans/tools/all data integrates".
--
-- 0300 gave the office one way to put a job file on the customer's page: a job_shared_photos row
-- per Photo. This GENERALIZES that model instead of inventing a second one next to it. The same
-- row, the same stamp (the file the office looked at, its stored version, who and when), the same
-- office-only policies, now for any job paper a customer may see: a photo, a plan, a permit, a
-- circuit map, a drawing, a rendering, a 3D scan, or another job paper.
--
-- WHAT CHANGES:
--
--  1. job_shared_photos is renamed job_shared_documents and gains:
--       kind                   how the portal presents it: photo | plan | permit | circuit_map |
--                              drawing | rendering | scan_3d | document. THE TYPE SEAM for LiDAR
--                              scans and 3D renderings: the portal knows each kind by name, and a
--                              file it cannot draw inline (a .glb, an .e57) gets a plain link.
--       title                  the words the customer reads, stamped from the document's name at
--                              share time (a crew member can rename documents; the customer keeps
--                              the title the office saw) and editable by the office.
--       replaces_document_id   "this newer file replaces that older one": the customer sees only
--                              the newest of a chain. The older row stays, with who marked it and
--                              when (replaces_marked_by / _at), as the office's history.
--       removed_at/removed_by  taking a paper off the page is a soft remove, so the history of what
--                              the customer was shown survives it and Undo puts it back.
--     A view named job_shared_photos keeps the old name working (security_invoker: the caller's
--     RLS applies) so an app build from before this migration keeps its Photos switch and its
--     Customer Page tab while the new build deploys.
--
--  2. THE CUSTOMER BOUNDARY, in the database and not only in the app (customer boundary law):
--     receipts, bills and supplier invoices can NEVER be shown. A share is allowed only for a
--     document whose category is on an ALLOW-list (Photo, Plan, Permit, Other: the job papers a
--     tech may see too, audit v994's tech-documents list minus Note, which has no file), and never for a
--     document that is money paper by what it is tied to (an Organize row that wrote or matched a
--     bill, a supplier invoice or petty cash, or that Organize read as a receipt, bill or invoice;
--     a supplier invoice's source file), whatever its category says now. Refused out loud at the
--     share, and checked again on every portal read (a paper re-filed as a Receipt after it was
--     shown drops off the page).
--
--  3. portal_job_view reads both the photos and the new 'documents' block through ONE rule,
--     job_share_shows(): the share is live, not replaced by a live newer one, the document is on
--     this job in this org, allowed, not money paper, still the file the office shared (same path,
--     same stored version), in the job's own folder. Rewritten FROM ITS LIVE DEFINITION by
--     replacing the exact 'photos' block (the 0315 technique): whatever else landed in the function
--     since 0301 is kept, and the rewrite refuses unless that block appears exactly once.
--
-- LIVE BODIES THIS STARTS FROM (pg_get_functiondef in production, 2026-09-24, after 0322):
--   job_shared_photos_stamp()   0300's body, unchanged since; job_shared_documents_stamp() below
--                               is it, generalized.
--   portal_job_view(text,uuid)  0301 + 0315 (customer_line_words on the lines' description);
--                               rewritten in place, not retyped.
--
-- WHO: the office only, for every verb (RLS, plus the trigger for the service role's writes). A
-- tech cannot share, replace, retitle or take down anything; the crew never reads these rows.
-- Nor through the documents underneath (section 3b, from the review): while a paper is up, nobody
-- deletes the version the customer sees (the office takes it off first, out loud, with Undo), the
-- crew can't delete an earlier version or move, re-file or re-point a shown paper, and putting a
-- paper back refuses one that moved to another job or had its file changed while it was down.
--
-- SELF-CHECK: every portal job page that opens today is read before and after. The only change
-- allowed is the new 'documents' key (empty today: production has no share rows). Plus the grants.
--
-- INTEGRATION (feat/portal-wave): 0323 (feat/portal-split) wrote job_shared_photo_state() over
-- job_shared_photos. Renamed here, that name becomes the compatibility view: every live row of
-- every kind, so a shown plan would read as a photo that "changed" and the office's Photos tab
-- would say so. Section 5b rebuilds it from 0323's body (the file, applied in the same practice
-- transaction; not live in production when this was written) to read job_shared_documents,
-- photos only, live rows only, with the money-paper rule the portal now applies. A photo a newer
-- paper REPLACES still reads as shown there: it did not change, and the Photos switch already says
-- which paper stands in for it. Section 0 therefore refuses unless 0323 is applied first.
--
-- ORDER: after 0300, 0301 and 0315 (all applied), and after 0323. Deploy-safe either way: the old app build keeps
-- working through the job_shared_photos view, and the new build reads the portal's documents block
-- only when it is there (no section until then) and says "not ready" on the office's controls.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. the ground this stands on ───────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.job_shared_photos') is null and to_regclass('public.job_shared_documents') is null then
    raise exception '0326: job_shared_photos (0300) is not on this database. Apply 0300 and 0301 first. Nothing was changed.';
  end if;
  if to_regprocedure('public.portal_job_view(text, uuid)') is null then
    raise exception '0326: portal_job_view (0301) is not on this database. Apply 0301 first. Nothing was changed.';
  end if;
  -- 0323 first: applied after this file, 0323 would put job_shared_photo_state back on the view.
  if to_regprocedure('public.job_shared_photo_state(uuid)') is null then
    raise exception '0326: job_shared_photo_state (0323) is not on this database. Apply 0323 first. Nothing was changed.';
  end if;
end $$;

-- Every portal job page as it reads TODAY, for the self-check at the end.
create temp table _0326_before as
select a.token, jb.id as job_id, public.portal_job_view(a.token, jb.id)::jsonb as j
  from public.customer_portal_access a
  join public.jobs jb on jb.customer_id = a.customer_id and jb.org_id = a.org_id
 where a.enabled;

-- ── 1. the share row, renamed and widened ──────────────────────────────────────────────────────
do $$
begin
  -- Only the TABLE is renamed (ALTER TABLE would rename the compatibility view on a re-run).
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'job_shared_photos' and c.relkind = 'r') then
    alter table public.job_shared_photos rename to job_shared_documents;
    alter table public.job_shared_documents rename constraint job_shared_photos_pkey to job_shared_documents_pkey;
    alter table public.job_shared_documents rename constraint job_shared_photos_document_id_fkey to job_shared_documents_document_id_fkey;
    alter table public.job_shared_documents rename constraint job_shared_photos_job_id_fkey to job_shared_documents_job_id_fkey;
    alter table public.job_shared_documents rename constraint job_shared_photos_org_id_fkey to job_shared_documents_org_id_fkey;
    alter table public.job_shared_documents rename constraint job_shared_photos_shared_by_fkey to job_shared_documents_shared_by_fkey;
    alter index public.job_shared_photos_job_idx rename to job_shared_documents_job_idx;
    alter policy job_shared_photos_staff_read on public.job_shared_documents rename to job_shared_documents_staff_read;
    alter policy job_shared_photos_staff_insert on public.job_shared_documents rename to job_shared_documents_staff_insert;
    alter policy job_shared_photos_staff_delete on public.job_shared_documents rename to job_shared_documents_staff_delete;
  end if;
end $$;

alter table public.job_shared_documents
  -- Every row that exists is a photo (0300 shared nothing else). The default is for that backfill
  -- only; it is dropped below so the stamp decides a new row's kind from its document.
  add column if not exists kind text not null default 'photo',
  add column if not exists title text,
  add column if not exists replaces_document_id uuid references public.documents(id) on delete set null,
  add column if not exists replaces_marked_by uuid references public.profiles(id) on delete set null,
  add column if not exists replaces_marked_at timestamptz,
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by uuid references public.profiles(id) on delete set null;
alter table public.job_shared_documents alter column kind drop default;

-- The title every existing row would have been stamped with.
update public.job_shared_documents s
   set title = left(coalesce(nullif(btrim(regexp_replace(d.name, '\.[A-Za-z0-9]{1,5}$', '')), ''), 'Photo'), 120)
  from public.documents d
 where d.id = s.document_id and s.title is null;
alter table public.job_shared_documents alter column title set not null;

alter table public.job_shared_documents drop constraint if exists job_shared_documents_kind_known;
alter table public.job_shared_documents add constraint job_shared_documents_kind_known
  check (kind in ('photo', 'plan', 'permit', 'circuit_map', 'drawing', 'rendering', 'scan_3d', 'document'));
alter table public.job_shared_documents drop constraint if exists job_shared_documents_title_words;
alter table public.job_shared_documents add constraint job_shared_documents_title_words
  check (length(btrim(title)) between 1 and 120);
alter table public.job_shared_documents drop constraint if exists job_shared_documents_not_itself;
alter table public.job_shared_documents add constraint job_shared_documents_not_itself
  check (replaces_document_id is null or replaces_document_id <> document_id);

-- One live newer version per paper (the stamp says it in words first; this is the backstop).
create unique index if not exists job_shared_documents_one_live_replacer
  on public.job_shared_documents (replaces_document_id)
  where removed_at is null and replaces_document_id is not null;

comment on table public.job_shared_documents is
  'One row per job paper the office chose to show the customer (0300 as job_shared_photos; 0326 any paper): kind, title, the file and its stored version at share, the version it replaces, and a soft remove. The portal selects by this row through job_share_shows(); never by listing a folder. Office staff only.';
comment on column public.job_shared_documents.kind is
  'How the portal presents it (0326). New kinds (LiDAR scans, 3D renderings) are shown by name; a file the portal cannot draw inline gets a plain link.';
comment on column public.job_shared_documents.replaces_document_id is
  'The older paper this one replaces (0326). The customer sees only the newest live paper of a chain; the older rows stay as the office''s history.';

-- ── 2. what a customer may be shown, one rule each ──────────────────────────────────────────────
-- The categories that can reach a customer: an ALLOW-list. Receipt, Bill and Invoice are not on it,
-- and neither is a category nobody set or one added later, until someone decides.
create or replace function public.document_category_is_showable(p_category text)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(p_category in ('Photo', 'Plan', 'Permit', 'Other'), false)
$$;
comment on function public.document_category_is_showable(text) is
  'The document categories a customer may be shown (0326): Photo, Plan, Permit, Other. Twin of PORTAL_SHOWABLE_CATEGORIES in src/lib/portal/share-input.ts.';

-- Money paper by what it is TIED to, whatever its category says now: an Organize row that wrote or
-- matched a bill, a supplier invoice or petty cash, or that Organize read as money paper; or the
-- source file of a supplier invoice. Definer-only (it reads other people's books by id).
create or replace function public.document_is_money_paper(p_document_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
      select 1 from public.organized_items oi
       where oi.document_id = p_document_id
         and (oi.bill_id is not null or oi.tied_bill_id is not null or oi.tied_supplier_invoice_id is not null
              or oi.petty_cash_id is not null
              or oi.category in ('Receipt', 'Bill', 'Invoice', 'Materials', 'Fuel', 'Tools & Supplies', 'Petty cash')))
      or exists (
      select 1 from public.documents d
        join public.supplier_invoices si on si.org_id = d.org_id and si.source_file = d.file_url
       where d.id = p_document_id and d.file_url is not null)
$$;
revoke execute on function public.document_is_money_paper(uuid) from public, anon, authenticated;
grant execute on function public.document_is_money_paper(uuid) to service_role;

-- ── 3. the stamp: the row describes the document it names, whatever the request said ────────────
-- Generalized from the LIVE job_shared_photos_stamp() (0300). Insert, and every update.
create or replace function public.job_shared_documents_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  d public.documents%rowtype;
  v_restamp boolean;
  v_hop uuid;
  v_hops int := 0;
  v_other text;
  v_old_title text;
  v_row public.job_shared_documents%rowtype;
begin
  if tg_op = 'UPDATE' then
    -- A paper or a person this row names was deleted (ON DELETE SET NULL, run as the table owner,
    -- past RLS): let exactly those links go and change nothing else. Whoever deleted them decided
    -- nothing about this row, so none of the office-only rules below apply to it, and nothing else
    -- in the row may ride along.
    if (new.replaces_document_id is null and old.replaces_document_id is not null
          and not exists (select 1 from public.documents x where x.id = old.replaces_document_id))
       or (new.shared_by is null and old.shared_by is not null
          and not exists (select 1 from public.profiles p where p.id = old.shared_by))
       or (new.removed_by is null and old.removed_by is not null
          and not exists (select 1 from public.profiles p where p.id = old.removed_by))
       or (new.replaces_marked_by is null and old.replaces_marked_by is not null
          and not exists (select 1 from public.profiles p where p.id = old.replaces_marked_by)) then
      v_row := old;
      if new.replaces_document_id is null and not exists (select 1 from public.documents x where x.id = old.replaces_document_id) then
        v_row.replaces_document_id := null;
      end if;
      if new.shared_by is null and not exists (select 1 from public.profiles p where p.id = old.shared_by) then
        v_row.shared_by := null;
      end if;
      if new.removed_by is null and not exists (select 1 from public.profiles p where p.id = old.removed_by) then
        v_row.removed_by := null;
      end if;
      if new.replaces_marked_by is null and not exists (select 1 from public.profiles p where p.id = old.replaces_marked_by) then
        v_row.replaces_marked_by := null;
      end if;
      return v_row;
    end if;

    -- What a share row IS never changes after it is written: which paper, on which job, which file.
    if new.document_id is distinct from old.document_id then
      raise exception 'A shared paper stays the paper it is. Take it off the page and show the other one.' using errcode = '42501';
    end if;
    new.org_id := old.org_id;
    new.job_id := old.job_id;
    new.file_url_at_share := old.file_url_at_share;
    new.object_version_at_share := old.object_version_at_share;
    new.shared_by := old.shared_by;
    new.shared_at := old.shared_at;
    new.removed_by := old.removed_by;
    new.replaces_marked_by := old.replaces_marked_by;
    new.replaces_marked_at := old.replaces_marked_at;
  end if;

  -- Only the office decides what the customer sees (the policies say so for a signed-in member;
  -- this says it for every writer RLS does not see but a session with a user).
  if not public.is_privileged_writer() and not public.is_org_staff() then
    raise exception 'Only the office decides what the customer sees.' using errcode = '42501';
  end if;

  -- Stamp the file on a new share and when a taken-down share goes back up: the office is looking
  -- at the document as it is NOW.
  v_restamp := tg_op = 'INSERT' or (old.removed_at is not null and new.removed_at is null);

  select * into d from public.documents where id = new.document_id;
  if not found then
    raise exception 'That paper is not on file.' using errcode = 'P0002';
  end if;

  if v_restamp then
    -- Back up after a take-down: the row puts back THIS job's paper as the office last saw it, never
    -- whatever the documents row has been pointed at since (review of 0326: a crew member may
    -- update documents while the row is down, and Undo must not move the paper to another job's,
    -- or another customer's, page, nor publish a different file).
    if tg_op = 'UPDATE' and (d.org_id is distinct from old.org_id or d.job_id is distinct from old.job_id) then
      raise exception 'This paper has moved to another job since it was on this job''s page, so it can''t go back up here.'
        using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' and d.file_url is distinct from old.file_url_at_share then
      raise exception 'This paper''s file was changed after it came off the customer''s page. Upload the new file and show that one.'
        using errcode = '23514';
    end if;
    if coalesce(d.category, '') in ('Receipt', 'Bill', 'Invoice') then
      raise exception 'A % is the company''s own paper and is never shown to the customer.', lower(d.category)
        using errcode = '23514';
    end if;
    if not public.document_category_is_showable(d.category) then
      raise exception '%', case when coalesce(btrim(d.category), '') = ''
          then 'Give this paper a category first (Photo, Plan, Permit or Other). Only those can be shown to the customer.'
          else format('Only a photo, a plan, a permit or another job paper can be shown to the customer, not a %s.', d.category) end
        using errcode = '23514';
    end if;
    if public.document_is_money_paper(d.id) then
      raise exception 'This paper is tied to a bill, a supplier invoice or petty cash, so it is never shown to the customer.'
        using errcode = '23514';
    end if;
    if d.job_id is null or d.file_url is null or d.file_url = '' then
      raise exception 'That paper is not filed on a job.' using errcode = '23514';
    end if;
    -- The portal signs only what sits in the job's own folder: refuse out loud here rather than
    -- accept a share the customer would never see.
    if d.file_url not like (d.org_id::text || '/' || d.job_id::text || '/%') or d.file_url ~ '\.\.' then
      raise exception '%', case when coalesce(d.category, '') = 'Photo'
          then 'Only photos taken or uploaded on this job can be shown to the customer.'
          else 'Only papers uploaded on this job can be shown to the customer.' end
        using errcode = '23514';
    end if;
    -- A signed-in writer shares only inside their own org (the policy says so too; this says it for
    -- the service role's writes, which RLS does not see).
    if not public.is_privileged_writer() and d.org_id is distinct from public.auth_org_id() then
      raise exception 'That paper is not in your book.' using errcode = '42501';
    end if;
    new.org_id := d.org_id;
    new.job_id := d.job_id;
    new.file_url_at_share := d.file_url;
    new.object_version_at_share := public.documents_object_version(d.file_url);
    new.shared_by := coalesce(auth.uid(), new.shared_by);
    new.shared_at := now();
    new.removed_at := null;
    new.removed_by := null;
  end if;

  if tg_op = 'INSERT' then
    new.kind := coalesce(new.kind, case d.category when 'Photo' then 'photo' when 'Plan' then 'plan'
                                                   when 'Permit' then 'permit' else 'document' end);
    new.title := coalesce(nullif(btrim(new.title), ''),
                          nullif(btrim(regexp_replace(d.name, '\.[A-Za-z0-9]{1,5}$', '')), ''),
                          initcap(replace(new.kind, '_', ' ')));
  else
    new.title := coalesce(nullif(btrim(new.title), ''), old.title);
  end if;
  new.title := left(regexp_replace(new.title, '\s+', ' ', 'g'), 120);

  -- Taking it down: when and who, once.
  if tg_op = 'UPDATE' and old.removed_at is null and new.removed_at is not null then
    new.removed_at := now();
    new.removed_by := auth.uid();
  elsif tg_op = 'UPDATE' and old.removed_at is not null and new.removed_at is not null then
    new.removed_at := old.removed_at;
  end if;

  -- "Replaces <older one>": checked whenever the row is live and names an older paper it did not
  -- name a moment ago (or comes back up naming it).
  if tg_op = 'UPDATE' and new.replaces_document_id is distinct from old.replaces_document_id then
    new.replaces_marked_by := auth.uid();
    new.replaces_marked_at := now();
  elsif tg_op = 'INSERT' and new.replaces_document_id is not null then
    new.replaces_marked_by := auth.uid();
    new.replaces_marked_at := now();
  else
    new.replaces_marked_by := case when tg_op = 'UPDATE' then old.replaces_marked_by end;
    new.replaces_marked_at := case when tg_op = 'UPDATE' then old.replaces_marked_at end;
  end if;

  if new.replaces_document_id is not null and new.removed_at is null
     and (tg_op = 'INSERT' or new.replaces_document_id is distinct from old.replaces_document_id or v_restamp) then
    if new.replaces_document_id = new.document_id then
      raise exception 'A paper can''t replace itself.' using errcode = '23514';
    end if;
    select s.title into v_old_title
      from public.job_shared_documents s
     where s.document_id = new.replaces_document_id and s.org_id = new.org_id and s.job_id = new.job_id;
    if not found then
      raise exception 'The older paper was never shown on this job''s page, so there is nothing for this one to replace.'
        using errcode = '23514';
    end if;
    select s.title into v_other
      from public.job_shared_documents s
     where s.replaces_document_id = new.replaces_document_id and s.removed_at is null
       and s.document_id <> new.document_id
     limit 1;
    if found then
      raise exception '"%" is already replaced by "%". Mark the newest one as replacing "%" instead.', v_old_title, v_other, v_other
        using errcode = '23514';
    end if;
    -- No circle: following "replaces" from the older paper must never come back to this one.
    v_hop := new.replaces_document_id;
    loop
      select s.replaces_document_id into v_hop from public.job_shared_documents s where s.document_id = v_hop;
      exit when v_hop is null;
      v_hops := v_hops + 1;
      if v_hop = new.document_id or v_hops > 500 then
        raise exception 'That would make these papers replace each other. Pick the older one.' using errcode = '23514';
      end if;
    end loop;
  end if;

  return new;
end $$;
revoke execute on function public.job_shared_documents_stamp() from public, anon, authenticated;

drop trigger if exists job_shared_photos_stamp on public.job_shared_documents;
drop trigger if exists job_shared_documents_stamp on public.job_shared_documents;
create trigger job_shared_documents_stamp
  before insert or update on public.job_shared_documents
  for each row execute function public.job_shared_documents_stamp();
drop function if exists public.job_shared_photos_stamp();

-- ── 3b. the paper under a share can't be pulled out from under it ────────────────────────────────
-- documents_write (0013) lets any member update or delete any document in the org, and the share
-- row goes with its document (0300's ON DELETE CASCADE). Without this, a crew member deleting the
-- newest version would silently put the older one back on the customer's page and erase what the
-- customer was shown; repointing its job, file or category would silently take it down. So, while
-- a paper is up (a live share row):
--   DELETE  refused while it is the version the customer sees, for everyone: the office takes it
--           off first (Take Off Portal, or the photo's Customer Sees It switch), which is visible,
--           says what shows instead, and has Undo. An earlier version a live newer one stands in
--           for changes nothing on the page: the office may delete it; the crew may not (it is the
--           office's record of what the customer was shown). When the job or the company itself
--           is being deleted, everything on it goes together.
--   UPDATE  of its org, job, file or category: the office only (a re-file by the office still
--           drops it off the page, fail-closed, as section 2 says). The name is free: the customer
--           reads the office's title.
create or replace function public.documents_keep_customer_share()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  s public.job_shared_documents%rowtype;
  v_staff boolean := public.is_org_staff();
begin
  select * into s from public.job_shared_documents where document_id = old.id and removed_at is null;
  if not found then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'UPDATE' then
    if new.org_id is not distinct from old.org_id and new.job_id is not distinct from old.job_id
       and new.file_url is not distinct from old.file_url and new.category is not distinct from old.category then
      return new;
    end if;
    if public.is_privileged_writer() or v_staff then
      return new;
    end if;
    raise exception 'This paper is on the customer''s page, so only the office can move it, re-file it or change its file.'
      using errcode = '42501';
  end if;

  -- DELETE. The job or the company is being deleted (a cascade): everything on it goes together.
  if not exists (select 1 from public.jobs j where j.id = s.job_id)
     or not exists (select 1 from public.organizations o where o.id = s.org_id) then
    return old;
  end if;
  -- An earlier version a live newer paper stands in for: the page doesn't change; the office may.
  if (v_staff or public.is_privileged_writer())
     and exists (select 1 from public.job_shared_documents r
                  where r.replaces_document_id = old.id and r.removed_at is null) then
    return old;
  end if;
  if not v_staff and not public.is_privileged_writer() then
    raise exception 'This paper is on the customer''s page, so only the office can take it down. Ask the office to take it off first.'
      using errcode = '42501';
  end if;
  raise exception '%', case when s.kind = 'photo'
      then 'This photo is on the customer''s page. Turn off Customer Sees It on the Photos tab first, then delete it.'
      else format('"%s" is on the customer''s page. Take it off with Take Off Portal on the job''s Customer Page tab first, then delete it.', s.title) end
    using errcode = '23514';
end $$;
revoke execute on function public.documents_keep_customer_share() from public, anon, authenticated;

drop trigger if exists documents_keep_customer_share on public.documents;
create trigger documents_keep_customer_share
  before update of org_id, job_id, file_url, category or delete on public.documents
  for each row execute function public.documents_keep_customer_share();

-- ── 4. RLS: the office, every verb; an update is now a verb (retitle, replace, take down) ──────
revoke all on public.job_shared_documents from public, anon, authenticated;
grant select, insert, update, delete on public.job_shared_documents to authenticated;
grant all on public.job_shared_documents to service_role;

drop policy if exists job_shared_documents_staff_update on public.job_shared_documents;
create policy job_shared_documents_staff_update on public.job_shared_documents
  for update to authenticated
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

-- The old name, for an app build from before this migration: its Photos switch inserts and deletes
-- through here, and its Customer Page tab counts from here. The caller's RLS applies.
drop view if exists public.job_shared_photos;
create view public.job_shared_photos with (security_invoker = true) as
  select document_id, org_id, job_id, file_url_at_share, object_version_at_share, shared_by, shared_at
    from public.job_shared_documents
   where removed_at is null;
comment on view public.job_shared_photos is
  'Compatibility name for job_shared_documents (0326), live rows only, for an app build from before 0326. Drop once no build reads it.';
revoke all on public.job_shared_photos from public, anon, authenticated;
grant select, insert, delete on public.job_shared_photos to authenticated;
grant all on public.job_shared_photos to service_role;

-- ── 5. the one rule the portal reads by ─────────────────────────────────────────────────────────
-- Does the customer holding a link to (org, job) see this share right now? Every condition, in one
-- place, for the photos and the documents alike.
create or replace function public.job_share_shows(p_document_id uuid, p_org uuid, p_job uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.job_shared_documents s
      join public.documents d on d.id = s.document_id
     where s.document_id = p_document_id
       and s.org_id = p_org and s.job_id = p_job and s.removed_at is null
       and d.org_id = p_org and d.job_id = p_job
       and public.document_category_is_showable(d.category)
       and not public.document_is_money_paper(d.id)
       and d.file_url = s.file_url_at_share
       and d.file_url like (p_org::text || '/' || p_job::text || '/%')
       and d.file_url !~ '\.\.'
       and public.documents_object_version(d.file_url) is not distinct from s.object_version_at_share
       -- Replaced by a newer paper that is itself up: the customer sees only the newest.
       and not exists (
         select 1 from public.job_shared_documents r
          where r.replaces_document_id = s.document_id
            and r.org_id = p_org and r.job_id = p_job and r.removed_at is null))
$$;
revoke execute on function public.job_share_shows(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.job_share_shows(uuid, uuid, uuid) to service_role;

-- ── 5b. the office's Photos tab asks the same rows (0323's job_shared_photo_state, rebuilt) ─────
-- 0323's body, with its source moved from job_shared_photos (now a view of every live paper) to
-- job_shared_documents: photos only, live rows only. still_shown is job_share_shows() without its
-- "replaced by a newer paper" clause: the file is the one shown, in the job's folder, the same
-- stored version, still a Photo on this job, and not money paper. Same grants as 0323.
create or replace function public.job_shared_photo_state(p_job_id uuid)
returns table (document_id uuid, still_shown boolean)
language sql stable security definer set search_path = public as $$
  select s.document_id,
         coalesce(
           d.id is not null
           and d.job_id = s.job_id
           and d.org_id = s.org_id
           and d.category = 'Photo'
           and not public.document_is_money_paper(d.id)
           and d.file_url = s.file_url_at_share
           and d.file_url like (s.org_id::text || '/' || s.job_id::text || '/%')
           and d.file_url !~ '\.\.'
           and public.documents_object_version(d.file_url) is not distinct from s.object_version_at_share,
           false) as still_shown
    from public.job_shared_documents s
    left join public.documents d on d.id = s.document_id
   where s.job_id = p_job_id
     and s.kind = 'photo'
     and s.removed_at is null
     and s.org_id = public.auth_org_id()
     and public.is_org_staff();
$$;
comment on function public.job_shared_photo_state(uuid) is
  'For each photo the office shows a customer on a job: does the customer''s page still show its file (0323, audit v994 PL4; 0326 reads job_shared_documents, photos and live rows only). Office staff of the caller''s own org only; a photo whose file changed after it was shown reads false.';
revoke execute on function public.job_shared_photo_state(uuid) from public, anon;
grant execute on function public.job_shared_photo_state(uuid) to authenticated, service_role;

-- ── 6. the portal reads it ──────────────────────────────────────────────────────────────────────
do $$
declare
  v_def text;
  v_n int;
  v_old text := $old$
    'photos', coalesce((select json_agg(json_build_object(
        'id', d.id, 'file_path', d.file_url, 'added_at', d.created_at)
        order by d.created_at desc, d.id)
      from public.job_shared_photos s
      join public.documents d on d.id = s.document_id
     where s.job_id = j.id and s.org_id = a.org_id
       and d.job_id = j.id and d.org_id = a.org_id
       and d.category = 'Photo'
       and d.file_url = s.file_url_at_share
       and d.file_url like (a.org_id::text || '/' || j.id::text || '/%')
       and public.documents_object_version(d.file_url) is not distinct from s.object_version_at_share), '[]'::json)$old$;
  v_new text := $new$
    -- 0326: one rule for every shared paper (job_share_shows). Photos keep their block and shape.
    'photos', coalesce((select json_agg(json_build_object(
        'id', d.id, 'file_path', d.file_url, 'added_at', d.created_at)
        order by d.created_at desc, d.id)
      from public.job_shared_documents s
      join public.documents d on d.id = s.document_id
     where s.job_id = j.id and s.org_id = a.org_id and s.kind = 'photo'
       and public.job_share_shows(s.document_id, a.org_id, j.id)), '[]'::json),
    -- 0326: the plans, permits, circuit maps, drawings, renderings and scans. The newest of each
    -- chain only (job_share_shows). The office's title, never the document's name; the file the
    -- office shared, for the server to sign; never who shared it.
    'documents', coalesce((select json_agg(json_build_object(
        'id', d.id, 'kind', s.kind, 'title', s.title, 'file_path', d.file_url,
        'added_at', d.created_at, 'shown_at', s.shared_at,
        'is_update', s.replaces_document_id is not null)
        order by s.shared_at desc, d.id)
      from public.job_shared_documents s
      join public.documents d on d.id = s.document_id
     where s.job_id = j.id and s.org_id = a.org_id and s.kind <> 'photo'
       and public.job_share_shows(s.document_id, a.org_id, j.id)), '[]'::json)$new$;
begin
  v_def := pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure);
  if position('job_share_shows' in v_def) = 0 then
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception '0326: portal_job_view''s photos block appears % time(s), not once, so someone changed it since 0301. Nothing was changed.', v_n;
    end if;
    execute replace(v_def, v_old, v_new);
  end if;
end $$;
comment on function public.portal_job_view(text, uuid) is
  'The customer portal''s job page (0301; 0315 scrubs supplier names; 0326 adds the shared papers through job_share_shows). Service role only; the gate (link on, job is this customer''s in this org, customer-facing status) is inside. Returns building blocks the server turns into the allowlisted page payload (src/lib/portal/job-view.ts).';

-- ── self-check ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_bad int;
  v_def text := pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure);
begin
  if position('job_share_shows' in v_def) = 0 or position('job_shared_photos' in v_def) > 0 then
    raise exception '0326: portal_job_view does not read the shared papers through job_share_shows. Nothing was changed.';
  end if;
  -- Nothing on any page that opens today changed, except the new (empty) documents block.
  select count(*) into v_bad
    from _0326_before b
   where (b.j - 'documents') is distinct from (public.portal_job_view(b.token, b.job_id)::jsonb - 'documents')
      or (b.j is not null and (b.j ? 'scope')
          and jsonb_typeof(public.portal_job_view(b.token, b.job_id)::jsonb -> 'documents') is distinct from 'array');
  if v_bad > 0 then
    raise exception '0326: % customer job page(s) would read differently. Nothing was changed.', v_bad;
  end if;

  if has_table_privilege('anon', 'public.job_shared_documents', 'select')
     or has_table_privilege('anon', 'public.job_shared_photos', 'select') then
    raise exception '0326: a signed-out visitor could read the shared papers. Nothing was changed.';
  end if;
  if has_function_privilege('authenticated', 'public.job_share_shows(uuid, uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.job_share_shows(uuid, uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.document_is_money_paper(uuid)', 'execute')
     or has_function_privilege('anon', 'public.document_is_money_paper(uuid)', 'execute')
     or has_function_privilege('anon', 'public.portal_job_view(text, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.portal_job_view(text, uuid)', 'execute') then
    raise exception '0326: a portal rule became callable without the service role. Nothing was changed.';
  end if;
  if position('job_shared_documents' in pg_get_functiondef('public.job_shared_photo_state(uuid)'::regprocedure)) = 0
     or has_function_privilege('anon', 'public.job_shared_photo_state(uuid)', 'execute') then
    raise exception '0326: job_shared_photo_state still reads the old name, or anon can call it. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.documents'::regclass
                    and tgname = 'documents_keep_customer_share' and not tgisinternal) then
    raise exception '0326: the documents under a share are not guarded. Nothing was changed.';
  end if;
  if public.document_category_is_showable('Receipt') or public.document_category_is_showable('Bill')
     or public.document_category_is_showable('Invoice') or public.document_category_is_showable(null)
     or not public.document_category_is_showable('Plan') then
    raise exception '0326: the showable categories are not what they must be. Nothing was changed.';
  end if;
end $$;
drop table _0326_before;
