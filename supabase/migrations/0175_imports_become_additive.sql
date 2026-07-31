-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0175: an import stops being all-or-nothing
--
-- Erik: "the invoice for lim kept force feeding all the shit from the invoice when
-- the scope of the job expanded and i wanted to import time and material."
--
-- He was describing something the schema made unavoidable. Every importer is a
-- DELETE-AND-REBUILD: replace_imported_invoice_items (0156) deletes every row for
-- a source and re-inserts from the job's CURRENT state. There is no key on
-- invoice_items, so there is nothing to match an incoming row against — importing
-- "only the new time and materials" was not unimplemented, it was NOT EXPRESSIBLE.
-- Three consequences, all of which bit him on INV-050:
--   * a hand-negotiated price is silently overwritten by the raw computed one;
--   * a line deliberately deleted comes back on the next import;
--   * you cannot add the work that accrued since without re-pulling everything.
--
-- WHAT THIS ADDS
--   import_key   the stable identity of what a line REPRESENTS — "labor:<profile>",
--                "po:<id>", "bli:<id>", "quote:<item>". Matching is by key, so an
--                import can update, insert and leave-alone independently.
--   edited       set the moment a human changes an imported line. An edited line is
--                never touched by a later import. This is the negotiated-price guard.
--   dismissed_import_keys
--                a tombstone per invoice. A line you deleted stays deleted — the
--                importer must not resurrect a decision you already made.
--
-- THE BACKFILL IS DELIBERATELY CONSERVATIVE. Existing imported rows carry no key and
-- no edit history, so there is no way to tell a hand-negotiated price from a computed
-- one. Assuming they were ALL edited is the only safe reading: on INV-050 Erik's labor
-- is billed 35.00 hr @ $125 and Brian's 24.50 @ $65, while the raw computation would
-- produce 40.25 @ $150 and 24.50 @ $95 — a +$2,397.50 swing. Protecting numbers that
-- turn out to have been computed costs a re-import; clobbering numbers that turn out to
-- have been negotiated costs a wrong bill to a customer. Only one of those is recoverable.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.invoice_items
  add column if not exists import_key text,
  add column if not exists edited boolean not null default false;

comment on column public.invoice_items.import_key is
  'Stable identity of the thing this imported line represents (labor:<profile>, po:<id>, bli:<id>, quote:<item>). NULL on hand-entered lines. Lets an import update/insert/skip per line instead of replacing the whole set — 0175.';
comment on column public.invoice_items.edited is
  'A human changed this imported line. Later imports leave it alone — this is what protects a negotiated price from being overwritten by the raw computed one — 0175.';

-- Matching is always within one invoice.
create index if not exists invoice_items_import_key_idx
  on public.invoice_items (invoice_id, import_key)
  where import_key is not null;

-- Every row that already exists predates the key, so treat it as hand-owned. See the
-- note above: the asymmetry of the two possible mistakes decides this.
update public.invoice_items
   set edited = true
 where import_source is not null
   and edited = false;

alter table public.invoices
  add column if not exists dismissed_import_keys text[] not null default '{}';

comment on column public.invoices.dismissed_import_keys is
  'Import keys deleted from this invoice on purpose. The importer never re-inserts them — deleting a line is a decision, not a temporary state — 0175.';

