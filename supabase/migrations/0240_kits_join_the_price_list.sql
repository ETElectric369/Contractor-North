-- 0240 — KITS JOIN THE PRICE LIST (Erik, 2026-09-03: "merge the kits and price list because that's
-- where all the kit magic should probably happen anyway").
--
-- Today a kit line is a COPY: description with the code glued in, a sell price frozen at the moment
-- it was added, no link to the item. So a kit never re-prices when the book changes, never
-- re-marks-up for a customer's level, and the order sheet can't find its cost. Same missing wire.
--
-- Three moves, all additive and reversible:
--   1. price_list_items.code becomes UNIQUE per org (case-insensitive, blanks exempt) — the join
--      key the importer refreshes by instead of duplicating. Verified 2026-09-03: no org has a
--      duplicate today.
--   2. The sizing rule ("kit magic", 0166) gains a home ON THE ITEM: qty_per_sqft / qty_per_lf /
--      qty_min / qty_round, same checks as kit_items. A linked kit line sizes from its item.
--   3. kit_items.price_list_item_id — a kit line may POINT at an item. Linked lines derive
--      description / unit / cost / markup / category / supplier live; unlinked lines keep the
--      frozen values they have today (nothing is lost, nothing is invented).
-- Backfill links by code (the "CODE — description" naming convention), then by exact normalized
-- description; anything else stays unlinked for a person to link or leave.

-- 1. one code, one row (per org)
create unique index if not exists price_list_items_org_code_uidx
  on public.price_list_items (org_id, lower(code))
  where code is not null and btrim(code) <> '';

-- 2. sizing lives on the item
alter table public.price_list_items
  add column if not exists qty_per_sqft numeric(12,4),
  add column if not exists qty_per_lf   numeric(12,4),
  add column if not exists qty_min      numeric(12,2),
  add column if not exists qty_round    text;
comment on column public.price_list_items.qty_per_sqft is 'Sizing: quantity per square foot of the measured job (NULL = not sized by area).';
comment on column public.price_list_items.qty_per_lf   is 'Sizing: quantity per linear foot of the measured job (NULL = not sized by length).';
comment on column public.price_list_items.qty_min      is 'Floor applied after the coefficients (a deck of any size needs four footings). NULL = none.';
comment on column public.price_list_items.qty_round    is 'up | nearest | none — NULL behaves as up, the safe direction for things bought whole.';
alter table public.price_list_items drop constraint if exists price_list_items_qty_round_ck;
alter table public.price_list_items add constraint price_list_items_qty_round_ck
  check (qty_round is null or qty_round in ('up', 'nearest', 'none'));
alter table public.price_list_items drop constraint if exists price_list_items_qty_coeff_ck;
alter table public.price_list_items add constraint price_list_items_qty_coeff_ck
  check (coalesce(qty_per_sqft, 0) >= 0 and coalesce(qty_per_lf, 0) >= 0 and coalesce(qty_min, 0) >= 0);

-- 3. a kit line may point at an item
alter table public.kit_items
  add column if not exists price_list_item_id uuid references public.price_list_items(id) on delete set null;
create index if not exists kit_items_price_list_item_idx on public.kit_items (price_list_item_id);
comment on column public.kit_items.price_list_item_id is
  'When set, this line derives description/unit/cost/markup/category/supplier/sizing from the item LIVE; quantity stays on the line. NULL = a frozen line (pre-0240 or hand-typed).';

-- Backfill (a): "CODE — description" lines whose CODE exists in the same org's book.
update public.kit_items ki
   set price_list_item_id = p.id
  from public.price_list_items p
 where ki.price_list_item_id is null
   and p.org_id = ki.org_id
   and p.archived = false
   and position(' — ' in ki.description) > 0
   and lower(btrim(split_part(ki.description, ' — ', 1))) = lower(btrim(p.code));

-- Backfill (b): exact normalized description match (whitespace-collapsed, case-insensitive),
-- only when it is unambiguous within the org.
update public.kit_items ki
   set price_list_item_id = m.id
  from (
    select p.org_id, lower(regexp_replace(btrim(p.description), '\s+', ' ', 'g')) as norm, min(p.id::text)::uuid as id, count(*) as n
      from public.price_list_items p
     where p.archived = false
     group by 1, 2
    having count(*) = 1
  ) m
 where ki.price_list_item_id is null
   and m.org_id = ki.org_id
   and lower(regexp_replace(btrim(ki.description), '\s+', ' ', 'g')) = m.norm;

-- Backfill (c): a linked line's sizing rule moves onto the item when the item has none yet.
update public.price_list_items p
   set qty_per_sqft = coalesce(p.qty_per_sqft, ki.qty_per_sqft),
       qty_per_lf   = coalesce(p.qty_per_lf,   ki.qty_per_lf),
       qty_min      = coalesce(p.qty_min,      ki.qty_min),
       qty_round    = coalesce(p.qty_round,    ki.qty_round)
  from public.kit_items ki
 where ki.price_list_item_id = p.id
   and (ki.qty_per_sqft is not null or ki.qty_per_lf is not null or ki.qty_min is not null or ki.qty_round is not null)
   and p.qty_per_sqft is null and p.qty_per_lf is null and p.qty_min is null and p.qty_round is null;

-- NOTE: no RLS change — price_list_items and kit_items keep their org-scoped, staff-only policies;
-- a new column and a new FK inherit them. The public estimate/site RPCs project explicit lists.
