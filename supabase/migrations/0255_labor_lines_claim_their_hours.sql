-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0255: a labor line claims the hours it bills
--
-- Erik, 2026-09-11, 18:59, from the Invoices tab of 85 Whitney Place (J-028):
--   "i couldnt even make an invoice for 85 whitney… kept referring to the old invoice even
--    though i have new time and new bills… i tried progress payments and nothing"
--
-- J-028 has ONE invoice, INV-061 — standard, PAID. Since it went out: one new time entry (Brian,
-- 09-10, 5.25 hr) and two new CED bills ($1,529.55). Every door he tried refused, and every
-- refusal pointed at another door that refused:
--   New Invoice          → "already invoiced on INV-061 — opened it instead"   (paid = locked)
--   Progress Payment     → "INV-061 is already billing labor/materials — bill the rest there,
--                           or void it"                                         (can't; paid)
--   Blank invoice+import → "labor is already billed on INV-061 … bill extra work as a
--                           progress payment"                                    (see above)
--
-- WHY IT WAS BUILT THAT WAY. The real invariant has always been "never bill the same hour twice".
-- A materials line carries a key (po:<id>, bill:<id>, bli:<id>) so an import can tell what is
-- already billed. A LABOR line carried only labor:<person> — nothing said WHICH hours it held —
-- so the only way cn-v479 could stop the Tao chandelier double was to forbid a SECOND invoice on
-- the job outright. That also forbade billing anything NEW once the first invoice went out, which
-- is Erik's everyday T&M rhythm: bill what's new since the last invoice, get paid on the spot.
--
-- WHAT THIS ADDS. invoice_items.source_ids — the time_entry / time_allocation ids a labor line
-- bills (and, for the other importers, the bill / PO / change-order / estimate-line ids). The
-- invariant moves to the ROW: an id is claimed by at most one non-void invoice, the importers skip
-- claimed rows and write their own claims, and a second invoice (or a progress draw) carries only
-- what is new. The claim lives with the line and dies with it — deleting the line, voiding the
-- invoice, or starting the import over (0204) releases the rows for free; nothing new to tidy.
--
-- The upsert RPC (0175) learns an optional per-row source_ids. An EDITED line keeps the claims it
-- already holds and takes no new ones: its hours were negotiated by a person, and hours that arrive
-- later are not on it, so they stay free for the next bill. That is the same contract 0175 made
-- for the price — the importer never overrules a decision the office already made.
--
-- 0256 backfills claims for the invoices that predate this (dry run first — see that file).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.invoice_items
  add column if not exists source_ids uuid[] not null default '{}';

comment on column public.invoice_items.source_ids is
  'The source rows this imported line bills — time_entry / time_allocation ids on a labor line; bill, purchase_order, change_order or quote_line_item ids on the others. A row is billed on at most ONE non-void invoice: the importers skip ids claimed elsewhere on the job. Empty on hand-typed lines. 0255.';

-- ── THE UPSERT, with claims ───────────────────────────────────────────────────
-- Same lock, same SECURITY INVOKER stance, same four-way reconcile as 0175. Two changes:
--   * every incoming row may carry source_ids (jsonb array of uuids); refreshed lines take the new
--     set, appended lines carry it, EDITED lines keep what they have (see the header);
--   * `drop table if exists _incoming` first — two imports in ONE transaction (a draw builds labor
--     then costs; the integration test does the same) used to die on "relation already exists".
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

  -- Announce that the IMPORTER is doing this, transaction-locally. Both 0175 triggers exist to
  -- catch a HUMAN touching a line; without this flag the importer's own refresh would mark every
  -- line it updated as "edited" and its own tidy-up deletes would tombstone keys.
  perform set_config('cn.importing', '1', true);

  select org_id, coalesce(dismissed_import_keys, '{}')
    into v_org, v_dismissed
    from public.invoices where id = p_invoice_id;
  if v_org is null then
    raise exception 'Invoice not found.';
  end if;

  -- Incoming rows, minus anything the office already deleted on purpose.
  drop table if exists _incoming;
  create temp table _incoming on commit drop as
  select
    r->>'import_key'                              as import_key,
    r->>'description'                             as description,
    coalesce((r->>'quantity')::numeric, 1)        as quantity,
    coalesce(r->>'unit', 'ea')                    as unit,
    coalesce((r->>'unit_price')::numeric, 0)      as unit_price,
    -- The claim. Only well-formed uuids are kept, so a stray value can never poison the write.
    case when jsonb_typeof(r->'source_ids') = 'array'
         then coalesce(
                (select array_agg(distinct x::uuid)
                   from jsonb_array_elements_text(r->'source_ids') as x
                  where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
                '{}'::uuid[])
         else '{}'::uuid[] end                    as source_ids,
    ord                                            as ord
  from jsonb_array_elements(p_rows) with ordinality as t(r, ord)
  where coalesce(r->>'import_key', '') <> ''
    and not (r->>'import_key' = any (v_dismissed));

  -- 1. GONE FROM THE SOURCE → remove, unless a human touched it. A keyed line whose
  --    time entry or bill no longer exists should not keep billing; one that was edited
  --    is now the office's line, not the importer's. (Its claims go with it — that IS the release.)
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

  -- 3. EXISTING + UNEDITED → refresh in place, claims included. Keeps sort_order, so the
  --    invoice does not reshuffle under the office every time they re-import.
  update public.invoice_items ii
     set description = i.description,
         quantity    = i.quantity,
         unit        = i.unit,
         unit_price  = i.unit_price,
         source_ids  = i.source_ids
    from _incoming i
   where ii.invoice_id = p_invoice_id
     and ii.import_source = p_source
     and ii.import_key = i.import_key
     and ii.edited = false;
  get diagnostics v_updated = row_count;

  -- An EDITED line is left entirely alone — price AND claims (header: negotiated hours hold the
  -- rows they were negotiated over; later hours are not on the line, so they stay free).
  select count(*) into v_kept
    from public.invoice_items ii
    join _incoming i on i.import_key = ii.import_key
   where ii.invoice_id = p_invoice_id
     and ii.import_source = p_source
     and ii.edited = true;

  -- 4. GENUINELY NEW → append, with their claims. This is "bill the work that has accrued
  --    since", and it is the whole point of 0175 — and now it works across invoices too.
  select coalesce(max(sort_order), -1) + 1 into v_next_sort
    from public.invoice_items where invoice_id = p_invoice_id;

  insert into public.invoice_items
    (invoice_id, org_id, import_source, import_key, sort_order, description, quantity, unit, unit_price, source_ids)
  select
    p_invoice_id, v_org, p_source, i.import_key,
    v_next_sort + (row_number() over (order by i.ord))::int - 1,
    i.description, i.quantity, i.unit, i.unit_price, i.source_ids
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
  'Additive import: match by import_key, refresh unedited lines (price + source_ids claims), append new ones with their claims, never touch an edited line, never resurrect a dismissed one. SECURITY INVOKER — RLS still governs (0175, claims 0255).';

-- CREATE OR REPLACE keeps the function''s ACL, but say it anyway: the app calls this as the signed-in
-- user. (0257 takes EXECUTE away from PUBLIC/anon, which 0246 only thought it had done.)
grant execute on function public.upsert_imported_invoice_items(uuid, text, jsonb) to authenticated, service_role;
