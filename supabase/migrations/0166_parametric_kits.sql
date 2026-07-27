-- PARAMETRIC KITS (determinism survey, Wave D) — the generic form of lib/estimate/deck.ts.
--
-- THE SCALING TRAP THIS EXISTS TO AVOID. `deck.ts` is ~250 lines and 30+ tests that turn a few
-- measurements into quantities: footings = max(4, ceil(area/60)), railing = 2L+W, joists per foot,
-- and so on. It is exact, it is fast, it runs offline — and it serves exactly ONE trade. Written
-- again for concrete, again for roofing, again for tile, it becomes a module per trade, which is
-- O(trades) and stops being maintainable somewhere around the fifth one.
--
-- The observation that fixes it: nearly all of that arithmetic is "so much of this per square foot
-- / per linear foot / per each". That is not code — it is a COEFFICIENT. A kit item that knows it
-- needs 0.0167 footings per square foot expresses the deck rule as data, and the same three
-- columns express a roofer's squares-per-roof-area or a tiler's thinset-per-square-foot.
--
-- So: a kit stops being a fixed shopping list and becomes a formula the org authors. `quantity`
-- keeps its exact current meaning (a flat count) so every existing kit behaves identically; the
-- new columns are opt-in per line.

alter table public.kit_items
  add column if not exists qty_per_sqft numeric(12,4),
  add column if not exists qty_per_lf   numeric(12,4),
  -- Some lines are genuinely fixed no matter the size (one permit, one dumpster, one mobilization).
  -- Without this they'd have to be modelled as a coefficient of something they don't depend on.
  add column if not exists qty_min      numeric(12,2),
  add column if not exists qty_round    text;

comment on column public.kit_items.qty_per_sqft is
  'Units of this item per square foot of the job. NULL = not area-driven. With qty_per_lf, both contribute (a deck needs decking by area AND railing by perimeter).';
comment on column public.kit_items.qty_per_lf is
  'Units of this item per linear foot. NULL = not length-driven.';
comment on column public.kit_items.qty_min is
  'Floor applied AFTER the coefficients — deck.ts footings are max(4, ...) because a deck of any size needs four corners. NULL = no floor.';
comment on column public.kit_items.qty_round is
  'How to round the computed quantity: up | nearest | none. Materials you buy whole (footings, sheets, boxes) round UP; bulk you buy by the foot does not. NULL behaves as up, which is the safe direction — under-ordering sends someone back to the supply house.';

-- Only 'up' | 'nearest' | 'none' are understood downstream; anything else would silently fall
-- through to a default and make a quantity that looks authored but isn't.
alter table public.kit_items
  drop constraint if exists kit_items_qty_round_ck;
alter table public.kit_items
  add constraint kit_items_qty_round_ck
  check (qty_round is null or qty_round in ('up', 'nearest', 'none'));

-- A negative coefficient would silently subtract material from an estimate.
alter table public.kit_items
  drop constraint if exists kit_items_qty_coeff_ck;
alter table public.kit_items
  add constraint kit_items_qty_coeff_ck
  check (
    coalesce(qty_per_sqft, 0) >= 0
    and coalesce(qty_per_lf, 0) >= 0
    and coalesce(qty_min, 0) >= 0
  );

-- NOTE: no RLS change. kit_items is already org-scoped from 0004/0021; new columns inherit it.
