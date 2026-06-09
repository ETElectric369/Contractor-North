"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { formatCurrency } from "@/lib/utils";
import { addMaterialItem, deleteMaterialItem } from "../actions";

interface Item {
  id: string;
  description: string;
  part_number: string | null;
  quantity: number;
  unit: string | null;
  vendor: string | null;
  est_cost: number | null;
}

export function ItemEditor({
  listId,
  items,
}: {
  listId: string;
  items: Item[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [desc, setDesc] = useState("");
  const [part, setPart] = useState("");
  const [qty, setQty] = useState(1);
  const [unit, setUnit] = useState("ea");
  const [cost, setCost] = useState(0);

  const total = items.reduce(
    (s, i) => s + (i.est_cost ?? 0) * i.quantity,
    0,
  );

  function add() {
    if (!desc.trim()) return;
    start(async () => {
      await addMaterialItem(listId, {
        description: desc,
        part_number: part || null,
        quantity: qty || 1,
        unit: unit || "ea",
        vendor: null,
        est_cost: cost || null,
      });
      setDesc("");
      setPart("");
      setQty(1);
      setUnit("ea");
      setCost(0);
      router.refresh();
    });
  }

  function remove(id: string) {
    start(async () => {
      await deleteMaterialItem(id, listId);
      router.refresh();
    });
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <ul className="divide-y divide-slate-100">
        {items.map((it) => (
          <li key={it.id} className="flex items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-slate-800">{it.description}</div>
              <div className="text-xs text-slate-400">
                {it.part_number ? `#${it.part_number} · ` : ""}
                {it.quantity} {it.unit}
                {it.est_cost != null ? ` × ${formatCurrency(it.est_cost)}` : ""}
              </div>
            </div>
            <div className="shrink-0 font-medium text-slate-900">
              {it.est_cost != null ? formatCurrency(it.est_cost * it.quantity) : "—"}
            </div>
            <button
              onClick={() => remove(it.id)}
              disabled={pending}
              className="shrink-0 text-slate-400 hover:text-red-600"
              aria-label="Remove item"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
        {items.length === 0 && (
          <li className="px-4 py-6 text-center text-slate-400">No items yet — add one below.</li>
        )}
      </ul>

      {items.length > 0 && (
        <div className="flex justify-between border-t border-slate-100 px-4 py-2 text-sm">
          <span className="text-slate-500">Estimated total</span>
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
