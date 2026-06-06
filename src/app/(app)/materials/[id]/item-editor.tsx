"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-5 py-3 font-semibold">Description</th>
            <th className="px-3 py-3 font-semibold">Part #</th>
            <th className="px-3 py-3 text-right font-semibold">Qty</th>
            <th className="px-3 py-3 font-semibold">Unit</th>
            <th className="px-3 py-3 text-right font-semibold">Est. cost</th>
            <th className="px-5 py-3 text-right font-semibold">Line</th>
            <th className="px-3 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((it) => (
            <tr key={it.id}>
              <td className="px-5 py-2.5 text-slate-800">{it.description}</td>
              <td className="px-3 py-2.5 text-slate-500">{it.part_number ?? "—"}</td>
              <td className="px-3 py-2.5 text-right text-slate-600">{it.quantity}</td>
              <td className="px-3 py-2.5 text-slate-500">{it.unit}</td>
              <td className="px-3 py-2.5 text-right text-slate-600">
                {it.est_cost != null ? formatCurrency(it.est_cost) : "—"}
              </td>
              <td className="px-5 py-2.5 text-right font-medium text-slate-900">
                {it.est_cost != null
                  ? formatCurrency(it.est_cost * it.quantity)
                  : "—"}
              </td>
              <td className="px-3 py-2.5 text-right">
                <button
                  onClick={() => remove(it.id)}
                  disabled={pending}
                  className="text-slate-400 hover:text-red-600"
                  aria-label="Remove item"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={7} className="px-5 py-6 text-center text-slate-400">
                No items yet — add one below.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-100 bg-slate-50/50">
            <td className="px-5 py-2">
              <Input
                placeholder="Add item…"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
              />
            </td>
            <td className="px-3 py-2">
              <Input placeholder="Part #" value={part} onChange={(e) => setPart(e.target.value)} />
            </td>
            <td className="px-3 py-2">
              <Input
                type="number"
                step="any"
                value={qty}
                onChange={(e) => setQty(Number(e.target.value))}
                className="text-right"
              />
            </td>
            <td className="px-3 py-2">
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
            </td>
            <td className="px-3 py-2">
              <Input
                type="number"
                step="any"
                value={cost}
                onChange={(e) => setCost(Number(e.target.value))}
                className="text-right"
              />
            </td>
            <td className="px-5 py-2 text-right font-semibold text-slate-900">
              {formatCurrency(total)}
            </td>
            <td className="px-3 py-2 text-right">
              <Button size="icon" onClick={add} disabled={pending || !desc.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
