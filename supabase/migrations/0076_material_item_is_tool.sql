-- Tools to the top: flag a material-list item as a TOOL (something to grab from the
-- shop) vs a consumable material to buy. Tools sort above materials so the field
-- crew loads what they own first, then shops for the rest.
alter table public.material_list_items
  add column if not exists is_tool boolean not null default false;
