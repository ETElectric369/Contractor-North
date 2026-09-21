"use client";

import { useEffect, useState, useTransition } from "react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { UNIT_DATALIST_ID } from "@/lib/pricing/units";
import { formatCurrency } from "@/lib/utils";
import { addItemOption, updateItemOption, type OptionResult } from "./actions";
import { markupSourceNote, optionView, type ItemOption } from "./item-options-math";
import type { PriceItem } from "./price-list-math";

/**
 * ADD OR EDIT ONE MAKER UNDER A CODE (0282).
 *
 * Six fields, and the two that matter are the maker and what it costs you. Everything else is
 * optional on purpose: Andrew asked for "mfg Andersen / mfg Milgard / mfg Marvin", not a product
 * database.
 *
 * TWO FIELDS ARE TEXT WHERE THE REST OF THIS PAGE USES <NumberInput>, deliberately. NumberInput
 * reports a blank box as 0, and both of these need to tell blank from zero:
 *   · cost — a blank one is REFUSED, because a $0.00 Andersen window on an estimate is worse than
 *     no option at all (money: never print a number nobody typed);
 *   · markup — blank means "not stated", which falls through to the item and then to the org
 *     default. That fall-through is the whole reason 0282 made the column nullable, and a 0
 *     written here would quietly sell at cost forever.
 */
