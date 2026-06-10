"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { updateInventoryItem, deleteInventoryItem } from "./actions";
import type { InventoryItem } from "@/lib/types";

export function ItemActions({ item }: { item: InventoryItem }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function onSubmit(formData: FormData) {
    setError(null);
    start(async () => {
      const res = await updateInventoryItem(item.id, formData);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  function onDelete() {
    if (!confirm(`Delete "${item.name}" from inventory?`)) return;
    start(async () => {
      await deleteInventoryItem(item.id);
      router.refresh();
    });
  }

  return (
    <>
      <div className="flex items-center justify-end gap-1">
        <button
          onClick={() => setOpen(true)}
          className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          title="Edit"
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          onClick={onDelete}
          disabled={pending}
          className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
          title="Delete"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Edit item">
        <form action={onSubmit} className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label htmlFor="ii-name">Name *</Label>
              <Input id="ii-name" name="name" required defaultValue={item.name} />
            </div>
            <div>
              <Label htmlFor="ii-part">Part #</Label>
              <Input id="ii-part" name="part_number" defaultValue={item.part_number ?? ""} />
            </div>
            <div>
              <Label htmlFor="ii-cat">Category</Label>
              <Input id="ii-cat" name="category" defaultValue={item.category ?? ""} />
            </div>
            <div>
              <Label htmlFor="ii-unit">Unit</Label>
              <Input id="ii-unit" name="unit" defaultValue={item.unit} />
            </div>
            <div>
              <Label htmlFor="ii-reorder">Reorder point</Label>
              <Input id="ii-reorder" name="reorder_point" type="number" step="any" defaultValue={item.reorder_point} />
            </div>
            <div>
              <Label htmlFor="ii-cost">Unit cost</Label>
              <Input id="ii-cost" name="unit_cost" type="number" step="any" defaultValue={item.unit_cost ?? ""} />
            </div>
            <div>
              <Label htmlFor="ii-vendor">Vendor</Label>
              <Input id="ii-vendor" name="vendor" defaultValue={item.vendor ?? ""} />
            </div>
            <div className="col-span-2">
              <Label htmlFor="ii-loc">Location</Label>
              <Input id="ii-loc" name="location" defaultValue={item.location ?? ""} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
