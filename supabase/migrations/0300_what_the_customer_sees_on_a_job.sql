-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0300: what the customer sees on a job, and who decides it
--
-- Erik, 2026-09-24, on the customer portal: "Update everything right away yes always" and "He
-- should see everything the invoice shows and everything related for the job". So the portal is
-- LIVE (no publish step) and it shows more than the invoice. Three things the invoice cannot hold
-- need a home, and each is a decision the OFFICE makes on purpose:
--
--  1. job_stretches: the named stretches of work on a job with the dates the office types
--     ("Rough-in start, Jul 14 to Aug 10"). The portal groups the billed days and the payments
--     under them and states the running balance after each. Typed by hand; nothing suggests them
--     (a suggester split J-011 at a payment that fell mid-stretch, customer portal plan item 9).
--  2. job_picks: the selections the office saves for the customer: the category (Paint Color,
--     Faceplate Color, Fixture), the brand (price_list_item_options.vendor names are the brands,
--     0296), the name or code, the room, a note, and a picture, a PDF, a swatch color or a link.
--     A pick NEVER carries a price: an option chosen from the price book pre-fills the brand and
--     the name, and its buy_price and markup_pct stay where they are.
--  3. job_shared_photos: one row per job photo the office chose to show. The portal picks photos
--     BY THIS ROW, never by listing a storage folder: receipts are filed under the same
--     <org>/<job>/ prefix as photos, and a folder listing would hand them over.
--
-- WHO WRITES WHAT (tech-job-access law, 2026-09-11): the crew READS stretches and picks (a tech
-- painting trim needs the paint color); only the office writes them. The share rows are office
-- only for every verb: a tech can write `documents` (documents_write is any member), so a share
-- flag ON documents would be a flag the crew could flip. The share row also records the file the
-- office looked at (file_url_at_share, stamped by a trigger from the documents row, never taken
-- from the request): if anyone repoints documents.file_url afterwards, the portal stops showing
-- that photo instead of showing whatever it now points at. It records the FILE'S CONTENT too
-- (object_version_at_share: storage.objects.version, which every upload replaces): any member may
-- upload over an object under <org>/<job>/ (docs_update), so a crew member could put a receipt's
-- bytes at a shared photo's exact path and leave file_url untouched. A new version is a different
-- file; the portal stops showing it until the office shares it again.
--
-- A SHARED PHOTO LIVES IN ITS JOB'S FOLDER. Only a file under <org>/<job>/ can be shared: that is
-- where the Photos tab files what it takes, and the portal signs nothing else (a paper Organize
-- filed under <org>/organize/ would be accepted here and then dropped at the page, silently).
--
-- PICK FILES live under <org>/picks/<job>/ in the documents bucket, and 'picks' joins the
-- staff-only prefixes (docs_path_is_staff_only, rebuilt from the LIVE definition of 0247): the
-- crew cannot read, replace or delete the file the customer is shown. A CHECK pins every pick's
-- file to its own org and job, so no row can point the portal at another job's paper.
--
-- Tenant isolation lives in each policy (org_id = auth_org_id()) and every write names a job of
-- the writer's own org (the 0173 law: a rule at one read path is a convention, not a boundary).
-- The customer never reaches these tables through RLS: the portal reads them through 0301's
-- portal_job_view, as the service role, with the gate inside.
--
-- ORDER: any time after 0298. Nothing reads these tables until the portal build deploys; the
-- office controls degrade to "not ready" while they are absent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. stretches of work ───────────────────────────────────────────────────────────────────────
create table if not exists public.job_stretches (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  job_id      uuid not null references public.jobs(id) on delete cascade,
  label       text not null check (length(btrim(label)) between 1 and 80),
  starts_on   date not null,
  ends_on     date not null,
  sort        int not null default 0,
  -- Removed, not deleted: the office's Undo puts it back exactly as it was.
  removed_at  timestamptz,
  created_by  uuid references public.profiles(id) on delete set null,
  updated_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint job_stretches_dates_in_order check (ends_on >= starts_on)
);
comment on table public.job_stretches is
  'A named stretch of work on a job with the dates the office typed (0300). The customer portal groups billed days and payments under them. Staff write; the org reads.';
