"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Minus, Plus } from "lucide-react";
import { adjustQuantity } from "./actions";

export function QtyControl({
  id,
  quantity,
  unit,
}: {
  id: string;
  quantity: number;
  unit: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function bump(delta: number) {
    start(async () => {
      await adjustQuantity(id, delta);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <button
        onClick={() => bump(-1)}
        disabled={pending || quantity <= 0}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
        aria-label="Decrease"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="w-16 text-right text-sm font-medium tabular-nums text-slate-900">
        {quantity} <span className="text-xs text-slate-400">{unit}</span>
      </span>
      <button
        onClick={() => bump(1)}
        disabled={pending}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
        aria-label="Increase"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
