"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Input, Label, Select } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { NumberInput } from "@/components/ui/number-input";
import { formatCurrency } from "@/lib/utils";
import {
  SHELF_UNITS,
  isFreightLine,
  lineNeedsShelfAnswer,
  shelfCountGuess,
  suggestShelfItem,
  ticketShelfProblem,
  type ShelfPickerItem,
  type TicketLineChoice,
} from "@/lib/shelf-plan";
import { shelfPickerItems } from "@/app/(app)/inventory/actions";

/**
 * ONE LINE OF A TICKET, COUNTED ONTO THE SHELF (Shop Stock, Phase 2).
 *
 * The same row on every screen that puts something on the shelf: the receipt card's Put The Rest
 * On The Shelf, the tray's Shop Stock destination and Record To Shelf on a CED document. It opens
 * already filled in from the ticket ("250 ft", from the ticket's own columns, shelfCountGuess) and
 * pre-picks an item only on an exact part number or name (suggestShelfItem). Nothing on it is
 * saved until a person confirms it; a row that has not been confirmed is not an answer.
 *
 * NO COST ANYWHERE A TECH COULD SEE IT: this lives only on office screens (the Bills page, the
 * office tray, CED documents), and the item picker carries names and units, never a price.
 */

/** A ticket line as this row needs it. */
export type ShelfCountLine = {
  key: string;
  description: string;
  quantity: number;
  unitPrice: number | null;
  amount: number;
  category?: string | null;
  partNumber?: string | null;
};

/** What a person has said about one line so far. */
export type ShelfCountValue = {
  notStock: boolean;
  /** Confirmed by a person (one tap on the prefilled row, or any edit). */
  confirmed: boolean;
  /** How many the ticket's quantity column counts, and how many pieces in each. */
  bought: number;
  each: number;
  unit: string;
  /** Pieces THIS job used (the receipt card only; 0 on a ticket bought for the shelf). */
  used: number;
  /** An item on the shelf, or "" for a new one named below. */
  itemId: string;
  newItemName: string;
};

export const shelfPieces = (v: Pick<ShelfCountValue, "bought" | "each">) => Math.round((Number(v.bought) || 0) * (Number(v.each) || 0) * 1000) / 1000;

/** A confirmed row as the server takes it (ShelfPick, less the line id the caller adds). */
export function shelfAnswerOf(line: ShelfCountLine, v: ShelfCountValue) {
  return {
    pieces: shelfPieces(v),
    used: Number(v.used) || 0,
    unit: v.unit,
    bought: Number(v.bought) || null,
    itemId: v.itemId || null,
    newItemName: v.itemId ? null : (v.newItemName || line.description).trim(),
    keyPart: line.partNumber ?? null,
  };
}

/** The row as it opens: the ticket's own count, the item only on an exact match. */
export function initialShelfCount(line: ShelfCountLine, items: ShelfPickerItem[], used = 0): ShelfCountValue {
  const g = shelfCountGuess({ description: line.description, quantity: line.quantity, unit_price: line.unitPrice, amount: line.amount });
  const unit = g.unit ?? "ea";
  const bought = g.pieces != null ? g.bought : 1;
  const each = g.pieces != null && bought > 0 ? Math.round((g.pieces / bought) * 1000) / 1000 : 0;
  const match = suggestShelfItem(items, { description: line.description, partNumber: line.partNumber ?? null }, unit);
  return {
    notStock: false,
    confirmed: false,
    bought,
    each,
    unit,
    used,
    itemId: match?.id ?? "",
    newItemName: line.description.slice(0, 200),
  };
}

/**
 * A WHOLE TICKET TO THE SHELF: one row per line (the tray's Shop Stock destination, and Record To
 * Shelf on a CED document). Every line that shipped something needs an answer, a confirmed count
 * or Not Stock; tax lines ride along with the lines they were charged on. The button stays shut,
 * and says why, until ticketShelfProblem has nothing to say.
 */