create index if not exists job_stretches_job_idx on public.job_stretches (job_id, starts_on) where removed_at is null;

-- ── 2. saved picks ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.job_picks (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  job_id      uuid not null references public.jobs(id) on delete cascade,
  -- "Paint Color", "Faceplate Color", "Fixture": free text, the editor offers the usual ones.
  category    text not null check (length(btrim(category)) between 1 and 60),
  -- The maker. Free text first; picking a price-book option fills it (and name/code) and nothing else.
  brand       text check (brand is null or length(brand) <= 120),
  option_id   uuid references public.price_list_item_options(id) on delete set null,
  -- "Swiss Coffee OC-45", "Decora 5-pack White", "Halo RL4".
  name        text check (name is null or length(name) <= 160),
  code        text check (code is null or length(code) <= 80),
  -- The room or place it goes: "Kitchen", "Primary bath, over the vanity".
  location    text check (location is null or length(location) <= 120),
  note        text check (note is null or length(note) <= 2000),
  -- A swatch the customer can see without opening anything.
  color_hex   text check (color_hex is null or color_hex ~ '^#[0-9a-fA-F]{6}$'),
  -- The maker's page or a spec sheet. https only: the portal opens it in a new tab.
  link_url    text check (link_url is null or (link_url ~ '^https://[^[:space:]]+$' and length(link_url) <= 2000)),
  -- A picture or PDF in the documents bucket, ONLY under this pick's own <org>/picks/<job>/.
  file_path   text,
  file_kind   text check (file_kind is null or file_kind in ('image', 'pdf')),
  sort        int not null default 0,
  removed_at  timestamptz,
  created_by  uuid references public.profiles(id) on delete set null,
  updated_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint job_picks_file_is_its_own
    check (file_path is null
           or (file_path like (org_id::text || '/picks/' || job_id::text || '/%')
               and file_path !~ '\.\.'
               and file_kind is not null))
);
comment on table public.job_picks is
  'The selections the office saved for a job (0300): category, brand, name/code, room, note, and a picture/PDF/swatch/link. Never a price. Staff write; the org reads; the customer sees them through portal_job_view.';
create index if not exists job_picks_job_idx on public.job_picks (job_id, sort) where removed_at is null;

-- ── 3. the photos the office chose to show ─────────────────────────────────────────────────────
create table if not exists public.job_shared_photos (
  document_id       uuid primary key references public.documents(id) on delete cascade,
  org_id            uuid not null references public.organizations(id) on delete cascade,
  job_id            uuid not null references public.jobs(id) on delete cascade,
  file_url_at_share text not null,
  -- The stored object's version when the office shared it (null: no object at that path then).
  object_version_at_share text,
  shared_by         uuid references public.profiles(id) on delete set null,
  shared_at         timestamptz not null default now()
);
comment on table public.job_shared_photos is
  'One row per job photo the office chose to show the customer (0300). The portal selects photos by this row and only while documents.file_url still equals file_url_at_share; never by listing a folder. Office staff only.';
create index if not exists job_shared_photos_job_idx on public.job_shared_photos (job_id, shared_at desc);

-- The version of the object a documents path names right now (null when there is none). One rule
-- for the share stamp below and for portal_job_view (0301), so they cannot disagree about "the same
-- file". Definer-only: it reads storage.objects, which no member reads directly.
create or replace function public.documents_object_version(p_name text)
returns text language sql stable security definer set search_path = public as $$
  select o.version
    from storage.objects o
   where o.bucket_id = 'documents' and o.name = p_name
   order by o.updated_at desc nulls last, o.created_at desc nulls last
   limit 1;
$$;
revoke execute on function public.documents_object_version(text) from public, anon, authenticated;
grant execute on function public.documents_object_version(text) to service_role;

