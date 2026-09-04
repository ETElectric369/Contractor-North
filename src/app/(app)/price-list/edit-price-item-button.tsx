"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { useToast } from "@/components/toast";
import { UnitSelect } from "@/components/unit-select";
import { updatePriceItem, type PriceItemInput } from "./actions";
import type { PriceItem } from "./price-list-math";
import { formulaSentence } from "./price-list-math";

/**
 * The words of an item — code, description, category, supplier — plus unit and the 0240 sizing
 * rule. Numbers (cost, markup) edit inline in the table; they are here too so a person who opened
 * the modal isn't sent back out to change one. Saves report through the toast with an Undo that
 * writes the previous values back.
 */
export function EditPriceItemButton({ item, sizingAvailable = false }: { item: PriceItem; sizingAvailable?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState(item.code ?? "");
  const [desc, setDesc] = useState(item.description);
  const [category, setCategory] = useState(item.category ?? "");
  const [supplier, setSupplier] = useState(item.supplier ?? "");
  const [unit, setUnit] = useState(item.unit ?? "ea");
  const [buy, setBuy] = useState(Number(item.buy_price) || 0);
  const [markup, setMarkup] = useState(Number(item.markup_pct) || 0);
  // SIZING (0240). 0/blank = no coefficient — a flat quantity wherever this item lands in a kit.
  const [perSqft, setPerSqft] = useState(Number(item.qty_per_sqft) || 0);
  const [perLf, setPerLf] = useState(Number(item.qty_per_lf) || 0);
  const [qtyMin, setQtyMin] = useState(Number(item.qty_min) || 0);
  const [rounding, setRounding] = useState(item.qty_round ?? "up");

  function openModal() {
    // reset to the item's current values each time it opens
    setCode(item.code ?? "");
    setDesc(item.description);
    setCategory(item.category ?? "");
    setSupplier(item.supplier ?? "");
    setUnit(item.unit ?? "ea");
    setBuy(Number(item.buy_price) || 0);
    setMarkup(Number(item.markup_pct) || 0);
    setPerSqft(Number(item.qty_per_sqft) || 0);
    setPerLf(Number(item.qty_per_lf) || 0);
    setQtyMin(Number(item.qty_min) || 0);
    setRounding(item.qty_round ?? "up");
    setError(null);
    setOpen(true);
  }

  const dirty =
    code !== (item.code ?? "") || desc !== item.description || category !== (item.category ?? "") ||
    supplier !== (item.supplier ?? "") || unit !== (item.unit ?? "ea") || buy !== (Number(item.buy_price) || 0) ||
    markup !== (Number(item.markup_pct) || 0) || perSqft !== (Number(item.qty_per_sqft) || 0) ||
    perLf !== (Number(item.qty_per_lf) || 0) || qtyMin !== (Number(item.qty_min) || 0) || rounding !== (item.qty_round ?? "up");

  function save() {
    setError(null);
    if (!desc.trim()) return setError("Description is required.");
    const patch: PriceItemInput = { code, description: desc, category, supplier, unit, buy_price: buy, markup_pct: markup };
    const before: PriceItemInput = {
      code: item.code ?? "", description: item.description, category: item.category ?? "", supplier: item.supplier ?? "",
      unit: item.unit ?? "ea", buy_price: Number(item.buy_price) || 0, markup_pct: Number(item.markup_pct) || 0,
    };
    // Sizing rides only when the columns exist — a deploy can land before its migration, and a
    // write naming an absent column would fail the whole save, not just the sizing.
    if (sizingAvailable) {
      Object.assign(patch, { qty_per_sqft: perSqft || null, qty_per_lf: perLf || null, qty_min: qtyMin || null, qty_round: rounding || null });
      Object.assign(before, {
        qty_per_sqft: item.qty_per_sqft ?? null, qty_per_lf: item.qty_per_lf ?? null, qty_min: item.qty_min ?? null, qty_round: item.qty_round ?? null,
      });
    }
    start(async () => {
      const res = await updatePriceItem(item.id, patch);
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      toast("Saved", "success", {
        label: "Undo",
        onClick: () => {
          updatePriceItem(item.id, before).then((r) => {
            toast(r.ok ? "Undone" : r.error ?? "Couldn't undo.", r.ok ? "success" : "error");
            router.refresh();
          });
        },
      });
      router.refresh();
    });
  }

  const sized = perSqft > 0 || perLf > 0 || qtyMin > 0;

  return (
    <>
      <button
        onClick={openModal}
        className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        title="Edit"
      >
        <Pencil className="h-4 w-4" />
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Edit Price Item"
        dirty={dirty}
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={save}
            saving={pending}
            saveLabel="Save Changes"
          />
        }
      >
        <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="epi-code">Code</Label>
              <Input id="epi-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="epi-cat">Category</Label>
              <Input id="epi-cat" value={category} onChange={(e) => setCategory(e.target.value)} />
            </div>
            <div className="col-span-2">
              <Label htmlFor="epi-desc">Description *</Label>
              <Input id="epi-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. how you'd say it at the supply house" />
            </div>
            <div className="col-span-2">
              <Label htmlFor="epi-supplier">Supplier</Label>
              <Input id="epi-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="epi-unit">Unit</Label>
              <UnitSelect id="epi-unit" value={unit} onChange={setUnit} />
            </div>
            <div />
            <div>
              <Label htmlFor="epi-buy">Cost $</Label>
              <NumberInput id="epi-buy" value={buy} onValueChange={setBuy} />
            </div>
            <div>
              <Label htmlFor="epi-mk">Markup %</Label>
              <NumberInput id="epi-mk" value={markup} onValueChange={setMarkup} />
            </div>
          </div>

          {/* SIZED BY THE JOB (0240) — the kit magic, living on the item. An item that knows it
              needs so-much per square foot fills its own quantity in wherever a kit uses it,
              from the walk-through measurements. Blank = a flat quantity, as today. */}
          {sizingAvailable && (
            <details className="rounded-lg border border-slate-200 p-3" open={sized}>
              <summary className="cursor-pointer text-sm font-medium text-slate-700">
                Item Formula
                {sized && <span className="ml-2 text-xs font-normal text-brand">on</span>}
              </summary>
              <p className="mt-2 text-xs text-slate-500">
                How many of this item a job needs, worked out from the walk-through measurements. Leave it all
                blank and you type the quantity yourself.
              </p>
              <p className="mt-1 text-xs font-medium text-slate-700">{formulaSentence({ perSqft, perLf, qtyMin, rounding })}</p>
              {/* ONE choice first (Erik: "these labels make no sense at all and don't apply to the item" —
                  a conduit strap has nothing to do with square feet). Fixed Quantity shows nothing else;
                  the coefficient, floor and rounding appear only for a rule that needs them. */}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <Label htmlFor="epi-mode">How It&rsquo;s Counted</Label>
                  <Select
                    id="epi-mode"
                    value={perSqft > 0 ? "sqft" : perLf > 0 ? "lf" : "fixed"}
                    onChange={(e) => {
                      const m = e.target.value;
                      setPerSqft(m === "sqft" ? perSqft || 1 : 0);
                      setPerLf(m === "lf" ? perLf || 1 : 0);
                    }}
                  >
                    <option value="fixed">Fixed Quantity — typed on the estimate</option>
                    <option value="sqft">Per Sq Ft of the Job</option>
                    <option value="lf">Per Linear Ft of the Job</option>
                  </Select>
                </div>
                {perSqft > 0 && (
                  <div><Label htmlFor="epi-sqft">How many per sq ft</Label><NumberInput id="epi-sqft" placeholder="e.g. 1" value={perSqft} onValueChange={setPerSqft} /></div>
                )}
                {perLf > 0 && (
                  <div><Label htmlFor="epi-lf">How many per linear ft</Label><NumberInput id="epi-lf" placeholder="e.g. 3" value={perLf} onValueChange={setPerLf} /></div>
                )}
                {(perSqft > 0 || perLf > 0) && (
                  <>
                    <div><Label htmlFor="epi-min">Never fewer than</Label><NumberInput id="epi-min" placeholder="—" value={qtyMin} onValueChange={setQtyMin} /></div>
                    <div>
                      <Label htmlFor="epi-round">Round</Label>
                      <Select id="epi-round" value={rounding} onChange={(e) => setRounding(e.target.value)}>
                        <option value="up">Round up (whole units)</option>
                        <option value="nearest">Nearest</option>
                        <option value="none">Exact — no rounding</option>
                      </Select>
                    </div>
                  </>
                )}
              </div>
            </details>
          )}
        </div>
      </Modal>
    </>
  );
}