export function ItemOptionModal({
  open,
  onClose,
  item,
  option,
  optionCount,
  defaultMarkupPct,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  item: PriceItem;
  /** Absent = adding a new one. */
  option?: ItemOption | null;
  /** How many options this item already has — drives the one-time explanation. */
  optionCount: number;
  defaultMarkupPct: number;
  onSaved: (res: OptionResult, what: string) => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [vendor, setVendor] = useState("");
  const [label, setLabel] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [unit, setUnit] = useState("");
  const [buyPrice, setBuyPrice] = useState("");
  const [markupPct, setMarkupPct] = useState("");
  const [isDefault, setIsDefault] = useState(false);

  // Re-seed every time it opens, so a cancelled edit never leaks into the next one.
  useEffect(() => {
    if (!open) return;
    setVendor(option?.vendor ?? "");
    setLabel(option?.label ?? "");
    setPartNumber(option?.part_number ?? "");
    setUnit(option?.unit ?? "");
    setBuyPrice(option ? String(option.buy_price ?? "") : "");
    setMarkupPct(option?.markup_pct === null || option?.markup_pct === undefined ? "" : String(option.markup_pct));
    setIsDefault(Boolean(option?.is_default));
    setError(null);
  }, [open, option]);

  const dirty =
    vendor !== (option?.vendor ?? "") ||
    label !== (option?.label ?? "") ||
    partNumber !== (option?.part_number ?? "") ||
    unit !== (option?.unit ?? "") ||
    buyPrice !== (option ? String(option.buy_price ?? "") : "") ||
    markupPct !== (option?.markup_pct === null || option?.markup_pct === undefined ? "" : String(option.markup_pct)) ||
    isDefault !== Boolean(option?.is_default);

  // THE SAME ARITHMETIC THE ROW WILL SHOW, live while he types — so the number on the estimate is
  // never a surprise. Blank cost shows nothing at all rather than a $0.00 that means "I have not
  // typed it yet".
  const typedCost = Number(String(buyPrice).replace(/[$,\s]/g, ""));
  const preview =
    Number.isFinite(typedCost) && String(buyPrice).trim()
      ? optionView(
          {
            vendor,
            label: label || null,
            unit: unit || null,
            buy_price: typedCost,
            markup_pct: markupPct.trim() === "" ? null : Number(markupPct.replace(/[%\s]/g, "")),
          },
          item,
          defaultMarkupPct,
        )
      : null;

  function save() {
    setError(null);
    const fields = { vendor, label, partNumber, unit, buyPrice, markupPct, isDefault };
    start(async () => {
      const res = option
        ? await updateItemOption({ optionId: option.id, ...fields })
        : await addItemOption({ itemId: item.id, ...fields });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      onSaved(res, (vendor.trim() || "That option") + (label.trim() ? ` ${label.trim()}` : ""));
      onClose();
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={option ? "Edit Option" : "Add An Option"}
      dirty={dirty}
      size="md"
      footer={
        <ModalActions
          onCancel={onClose}
          onSave={save}
          saving={pending}
          disabled={!vendor.trim() || !buyPrice.trim()}
          saveLabel={option ? "Save Changes" : "Add Option"}
        />
      }
    >
      <div className="space-y-4">
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        {/* WHAT AN OPTION IS, SAID ONCE — here, the moment he adds the first one under a code.
            After that the rows speak for themselves and this is out of the way. */}
        {!option && optionCount === 0 && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
            <p>
              <span className="font-medium text-slate-800">
                {item.code ? `${item.code} ` : ""}
                {item.description}
              </span>{" "}
              already has its own price of {formatCurrency(Number(item.buy_price) || 0)}. That is the allowance, and it stays the
              default.
            </p>
            <p className="mt-1.5">
              An option is what you use <span className="font-medium">instead</span>, once somebody picks a maker. Three options
              under this code is still one line on an estimate, not three.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="opt-vendor">Maker *</Label>
            <Input
              id="opt-vendor"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="e.g. Andersen"
              autoComplete="off"
            />
            {/* Erik's book already has a `supplier` column and it means something else. Say so
                once, here, rather than letting him fill this with the lumber yard's name. */}
            <p className="mt-1 text-xs text-slate-500">Who makes it, not who you buy it from.</p>
          </div>
          <div>
            <Label htmlFor="opt-label">Product Line</Label>
            <Input
              id="opt-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. 400 Series"
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-slate-500">Only when the maker alone isn&rsquo;t the answer.</p>
          </div>
          <div>
            <Label htmlFor="opt-part">Part Number</Label>
            <Input id="opt-part" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} autoComplete="off" />
          </div>
          <div>
            <Label htmlFor="opt-unit">Unit</Label>
            <Input
              id="opt-unit"
              list={UNIT_DATALIST_ID}
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder={`Same as the item (${item.unit || "ea"})`}
              autoComplete="off"
            />
          </div>
          <div>
            <Label htmlFor="opt-cost">Cost $ *</Label>
            <Input
              id="opt-cost"
              inputMode="decimal"
              value={buyPrice}
              onChange={(e) => setBuyPrice(e.target.value)}
              placeholder="what this one costs you"
              autoComplete="off"
            />
          </div>
          <div>
            <Label htmlFor="opt-markup">Markup %</Label>
            <Input
              id="opt-markup"
              inputMode="decimal"
              value={markupPct}
              onChange={(e) => setMarkupPct(e.target.value)}
              placeholder={markupPlaceholder(item, defaultMarkupPct)}
              autoComplete="off"
            />
            <p className="mt-1 text-xs text-slate-500">Leave it blank to use the item&rsquo;s own.</p>
          </div>
        </div>

        {preview && (
          <div className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm">
            <span className="text-slate-500">Sells at</span>{" "}
            <span className="font-semibold text-slate-900">{formatCurrency(preview.sell)}</span>{" "}
            <span className="text-slate-500">
              per {preview.unit} ({preview.pct}% on {formatCurrency(preview.cost)})
            </span>
            <p className="mt-0.5 text-xs text-slate-500">{markupSourceNote(preview.source)}</p>
          </div>
        )}

        <label className="flex min-h-11 items-center gap-2.5 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-brand)]"
          />
          Price this item at this option
        </label>
        <p className="-mt-2 text-xs text-slate-500">
          Off, and the item keeps pricing at its own number until somebody picks a maker.
        </p>
      </div>
    </Modal>
  );
}

/** What a blank markup will actually do, in the box itself — never a 0 pretending to be an answer. */
function markupPlaceholder(item: PriceItem, defaultMarkupPct: number): string {
  const itemPct = Number(item.markup_pct) || 0;
  if (itemPct > 0) return `item's ${itemPct}%`;
  if (Number(defaultMarkupPct) > 0) return `your default ${defaultMarkupPct}%`;
  return "none set anywhere, sells at cost";
}
