// Kit Picker mapping — the pure core of "a kit is a template, the quote is the instance".
// The picker shows every kit item pre-checked; these helpers turn the (possibly edited,
// possibly partial) selection into quote lines without touching the kit itself.

import type { DraftLineItem } from "@/app/(app)/quotes/actions";
import { subtotalTaxTotal } from "@/lib/invoice-math";
import { sellPrice } from "@/lib/pricing/markup";
import { kitLineView, linkedItemOf, type KitLineRaw, type KitLinkedItem, type KitPricing } from "@/lib/kit-line";

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
  /** 0240: true when the row opened LIVE from a price-list item (name/unit/price came from the
   *  book, marked up for THIS customer). The picker shows it; edits stay quote-only either way. */
  linked?: boolean;
  code?: string | null;
  /** The item's buy price when linked — so the picker can show margin, and the order sheet
   *  downstream never has to back a cost out of a sell. */
  cost?: number | null;
  price_list_item_id?: string | null;
}

/** Raw kit_items shape as the pages select it (THE SHARED SELECT SHAPE, kit-line.ts). Numerics
 *  may arrive as strings from PostgREST; the 0166/0240 columns are absent on an older row. */
export type KitItemRaw = KitLineRaw;

/** How the picker prices a LINKED line. `orgDefaultPct` + `levelPct` feed THE rule directly
 *  (effectiveMarkupPct via kitLineView). `markupFor` is for a caller that already owns the rule
 *  as a function — AddLineItems' markupFor, the same closure its price-list typeahead uses — so
 *  the two "add" doors on one page can never price the same item differently. When given, it
 *  wins for linked lines. */
export type KitPickerPricing = KitPricing & {
  markupFor?: (item: KitLinkedItem) => number;
};

/** Stable order by sort_order (input order breaks ties) — the kit's authored order wins,
 *  and two items with the same sort_order (legacy rows all default 0) keep their DB order. */
function stableBySortOrder<T extends { sort_order: number }>(rows: T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.sort_order - b.r.sort_order || a.i - b.i)
    .map(({ r }) => r);
}

/** Kit items → picker rows: pre-checked (open → Add keeps the one-tap feel), numerics
 *  coerced the way the old instant-import did for MISSING values (qty null/blank → 1,
 *  price blank → 0). An EXPLICIT qty 0 is different: the write path (kit-actions
 *  updateKitItems/addKitItem) deliberately persists it as a template value, so it must
 *  come back as 0 — and the row opens UNCHECKED, because one confirm would otherwise
 *  silently re-bill a line the kit author zeroed.
 *
 *  0240: a LINKED line opens with the LIVE description/unit/price from its item, marked up for
 *  the customer this estimate is for (the gap this closes: kits ignored the customer's level and
 *  quoted whatever price was frozen in when the line was authored). Unlinked lines are unchanged.
 *  Without `pricing` a linked line still prices live — item markup → 0 — so a caller that has
 *  not been taught the customer yet is never worse than the frozen price it replaced. */
export function kitItemsToPickerRows(items: KitItemRaw[], pricing?: KitPickerPricing): KitPickerRow[] {
  const ctx: KitPricing = { orgDefaultPct: pricing?.orgDefaultPct ?? 0, levelPct: pricing?.levelPct ?? null };
  return stableBySortOrder(
    (items ?? []).map((it) => {
      const raw = it.quantity;
      const num = Number(raw);
      const missing = raw === null || raw === undefined || raw === "" || !Number.isFinite(num);
      const quantity = missing ? 1 : num;
      const view = kitLineView(it, ctx);
      const item = view.linked ? linkedItemOf(it) : null;
      // The caller's own rule beats the numbers when it has one (see KitPickerPricing).
      const unit_price =
        item && pricing?.markupFor ? sellPrice(view.cost ?? 0, pricing.markupFor(item)) : view.unit_price;
      return {
        id: it.id,
        description: view.description,
        quantity,
        unit: view.unit,
        unit_price,
        sort_order: Number(it.sort_order) || 0,
        // OPT IN, not opt out (Chris: "Don't auto select all items"). A kit is a
        // TEMPLATE of what a job could need, not a bill of everything — pre-checking
        // it all meant unchecking a dozen rows on every estimate, and anything missed
        // silently billed the customer for material that was never used.
        checked: false,
        linked: view.linked,
        code: view.code,
        cost: view.cost,
        price_list_item_id: item?.id ?? null,
      };
    }),
  );
}

/** Selection → quote lines: only checked rows, with their edited qty/price/description,
 *  in kit order, each tagged with the kit's name as its collapsible group. Blank
 *  descriptions are dropped (the quote save filters them anyway). Qty is NOT re-coerced
 *  0 → 1 here: a 0 is either a USER-cleared qty or a template 0 the author saved
 *  (kitItemsToPickerRows keeps it) — either way the on-screen row total reads $0.00,
 *  so re-inflating it would silently charge for it. */
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
