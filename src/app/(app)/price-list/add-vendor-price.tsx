"use client";

import { useId, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { addItemOption, type OptionResult } from "./actions";
import { markupForSell, markupSourceNote, optionView, showPct } from "./item-options-math";
import { parseCellNumber, type PriceItem } from "./price-list-math";

/**
 * PUT A VENDOR ON AN ITEM, WITH ITS PRICE. The four things that matter, inline, no modal:
 * the vendor (the brand), what it costs you, and optionally what it sells for, and whether
 * estimates use it by default. Product line, part number and unit are edited on the row
 * afterwards, where every other number already edits in place.
 *
 * Sell is optional. Blank = the vendor sells at the item's markup, then your default (the
 * estimate's ladder). Typed = this vendor's own markup, the one that lands on those cents.
 *
 * `vendor` fixed (the vendor's own sheet) hides the vendor box; `item` is always fixed.
 *
 * THE VENDOR IS A VISIBLE PICKER (b0a8f25e). It was a text box over a native datalist, which in
 * Chrome on a Mac pops only after matching letters or a double-click, so Justin's twenty-nine
 * imported vendors looked like none. Now a select lists every vendor that can carry a price, with
 * Someone New (Type It) at the end for a brand not on the Vendors tab yet - and the sheet SAYS how
 * many of his vendors are subcontractors and so aren't in the list (0341), rather than the list
 * silently being short.
 */
export const SOMEONE_NEW = "__someone_new__";

export function AddVendorPrice({
  item,
  vendor,
  knownVendors,
  subcontractorsLeftOut = [],
  defaultMarkupPct,
  hasDefault,
  onDone,
  run,
}: {
  item: PriceItem;
  /** Fixed vendor name (adding from the vendor's sheet). Absent = picked or typed here. */
  vendor?: string;
  knownVendors: string[];
  /** The live subcontractor cards knownVendors leaves out (0341), named under the picker. */
  subcontractorsLeftOut?: string[];
  defaultMarkupPct: number;
  /** Whether this item already has a default vendor (the tick's wording depends on it). */
  hasDefault: boolean;
  onDone?: () => void;
  /** The sheet's write runner, so the toast and refresh are the same as every other write. */
  run: (key: string, fn: () => Promise<OptionResult>, okMsg: string) => Promise<OptionResult>;
}) {
  const uid = useId();
  // The picker's choice: "" (nothing yet), a vendor's name, or SOMEONE_NEW (the text box shows).
  // With no vendors to pick from, the box is open from the start rather than behind a two-option
  // select.
  const [pick, setPick] = useState(knownVendors.length ? "" : SOMEONE_NEW);
  const [name, setName] = useState(vendor ?? "");
  const [cost, setCost] = useState("");
  const [sell, setSell] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const typing = !vendor && pick === SOMEONE_NEW;
  const who = (vendor ?? (typing ? name : pick)).trim();
  const subsLeftOut = subcontractorsLeftOut.length;

  const costN = parseCellNumber(cost);
  const sellN = parseCellNumber(sell);
  const typedMarkup = costN !== null && costN > 0 && sellN !== null ? markupForSell(costN, sellN) : null;
  const preview =
    costN !== null
      ? optionView({ vendor: who, label: null, unit: null, buy_price: costN, markup_pct: typedMarkup }, item, defaultMarkupPct)
      : null;

  async function add() {
    if (saving) return;
    setError(null);
    if (!who) return setError(typing ? "Name the vendor: the brand, e.g. Andersen." : "Pick one of your vendors, or Someone New (Type It).");
    if (costN === null) return setError("Type what this vendor's one costs you.");
    if (sell.trim() && sellN === null) return setError("That sell price isn't a number.");
    if (sell.trim() && typedMarkup === null) return setError("Sell is cost plus markup, so it needs a cost above zero.");
    // The server says the same (optionSellPatch); saying it here keeps the typing in the boxes.
    if (typedMarkup !== null && typedMarkup < 0) {
      return setError(`Sell is below this vendor's cost of ${formatCurrency(costN)}. Set it at cost or above.`);
    }
    setSaving(true);
    const res = await run(
      `add:${item.id}`,
      () =>
        addItemOption({
          itemId: item.id,
          vendor: who,
          buyPrice: cost,
          // The TYPED SELL goes to the server, which turns it into the markup and reads back
          // where it landed (a column that rounds it says so in the toast instead of silently).
          markupPct: "",
          sell: sell.trim() ? sell : null,
          isDefault,
        }),
      `Added ${who}`,
    );
    setSaving(false);
    if (!res.ok) return setError(res.error ?? "Couldn't add that.");
    if (!vendor) {
      setName("");
      setPick(knownVendors.length ? "" : SOMEONE_NEW);
    }
    setCost("");
    setSell("");
    setIsDefault(false);
    onDone?.();
  }

  const listId = `${uid}-vendors`;
  return (
    <div
      className="rounded-lg border border-slate-200 bg-slate-50/60 p-3"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "checkbox") {
          e.preventDefault();
          void add();
        }
      }}
    >
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      <div className={`grid grid-cols-2 gap-2 ${vendor ? "" : "sm:grid-cols-4"}`}>
        {!vendor && (
          <div className="col-span-2">
            <Label htmlFor={`${uid}-pick`}>Vendor *</Label>
            <Select id={`${uid}-pick`} className="h-11" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Pick One Of Your Vendors</option>
              {knownVendors.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value={SOMEONE_NEW}>Someone New (Type It)</option>
            </Select>
            {typing && (
              <>
                <Label htmlFor={`${uid}-name`} className="mt-2">
                  Their Name *
                </Label>
                <Input
                  id={`${uid}-name`}
                  list={listId}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="the brand, e.g. Andersen"
                  autoComplete="off"
                  autoFocus={knownVendors.length > 0}
                />
                <datalist id={listId}>
                  {knownVendors.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </>
            )}
            {/* WHAT THE LIST LEAVES OUT, SAID OUT LOUD (0341): a subcontractor is on the Vendors
                tab to be reached, never priced, and a list that is quietly short reads as broken. */}
            {subsLeftOut > 0 ? (
              <p className="mt-1 text-xs text-slate-500">
                {subsLeftOut === 1
                  ? "1 on your Vendors list is a subcontractor and isn't offered here: subcontractors don't carry prices on items."
                  : `${subsLeftOut} on your Vendors list are subcontractors and aren't offered here: subcontractors don't carry prices on items.`}{" "}
                Change a vendor&apos;s Kind to Supplier or Brand on the Vendors tab to price it.
              </p>
            ) : knownVendors.length === 0 ? (
              <p className="mt-1 text-xs text-slate-500">No vendors yet. Add them on the Vendors tab or type one here.</p>
            ) : null}
          </div>
        )}
        <div>
          <Label htmlFor={`${uid}-cost`}>Cost $ *</Label>
          <Input id={`${uid}-cost`} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <Label htmlFor={`${uid}-sell`}>Sell $</Label>
          <Input
            id={`${uid}-sell`}
            inputMode="decimal"
            value={sell}
            onChange={(e) => setSell(e.target.value)}
            placeholder={preview ? formatCurrency(preview.sell) : "from markup"}
            autoComplete="off"
          />
        </div>
      </div>
      {preview && (
        <p className="mt-2 text-xs text-slate-500">
          Sells at <span className="font-semibold text-slate-800">{formatCurrency(preview.sell)}</span> per {preview.unit} (
          {showPct(preview.pct)}% markup). {sell.trim() ? "Markup set from the sell you typed." : markupSourceNote(preview.source)}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-brand)]"
          />
          {hasDefault ? "Make it the default instead" : "Make it the default for estimates"}
        </label>
        <Button onClick={() => void add()} disabled={saving || !who || !cost.trim()}>
          <Plus className="h-4 w-4" /> {saving ? "Adding…" : "Add Vendor"}
        </Button>
      </div>
    </div>
  );
}
