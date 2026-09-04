"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";
import {
  kitItemsToPickerRows,
  kitSelectionToLines,
  kitSelectionSubtotal,
  type KitPickerRow,
  type KitItemRaw,
  type KitPickerPricing,
} from "@/lib/kit-picker";
import { BookOpen } from "lucide-react";
import { kitIsParametric, kitQuantities, type ParametricKitItem } from "@/lib/estimate/parametric-kit";
import type { DraftLineItem } from "../actions";

export interface KitForPicker {
  id: string;
  name: string;
  kit_items: KitItemRaw[];
}

/** The Kit Picker — a kit is a TEMPLATE you choose items from, not a dump-everything
 *  button. Every item opens pre-checked (open → Add keeps the one-tap feel) except
 *  template lines saved at qty 0, which open unchecked; uncheck what this estimate
 *  doesn't need, tweak qty/price for THIS import only, or explicitly push edits/new
 *  lines back onto the kit for next time. */
export function KitPickerModal({
  kit,
  onClose,
  onAdd,
  measured,
  pricing,
}: {
  kit: KitForPicker;
  /** What the walk-through already measured — prefilled so the sizing boxes open with the real
   *  numbers rather than zeros. Typing a measurement a second time is how the two copies drift. */
  measured?: { sqft?: number | null; linearFt?: number | null };
  /** 0240: how a LINKED kit line prices for THIS customer — the org default plus the selected
   *  customer's level (or the caller's own markupFor). Before this, a kit line was a frozen copy
   *  and ignored the customer's level entirely. */
  pricing?: KitPickerPricing;
  onClose: () => void;
  onAdd: (lines: DraftLineItem[]) => void;
}) {
  const [rows, setRows] = useState<KitPickerRow[]>(() => kitItemsToPickerRows(kit.kit_items, pricing));
  const linkedCount = rows.filter((r) => r.linked).length;
  const [err] = useState<string | null>(null);

  /**
   * PARAMETRIC KITS (0166). When a kit's lines carry per-sq-ft / per-linear-foot coefficients, the
   * kit stops being a fixed shopping list and becomes the trade's quantity rule expressed as data.
   * Type the two measurements and every coefficient line sizes itself — the same arithmetic
   * lib/estimate/deck.ts does in code, without a module per trade.
   *
   * Only shown for kits that actually have coefficients; a flat kit looks and behaves exactly as
   * it did before.
   */
  const parametric = useMemo(() => kitIsParametric(kit.kit_items as ParametricKitItem[]), [kit.kit_items]);
  const [sqft, setSqft] = useState<number>(Number(measured?.sqft) || 0);
  const [linearFt, setLinearFt] = useState<number>(Number(measured?.linearFt) || 0);

  const sizeToJob = () => {
    const computed = kitQuantities(kit.kit_items as ParametricKitItem[], { sqft, linearFt });
    setRows((prev) =>
      prev.map((r, i) => {
        const c = computed[i];
        // Sizing sets the quantity and TICKS the line, because a line the measurements produced is
        // one this job needs. Lines the coefficients couldn't size are left exactly as they were.
        return c && c.parametric ? { ...r, quantity: c.quantity, checked: true } : r;
      }),
    );
  };

  const patchRow = (idx: number, patch: Partial<KitPickerRow>) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const checkedCount = rows.filter((r) => r.checked).length;
  const allChecked = checkedCount === rows.length && rows.length > 0;
  const subtotal = kitSelectionSubtotal(rows);
  // What the confirm ACTUALLY adds (blank-description rows are dropped by the mapper) —
  // the footer's count/$ must state exactly these lines, never the raw checkbox count.
  const addLines = useMemo(() => kitSelectionToLines(kit.name, rows), [kit.name, rows]);

  // Selection-only now: the close-confirm should fire when you've ticked lines you
  // haven't added yet, not when you've edited the kit (that path moved to Price list).
  const hasEdits = addLines.length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Add from kit: ${kit.name}`}
      size="xl"
      dirty={hasEdits}
      footer={
        <ModalActions
          onCancel={onClose}
          onSave={() => onAdd(addLines)}
          saveLabel={`Add ${addLines.length} item${addLines.length === 1 ? "" : "s"} — ${formatCurrency(subtotal)}`}
          disabled={addLines.length === 0}
          saving={false}
        />
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Tick the lines this estimate needs. Qty and price edits apply to THIS estimate only —
          the kit itself is unchanged.
          {linkedCount > 0 && (
            <>
              {" "}
              <BookOpen className="inline h-3 w-3 text-brand" /> lines are priced from the Price List for this
              customer.
            </>
          )}
        </p>

        {parametric && (
          <div className="rounded-lg border border-brand/30 bg-brand/5 p-3">
            <p className="mb-2 text-xs font-medium text-slate-600">
              This list sizes itself.{" "}
              {measured?.sqft || measured?.linearFt
                ? "Taken from the walk-through — change them if the job did."
                : "Enter the job\u2019s measurements and the quantities fill in."}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-28">
                <label className="mb-1 block text-[11px] text-slate-500" htmlFor="kit-sqft">Square feet</label>
                <NumberInput id="kit-sqft" value={sqft} onValueChange={setSqft} />
              </div>
              <div className="w-28">
                <label className="mb-1 block text-[11px] text-slate-500" htmlFor="kit-lf">Linear feet</label>
                <NumberInput id="kit-lf" value={linearFt} onValueChange={setLinearFt} />
              </div>
              <button
                type="button"
                onClick={sizeToJob}
                disabled={sqft <= 0 && linearFt <= 0}
                className="h-10 rounded-lg bg-brand px-3 text-sm font-medium text-white disabled:opacity-40"
              >
                Size to Job
              </button>
            </div>
          </div>
        )}

        {/* Select all / none */}
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={allChecked}
            onChange={(e) => setRows((prev) => prev.map((r) => ({ ...r, checked: e.target.checked })))}
            className="h-4 w-4 rounded border-slate-300 text-brand"
          />
          <span>
            {checkedCount} of {rows.length} selected
          </span>
        </label>

        <div className="space-y-2">
          {rows.map((r, idx) => (
            <div
              key={r.id ?? `new-${idx}`}
              className={`grid grid-cols-12 items-center gap-2 rounded-lg border p-2 ${r.checked ? "border-slate-200" : "border-slate-100 opacity-60"}`}
            >
              <div className="col-span-1 flex justify-center">
                <input
                  type="checkbox"
                  checked={r.checked}
                  onChange={(e) => patchRow(idx, { checked: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-brand"
                  aria-label={`Include ${r.description}`}
                />
              </div>
              <div className="col-span-11 flex items-center gap-1.5 sm:col-span-5">
                {r.linked && <BookOpen className="h-3.5 w-3.5 shrink-0 text-brand" aria-label="Priced from the Price List" />}
                <Input
                  value={r.description}
                  onChange={(e) => patchRow(idx, { description: e.target.value })}
                  placeholder="Description"
                />
              </div>
              <div className="col-span-3 sm:col-span-2">
                <NumberInput value={r.quantity} onValueChange={(n) => patchRow(idx, { quantity: n })} placeholder="Qty" aria-label="Quantity" />
              </div>
              <div className="col-span-2 sm:col-span-1 text-center text-xs text-slate-500">{r.unit}</div>
              <div className="col-span-4 sm:col-span-2">
                <NumberInput value={r.unit_price} onValueChange={(n) => patchRow(idx, { unit_price: n })} placeholder="Unit $" aria-label="Unit price" />
              </div>
              <div className="col-span-3 sm:col-span-1 text-right text-sm font-medium text-slate-700">
                {formatCurrency((Number(r.quantity) || 0) * (Number(r.unit_price) || 0))}
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <p className="py-4 text-center text-sm text-slate-400">This kit has no items yet — add the first one below.</p>
          )}
        </div>

        {/* Kit AUTHORING lives in Price list & kits, not here. Editing the kit from inside
            an estimate is what made this modal feel unpredictable (Chris: "button on the
            bottom is glitchy") — a tap could change the template for every future estimate
            while you thought you were adjusting this one. Selection only now. */}
        <p className="border-t border-slate-100 pt-3 text-[11px] text-slate-400">
          Need to change the kit itself — add, remove or re-price a line for every future
          estimate? Do it in Price list &amp; kits.
        </p>

        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  );
}
