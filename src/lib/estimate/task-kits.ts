import { kitsSelectRungs, type KitLineRaw, type KitLinkedItem } from "@/lib/kit-line";
import type { TaskKit } from "./task-lines";

/**
 * TASK KITS, READ (W4, cn-v1076). A kit with `labor_minutes` (0386) is a TASK PER UNIT — "Footing":
 * his minutes for one, his parts for one — and it is what the Inspector's kit picker offers and
 * what the estimate's seed expands (expandTaskKit, task-lines.ts). An ordinary parts kit has no
 * minutes and is never offered to a task.
 *
 * ONE select shape for every page that needs task kits: the kit columns 0386 added, on top of
 * kit-line's shared item rungs, with a last rung without them — a deploy lands before its
 * migration, and naming an absent column fails the whole query rather than degrading.
 */

/** The kit columns a task kit needs (0386). */
export const TASK_KIT_COLS = "id, name, labor_minutes, unit";

/** Select strings, most capable first: with 0386's columns across every item rung, then without. */
export function taskKitSelectRungs(extraKitCols = ""): string[] {
  const full = extraKitCols ? `${TASK_KIT_COLS}, ${extraKitCols}` : TASK_KIT_COLS;
  const bare = extraKitCols ? `id, name, ${extraKitCols}` : "id, name";
  return [...kitsSelectRungs(full), ...kitsSelectRungs(bare)];
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Only the kits that are TASKS, coerced. Rows without minutes (ordinary kits, or a database
 *  before 0386) are not task kits, whatever else they carry. */
export function taskKitsFrom(rows: unknown): TaskKit[] {
  if (!Array.isArray(rows)) return [];
  const out: TaskKit[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const minutes = num(o.labor_minutes);
    if (minutes === null || minutes <= 0) continue;
    const id = typeof o.id === "string" ? o.id : "";
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!id || !name) continue;
    const unit = typeof o.unit === "string" && o.unit.trim() ? o.unit.trim() : null;
    out.push({ id, name, labor_minutes: Math.round(minutes), unit, items: Array.isArray(o.kit_items) ? (o.kit_items as KitLineRaw[]) : [] });
  }
  return out;
}

/** The keys of a linked item that are NOT money: what a line needs to name and size itself. */
const linkedWithoutMoney = (it: KitLinkedItem): KitLinkedItem => ({
  id: it.id,
  code: it.code ?? null,
  archived: it.archived ?? null,
  description: it.description,
  unit: it.unit ?? null,
  qty_per_sqft: it.qty_per_sqft ?? null,
  qty_per_lf: it.qty_per_lf ?? null,
  qty_min: it.qty_min ?? null,
  qty_round: it.qty_round ?? null,
  sized_by: it.sized_by ?? null,
  qty_per: it.qty_per ?? null,
});

/** THE SAME KITS WITH EVERY MONEY FIELD DROPPED — what the Inspector is handed. It previews a
 *  kit's hours and parts by name and count and never a price (a crew lead fills the visit in,
 *  0356), so the page sends nothing a price could be read from: no line snapshot price, no item
 *  buy price or markup, no vendor options. */
export function kitsWithoutMoney(kits: TaskKit[]): TaskKit[] {
  return kits.map((k) => ({
    ...k,
    items: k.items.map((it) => {
      const { unit_price: _price, price_list_items, ...rest } = it;
      const linked = Array.isArray(price_list_items) ? price_list_items[0] : price_list_items;
      return linked ? { ...rest, price_list_items: linkedWithoutMoney(linked) } : rest;
    }),
  }));
}
