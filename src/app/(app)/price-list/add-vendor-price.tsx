"use client";

import { useId, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
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
 */
export function AddVendorPrice({
  item,
  vendor,
  knownVendors,
  defaultMarkupPct,
  hasDefault,
  onDone,
  run,
}: {
  item: PriceItem;
  /** Fixed vendor name (adding from the vendor's sheet). Absent = typed here. */
  vendor?: string;
  knownVendors: string[];
  defaultMarkupPct: number;
  /** Whether this item already has a default vendor (the tick's wording depends on it). */
  hasDefault: boolean;
  onDone?: () => void;
  /** The sheet's write runner, so the toast and refresh are the same as every other write. */
  run: (key: string, fn: () => Promise<OptionResult>, okMsg: string) => Promise<OptionResult>;
}) {
  const uid = useId();
  const [name, setName] = useState(vendor ?? "");
  const [cost, setCost] = useState("");
  const [sell, setSell] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const costN = parseCellNumber(cost);
  const sellN = parseCellNumber(sell);
  const typedMarkup = costN !== null && costN > 0 && sellN !== null ? markupForSell(costN, sellN) : null;
  const preview =
    costN !== null
      ? optionView({ vendor: name, label: null, unit: null, buy_price: costN, markup_pct: typedMarkup }, item, defaultMarkupPct)
      : null;
  const who = (vendor ?? name).trim();

  async function add() {
    if (saving) return;
    setError(null);
    if (!who) return setError("Name the vendor: the brand, e.g. Andersen.");
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
    if (!vendor) setName("");
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
            <Label htmlFor={`${uid}-name`}>Vendor *</Label>
            <Input
              id={`${uid}-name`}
              list={listId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="the brand, e.g. Andersen"
              autoComplete="off"
            />
            <datalist id={listId}>
              {knownVendors.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
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
