-- 0241 — COUNTED PER MEASUREMENT (Erik, 2026-09-04: "these labels make no sense at all and don't
-- apply to the item" — a conduit strap asked for its count per square foot of the job).
--
-- 0166/0240 gave an item two ways to size itself: per square foot and per linear foot — the deck's
-- two dimensions, hard-wired. Every other trade measures other things: conduit run, device count,
-- fixture count, ceiling height, stair steps, doors. Those measurements already exist as the org's
-- own walk-through questions (playbook needs marked `measured`, keyed by name).
--
-- So an item may now say: "counted per <one of the org's measurements>, so many per". One pair
-- of columns, generic:
--   sized_by  — the walk-through need's key (e.g. 'run_ft', 'device_count'), or one of two built-ins
--               the deck flow already computes: 'area_sqft' (length × width or an explicit area) and
--               'length_lf' (an explicit linear/railing/perimeter run, else the perimeter).
--   qty_per   — how many of the item per ONE unit of that measurement.
-- qty_min / qty_round (0240) apply after, as before. qty_per_sqft / qty_per_lf stay for the lines and
-- items that carry them; the sizing math prefers sized_by/qty_per when set.

alter table public.price_list_items
  add column if not exists sized_by text,
  add column if not exists qty_per  numeric(12,4);
comment on column public.price_list_items.sized_by is
  'Counted per this measurement: a walk-through need key (measured number), or the built-ins area_sqft / length_lf. NULL = fixed quantity (or the legacy qty_per_sqft / qty_per_lf).';
comment on column public.price_list_items.qty_per is
  'How many of this item per ONE unit of sized_by''s measurement.';
alter table public.price_list_items drop constraint if exists price_list_items_qty_per_ck;
alter table public.price_list_items add constraint price_list_items_qty_per_ck
  check (qty_per is null or qty_per >= 0);
alter table public.price_list_items drop constraint if exists price_list_items_sized_by_ck;
alter table public.price_list_items add constraint price_list_items_sized_by_ck
  check (sized_by is null or (length(btrim(sized_by)) between 1 and 64));

-- Backfill: an item already sized by area or length gets the generic pair too, so one reader
-- (sized_by/qty_per) covers everything going forward.
update public.price_list_items
   set sized_by = 'area_sqft', qty_per = qty_per_sqft
 where sized_by is null and coalesce(qty_per_sqft, 0) > 0;
update public.price_list_items
   set sized_by = 'length_lf', qty_per = qty_per_lf
 where sized_by is null and coalesce(qty_per_lf, 0) > 0;

-- NOTE: no RLS change — new columns inherit the table's org-scoped, staff-only policies.
