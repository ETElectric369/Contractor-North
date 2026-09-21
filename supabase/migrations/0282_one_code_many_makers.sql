-- ONE ITEM CODE, SEVERAL THINGS THAT COULD FILL IT (Andrew, for Justin Vivian, 2026-09-20):
--
--     Nort - pricelist
--       increase drop down options for each item code
--       multiple vendors / multiple items
--       ie. windows - mfg Andersen / mfg Milgard / mfg Marvin
--
-- Vivian Builders' code 830 is "Windows (Materials) (Allowance)" at $830.00, one row, no supplier.
-- That allowance is a builder's placeholder for a decision nobody has made yet, and the decision is
-- WHOSE window. Three manufacturers, three prices, and the estimate has to be able to say which.
--
-- `price_list_items` is unique on (org_id, lower(code)), and twelve places in the app read the list
-- on the assumption that a code names one thing. Breaking that to let 830 appear three times would
-- put the question "which 830 did you mean?" into every one of them. So the code keeps meaning one
-- line on an estimate, and gains a list of things that can FILL it.
--
-- THE ITEM'S OWN PRICE STAYS THE DEFAULT, deliberately. Every existing item has one and nothing
-- about it changes: an item with no options priced the way it always was, and an option is only
-- ever an answer to "instead of the allowance, use this one". That is also why `markup_pct` is
-- nullable here - an option that does not state one falls through to the item's, and then to the
-- org default, which is the one markup rule this app already has (pricing/markup.ts).
create table if not exists public.price_list_item_options (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  item_id uuid not null references public.price_list_items(id) on delete cascade,

  -- WHO MAKES IT. "Andersen", "Milgard", "Marvin" - the manufacturer, which for a builder is the
  -- thing being chosen. It is not `supplier`: the supplier is who he buys it FROM, and the same
  -- Andersen window comes from three lumber yards.
  vendor text not null,
  -- The product line or model, when the maker alone is not the answer: "400 Series", "Tuscany".
  label text,
  part_number text,

  unit text,
  buy_price numeric(12,4) not null,
  /** Null = use the item's own markup, then the org default. Never a silent 0. */
  markup_pct numeric(6,2),

  /** The one picked when nobody picks: shown first, and what a kit or an import resolves to. */
  is_default boolean not null default false,
  archived boolean not null default false,
  sort_order int not null default 0,

  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

comment on table public.price_list_item_options is
  'The things that can fill one price-list code: same code, different maker and price (Andersen / Milgard / Marvin under 830 Windows). The item keeps its own price as the default; an option overrides it when somebody chooses one.';

-- The same maker and line twice under one code is a typo, not a choice.
create unique index if not exists price_list_item_options_one_per_maker
  on public.price_list_item_options (item_id, lower(vendor), lower(coalesce(label, '')));

create index if not exists price_list_item_options_item_idx
  on public.price_list_item_options (item_id, sort_order)
  where archived = false;

-- AT MOST ONE DEFAULT PER ITEM, in the database rather than in whichever screen wrote last.
create unique index if not exists price_list_item_options_one_default
  on public.price_list_item_options (item_id)
  where is_default = true and archived = false;

-- 0270's tables taught this the hard way: a table created without set_org_id and with a NOT NULL
-- org_id refuses every insert that leaves the column to the database. Both triggers, like its parent.
drop trigger if exists stamp_org_price_list_item_options on public.price_list_item_options;
create trigger stamp_org_price_list_item_options
  before insert on public.price_list_item_options
  for each row execute function public.set_org_id();

drop trigger if exists touch_price_list_item_options on public.price_list_item_options;
create trigger touch_price_list_item_options
  before update on public.price_list_item_options
  for each row execute function public.touch_updated_at();

alter table public.price_list_item_options enable row level security;

-- Exactly its parent's rule: the price list is staff-only, both ways. A tech sees the materials
-- list on a job and never a buy price (0254's law).
drop policy if exists price_list_item_options_read on public.price_list_item_options;
create policy price_list_item_options_read on public.price_list_item_options
  for select using (org_id = public.auth_org_id() and public.is_org_staff());

drop policy if exists price_list_item_options_write on public.price_list_item_options;
create policy price_list_item_options_write on public.price_list_item_options
  for all using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());