-- Whatever the request said, the share row describes the document it names: its org, its job, the
-- file it points at right now, and who shared it. Only a Photo on a job can be shared; a receipt
-- (same folder, same bucket) is refused by name.
create or replace function public.job_shared_photos_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
declare d public.documents%rowtype;
begin
  select * into d from public.documents where id = new.document_id;
  if not found then
    raise exception 'That photo is not on file.' using errcode = 'P0002';
  end if;
  if coalesce(d.category, '') <> 'Photo' then
    raise exception 'Only a job photo can be shown to the customer, not a %.', coalesce(nullif(d.category, ''), 'document')
      using errcode = '23514';
  end if;
  if d.job_id is null or d.file_url is null or d.file_url = '' then
    raise exception 'That photo is not filed on a job.' using errcode = '23514';
  end if;
  -- The portal signs only what sits in the job's own folder: refuse out loud here rather than
  -- accept a share the customer would never see.
  if d.file_url not like (d.org_id::text || '/' || d.job_id::text || '/%') or d.file_url ~ '\.\.' then
    raise exception 'Only photos taken or uploaded on this job can be shown to the customer.' using errcode = '23514';
  end if;
  -- A signed-in writer shares only inside their own org (the policy says so too; this says it for
  -- the service role's writes, which RLS does not see).
  if not public.is_privileged_writer() and d.org_id is distinct from public.auth_org_id() then
    raise exception 'That photo is not in your book.' using errcode = '42501';
  end if;
  new.org_id := d.org_id;
  new.job_id := d.job_id;
  new.file_url_at_share := d.file_url;
  new.object_version_at_share := public.documents_object_version(d.file_url);
  new.shared_by := coalesce(auth.uid(), new.shared_by);
  new.shared_at := now();
  return new;
end $$;
revoke execute on function public.job_shared_photos_stamp() from public, anon, authenticated;

drop trigger if exists job_shared_photos_stamp on public.job_shared_photos;
create trigger job_shared_photos_stamp
  before insert on public.job_shared_photos
  for each row execute function public.job_shared_photos_stamp();

-- ── stamps ─────────────────────────────────────────────────────────────────────────────────────
drop trigger if exists stamp_org_job_stretches on public.job_stretches;
create trigger stamp_org_job_stretches before insert on public.job_stretches
  for each row execute function public.set_org_id();
drop trigger if exists touch_job_stretches on public.job_stretches;
create trigger touch_job_stretches before update on public.job_stretches
  for each row execute function public.touch_updated_at();

drop trigger if exists stamp_org_job_picks on public.job_picks;
create trigger stamp_org_job_picks before insert on public.job_picks
  for each row execute function public.set_org_id();
drop trigger if exists touch_job_picks on public.job_picks;
create trigger touch_job_picks before update on public.job_picks
  for each row execute function public.touch_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────
alter table public.job_stretches enable row level security;
alter table public.job_picks enable row level security;
alter table public.job_shared_photos enable row level security;

-- Supabase's default privileges hand every new table to anon and authenticated in full. Nobody
-- signed out reads these (the portal goes through the service role), and a signed-in member gets
-- only the verbs a policy below answers: stretches and picks are removed (Undo), never deleted; a
-- share row is added or taken away, never edited.
revoke all on public.job_stretches from public, anon, authenticated;
revoke all on public.job_picks from public, anon, authenticated;
revoke all on public.job_shared_photos from public, anon, authenticated;
grant select, insert, update on public.job_stretches to authenticated;
grant select, insert, update on public.job_picks to authenticated;
grant select, insert, delete on public.job_shared_photos to authenticated;
grant all on public.job_stretches, public.job_picks, public.job_shared_photos to service_role;

-- Stretches: the org reads (the crew too), the office writes, always about a job of its own org.
drop policy if exists job_stretches_read on public.job_stretches;
create policy job_stretches_read on public.job_stretches
  for select to authenticated
  using (org_id = public.auth_org_id() and public.is_member());

drop policy if exists job_stretches_insert on public.job_stretches;
create policy job_stretches_insert on public.job_stretches
  for insert to authenticated
  with check (
    org_id = public.auth_org_id() and public.is_org_staff()
    and exists (select 1 from public.jobs j where j.id = job_stretches.job_id and j.org_id = public.auth_org_id())
  );

drop policy if exists job_stretches_update on public.job_stretches;
create policy job_stretches_update on public.job_stretches
  for update to authenticated
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (
    org_id = public.auth_org_id() and public.is_org_staff()
    and exists (select 1 from public.jobs j where j.id = job_stretches.job_id and j.org_id = public.auth_org_id())
  );

-- Picks: same shape. A price-book option, when named, is one of the org's own.
drop policy if exists job_picks_read on public.job_picks;
create policy job_picks_read on public.job_picks
  for select to authenticated
  using (org_id = public.auth_org_id() and public.is_member());

drop policy if exists job_picks_insert on public.job_picks;
create policy job_picks_insert on public.job_picks
  for insert to authenticated
  with check (
    org_id = public.auth_org_id() and public.is_org_staff()
    and exists (select 1 from public.jobs j where j.id = job_picks.job_id and j.org_id = public.auth_org_id())
    and (option_id is null or exists (
      select 1 from public.price_list_item_options o where o.id = job_picks.option_id and o.org_id = public.auth_org_id()))
  );

drop policy if exists job_picks_update on public.job_picks;
create policy job_picks_update on public.job_picks
  for update to authenticated
  using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (
    org_id = public.auth_org_id() and public.is_org_staff()
    and exists (select 1 from public.jobs j where j.id = job_picks.job_id and j.org_id = public.auth_org_id())
    and (option_id is null or exists (
      select 1 from public.price_list_item_options o where o.id = job_picks.option_id and o.org_id = public.auth_org_id()))
  );

-- Shared photos: the office only, every verb. (The trigger above fills org/job/file from the row.)
drop policy if exists job_shared_photos_staff_read on public.job_shared_photos;
create policy job_shared_photos_staff_read on public.job_shared_photos
  for select to authenticated
  using (org_id = public.auth_org_id() and public.is_org_staff());

drop policy if exists job_shared_photos_staff_insert on public.job_shared_photos;
create policy job_shared_photos_staff_insert on public.job_shared_photos
  for insert to authenticated
  with check (org_id = public.auth_org_id() and public.is_org_staff());

drop policy if exists job_shared_photos_staff_delete on public.job_shared_photos;
create policy job_shared_photos_staff_delete on public.job_shared_photos
  for delete to authenticated
  using (org_id = public.auth_org_id() and public.is_org_staff());

-- ── pick files are the office's ────────────────────────────────────────────────────────────────
-- Rebuilt from the LIVE definition (0247). 'picks' joins the staff-only second segments.
create or replace function public.docs_path_is_staff_only(p_name text)
returns boolean language sql immutable as $$
  -- 0247: 'bug-screenshots' added. A screenshot attached to a bug report can show whatever was on
  -- the reporter's screen — another customer's money, a pay rate — and was readable by every
  -- member of the org. The BugReporter only renders for staff, so gating insert too matches who
  -- actually files them.
  -- 0300: 'picks' added. The picture or PDF a customer is shown for a saved pick is the office's:
  -- the crew cannot replace or delete the file behind it.
  select (storage.foldername(p_name))[2] in ('employees', 'organize', 'bug-screenshots', 'picks');
$$;

-- ── self-check ─────────────────────────────────────────────────────────────────────────────────
do $$
begin
  if has_table_privilege('anon', 'public.job_picks', 'select')
     or has_table_privilege('anon', 'public.job_stretches', 'select')
     or has_table_privilege('anon', 'public.job_shared_photos', 'select') then
    raise exception '0300: a signed-out visitor could read a portal table. Nothing was changed.';
  end if;
  if not public.docs_path_is_staff_only('00000000-0000-0000-0000-000000000000/picks/x/y.jpg')
     or public.docs_path_is_staff_only('00000000-0000-0000-0000-000000000000/11111111-1111-1111-1111-111111111111/y.jpg') then
    raise exception '0300: the picks prefix is not the office''s alone. Nothing was changed.';
  end if;
  if has_function_privilege('authenticated', 'public.documents_object_version(text)', 'execute')
     or has_function_privilege('anon', 'public.documents_object_version(text)', 'execute') then
    raise exception '0300: a member could read storage object versions. Nothing was changed.';
  end if;
end $$;