export function ShelfTicketSheet({
  title,
  lines,
  total,
  fileLabel,
  onClose,
  onFile,
}: {
  title: string;
  lines: ShelfCountLine[];
  total: number | null;
  fileLabel: string;
  onClose: () => void;
  /** Answers by line position: a count or Not Stock. The caller files and reports. */
  onFile: (choices: TicketLineChoice[]) => Promise<{ ok: boolean; error?: string }>;
}) {
  const { items, loaded, error: itemsError } = useShelfItems(true);
  const [values, setValues] = useState<Record<string, ShelfCountValue>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    setValues((v) => {
      if (Object.keys(v).length) return v;
      const out: Record<string, ShelfCountValue> = {};
      for (const l of lines) if (lineNeedsShelfAnswer(l)) out[l.key] = initialShelfCount(l, items);
      // Same object back when there is nothing to answer, so this never re-renders itself in a loop.
      return Object.keys(out).length ? out : v;
    });
  }, [loaded, lines, items]);

  const choices: TicketLineChoice[] = lines.flatMap((l, index): TicketLineChoice[] => {
    const v = values[l.key];
    if (!v || !v.confirmed) return [];
    if (v.notStock) return [{ index, notStock: true as const }];
    const a = shelfAnswerOf(l, v);
    return [{ index, notStock: false as const, pieces: a.pieces, unit: a.unit, bought: a.bought, itemId: a.itemId, newItemName: a.newItemName, keyPart: a.keyPart }];
  });
  const problem = loaded ? ticketShelfProblem(lines, total, choices) : "Reading the shelf…";
  const openCount = lines.filter((l) => lineNeedsShelfAnswer(l) && !values[l.key]?.confirmed).length;

  function confirmAll() {
    setValues((v) => {
      const out = { ...v };
      for (const k of Object.keys(out)) if (!out[k].confirmed && shelfPieces(out[k]) > 0) out[k] = { ...out[k], confirmed: true };
      return out;
    });
  }

  function save() {
    setSaving(true);
    setError(null);
    onFile(choices)
      .then((res) => {
        setSaving(false);
        if (!res?.ok) setError(res?.error ?? "Nothing was filed. Try again.");
      })
      .catch(() => {
        setSaving(false);
        setError("Nothing was filed: the connection dropped. Try again.");
      });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      size="lg"
      dirty={Object.values(values).some((v) => v.confirmed)}
      footer={<ModalActions onCancel={onClose} onSave={save} saving={saving} saveLabel={fileLabel} disabled={!!problem || saving} />}
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Each line opens with the count off the ticket. Confirm it, change it, or tap Not Stock for anything the shop used up. What
          goes on the shelf counts as Put On The Shelf in the month the ticket is dated; Not Stock lines, their tax and freight count
          as Tools &amp; Supplies. Something a job used belongs on that job: file the ticket there instead.
        </p>
        {!loaded ? (
          <p className="text-sm text-slate-500">Reading the shelf…</p>
        ) : (
          <>
            {openCount > 1 && (
              <button
                type="button"
                onClick={confirmAll}
                className="flex min-h-11 items-center rounded-lg border border-sky-300 bg-white px-3 text-sm font-medium text-sky-800 hover:bg-sky-50"
              >
                Confirm Every Count As Shown
              </button>
            )}
            {lines.map((l) =>
              lineNeedsShelfAnswer(l) && values[l.key] ? (
                <ShelfCountRow key={l.key} line={l} value={values[l.key]} onChange={(next) => setValues((v) => ({ ...v, [l.key]: next }))} items={items} />
              ) : (
                <p key={l.key} className="px-1 text-xs text-slate-500">
                  {l.description}: {formatCurrency(l.amount)}
                  {/tax/i.test(String(l.category ?? ""))
                    ? " (tax: it rides with the lines it was charged on)"
                    : isFreightLine(l)
                      ? " (freight: Tools & Supplies, never a roll)"
                      : " (nothing shipped on this line)"}
                </p>
              ),
            )}
            {itemsError && <p className="text-xs text-amber-800">{itemsError}</p>}
          </>
        )}
        {problem && loaded && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{problem}</p>}
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
    </Modal>
  );
}

/** Load the shelf's items once for a sheet: names and units only. */
export function useShelfItems(open: boolean): { items: ShelfPickerItem[]; loaded: boolean; error: string | null } {
  const [items, setItems] = useState<ShelfPickerItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || loaded) return;
    let live = true;
    shelfPickerItems()
      .then((r) => {
        if (!live) return;
        if (r.ok) setItems(r.items);
        else setError(r.error ?? "The shelf's items couldn't be read.");
        setLoaded(true);
      })
      .catch(() => {
        if (!live) return;
        setError("The shelf's items couldn't be read. You can still name a new item.");
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [open, loaded]);
  return { items, loaded, error };
}

/**
 * THE ROW. Collapsed it reads "250 ft · New item: NMB 12/2 w/gnd 250 ft coil" with Confirm and Not
 * Stock beside it, one tap each; Change opens the count, the unit and the item. `showUsed` adds
 * "How many did this job use?" for a line on a job's own receipt.
 */
