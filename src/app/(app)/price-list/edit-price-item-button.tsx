"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { updatePriceItem } from "./actions";

interface PriceItem {
  id: string;
  code: string | null;
  description: string;
  category: string | null;
  supplier: string | null;
  unit: string;
  buy_price: number;
  markup_pct: number;
}

export function EditPriceItemButton({ item }: { item: PriceItem }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState(item.code ?? "");
  const [desc, setDesc] = useState(item.description);
  const [category, setCategory] = useState(item.category ?? "");
  const [supplier, setSupplier] = useState(item.supplier ?? "");
  const [buy, setBuy] = useState(item.buy_price);
  const [markup, setMarkup] = useState(item.markup_pct);

  function openModal() {
    // reset to the item's current values each time it opens
    setCode(item.code ?? "");
    setDesc(item.description);
    setCategory(item.category ?? "");
    setSupplier(item.supplier ?? "");
    setBuy(item.buy_price);
    setMarkup(item.markup_pct);
    setError(null);
    setOpen(true);
  }

  function save() {
    setError(null);
    if (!desc.trim()) return setError("Description is required.");
    start(async () => {
      const res = await updatePriceItem(item.id, {
        code,
        description: desc,
        category,
        supplier,
        buy_price: buy,
        markup_pct: markup,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      router.refresh();
    });
  }

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
        title="Edit price item"
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={save}
            saving={pending}
            saveLabel="Save changes"
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
              <Input id="epi-desc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. 12/2 Romex (250ft)" />
            </div>
            <div className="col-span-2">
              <Label htmlFor="epi-supplier">Supplier</Label>
              <Input id="epi-supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="epi-buy">Buy $</Label>
              <NumberInput id="epi-buy" value={buy} onValueChange={setBuy} />
            </div>
            <div>
              <Label htmlFor="epi-mk">Markup %</Label>
              <NumberInput id="epi-mk" value={markup} onValueChange={setMarkup} />
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
