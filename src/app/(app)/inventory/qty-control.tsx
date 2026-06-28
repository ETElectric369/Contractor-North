"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Minus, Plus } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { adjustQuantity } from "./actions";

export function QtyControl({
  id,
  name,
  quantity,
  unit,
}: {
  id: string;
  name: string;
  quantity: number;
  unit: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(quantity);
  const [error, setError] = useState<string | null>(null);

  function bump(delta: number) {
    start(async () => {
      await adjustQuantity(id, delta);
      router.refresh();
    });
  }

  function openRecount() {
    setCount(quantity);
    setError(null);
    setOpen(true);
  }

  function saveRecount() {
    setError(null);
    // Click-to-edit = set an absolute count after a physical recount. We reuse
    // the existing, audited adjustQuantity by feeding it the delta from current.
    const delta = count - quantity;
    if (delta === 0) {
      setOpen(false);
      return;
    }
    start(async () => {
      const res = await adjustQuantity(id, delta);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={() => bump(-1)}
          disabled={pending || quantity <= 0}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
          aria-label="Decrease"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={openRecount}
          disabled={pending}
          title="Set on-hand count (physical recount)"
          className="w-16 rounded-md px-1 py-0.5 text-right text-sm font-medium tabular-nums text-slate-900 hover:bg-slate-100 disabled:opacity-40"
        >
          {quantity} <span className="text-xs text-slate-400">{unit}</span>
        </button>
        <button
          onClick={() => bump(1)}
          disabled={pending}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-40"
          aria-label="Increase"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Set on-hand count"
        size="sm"
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={saveRecount}
            saving={pending}
            saveLabel="Save count"
          />
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <p className="text-sm text-slate-500">
            Enter the actual count for <span className="font-medium text-slate-700">{name}</span> after a
            physical recount. Currently {quantity} {unit} on hand.
          </p>
          <div>
            <Label htmlFor="qty-recount">On hand ({unit})</Label>
            <NumberInput
              id="qty-recount"
              value={count}
              onValueChange={setCount}
              autoFocus
            />
          </div>
        </div>
      </Modal>
    </>
  );
}
