"use client";

import { useMemo, useState } from "react";
import { ListPlus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { sellPrice } from "@/lib/pricing/markup";
import { KitPickerModal, type KitForPicker } from "@/app/(app)/quotes/new/kit-picker-modal";
import type { KitPickerPricing } from "@/lib/kit-picker";
import type { KitLinkedItem } from "@/lib/kit-line";
import type { DraftLineItem } from "@/lib/estimate/line-map";

/**
 * THE ONE WAY TO PUT A LINE ON A DOCUMENT.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 *
 * The owner's words: "there are different page layouts and options for new invoice vs edit
 * invoice, new estimate vs edit estimate... there really needs to be continuity of simplicity."
 *
 * He was describing a structural fact, not a styling one. The price-list typeahead and the kit
 * picker were written as INLINE JSX inside the new-estimate composer, which made them unreachable
 * from anywhere else — so the saved-estimate editor and the invoice editor each hand-rolled their
 * own thinner version. On a saved estimate the only way to add a line was to TYPE it into a bare
 * text box: no price list, no kits, no catalog at all. Same document, same table, three different
 * front doors, two of them worse.
 *
 * It also silently split fixes in half. The browse-on-empty behaviour (tap the box and see the
 * whole book, rather than being forced to guess a search term) was fixed in the composer and never
 * reached the invoice editor, because they were two separate blocks of markup that happened to
 * look similar.
 *
 * ── THE RULE THIS ENFORCES ───────────────────────────────────────────────────────────────────
 *
 *   A way to put data into a record is a COMPONENT that takes onAdd(lines) — never markup inside
 *   a page. If two surfaces write the same table, they import the same picker and are handed the
 *   same lookup list by the server. The page decides only what to DO with the result.
 *
 * Note what stays with the page and is deliberately NOT absorbed here: the page shell. A composer
 * (three-column, building something new) and a document view (single column, a live record with
 * Email/Status/Duplicate in its header) SHOULD look different. What must not differ is the set of
 * controls for doing the same job.
 */

export type PriceItemLite = {
  id: string;
  code: string | null;
  description: string;
  category?: string | null;
  unit: string;
  buy_price: number;
  markup_pct: number;
};

export function AddLineItems({
  priceItems = [],
  kits = [],
  /** The effective markup for a book item — the caller owns THE markup rule (customer level →
   *  item → org default), because only it knows which customer is selected. */
  markupFor,
  orgDefaultPct,
  levelPct,
  /** Measurements from the walk-through, so a self-sizing kit opens with real numbers. */
  measured,
  onAdd,
  className = "",
}: {
  priceItems?: PriceItemLite[];
  kits?: KitForPicker[];
  markupFor?: (p: PriceItemLite) => number;
  /** Optional plain numbers for the kit picker's linked lines (0240); when `markupFor` is given
   *  it wins, so a caller that already owns THE rule need not pass these. */
  orgDefaultPct?: number;
  levelPct?: number | null;
  measured?: { sqft?: number | null; linearFt?: number | null; byKey?: Record<string, number | null> | null };
  onAdd: (lines: DraftLineItem[]) => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [pickerKit, setPickerKit] = useState<KitForPicker | null>(null);

  const markup = (p: PriceItemLite) => (markupFor ? markupFor(p) : p.markup_pct || 0);

  // KITS PRICE THE WAY THE TYPEAHEAD DOES (0240). A linked kit line is a price-list item, so it
  // runs through the SAME markupFor the book picker above uses — the two "add" doors on one page
  // cannot quote the same item at two prices. This is the gap kits had: a frozen copy that
  // ignored the customer's pricing level.
  const kitPricing: KitPickerPricing = {
    orgDefaultPct: orgDefaultPct ?? 0,
    levelPct: levelPct ?? null,
    markupFor: markupFor
      ? (item: KitLinkedItem) =>
          markupFor({
            id: item.id,
            code: item.code ?? null,
            description: item.description,
            category: item.category ?? null,
            unit: item.unit ?? "ea",
            buy_price: Number(item.buy_price) || 0,
            markup_pct: Number(item.markup_pct) || 0,
          })
      : undefined,
  };

  // BROWSE ON EMPTY. Tapping the box with nothing typed shows the book rather than an empty
  // dropdown — you cannot search a catalog you have never seen. This was the fix that only ever
  // reached one of the three surfaces; living here, it reaches all of them by construction.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q
      ? priceItems.filter((p) => [p.code, p.description, p.category].some((v) => (v ?? "").toLowerCase().includes(q)))
      : priceItems;
    return pool.slice(0, q ? 25 : 200);
  }, [query, priceItems]);

  const addOne = (p: PriceItemLite) => {
    onAdd([
      {
        description: p.code ? `${p.code} — ${p.description}` : p.description,
        quantity: 1,
        unit: p.unit || "ea",
        unit_price: sellPrice(p.buy_price, markup(p)),
      },
    ]);
    setQuery("");
    setOpen(false);
  };

  if (!priceItems.length && !kits.length) return null;

  return (
    <div className={className}>
      {priceItems.length > 0 && (
        <div className="relative mb-3">
          <Input
            placeholder="Add from Price List — tap to browse, or search…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            // The blur delay lets a click on a row land before the list unmounts.
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
          {open && (
            <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
              {matches.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => addOne(p)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
                  >
                    <span className="min-w-0 truncate">
                      {p.code && <span className="mr-1 font-mono text-xs text-slate-400">{p.code}</span>}
                      {p.description}
                    </span>
                    <span className="shrink-0 text-slate-600">{formatCurrency(sellPrice(p.buy_price, markup(p)))}</span>
                  </button>
                </li>
              ))}
              {matches.length === 0 && (
                <li className="px-3 py-2 text-sm text-slate-400">
                  {priceItems.length === 0 ? "Your price list is empty." : "Nothing matches that."}
                </li>
              )}
              {/* Say when the list is capped. A silent slice reads as "that's everything". */}
              {!query.trim() && priceItems.length > matches.length && (
                <li className="border-t border-slate-100 px-3 py-2 text-xs text-slate-400">
                  Showing {matches.length} of {priceItems.length} — type to narrow it down.
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {/* Categories as BUTTONS. As a <Select> reading "+ Add from a kit…" this was invisible —
          it looked like one more form field, and on iOS it opened the native wheel instead of a
          list. Naming the lists out loud is the whole fix. */}
      {kits.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-xs font-medium text-slate-500">Add from a list</p>
          <div className="flex flex-wrap gap-2">
            {kits.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => setPickerKit(k)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-brand hover:text-brand"
              >
                <ListPlus className="h-3.5 w-3.5" />
                {k.name}
                <span className="text-xs font-normal text-slate-400">{k.kit_items?.length ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {pickerKit && (
        <KitPickerModal
          kit={pickerKit}
          measured={measured}
          pricing={kitPricing}
          onClose={() => setPickerKit(null)}
          onAdd={(lines) => {
            onAdd(lines);
            setPickerKit(null);
          }}
        />
      )}
    </div>
  );
}
