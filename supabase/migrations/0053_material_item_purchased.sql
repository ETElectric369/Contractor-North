-- Migration 0053: track which material-list items have been purchased, so a
-- take-off doubles as a shopping checklist. Additive + backward compatible.
alter table public.material_list_items
  add column if not exists purchased boolean not null default false,
  add column if not exists purchased_at timestamptz;
