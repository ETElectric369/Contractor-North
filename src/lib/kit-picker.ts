// Kit Picker mapping — the pure core of "a kit is a template, the quote is the instance".
// The picker shows every kit item pre-checked; these helpers turn the (possibly edited,
// possibly partial) selection into quote lines without touching the kit itself.

import type { DraftLineItem } from "@/app/(app)/quotes/actions";
import { subtotalTaxTotal } from "@/lib/invoice-math";

/** One row in the Kit Picker: a kit item plus its in-picker state (checked + edits). */
export interface KitPickerRow {
  /** kit_items row id — present for persisted rows; an in-flight add gets one after the insert. */
  id?: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  sort_order: number;
  checked: boolean;
}

/** Raw kit_items shape as the pages select it (numerics may arrive as strings from PostgREST). */
export interface KitItemRaw {
  id?: string;
  description: string;
  quantity: number | string;
  unit: string | null;
  unit_price: number | string;
  sort_order?: number | string | null;
}

/** Stable order by sort_order (input order breaks ties) — the kit's authored order wins,
 *  and two items with the same sort_order (legacy rows all default 0) keep their DB order. */
function stableBySortOrder<T extends { sort_order: number }>(rows: T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.sort_order - b.r.sort_order || a.i - b.i)
    .map(({ r }) => r);
}

/** Kit items → picker rows: everything pre-checked (open → Add keeps the one-tap feel),
 *  numerics coerced the same way the old instant-import did (qty 0/blank → 1, price blank → 0). */
export function kitItemsToPickerRows(items: KitItemRaw[]): KitPickerRow[] {
  return stableBySortOrder(
    (items ?? []).map((it) => ({
      id: it.id,
      description: it.description ?? "",
      quantity: Number(it.quantity) || 1,
      unit: it.unit || "ea",
      unit_price: Number(it.unit_price) || 0,
      sort_order: Number(it.sort_order) || 0,
      checked: true,
    })),
  );
}

/** Selection → quote lines: only checked rows, with their edited qty/price/description,
 *  in kit order, each tagged with the kit's name as its collapsible group. Blank
 *  descriptions are dropped (the quote save filters them anyway). Qty is NOT re-coerced
 *  0 → 1 here: rows arrive pre-normalized (kitItemsToPickerRows), so a 0 is a USER-cleared
 *  qty whose on-screen row total reads $0.00 — re-inflating it would silently charge for it. */
export function kitSelectionToLines(kitName: string, rows: KitPickerRow[]): DraftLineItem[] {
  return stableBySortOrder(rows.filter((r) => r.checked && r.description.trim())).map((r) => ({
    description: r.description,
    quantity: Number(r.quantity) || 0,
    unit: r.unit || "ea",
    unit_price: Number(r.unit_price) || 0,
    group: kitName,
  }));
}

/** Running subtotal of the checked rows — via THE shared rounding (subtotalTaxTotal),
 *  so the picker footer can never show a cent off from the quote preview it feeds. */
export function kitSelectionSubtotal(rows: KitPickerRow[]): number {
  return subtotalTaxTotal(
    kitSelectionToLines("x", rows).map((l) => l.quantity * l.unit_price),
    0,
  ).subtotal;
}
