-- ═══════════════════════════════════════════════════════════════════════════
-- Contractor North — migration 0341: a vendor has a kind
--
-- Andrew (Vivian Builders), 2026-09-25, dropped his vendor list on the Vendors tab: 29 names, and
-- about 23 of them are SUBCONTRACTORS (Granite Peak Plumbing, Coldwater Drywall), a few are SUPPLIERS
-- (Lakeside Windows, Northgate Iron), and some nobody can tell from the name. 0296 said "a
-- vendor is the brand" and every vendor name was offered as a brand in an item's price picker, so
-- Coldwater Drywall would have shown up as a maker of windows.
--
-- Erik said Go to one directory with a Kind:
--
--   kind   'brand' | 'supplier' | 'subcontractor', or NULL = Not Sorted. Only brand, supplier and
--          Not Sorted are offered as a vendor on an item; a subcontractor never is. Every card that
--          exists today was added under 0296's "a vendor is the brand", so it is backfilled to
--          'brand' and today's prices behave exactly as before. (Live 2026-09-25: 0 cards in any
--          org, so the backfill is a formality that keeps the rule true if one lands first.)
--   trade  the trade in plain words ("Plumbing", "Windows"), at most 60 characters.
--   is_person  the name is a person's (Maria Delgado), not a company's. A guess the import makes and a
--          person can change; it changes the words the app uses, nothing else.
--   import_batch  the one Add press that created this card, so Undo can archive exactly that
--          batch and nothing else. Indexed with org_id, the way Undo reads it.
--
-- UNCHANGED: RLS (0296's read / staff insert / staff update, tenant line on every verb), no delete
-- policy (archive, never delete), set_org_id, touch_updated_at, and the exact one-per-name index
-- on (org_id, lower(btrim(name))). Undo relies on touch_updated_at firing on UPDATE only: an
-- insert leaves updated_at = created_at (both now() of the inserting transaction), so a card that
-- nobody has touched since the import is exactly one whose two stamps are still equal.
--
-- ORDER: any time after 0296. Safe before or after the code: the page asks for these columns first
-- and retries without them, and the import says in words that sorting arrives with the update.
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- THE BACKFILL RUNS ONCE, in the same step that adds the column. Every card made before kinds
-- existed was made as a brand (0296's words, on the screen and in the code). A re-run finds the
-- column already there and touches nothing, so a card a person left Not Sorted stays Not Sorted.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'price_list_vendors' and column_name = 'kind'
  ) then
    alter table public.price_list_vendors add column kind text;
    update public.price_list_vendors set kind = 'brand';
  end if;
end $$;

alter table public.price_list_vendors
  add column if not exists trade text,
  add column if not exists is_person boolean not null default false,
  add column if not exists import_batch uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'price_list_vendors_kind_check') then
    alter table public.price_list_vendors
      add constraint price_list_vendors_kind_check check (kind is null or kind in ('brand', 'supplier', 'subcontractor'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'price_list_vendors_trade_check') then
    alter table public.price_list_vendors
      add constraint price_list_vendors_trade_check check (trade is null or length(btrim(trade)) between 1 and 60);
  end if;
end $$;

create index if not exists price_list_vendors_import_batch
  on public.price_list_vendors (org_id, import_batch)
  where import_batch is not null;

comment on column public.price_list_vendors.kind is
  'brand | supplier | subcontractor, NULL = Not Sorted (0341). A subcontractor is never offered as a vendor on an item.';
comment on column public.price_list_vendors.trade is
  'The trade in plain words, e.g. Plumbing or Windows (0341). At most 60 characters.';
comment on column public.price_list_vendors.is_person is
  'The name is a person''s, not a company''s (0341). A guess the import makes; a person can change it.';
comment on column public.price_list_vendors.import_batch is
  'The Add press that created this card (0341), so Undo archives exactly that batch, and only the cards nobody has edited since.';
