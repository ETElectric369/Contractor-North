/**
 * WHICH material_list_items COLUMNS A TECH MAY READ (cn-v945).
 *
 * The job's ONE materials list is the crew's list too — they read it and write to it from the
 * truck — but est_cost and vendor are the office's money and never reach a tech's phone.
 * Projected at the query, not filtered after: a column that was never selected can't leak
 * through a later "just spread it" edit, and it never rides the RSC payload. is_tool stays:
 * the tools-first grouping is a field convenience (load what you own, then shop), not a price.
 *
 * One list, two doors — /materials/[id] and the job hub's Materials tab — and both pick their
 * select list HERE, so a column added to the table stays invisible to the crew until someone
 * decides it is safe for them to read. Migration 0254's trigger pins the write side (a tech's
 * line lands with no price, no vendor); this is the read side.
 */
export const TECH_ITEM_COLUMNS = "id, list_id, description, part_number, quantity, unit, purchased, purchased_at, is_tool, sort_order";
