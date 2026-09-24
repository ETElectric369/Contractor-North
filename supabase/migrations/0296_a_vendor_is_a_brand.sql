-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0296: a vendor is a brand, and a brand has a phone number
--
-- Erik, answering for Justin Vivian (Vivian Builders), 2026-09-24:
--     "vendor means what brand with its own cost and sell price"
--
-- So a VENDOR is the maker: Andersen, Milgard, Marvin. 0282 already built exactly that as
-- price_list_item_options (one price-list code, many makers, each with its own buy_price and
-- markup_pct, one flagged as the default). This migration adds the two things that were missing:
--
--  1. price_list_vendors: ONE row per vendor name per org, holding what a person needs to reach
--     them (contact person, phone, email, website, address, notes). It is keyed by NAME, the same
--     name price_list_item_options.vendor carries, compared case-insensitively. There is no foreign
--     key from the options on purpose: an option written before its vendor has a card is still a
--     vendor, the card is optional, and a vendor with contact details and no items yet is allowed
--     (Justin adds the vendor first, then puts it on items). Renames go through one server action
--     that rewrites both sides.
--
--  2. price_list_item_options.markup_pct widens from numeric(6,2) to numeric(12,6). Typing a SELL
--     price sets the markup, and with two decimals of percent a $12,000 window cannot land on the
--     cent somebody typed (one hundredth of a percent of $12,000 is $1.20). Six decimals reproduce
--     any typed sell to the cent for a cost under $500,000. The app writes the fewest decimals
--     that reproduce the typed sell, so a typed 25% is still stored as 25.
--
-- RLS: the org reads its vendor cards, staff write them. A vendor's phone number is not a price,
-- and a tech on a job may need to call the window company; the prices stay on
-- price_list_item_options, which stays staff-only (0254's law). Tenant isolation lives in the
-- policy itself (org_id = auth_org_id()) on every verb, never in a read path (the 0173 law).
--
-- ORDER: any time after 0282. Safe before or after the code: the page degrades to "no vendor
-- cards" when the table is absent, and a markup written with more decimals than the old column
-- holds is rounded by Postgres to two, which the app then shows (never hides).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.price_list_vendors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- The brand, spelled the way the org wants it read. Matched case-insensitively against
  -- price_list_item_options.vendor.
  name text not null check (length(btrim(name)) between 1 and 120),
  contact_name text,
  phone text,
  email text,
  website text,
  address text,
  notes text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

comment on table public.price_list_vendors is
  'A vendor (the brand: Andersen, Milgard) and how to reach it. One row per name per org, matched case-insensitively to price_list_item_options.vendor, where each item''s cost and sell for that vendor live.';

-- ONE CARD PER NAME. "Andersen" and "andersen " are the same vendor; two cards would split its
-- items across two phone numbers.
create unique index if not exists price_list_vendors_one_per_name
  on public.price_list_vendors (org_id, lower(btrim(name)));

drop trigger if exists stamp_org_price_list_vendors on public.price_list_vendors;
create trigger stamp_org_price_list_vendors
  before insert on public.price_list_vendors
  for each row execute function public.set_org_id();

drop trigger if exists touch_price_list_vendors on public.price_list_vendors;
create trigger touch_price_list_vendors
  before update on public.price_list_vendors
  for each row execute function public.touch_updated_at();

alter table public.price_list_vendors enable row level security;

drop policy if exists price_list_vendors_read on public.price_list_vendors;
create policy price_list_vendors_read on public.price_list_vendors
  for select using (org_id = public.auth_org_id());

drop policy if exists price_list_vendors_insert on public.price_list_vendors;
create policy price_list_vendors_insert on public.price_list_vendors
  for insert with check (org_id = public.auth_org_id() and public.is_org_staff());

drop policy if exists price_list_vendors_update on public.price_list_vendors;
create policy price_list_vendors_update on public.price_list_vendors
  for update using (org_id = public.auth_org_id() and public.is_org_staff())
  with check (org_id = public.auth_org_id() and public.is_org_staff());

-- No delete policy: archive, never delete (a card is how somebody found the rep's number last
-- year). The service role still can, for an org being removed.

-- THE SELL SOMEBODY TYPED, TO THE CENT. See (2) above. Widening numeric keeps every stored value.
alter table public.price_list_item_options
  alter column markup_pct type numeric(12,6);