-- ── THE UPSERT ────────────────────────────────────────────────────────────────
-- Replaces replace_imported_invoice_items for keyed callers. Same advisory lock and
-- the same SECURITY INVOKER stance as 0156: RLS still governs every write.
create or replace function public.upsert_imported_invoice_items(
  p_invoice_id uuid,
  p_source     text,
  p_rows       jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_org        uuid;
  v_next_sort  integer;
  v_dismissed  text[];
  v_inserted   integer := 0;
  v_updated    integer := 0;
  v_removed    integer := 0;
  v_kept       integer := 0;
begin
  if p_source is null or p_source = '' then
    raise exception 'An import source is required.';
  end if;

  -- Same lock as 0156: two overlapping imports of one source on one invoice must not
  -- interleave. Different invoices, and labor vs costs on one invoice, never contend.
  perform pg_advisory_xact_lock(hashtext(p_invoice_id::text || ':' || p_source));

  -- Announce that the IMPORTER is doing this, transaction-locally. Both triggers below
  -- exist to catch a HUMAN touching a line; without this flag the importer's own refresh
  -- would mark every line it updated as "edited" (so nothing would ever refresh again),
  -- and its own tidy-up deletes would tombstone keys that merely left the source (so real
  -- work could never come back). The flag is the difference between "a person decided
  -- this" and "the machine reconciled it".
  perform set_config('cn.importing', '1', true);

  select org_id, coalesce(dismissed_import_keys, '{}')
    into v_org, v_dismissed
    from public.invoices where id = p_invoice_id;
  if v_org is null then
    raise exception 'Invoice not found.';
  end if;

  -- Incoming rows, minus anything the office already deleted on purpose.
  create temp table _incoming on commit drop as
  select
    r->>'import_key'                              as import_key,
    r->>'description'                             as description,
    coalesce((r->>'quantity')::numeric, 1)        as quantity,
    coalesce(r->>'unit', 'ea')                    as unit,
    coalesce((r->>'unit_price')::numeric, 0)      as unit_price,
    ord                                            as ord
  from jsonb_array_elements(p_rows) with ordinality as t(r, ord)
  where coalesce(r->>'import_key', '') <> ''
    and not (r->>'import_key' = any (v_dismissed));

  -- 1. GONE FROM THE SOURCE → remove, unless a human touched it. A keyed line whose
  --    time entry or bill no longer exists should not keep billing; one that was edited
  --    is now the office's line, not the importer's.
  delete from public.invoice_items ii
   where ii.invoice_id = p_invoice_id
     and ii.import_source = p_source
     and ii.import_key is not null
     and ii.edited = false
     and not exists (select 1 from _incoming i where i.import_key = ii.import_key);
  get diagnostics v_removed = row_count;

  -- 2. UNKEYED LEGACY ROWS for this source. They predate 0175 and were all marked
  --    edited by the backfill, so this clears only rows created keyless afterwards.
  delete from public.invoice_items ii
   where ii.invoice_id = p_invoice_id
     and ii.import_source = p_source
     and ii.import_key is null
     and ii.edited = false;

  -- 3. EXISTING + UNEDITED → refresh in place. Keeps sort_order, so the invoice does
  --    not reshuffle under the office every time they re-import.
  update public.invoice_items ii
     set description = i.description,
         quantity    = i.quantity,
         unit        = i.unit,
         unit_price  = i.unit_price
    from _incoming i
   where ii.invoice_id = p_invoice_id
     and ii.import_source = p_source
     and ii.import_key = i.import_key
     and ii.edited = false;
  get diagnostics v_updated = row_count;

  select count(*) into v_kept
    from public.invoice_items ii
    join _incoming i on i.import_key = ii.import_key
   where ii.invoice_id = p_invoice_id
     and ii.import_source = p_source
     and ii.edited = true;

  -- 4. GENUINELY NEW → append. This is "bill the work that has accrued since", and it
  --    is the whole point of the migration.
  select coalesce(max(sort_order), -1) + 1 into v_next_sort
    from public.invoice_items where invoice_id = p_invoice_id;

  insert into public.invoice_items
    (invoice_id, org_id, import_source, import_key, sort_order, description, quantity, unit, unit_price)
  select
    p_invoice_id, v_org, p_source, i.import_key,
    v_next_sort + (row_number() over (order by i.ord))::int - 1,
    i.description, i.quantity, i.unit, i.unit_price
  from _incoming i
  where not exists (
    select 1 from public.invoice_items ii
     where ii.invoice_id = p_invoice_id
       and ii.import_source = p_source
       and ii.import_key = i.import_key
  );
  get diagnostics v_inserted = row_count;

  -- Reported so the UI can say what happened in the office's own terms — "3 added,
  -- 2 updated, 5 of your edited lines left alone" beats a green "imported" toast.
  return jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated,
    'kept_edited', v_kept, 'removed', v_removed
  );
end $$;

comment on function public.upsert_imported_invoice_items(uuid, text, jsonb) is
  'Additive import: match by import_key, refresh unedited lines, append new ones, never touch an edited line, never resurrect a dismissed one. Replaces the delete-and-rebuild of 0156 for keyed callers. SECURITY INVOKER — RLS still governs (0175).';

grant execute on function public.upsert_imported_invoice_items(uuid, text, jsonb) to authenticated;

-- ── DELETING A LINE IS A DECISION ─────────────────────────────────────────────
-- Record the key so the next import does not bring it back.
create or replace function public.tombstone_dismissed_import_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only a HUMAN deleting a line is a decision. The importer's own reconciliation deletes
  -- must not tombstone anything — see the flag set in upsert_imported_invoice_items.
  if coalesce(current_setting('cn.importing', true), '') = '1' then
    return old;
  end if;
  if old.import_key is not null then
    update public.invoices
       set dismissed_import_keys =
             (select array(select distinct unnest(coalesce(dismissed_import_keys, '{}') || old.import_key)))
     where id = old.invoice_id;
  end if;
  return old;
end $$;

drop trigger if exists invoice_items_tombstone_key on public.invoice_items;
create trigger invoice_items_tombstone_key
  after delete on public.invoice_items
  for each row
  execute function public.tombstone_dismissed_import_key();

-- ── AN EDIT MARKS THE LINE AS THE OFFICE'S ────────────────────────────────────
-- A trigger rather than app code on purpose: invoice_items is writable through RLS
-- directly (PostgREST PATCH), so a guard that lives only in the server action is a
-- convention. This is the same lesson as the offline-punch ceiling and the /site/
-- cookie check — enforce it where the write actually lands.
create or replace function public.mark_invoice_item_edited()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('cn.importing', true), '') = '1' then
    return new; -- the importer refreshing its own line is not an edit
  end if;
  if new.import_key is not null and new.edited = old.edited then
    if new.description is distinct from old.description
       or new.quantity is distinct from old.quantity
       or new.unit_price is distinct from old.unit_price
       or new.unit is distinct from old.unit then
      new.edited := true;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists invoice_items_mark_edited on public.invoice_items;
create trigger invoice_items_mark_edited
  before update on public.invoice_items
  for each row
  execute function public.mark_invoice_item_edited();
