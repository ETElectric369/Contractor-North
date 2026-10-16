import type { ShelfRow } from "@/lib/stock-take";

/**
 * WHAT THE SHELF HAS of a list's lines (Erik, 2026-10-15, twice: "get rid of pricing on the
 * materials list as it is just for reference, a bill is a cost. However, it could show if stock is
 * available"). The checklist prints no money any more — the price book prices, a bill costs — and
 * where the shop shelf holds a line's item, the line says "In Stock · N". By NAME, exactly (case and
 * spaces aside): the shelf has no part numbers, and a loose match would let "12/2 NM" read as the
 * 250-ft roll. Only what is actually on hand; nothing read (the shelf off, a failed read) = nothing said.
 */
export type StockOnShelf = Record<string, { onHand: number; unit: string }>;

const norm = (s: unknown): string =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

export function stockForLines(
  rows: readonly Pick<ShelfRow, "name" | "unit" | "onHand">[] | null | undefined,
  items: readonly { id: string; description?: string | null }[] | null | undefined,
): StockOnShelf {
  const byName = new Map<string, { onHand: number; unit: string }>();
  for (const r of rows ?? []) {
    const key = norm(r.name);
    if (!key || !(Number(r.onHand) > 0)) continue;
    const cur = byName.get(key);
    const unit = String(r.unit ?? "");
    if (cur && cur.unit !== unit) continue; // 250 ft and 2 rolls are not 252 of anything: the first unit holds
    byName.set(key, { onHand: (cur?.onHand ?? 0) + Number(r.onHand), unit: cur?.unit ?? unit });
  }
  const out: StockOnShelf = {};
  for (const it of items ?? []) {
    const hit = byName.get(norm(it.description));
    if (hit && it.id) out[String(it.id)] = hit;
  }
  return out;
}

/** "In Stock · 12 ea" — the line's own words for what the shelf holds. */
export function inStockWords(s: { onHand: number; unit: string }): string {
  const n = String(Math.round(s.onHand * 100) / 100);
  return `In Stock · ${n}${s.unit ? ` ${s.unit}` : ""}`;
}
