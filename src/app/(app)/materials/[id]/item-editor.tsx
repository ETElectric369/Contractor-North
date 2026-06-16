"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { formatCurrency } from "@/lib/utils";
import {
  addMaterialItem,
  deleteMaterialItem,
  updateMaterialItem,
  setMaterialItemPurchased,
} from "../actions";

interface Item {
  id: string;
  description: string;
  part_number: string | null;
  quantity: number;
  unit: string | null;
  vendor: string | null;
  est_cost: number | null;
  purchased?: boolean;
}

export function ItemEditor({ listId, items }: { listId: string; items: Item[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // add
  const [desc, setDesc] = useState("");
  const [part, setPart] = useState("");
  const [qty, setQty] = useState(1);
  const [unit, setUnit] = useState("ea");
  const [cost, setCost] = useState(0);
  // edit
  const [editId, setEditId] = useState<string | null>(null);
  const [eDesc, setEDesc] = useState("");
  const [ePart, setEPart] = useState("");
  const [eQty, setEQty] = useState(1);
  const [eUnit, setEUnit] = useState("ea");
  const [eCost, setECost] = useState(0);

  const total = items.reduce((s, i) => s + (i.est_cost ?? 0) * i.quantity, 0);
  const purchasedCount = items.filter((i) => i.purchased).length;

  function add() {
    if (!desc.trim()) return;
    setError(null);
    start(async () => {
      const res = await addMaterialItem(listId, {
        description: desc,
        part_number: part || null,
        quantity: qty || 1,
        unit: unit || "ea",
        vendor: null,
        est_cost: cost || null,
      });
      if (!res.ok) return setError(res.error ?? "Could not add the item.");
      setDesc("");
      setPart("");
      setQty(1);
      setUnit("ea");
      setCost(0);
      router.refresh();
    });
  }

  function remove(id: string) {
    setError(null);
    start(async () => {
      const res = await deleteMaterialItem(id, listId);
      if (!res.ok) return setError(res.error ?? "Could not remove the item.");
      router.refresh();
    });
  }

  function togglePurchased(it: Item) {
    setError(null);
    start(async () => {
      const res = await setMaterialItemPurchased(it.id, listId, !it.purchased);
      if (!res.ok) return setError(res.error ?? "Could not update.");
      router.refresh();
    });
  }

  function startEdit(it: Item) {
    setEditId(it.id);
    setEDesc(it.description);
    setEPart(it.part_number ?? "");
    setEQty(it.quantity);
    setEUnit(it.unit ?? "ea");
    setECost(it.est_cost ?? 0);
  }

  function saveEdit() {
    if (!editId || !eDesc.trim()) return;
    setError(null);
    start(async () => {
      const res = await updateMaterialItem(editId, listId, {
        description: eDesc,
        part_number: ePart || null,
        quantity: eQty || 1,
        unit: eUnit || "ea",
        est_cost: eCost || null,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setEditId(null);
      router.refresh();
    });
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      {error && <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      <ul className="divide-y divide-slate-100">
        {items.map((it) =>
          editId === it.id ? (
            <li key={it.id} className="space-y-2 bg-slate-50/80 px-4 py-3">
              <div className="flex gap-2">
                <Input value={eDesc} onChange={(e) => setEDesc(e.target.value)} className="flex-1" placeholder="Description" />
                <Input value={ePart} onChange={(e) => setEPart(e.target.value)} className="w-24 shrink-0" placeholder="Part #" />
              </div>
              <div className="flex items-center gap-2">
                <NumberInput value={eQty} onValueChange={setEQty} className="w-16 text-center" />
                <Input value={eUnit} onChange={(e) => setEUnit(e.target.value)} className="w-16 shrink-0" />
                <NumberInput value={eCost} onValueChange={setECost} className="flex-1 text-right" placeholder="Est. cost" />
                <button onClick={saveEdit} disabled={pending} className="rounded-md bg-brand p-2 text-white disabled:opacity-50" aria-label="Save">
                  <Check className="h-4 w-4" />
                </button>
                <button onClick={() => setEditId(null)} className="rounded-md p-2 text-slate-400 hover:bg-slate-100" aria-label="Cancel">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </li>
          ) : (
            <li key={it.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <input
                type="checkbox"
                checked={!!it.purchased}
                onChange={() => togglePurchased(it)}
                disabled={pending}
                className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand focus:ring-brand"
                title="Mark purchased"
              />
              <div className={`min-w-0 flex-1 ${it.purchased ? "opacity-50" : ""}`}>
                <div className={`font-medium text-slate-800 ${it.purchased ? "line-through" : ""}`}>{it.description}</div>
                <div className="text-xs text-slate-400">
                  {it.part_number ? `#${it.part_number} · ` : ""}
                  {it.quantity} {it.unit}
                  {it.est_cost != null ? ` × ${formatCurrency(it.est_cost)}` : ""}
                </div>
              </div>
              <div className="shrink-0 font-medium text-slate-900">
                {it.est_cost != null ? formatCurrency(it.est_cost * it.quantity) : "—"}
              </div>
              <button onClick={() => startEdit(it)} disabled={pending} className="shrink-0 text-slate-300 hover:text-slate-600" aria-label="Edit item">
                <Pencil className="h-4 w-4" />
              </button>
              <button onClick={() => remove(it.id)} disabled={pending} className="shrink-0 text-slate-300 hover:text-red-600" aria-label="Remove item">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ),
        )}
        {items.length === 0 && <li className="px-4 py-6 text-center text-slate-400">No items yet — add one below.</li>}
      </ul>

      {items.length > 0 && (
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2 text-sm">
          <span className="text-slate-500">{purchasedCount}/{items.length} purchased</span>
          <span className="font-semibold text-slate-900">{formatCurrency(total)}</span>
        </div>
      )}

      {/* Add item */}
      <div className="space-y-2 border-t border-slate-100 bg-slate-50/60 p-3">
        <div className="flex gap-2">
          <Input placeholder="Add an item…" value={desc} onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} className="flex-1" />
          <Input placeholder="Part #" value={part} onChange={(e) => setPart(e.target.value)} className="w-24 shrink-0" />
        </div>
        <div className="flex items-center gap-2">
          <NumberInput value={qty} onValueChange={setQty} className="w-16 text-center" placeholder="Qty" />
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} className="w-16 shrink-0" placeholder="ea" />
          <NumberInput value={cost} onValueChange={setCost} className="flex-1 text-right" placeholder="Est. cost" />
          <Button onClick={add} disabled={pending || !desc.trim()}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
      </div>
    </div>
  );
}
