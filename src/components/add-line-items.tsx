"use client";

import { useMemo, useRef, useState } from "react";
import { ListPlus, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { formatCurrency } from "@/lib/utils";
import { lineQuantity, priceBookLineKind, typedLine, type AddLineAsk } from "@/lib/invoice-math";
import { UNIT_DATALIST_ID } from "@/lib/pricing/units";
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
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";

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
  /** Who the item is bought from (0342). A book item with a supplier is a part, so its line files
   *  under Materials; one without (installed work, a job-cost code) says nothing and is read by its
   *  words. Staff screens only: the page that hands this list over is the office's. */
  supplier?: string | null;
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

/**
 * THE TYPED LINE (cn-v1152). Erik, 2026-11-07, on an invoice: "add from pricelist should be with or
 * integrated into the add a line item on the bottom".
 *
 * The invoice page drew two add doors: this picker above its lines table, and under the table its own
 * hand-typed row — a box, then Qty · unit · × · Price · Add — because this component had no way to add
 * words that match nothing. Given `typed`, the picker's box is ALSO that row's description box, and the
 * row is drawn under it: a pick from the book still adds at once, at THE price; words that match nothing
 * are the line, and Enter (in any box of the row) or Add puts them on with the count, the unit and the
 * price from the row. Without `typed` the component is what it always was — the estimate editor types
 * its lines in rows of its own and hands this nothing.
 *
 * The typed line goes through the same onAdd as a pick and a kit (one save model, one loop on the page);
 * onAdd's answer says whether the row may clear. The words the row says (Qty, unit, Price, Add) are the
 * catalog's, like the rest of this component's, and so are the two asks; WHICH box is asked for is the
 * caller's rule. The row's Qty is honored by a pick from the book too (skeptic #56b): Qty 5 and a tap
 * on a row put five on, and the row starts over after any add — a typed line, a pick, a kit.
 */
export type TypedLineDoor = {
  /** Which box the line is still missing (null = none): the words, or a price nobody typed — a blank
   *  Price box asks, a 0 typed on purpose is a no-charge line (lib/invoice-math addLineAsk). Said under
   *  the row, in the catalog's words, once he has typed a figure, changed the count or pressed Add — and
   *  the press puts the cursor in the box that is missing (44aeec9c: Add is never greyed; a refusal is said). */
  ask: (row: { words: string; price: number | null }) => AddLineAsk | null;
  /** While the page's save is on the wire the Add button waits, and Enter does nothing. The box itself does
   *  NOT wait: a disabled box drops the cursor, and the cursor is where the next line goes. */
  saving?: boolean;
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
  /** Measurements from the inspection, so a self-sizing kit opens with real numbers. */
  measured,
  onAdd,
  typed,
  className = "",
  disabled = false,
}: {
  priceItems?: PriceItemLite[];
  kits?: KitForPicker[];
  pricing: BookPricing;
  measured?: { sqft?: number | null; linearFt?: number | null; byKey?: Record<string, number | null> | null };
  /** Every line this component adds — a pick, a kit's lines, a typed line — goes through here. The answer
   *  matters only for a typed line: `false` (or a promise of it) keeps its words in the row, because the
   *  page's toast has said why the server refused; anything else clears the row. A pick clears at once. */
  onAdd: (lines: DraftLineItem[]) => void | boolean | Promise<void | boolean>;
  /** The hand-typed row under the box (TypedLineDoor). Absent on the estimate editor. */
  typed?: TypedLineDoor;
  className?: string;
  /** While the document's save is on the wire: the box and the kit chips wait, so a pick cannot
   *  land mid-flight (the one save model). */
  disabled?: boolean;
}) {
  const t = translator(useLang());
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [pickerKit, setPickerKit] = useState<KitForPicker | null>(null);
  /** The code whose makers are open. One at a time: a phone list that expands three rows in two
   *  places is a list nobody can read. */
  const [makersFor, setMakersFor] = useState<string | null>(null);

  // KITS TAKE THE SAME TWO NUMBERS AS THE TYPEAHEAD (0240): a linked kit line is a price-list item,
  // and kitLineView resolves it through priceBookLine with the customer's level and the org
  // default, the same function the typeahead above uses. So a code with a default vendor quotes
  // the same vendor and the same number from both doors (audit v994 VP2, the kit piece).
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

  // THE TYPED LINE'S OWN THREE (cn-v1152): the count, the unit and the price under the box; its words
  // are `query`, the same box a pick is searched from. Unused, and unseen, without `typed` (the count
  // stays 1, so a pick on the estimate editor adds one, as it always did). The price is null while the
  // box is blank: a blank is a question, and a 0 typed on purpose is a no-charge line (skeptic #56b).
  const [qty, setQty] = useState(1);
  const [unit, setUnit] = useState("ea");
  const [price, setPrice] = useState<number | null>(null);
  /** Add was pressed with a box missing: the ask shows from then on, until the answer comes. */
  const [askPressed, setAskPressed] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const priceBox = useRef<HTMLInputElement>(null);
  const missing = typed ? typed.ask({ words: query, price }) : null;
  /** The ask in the person's language: the words are the box above, the price is the Price box. */
  const missingLine = missing === "words" ? t("qt_askWords") : missing === "price" ? t("qt_askPrice") : null;
  /** Whether to say it yet: a figure typed, the count changed, or Add pressed (the invoice page's rule,
   *  moved here with the row). */
  const sayMissing = !!missing && (price !== null || qty !== 1 || askPressed);

  /** The row after ANY add — a typed line, a pick, a kit: the words gone, the count back to one, the
   *  unit to ea, the price blank, the ask quiet, the list closed. A row that kept its 5 would put five
   *  of the next thing on too (skeptic #56b). */
  const resetRow = () => {
    setQuery("");
    setQty(1);
    setUnit("ea");
    setPrice(null);
    setAskPressed(false);
    setOpen(false);
  };

  /** A code with no vendors adds on the first tap, at THE price (priceBookLine): the same function
   *  and the same inputs as every vendor row below it. The count is the row's Qty when there is one. */
  const addOne = (p: PriceItemLite) => {
    const line = priceBookLine(p, pricing);
    // A LINE FROM THE BOOK SAYS WHAT IT IS WHEN THE BOOK DOES (0342): labor when the book sells it
    // by the hour, materials when the item names a supplier. Neither, and it says nothing.
    const kind = priceBookLineKind(p.unit, line.unit, p.supplier);
    onAdd([{ description: line.description, quantity: lineQuantity(qty), unit: line.unit, unit_price: line.unitPrice, ...(kind ? { kind } : {}) }]);
    resetRow();
  };

  /**
   * ADD THE MAKER SOMEBODY PICKED, not the code's allowance.
   *
   * The maker goes in the DESCRIPTION because that is what the customer reads on the quote and
   * what the crew orders from: "830 Windows (Andersen 400 Series)", not "830 Windows". The price
   * is the option's own, through the same markup ladder, never recomputed here.
   */
  const addChoice = (choice: ItemOptionChoice, item: PriceItemLite) => {
    const kind = priceBookLineKind(item.unit, choice.unit, item.supplier);
    onAdd([{ description: choice.description, quantity: lineQuantity(qty), unit: choice.unit, unit_price: choice.unitPrice, ...(kind ? { kind } : {}) }]);
    resetRow();
    setMakersFor(null);
  };

  /** Enter in any box of the row, or the Add button: the words are the line. */
  const addTyped = async () => {
    if (!typed || typed.saving) return;
    if (missing) {
      // The ask, with the cursor put where the answer goes (44aeec9c — the press used to do nothing):
      // the box above for the words, the Price box for a price nobody typed. The words stay.
      setAskPressed(true);
      (missing === "price" ? priceBox : box).current?.focus();
      return;
    }
    setAskPressed(false);
    const landed = await onAdd([typedLine({ words: query, qty, unit, price })]);
    if (landed === false) return; // the page said why; the words stay for the retry
    resetRow();
    box.current?.focus();
  };
  const onRowEnter = (e: { key: string }) => e.key === "Enter" && void addTyped();

  // With a typed row there is always something to draw, book or no book.
  if (!typed && !priceItems.length && !kits.length) return null;

  return (
    <div className={className}>
      {(priceItems.length > 0 || typed) && (
        <div className={typed ? "relative" : "relative mb-3"}>
          {/* ONE BOX: with `typed` it is the line's description box too, and says so; with no book to
              pick from it says only that. */}
          <Input
            ref={box}
            placeholder={typed ? t(priceItems.length > 0 ? "qt_addLineOrPick" : "qt_addALineItem") : t("qt_addFromPriceList")}
            aria-label={typed ? t("qt_whatThisChargeIsFor") : undefined}
            value={query}
            disabled={disabled}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            // The blur delay lets a click on a row land before the list unmounts.
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={typed ? onRowEnter : undefined}
          />
          {open && priceItems.length > 0 && (
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
                              {fillText(t(summary.count === 1 ? "qt_vendorsOne" : "qt_vendorsMany"), { n: String(summary.count) })}
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
                              onClick={() => addChoice(choice, p)}
                              className="flex min-h-[44px] w-full items-center justify-between gap-3 py-2 pl-7 pr-3 text-left text-sm hover:bg-white"
                            >
                              <span className="min-w-0 truncate">
                                {choice.makerLabel}
                                {choice.isDefault && <span className="ml-1.5 text-xs font-medium text-brand">{t("qt_default")}</span>}
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
                  {priceItems.length === 0 ? t("qt_priceListEmpty") : t("qt_nothingMatches")}
                </li>
              )}
              {/* Say when the list is capped. A silent slice reads as "that's everything". */}
              {!query.trim() && priceItems.length > matches.length && (
                <li className="border-t border-slate-100 px-3 py-2 text-xs text-slate-400">
                  {fillText(t("qt_showingNofTotal"), { n: String(matches.length), total: String(priceItems.length) })}
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {/* THE ROW UNDER THE BOX (cn-v1152), as the invoice page drew it under its own box: the count, the
          unit, × the price, Add. Enter in any of them is Add. */}
      {typed && (
        <div className="mt-2 flex items-center gap-2">
          <NumberInput value={qty} onValueChange={setQty} onKeyDown={onRowEnter} className="w-16 text-center" placeholder={t("qt_qty")} />
          {/* THE UNIT, TYPEABLE (Erik 8/18). "hrs" is not "ea", and a line that says the wrong word is a
              line he has to explain to a customer. Free text with a suggestion list — his trade's words
              are his, not a dropdown we curate. The list is the page's one <datalist> (lib/pricing/units
              UNIT_DATALIST_ID): the invoice draws it once for this row and its line editor alike. */}
          <Input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            onKeyDown={onRowEnter}
            className="w-16 text-center"
            placeholder={t("qt_unitPh")}
            aria-label={t("qt_unitAria")}
            list={UNIT_DATALIST_ID}
          />
          <span className="text-slate-400">×</span>
          {/* Blank is blank, not 0: the box reports whether it is empty, and a reset empties it even after a typed "0". */}
          <NumberInput ref={priceBox} value={price} onValueChange={(n, blank) => setPrice(blank ? null : n)} onKeyDown={onRowEnter} className="flex-1 text-right" placeholder={t("qt_price")} />
          {/* ALWAYS PRESSABLE (44aeec9c): a tap with no words says what's missing and puts the cursor in
              the box. It used to be greyed out, so the tap did nothing at all. It waits only while the
              page's save is on the wire. */}
          <Button onClick={() => void addTyped()} disabled={disabled || typed.saving}>
            <Plus className="h-4 w-4" /> {t("qt_btn_add")}
          </Button>
        </div>
      )}
      {typed && sayMissing && <p className="mt-2 text-xs text-amber-700">{missingLine}</p>}

      {/* Categories as BUTTONS. As a <Select> reading "+ Add from a kit…" this was invisible —
          it looked like one more form field, and on iOS it opened the native wheel instead of a
          list. Naming the lists out loud is the whole fix. */}
      {kits.length > 0 && (
        <div className={typed ? "mt-3" : "mb-3"}>
          <p className="mb-1.5 text-xs font-medium text-slate-500">{t("qt_addFromAList")}</p>
          <div className="flex flex-wrap gap-2">
            {kits.map((k) => (
              <button
                key={k.id}
                type="button"
                disabled={disabled}
                onClick={() => setPickerKit(k)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:border-brand hover:text-brand disabled:opacity-50"
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
            // A kit is its own count: its lines go on as the picker sized them, whatever the Qty box says.
            onAdd(lines);
            setPickerKit(null);
            resetRow();
          }}
        />
      )}
    </div>
  );
}