export function ShelfCountRow({
  line,
  value,
  onChange,
  items,
  showUsed = false,
  allowNotStock = true,
  startOpen = false,
}: {
  line: ShelfCountLine;
  value: ShelfCountValue;
  onChange: (next: ShelfCountValue) => void;
  items: ShelfPickerItem[];
  showUsed?: boolean;
  allowNotStock?: boolean;
  startOpen?: boolean;
}) {
  const pieces = shelfPieces(value);
  // A ticket that doesn't say how many opens on the count: there is nothing to confirm yet.
  const needsCount = !(pieces > 0);
  const [open, setOpen] = useState(startOpen || needsCount);
  const rest = Math.round((pieces - (showUsed ? Number(value.used) || 0 : 0)) * 1000) / 1000;
  const item = items.find((i) => i.id === value.itemId) ?? null;
  const set = (patch: Partial<ShelfCountValue>) => onChange({ ...value, ...patch, confirmed: true, notStock: false });
  const summary = value.notStock
    ? "Not stock: stays on this ticket, never on the shelf."
    : `${rest > 0 ? rest : 0} ${value.unit} to the shelf · ${item ? item.name : `New item: ${value.newItemName || line.description}`}`;
  const baseId = `shelf-${line.key}`;

  return (
    <div className={`rounded-lg border px-3 py-2 ${value.notStock ? "border-slate-200 bg-slate-50" : value.confirmed ? "border-sky-200 bg-sky-50/50" : "border-amber-200 bg-amber-50/40"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-900">{line.description}</p>
          <p className="text-xs text-slate-500">
            {formatCurrency(line.amount)} on the ticket
            {line.partNumber ? ` · #${line.partNumber}` : ""}
          </p>
          <p className={`mt-0.5 text-xs ${value.notStock ? "text-slate-500" : "font-medium text-slate-700"}`}>{summary}</p>
        </div>
        {value.confirmed && !value.notStock && <Check className="mt-1 h-4 w-4 shrink-0 text-sky-700" aria-label="Confirmed" />}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {!value.confirmed || value.notStock ? (
          <button
            type="button"
            disabled={needsCount && !value.notStock}
            onClick={() => onChange({ ...value, confirmed: true, notStock: false })}
            className="flex min-h-11 items-center rounded-lg border border-sky-300 bg-white px-3 text-sm font-medium text-sky-800 hover:bg-sky-50 disabled:opacity-50"
          >
            {value.notStock ? "It Is Stock" : `Confirm ${rest > 0 ? rest : 0} ${value.unit}`}
          </button>
        ) : null}
        {allowNotStock && !value.notStock && (
          <button
            type="button"
            onClick={() => onChange({ ...value, confirmed: true, notStock: true })}
            className="flex min-h-11 items-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Not Stock
          </button>
        )}
        {!value.notStock && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-brand hover:underline"
          >
            {open ? "Done Changing" : "Change"}
          </button>
        )}
      </div>

      {open && !value.notStock && (
        <div className="mt-2 space-y-3 border-t border-slate-200 pt-2">
          <div>
            <Label htmlFor={`${baseId}-bought`}>How many did this line buy, and how many in each?</Label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <NumberInput id={`${baseId}-bought`} value={value.bought} onValueChange={(n) => set({ bought: n })} className="h-11 w-24" placeholder="1" />
              <span className="text-sm text-slate-500">×</span>
              <NumberInput id={`${baseId}-each`} value={value.each} onValueChange={(n) => set({ each: n })} className="h-11 w-24" placeholder="250" aria-label="How many in each" />
              <Select
                aria-label="Counted in"
                value={value.unit}
                onChange={(e) => set({ unit: e.target.value })}
                className="h-11 w-24"
              >
                {Array.from(new Set([...SHELF_UNITS, value.unit].filter(Boolean))).map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
              <span className="text-sm font-medium text-slate-700">= {pieces} {value.unit}</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              A 250 ft coil the ticket sold by the foot is 250 × 1 ft. Two 250 ft coils are 2 × 250 ft. Only you know what is really in the box.
            </p>
          </div>
          {showUsed && (
            <div>
              <Label htmlFor={`${baseId}-used`}>How many did this job use?</Label>
              <div className="mt-1 flex items-center gap-2">
                <NumberInput id={`${baseId}-used`} value={value.used} onValueChange={(n) => set({ used: n })} className="h-11 w-28" placeholder="0" />
                <span className="text-sm text-slate-500">{value.unit}</span>
              </div>
            </div>
          )}
          <div>
            <Label htmlFor={`${baseId}-item`}>Which item on the shelf is it?</Label>
            <Select
              id={`${baseId}-item`}
              value={value.itemId}
              onChange={(e) => set({ itemId: e.target.value })}
              className="mt-1 h-11 w-full"
            >
              <option value="">A new item</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} ({i.unit})
                </option>
              ))}
            </Select>
            {!value.itemId && (
              <Input
                aria-label="New item name"
                value={value.newItemName}
                onChange={(e) => set({ newItemName: e.target.value })}
                className="mt-2 h-11"
                placeholder="12/2 NM-B"
              />
            )}
            {item && item.unit !== value.unit && (
              <p className="mt-1 text-xs text-amber-800">
                {item.name} is counted in {item.unit}. Count this in {item.unit}, or make a new item.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
