"use client";

import { useMemo, useState } from "react";
import { ListPlus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import {
  hasItemOptions,
  pickerChoices,
  pickerSummary,
  priceBookLine,
  type BookPricing,
  type ItemOptionChoice,
  type PriceItemOptionRow,
} from "@/lib/pricing/item-options";
import { KitPickerModal, type KitForPicker } from "@/app/(app)/quotes/new/kit-picker-modal";
import type { KitPickerPricing } from "@/lib/kit-picker";
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
  /**
   * THE MAKERS UNDER THIS CODE (0282). Andrew, for Justin Vivian: "increase drop down options for
   * each item code, multiple vendors, ie. windows - mfg Andersen, mfg Milgard, mfg Marvin".
   *
   * Optional, and absent on most items forever - 830 Windows has three, and the other 318 items
   * across his three price lists have none. An item without them behaves here exactly as it did
   * before this existed, which is the whole reason the code stayed one row and grew a list.
   *
   * THIS COMPONENT IS THE DOOR. The wave that built the table also wrote a server action and a
   * pure resolver, and wired NEITHER to a screen: every quote still priced at the allowance while
   * the price-list tab said the item now priced at Marvin. That is the third time in four waves,
   * and it is why the reviewer's sentence was "shipping the admin half alone is worse than
   * shipping nothing".
   */
  price_list_item_options?: PriceItemOptionRow[] | null;
};

export function AddLineItems({
  priceItems = [],
  kits = [],
  /** WHO THIS DOCUMENT IS PRICED FOR: the customer's pricing level (null = none) and the org
   *  default markup. ONE input, required, and every price this component shows or adds comes out
   *  of it: the one-tap add, each vendor row, and the kit picker alike.
   *
   *  It used to take a `markupFor` closure for the book rows AND two optional numbers for the
   *  vendor rows, and no caller ever passed the two numbers (audit v994, VP1): the book row sold at
   *  $115 for a Local customer while a vendor under the same code sold at its $100 net cost. Two
   *  inputs for one rule is how a page hands over one and forgets the other. */
  pricing,
  /** Measurements from the walk-through, so a self-sizing kit opens with real numbers. */
  measured,
  onAdd,
  className = "",
}: {
  priceItems?: PriceItemLite[];
  kits?: KitForPicker[];
  pricing: BookPricing;
  measured?: { sqft?: number | null; linearFt?: number | null; byKey?: Record<string, number | null> | null };
  onAdd: (lines: DraftLineItem[]) => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [pickerKit, setPickerKit] = useState<KitForPicker | null>(null);
  /** The code whose makers are open. One at a time: a phone list that expands three rows in two
   *  places is a list nobody can read. */
  const [makersFor, setMakersFor] = useState<string | null>(null);

  // KITS PRICE THE WAY THE TYPEAHEAD DOES (0240). A linked kit line is a price-list item, so it
  // runs on the SAME two numbers the book picker above uses (kitLineView puts them to THE markup
  // rule), and the two "add" doors on one page cannot quote the same item at two prices.
  const kitPricing: KitPickerPricing = {
    orgDefaultPct: pricing.orgDefaultPct ?? 0,
    levelPct: pricing.levelPct,
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

  /** A code with no vendors adds on the first tap, at THE price (priceBookLine): the same function
   *  and the same inputs as every vendor row below it. */
  const addOne = (p: PriceItemLite) => {
    const line = priceBookLine(p, pricing);
    onAdd([{ description: line.description, quantity: 1, unit: line.unit, unit_price: line.unitPrice }]);
    setQuery("");
    setOpen(false);
  };

  /**
   * ADD THE MAKER SOMEBODY PICKED, not the code's allowance.
   *
   * The maker goes in the DESCRIPTION because that is what the customer reads on the quote and
   * what the crew orders from: "830 Windows (Andersen 400 Series)", not "830 Windows". The price
   * is the option's own, through the same markup ladder, never recomputed here.
   */
  const addChoice = (choice: ItemOptionChoice) => {
    onAdd([{ description: choice.description, quantity: 1, unit: choice.unit, unit_price: choice.unitPrice }]);
    setQuery("");
    setOpen(false);
    setMakersFor(null);
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
              {matches.map((p) => {
                const makers = hasItemOptions(p);
                const openMakers = makers && makersFor === p.id;
                const summary = makers ? pickerSummary(p, pricing) : null;
                return (
                  <li key={p.id}>
                    {/* A CODE WITH MAKERS ASKS WHICH ONE; every other code adds on the first tap,
                        exactly as it always has. Two taps only where there is a real choice, and
                        the second tap is the answer rather than a confirmation. */}
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => (makers ? setMakersFor(openMakers ? null : p.id) : addOne(p))}
                      className="flex min-h-[44px] w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      <span className="min-w-0 truncate">
                        {p.code && <span className="mr-1 font-mono text-xs text-slate-400">{p.code}</span>}
                        {p.description}
                      </span>
                      <span className="shrink-0 text-slate-600">
                        {summary ? (
                          // THE DEFAULT VENDOR, NAMED, with its price: the one this code uses when
                          // nobody picks. The count says there are others to pick from.
                          <span className="flex flex-col items-end leading-tight">
                            <span>
                              {summary.defaultChoice
                                ? `${summary.defaultChoice.makerLabel} ${formatCurrency(summary.defaultChoice.unitPrice)}`
                                : formatCurrency(summary.ownChoice.unitPrice)}
                            </span>
                            <span className="text-xs font-medium text-brand">
                              {summary.count} Vendor{summary.count === 1 ? "" : "s"}
                            </span>
                          </span>
                        ) : (
                          formatCurrency(priceBookLine(p, pricing).unitPrice)
                        )}
                      </span>
                    </button>
                    {openMakers && (
                      <ul className="border-t border-slate-100 bg-slate-50/60">
                        {pickerChoices(p, pricing).map((choice) => (
                          <li key={choice.id || "own"}>
                            <button
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => addChoice(choice)}
                              className="flex min-h-[44px] w-full items-center justify-between gap-3 py-2 pl-7 pr-3 text-left text-sm hover:bg-white"
                            >
                              <span className="min-w-0 truncate">
                                {choice.makerLabel}
                                {choice.isDefault && <span className="ml-1.5 text-xs font-medium text-brand">Default</span>}
                              </span>
                              <span className="shrink-0 text-slate-600">{formatCurrency(choice.unitPrice)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
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
