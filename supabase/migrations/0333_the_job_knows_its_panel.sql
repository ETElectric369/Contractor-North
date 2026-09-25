-- 0333 — THE JOB KNOWS ITS PANEL (Panel tab plan, phase 1; Erik 2026-09-25: "instead of a .pdf it
-- can just be there", and "go for all").
--
-- THE NIGHT IT CAME FROM. For J-011 (13897 Herringbone) a "Final Circuit Map" PDF was built by hand
-- from five sources: Erik's hand map, estimate E-017's circuit take-off (12 circuits), the CED
-- ticket (8 x Q2020 + 1 x Q21530CT, one 2P 20A short), a panel photo, and Erik's answers (the entry
-- lights are on the kitchen circuit; the 50A 2P GFCI is the range; no dishwasher). The circuits
-- were never data anywhere: the estimate's take-off is a proposal the customer signs, and the PDF
-- is a picture. This makes them the JOB's own list, which the crew works at the panel.
--
-- TWO TABLES, NO BREAKERS TABLE. A circuit is what gets worked (added, labelled, placed, roughed,
-- verified). The physical breaker is derived from the circuits, and which spaces are taken is
-- worked out in TypeScript (src/lib/panel/model.ts), where a collision or an odd tandem is a
-- WARNING a person reads, never a database refusal: the app suggests, a person decides. The only
-- electrical rule the database holds is the one nobody can talk their way past: a kept circuit may
-- not sit on a crimped space (No Stab) or run off the end of the panel.
--
-- WHO MAY DO WHAT (Erik's decision 1, and the tech job access law of 2026-09-11):
--   * Every active member of the org reads, adds and edits circuits and panels on the org's jobs:
--     add, relabel, set the space, Planned / Roughed / Done, Verified On Site, Take Off (a soft
--     remove, so Undo puts it back). Nothing on either table carries a price, a part number or a
--     supplier, so there is nothing money-shaped for a tech to see or write.
--   * Only the office brings circuits in from an estimate or the plans (source 'estimate' /
--     'plan'), shows the panel on the customer's page (shown_on_portal, Erik's decision 2: OFF
--     until the office turns it on per job; phase 5 reads it), or takes a panel off a job.
--   * Nobody deletes. There is no DELETE policy and no DELETE grant: removal is removed_at plus
--     Undo, and rows only really go when their job is deleted (the cascade).
--
-- WHAT THE TRIGGER STAMPS, SO NO CLIENT CAN SAY IT: org_id (from the job; a panel or a source
-- from another job or org is refused, 0173's law), created_by/at, updated_by/at, removed_by, and
-- verified_by/at, which move only when the verified flag flips. Provenance (source, the source
-- quote / document / row) is fixed at insert. A circuit from any machine source (estimate, plan,
-- photo, nort, inspector) lands as a SUGGESTION whatever the request said: nothing counts until a
-- person keeps it.
--
-- NOT APPLIED BY THE AUTHOR. Nothing here touches existing rows; the J-011 seed is never in a
-- migration (Erik taps Bring In E-017 in the app).

-- ── 1. the panel ─────────────────────────────────────────────────────────────────────────────────
create table if not exists public.job_panels (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  job_id            uuid not null references public.jobs(id) on delete cascade,
  name              text not null default 'Main Panel' check (length(btrim(name)) between 1 and 60),
  brand             text check (brand is null or length(brand) <= 60),
  bus_amps          smallint check (bus_amps is null or bus_amps between 30 and 1200),
  main_amps         smallint check (main_amps is null or main_amps between 30 and 1200),
  spaces            smallint check (spaces is null or spaces between 1 and 84),
  -- Which end space 1 is at. A person sets it from the panel label; the app never guesses.
  numbering         text not null default 'top_down' check (numbering in ('top_down', 'bottom_up')),
  -- A crimped bus with no stab: a HARD refusal for a kept circuit (below).
  dead_spaces       smallint[] not null default '{}',
  -- The spaces the panel label allows tandems (twins / quads) in: a WARNING only, in TypeScript.
  twin_spaces       smallint[] not null default '{}',
  photo_document_id uuid references public.documents(id) on delete set null,
  -- The office's and crew's own words about the panel. Never on the customer's page.
  notes             text check (notes is null or length(notes) <= 2000),
  -- Erik's decision 2: the customer's live "Your Panel" is OFF until the office turns it on.
  shown_on_portal   boolean not null default false,
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_by        uuid references public.profiles(id) on delete set null,
  updated_at        timestamptz not null default now(),
  removed_at        timestamptz,
  removed_by        uuid references public.profiles(id) on delete set null
);
comment on table public.job_panels is
  'A panel on a job (0333): name, brand, amps, spaces, which way the spaces are numbered, the No Stab '
  'and tandem spaces, a photo, and whether the customer sees it (off until the office turns it on). '
  'Every active org member reads and edits; only the office shows it on the portal or takes it off. No price, ever.';
create unique index if not exists job_panels_one_name_per_job
  on public.job_panels (job_id, lower(name)) where removed_at is null;
create index if not exists job_panels_job_idx on public.job_panels (job_id) where removed_at is null;

-- ── 2. the circuit ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.job_circuits (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  job_id             uuid not null references public.jobs(id) on delete cascade,
  -- null = no panel yet (a circuit can be listed before anyone has looked in the box).
  panel_id           uuid references public.job_panels(id) on delete set null,
  room               text check (room is null or length(room) <= 80),
  -- What it feeds ("Kitchen And Living"), and what the door says ("Entry Lights").
  description        text check (description is null or length(description) <= 200),
  panel_label        text check (panel_label is null or length(panel_label) <= 120),
  amps               smallint check (amps is null or amps in (10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225)),
  poles              smallint not null default 1 check (poles between 1 and 3),
  -- null = nobody has said. A person picks it; the app does not assume standard.
  kind               text check (kind is null or kind in ('standard', 'afci', 'gfci', 'dual_function', 'spd')),
  wire               text check (wire is null or length(wire) <= 40),
  wire_tag           text check (wire_tag is null or length(wire_tag) <= 40),
  -- Where it sits. A 2P at space 25 covers 25 and 27; half B puts it in the B half of each, which is
  -- how the inner 2P 30 of a Q21530CT quad is written down.
  space              smallint check (space is null or space between 1 and 84),
  half               text check (half is null or half in ('A', 'B')),
  work               text not null default 'new' check (work in ('new', 'existing', 'reused', 'removed')),
  progress           text not null default 'planned' check (progress in ('planned', 'roughed', 'done')),
  state              text not null default 'kept' check (state in ('suggested', 'kept')),
  source             text not null default 'hand' check (source in ('estimate', 'plan', 'photo', 'hand', 'nort', 'inspector')),
  source_quote_id    uuid references public.quotes(id) on delete set null,
  source_document_id uuid references public.documents(id) on delete set null,
  -- The raw row that was read ("From E-017"), with a `key` that stops the same row coming in twice.
  source_row         jsonb,
  verified           boolean not null default false,
  verified_by        uuid references public.profiles(id) on delete set null,
  verified_at        timestamptz,
  sort_order         int not null default 0,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_by         uuid references public.profiles(id) on delete set null,
  updated_at         timestamptz not null default now(),
  removed_at         timestamptz,
  removed_by         uuid references public.profiles(id) on delete set null,
  constraint job_circuits_half_needs_a_space check (half is null or space is not null),
  constraint job_circuits_source_row_is_an_object check (source_row is null or jsonb_typeof(source_row) = 'object')
);
comment on table public.job_circuits is
  'A circuit on a job (0333): room, what it feeds, what the door says, amps, poles, type, wire, space, '
  'new/existing, planned/roughed/done, suggested/kept, where it came from, verified on site. NO money, '
  'NO part number, NO supplier. Every active org member reads and edits; removal is soft (Undo).';
create index if not exists job_circuits_job_idx on public.job_circuits (job_id) where removed_at is null;
create index if not exists job_circuits_panel_space_idx on public.job_circuits (panel_id, space);
-- Bring In is idempotent: the same row of the same estimate lands on a job once, even after Not This
-- (a set-aside suggestion still holds its key, so a second tap does not bring it back).
create unique index if not exists job_circuits_one_per_source_row
  on public.job_circuits (job_id, source_quote_id, (source_row ->> 'key'))
  where source_quote_id is not null and source_row ? 'key';

-- ── 3. the guard: pins, stamps, the office-only doors and the No Stab refusal ────────────────────
create or replace function public.job_panel_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_office  boolean := public.is_org_staff() or public.is_privileged_writer();
  v_uid     uuid := auth.uid();
  v_job_org uuid;
  v_panel   public.job_panels%rowtype;
  v_slot    int;
  i         int;
begin
  -- A CASCADE IS NOT AN EDIT. When a quote, document or profile a row points at is deleted, the
  -- foreign key's ON DELETE SET NULL arrives here as an UPDATE issued from inside another trigger
  -- (pg_trigger_depth() > 1). Pinning provenance or the stamps back to the old id would refuse that
  -- delete outright: an estimate whose circuits were brought in could never be deleted, nor a
  -- departed employee's profile. So it passes untouched. A person's own write is always depth 1,
  -- and gets every rule below; no trigger in the schema writes these tables on anyone's behalf.
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1 then
    return new;
  end if;

  -- THE JOB DECIDES THE ORG. A signed-in writer writes only on a job of their own org; the direct
  -- connection and the service role (privileged) may write anywhere, and still get the job's org.
  if tg_op = 'UPDATE' then
    new.job_id := old.job_id;
    new.org_id := old.org_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  else
    select j.org_id into v_job_org from public.jobs j where j.id = new.job_id;
    if v_job_org is null then
      raise exception 'That job is not on file.' using errcode = '23503';
    end if;
    if not public.is_privileged_writer() and v_job_org is distinct from public.auth_org_id() then
      raise exception 'That job isn''t in your book.' using errcode = '42501';
    end if;
    new.org_id := v_job_org;
    new.created_by := coalesce(v_uid, new.created_by);
    new.created_at := now();
  end if;
  new.updated_by := coalesce(v_uid, new.updated_by);
  new.updated_at := now();

  -- WHO TOOK IT OFF, stamped here. Clearing removed_at (Undo) clears it too.
  if tg_op = 'INSERT' then
    new.removed_by := case when new.removed_at is null then null else coalesce(v_uid, new.removed_by) end;
  elsif new.removed_at is distinct from old.removed_at then
    new.removed_by := case when new.removed_at is null then null else coalesce(v_uid, new.removed_by) end;
  else
    new.removed_by := old.removed_by;
  end if;

  if tg_table_name = 'job_panels' then
    -- The customer's page and taking a panel off the job are the office's (Erik's decisions).
    if not v_office then
      if tg_op = 'INSERT' then
        new.shown_on_portal := false;
        if new.removed_at is not null then
          raise exception 'Only the office can take a panel off a job.' using errcode = '42501';
        end if;
      else
        if new.shown_on_portal is distinct from old.shown_on_portal then
          raise exception 'Only the office can show the panel on the customer''s page.' using errcode = '42501';
        end if;
        if new.removed_at is distinct from old.removed_at then
          raise exception 'Only the office can take a panel off a job or put it back.' using errcode = '42501';
        end if;
      end if;
    end if;
    -- The photo is one of this org's documents.
    if new.photo_document_id is not null
       and (tg_op = 'INSERT' or new.photo_document_id is distinct from old.photo_document_id)
       and not exists (select 1 from public.documents d where d.id = new.photo_document_id and d.org_id = new.org_id) then
      raise exception 'That photo isn''t in your book.' using errcode = '42501';
    end if;
    -- Space lists: in the panel, once each, in order.
    new.dead_spaces := coalesce(array(select distinct x from unnest(new.dead_spaces) x where x is not null order by x), '{}');
    new.twin_spaces := coalesce(array(select distinct x from unnest(new.twin_spaces) x where x is not null order by x), '{}');
    if exists (select 1 from unnest(new.dead_spaces || new.twin_spaces) x where x < 1 or x > coalesce(new.spaces, 84)) then
      raise exception 'A No Stab or tandem space is outside this panel''s % spaces.', coalesce(new.spaces, 84) using errcode = '23514';
    end if;
    return new;
  end if;

  -- ── job_circuits ──
  -- Provenance is fixed at insert: where a circuit came from never changes after.
  if tg_op = 'UPDATE' then
    new.source := old.source;
    new.source_quote_id := old.source_quote_id;
    new.source_document_id := old.source_document_id;
    new.source_row := old.source_row;
  else
    if not v_office and new.source in ('estimate', 'plan') then
      raise exception 'Only the office brings in circuits from an estimate or the plans.' using errcode = '42501';
    end if;
    -- The app suggests, a person decides: a machine's circuit is a suggestion until someone keeps it.
    if new.source <> 'hand' then
      new.state := 'suggested';
    end if;
    if new.source_quote_id is not null
       and not exists (select 1 from public.quotes q where q.id = new.source_quote_id and q.org_id = new.org_id) then
      raise exception 'That estimate isn''t in your book.' using errcode = '42501';
    end if;
    if new.source_document_id is not null
       and not exists (select 1 from public.documents d where d.id = new.source_document_id and d.org_id = new.org_id) then
      raise exception 'That document isn''t in your book.' using errcode = '42501';
    end if;
  end if;

  -- VERIFIED ON SITE: who and when come from the session, and move only when the flag flips.
  if tg_op = 'INSERT' or new.verified is distinct from old.verified then
    if new.verified then
      new.verified_by := v_uid;
      new.verified_at := now();
    else
      new.verified_by := null;
      new.verified_at := null;
    end if;
  else
    new.verified_by := old.verified_by;
    new.verified_at := old.verified_at;
  end if;

  -- The panel is on this job.
  if new.panel_id is not null then
    select * into v_panel from public.job_panels p where p.id = new.panel_id;
    if not found or v_panel.job_id is distinct from new.job_id or v_panel.org_id is distinct from new.org_id then
      raise exception 'That panel is on another job.' using errcode = '42501';
    end if;
  end if;

  -- THE ONE HARD ELECTRICAL RULE: a kept, live circuit may not sit on a No Stab space or run off the
  -- end of the panel. A 1P covers its space; a 2P covers s and s+2 on the same side; a 3P s, s+2, s+4.
  if new.panel_id is not null and new.space is not null and new.state = 'kept' and new.removed_at is null then
    for i in 0 .. new.poles - 1 loop
      v_slot := new.space + 2 * i;
      if v_panel.spaces is not null and v_slot > v_panel.spaces then
        raise exception 'Space % is past the end of this panel (it has % spaces). Pick another space.', v_slot, v_panel.spaces
          using errcode = '23514';
      end if;
      if v_slot = any (v_panel.dead_spaces) then
        raise exception 'Space % has no stab (No Stab). Pick another space.', v_slot using errcode = '23514';
      end if;
    end loop;
  end if;
  return new;
end $$;

comment on function public.job_panel_guard() is
  'Before insert/update on job_panels and job_circuits (0333): org from the job (a foreign job, panel, '
  'quote or document is refused), trigger-stamped created/updated/removed/verified, provenance fixed at '
  'insert, machine sources land as suggestions, the office-only doors (shown_on_portal, panel removal, '
  'source estimate/plan), and the No Stab / end-of-panel refusal for a kept circuit.';

-- A trigger function has no business being callable by a request; firing it never checks EXECUTE.
revoke execute on function public.job_panel_guard() from public, anon, authenticated;

drop trigger if exists job_panel_guard on public.job_panels;
create trigger job_panel_guard before insert or update on public.job_panels
  for each row execute function public.job_panel_guard();
drop trigger if exists job_panel_guard on public.job_circuits;
create trigger job_panel_guard before insert or update on public.job_circuits
  for each row execute function public.job_panel_guard();

-- ── 4. RLS: the org's active members read and write; nobody deletes ─────────────────────────────
alter table public.job_panels enable row level security;
alter table public.job_circuits enable row level security;

revoke all on public.job_panels from public, anon, authenticated;
revoke all on public.job_circuits from public, anon, authenticated;
grant select, insert, update on public.job_panels to authenticated;
grant select, insert, update on public.job_circuits to authenticated;
grant all on public.job_panels, public.job_circuits to service_role;

drop policy if exists job_panels_read on public.job_panels;
create policy job_panels_read on public.job_panels
  for select to authenticated
  using (org_id = public.auth_org_id() and public.is_member());

drop policy if exists job_panels_insert on public.job_panels;
create policy job_panels_insert on public.job_panels
  for insert to authenticated
  with check (
    org_id = public.auth_org_id() and public.is_member()
    and exists (select 1 from public.jobs j where j.id = job_panels.job_id and j.org_id = public.auth_org_id())
  );

drop policy if exists job_panels_update on public.job_panels;
create policy job_panels_update on public.job_panels
  for update to authenticated
  using (org_id = public.auth_org_id() and public.is_member())
  with check (
    org_id = public.auth_org_id() and public.is_member()
    and exists (select 1 from public.jobs j where j.id = job_panels.job_id and j.org_id = public.auth_org_id())
  );

drop policy if exists job_circuits_read on public.job_circuits;
create policy job_circuits_read on public.job_circuits
  for select to authenticated
  using (org_id = public.auth_org_id() and public.is_member());

drop policy if exists job_circuits_insert on public.job_circuits;
create policy job_circuits_insert on public.job_circuits
  for insert to authenticated
  with check (
    org_id = public.auth_org_id() and public.is_member()
    and exists (select 1 from public.jobs j where j.id = job_circuits.job_id and j.org_id = public.auth_org_id())
  );

drop policy if exists job_circuits_update on public.job_circuits;
create policy job_circuits_update on public.job_circuits
  for update to authenticated
  using (org_id = public.auth_org_id() and public.is_member())
  with check (
    org_id = public.auth_org_id() and public.is_member()
    and exists (select 1 from public.jobs j where j.id = job_circuits.job_id and j.org_id = public.auth_org_id())
  );

-- ── 5. say so if any of it didn't take ───────────────────────────────────────────────────────────
do $$
begin
  if has_table_privilege('anon', 'public.job_panels', 'select')
     or has_table_privilege('anon', 'public.job_circuits', 'select') then
    raise exception '0333: a signed-out visitor could read a panel table. Nothing was changed.';
  end if;
  if has_table_privilege('authenticated', 'public.job_panels', 'delete')
     or has_table_privilege('authenticated', 'public.job_circuits', 'delete') then
    raise exception '0333: a member could hard-delete a panel or circuit. Nothing was changed.';
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name in ('job_panels', 'job_circuits')
       and (column_name ~ '(price|cost|amount|supplier|vendor|part)')
  ) then
    raise exception '0333: a panel table carries a money or part column. Nothing was changed.';
  end if;
end $$;
