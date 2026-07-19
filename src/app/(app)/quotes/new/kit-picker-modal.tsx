"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { addKitItem, updateKitItems } from "../../price-list/kit-actions";
import {
  kitItemsToPickerRows,
  kitSelectionToLines,
  kitSelectionSubtotal,
  type KitPickerRow,
  type KitItemRaw,
} from "@/lib/kit-picker";
import type { DraftLineItem } from "../actions";

export interface KitForPicker {
  id: string;
  name: string;
  kit_items: KitItemRaw[];
}

/** The Kit Picker — a kit is a TEMPLATE you choose items from, not a dump-everything
 *  button. Every item opens pre-checked (open → Add keeps the one-tap feel); uncheck
 *  what this estimate doesn't need, tweak qty/price for THIS import only, or explicitly
 *  push edits/new lines back onto the kit for next time. */
export function KitPickerModal({
  kit,
  onClose,
  onAdd,
}: {
  kit: KitForPicker;
  onClose: () => void;
  onAdd: (lines: DraftLineItem[]) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<KitPickerRow[]>(() => kitItemsToPickerRows(kit.kit_items));
  // Baseline for "Save changes to kit" — only persisted rows whose values drifted count.
  const baseline = useRef(new Map(kitItemsToPickerRows(kit.kit_items).filter((r) => r.id).map((r) => [r.id!, r])));
  const [err, setErr] = useState<string | null>(null);

  // Add-a-line-to-the-kit row (persists to the kit AND joins the selection checked).
  const [newDesc, setNewDesc] = useState("");
  const [newQty, setNewQty] = useState(1);
  const [newUnit, setNewUnit] = useState("ea");
  const [newPrice, setNewPrice] = useState(0);
  const [adding, startAdd] = useTransition();
  const [savingKit, startSaveKit] = useTransition();

  const patchRow = (idx: number, patch: Partial<KitPickerRow>) =>
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const checkedCount = rows.filter((r) => r.checked).length;
  const allChecked = checkedCount === rows.length && rows.length > 0;
  const subtotal = kitSelectionSubtotal(rows);
  // What the confirm ACTUALLY adds (blank-description rows are dropped by the mapper) —
  // the footer's count/$ must state exactly these lines, never the raw checkbox count.
  const addLines = useMemo(() => kitSelectionToLines(kit.name, rows), [kit.name, rows]);

  // Persisted rows whose desc/qty/unit/price drifted from the kit — what "Save changes
  // to kit" would write back. Checkboxes are selection-only, never a kit edit. A row
  // blanked to no description can't be written back (the server skips it), so it must
  // not count toward the button — counting it would toast success for a skipped write.
  const kitEdits = useMemo(
    () =>
      rows.filter((r) => {
        if (!r.id || !r.description.trim()) return false;
        const b = baseline.current.get(r.id);
        return (
          !!b &&
          (b.description !== r.description ||
            b.quantity !== r.quantity ||
            b.unit !== r.unit ||
            b.unit_price !== r.unit_price)
        );
      }),
    [rows],
  );

  function addLineToKit() {
    // Normalize ONCE and send the server exactly what the local row (and its baseline)
    // will hold — sending the raw fields let a cleared qty land in the kit as 0 while
    // the row on screen showed 1, a drift the next open would silently paper over.
    const desc = newDesc.trim();
    if (!desc) return;
    const qty = newQty || 1;
    const unit = newUnit.trim() || "ea";
    const price = newPrice || 0;
    setErr(null);
    startAdd(async () => {
      const res = await addKitItem({
        kit_id: kit.id,
        description: desc,
        quantity: qty,
        unit,
        unit_price: price,
      });
      if (!res.ok) {
        setErr(res.error ?? "Could not add the item to the kit.");
        return;
      }
      // Joins the kit for next time AND this selection right now, checked, at the end.
      setRows((prev) => {
        const nextSort = prev.reduce((m, r) => Math.max(m, r.sort_order), 0) + 1;
        const row: KitPickerRow = {
          id: res.id,
          description: desc,
          quantity: qty,
          unit,
          unit_price: price,
          sort_order: nextSort,
          checked: true,
        };
        if (res.id) baseline.current.set(res.id, row);
        return [...prev, row];
      });
      setNewDesc(""); setNewQty(1); setNewUnit("ea"); setNewPrice(0);
      toast(`Added to the "${kit.name}" kit`, "success");
      router.refresh();
    });
  }

  function saveEditsToKit() {
    // Snapshot the edits at click time — the payload, and the baseline reset below,
    // must both describe exactly what was written, even if typing continues mid-save.
    const edits = kitEdits;
    if (edits.length === 0) return;
    setErr(null);
    startSaveKit(async () => {
      const res = await updateKitItems(
        kit.id,
        edits.map((r) => ({
          id: r.id!,
          description: r.description,
          quantity: r.quantity,
          unit: r.unit,
          unit_price: r.unit_price,
        })),
      );
      if (!res.ok) {
        setErr(res.error ?? "Could not save the kit.");
        return;
      }
      // New baseline for exactly the rows that were written — an unsent row (e.g. one
      // blanked out) must not have its baseline moved to values the kit doesn't hold.
      edits.forEach((r) => { if (r.id) baseline.current.set(r.id, { ...r }); });
      setRows((prev) => [...prev]); // re-derive kitEdits (disables the button)
      toast(`Kit "${kit.name}" updated — future estimates start from these values`, "success");
      router.refresh();
    });
  }

  const hasEdits = kitEdits.length > 0 || newDesc.trim() !== "";

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
          extra={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={saveEditsToKit}
              disabled={savingKit || kitEdits.length === 0}
              title="Writes the edited descriptions, quantities and prices back onto the kit itself"
            >
              {savingKit ? "Saving…" : `Save changes to kit${kitEdits.length ? ` (${kitEdits.length})` : ""}`}
            </Button>
          }
        />
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Everything starts checked — uncheck what this estimate doesn&apos;t need. Qty/price edits
          apply to this estimate only, unless you Save changes to kit.
        </p>

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
              <div className="col-span-11 sm:col-span-5">
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

        {/* Add a line TO THE KIT (and to this selection) — the "edit the kit on the fly" path. */}
        <div className="space-y-2 border-t border-slate-100 pt-3">
          <p className="text-xs font-medium text-slate-500">
            Add a line to this kit — it saves to the kit for next time and joins this selection checked.
          </p>
          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-12 sm:col-span-5">
              <Input placeholder="Description" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
            </div>
            <div className="col-span-3 sm:col-span-2">
              <NumberInput placeholder="Qty" value={newQty} onValueChange={setNewQty} aria-label="New item quantity" />
            </div>
            <div className="col-span-3 sm:col-span-1">
              <Input placeholder="ea" value={newUnit} onChange={(e) => setNewUnit(e.target.value)} />
            </div>
            <div className="col-span-3 sm:col-span-2">
              <NumberInput placeholder="Unit $" value={newPrice} onValueChange={setNewPrice} aria-label="New item unit price" />
            </div>
            <div className="col-span-3 sm:col-span-2">
              <Button size="sm" onClick={addLineToKit} disabled={adding || !newDesc.trim()} className="w-full">
                <Plus className="h-3.5 w-3.5" /> {adding ? "Adding…" : "Add to kit"}
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-slate-400">
            Unchecking only skips a line for this estimate. To remove a line from the kit itself, use Price list &amp; kits.
          </p>
        </div>

        {err && <p className="text-sm text-red-600">{err}</p>}
      </div>
    </Modal>
  );
}
