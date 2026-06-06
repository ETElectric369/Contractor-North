"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { createInventoryItem } from "./actions";

export function NewItemButton() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function onSubmit(formData: FormData) {
    setError(null);
    start(async () => {
      const res = await createInventoryItem(formData);
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
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New item
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="New inventory item">
        <form action={onSubmit} className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label htmlFor="name">Name *</Label>
              <Input id="name" name="name" required placeholder="e.g. 12/2 Romex NM-B" />
            </div>
            <div>
              <Label htmlFor="part_number">Part #</Label>
              <Input id="part_number" name="part_number" />
            </div>
            <div>
              <Label htmlFor="category">Category</Label>
              <Input id="category" name="category" placeholder="Wire, Breakers…" />
            </div>
            <div>
              <Label htmlFor="quantity_on_hand">On hand</Label>
              <Input id="quantity_on_hand" name="quantity_on_hand" type="number" step="any" defaultValue={0} />
            </div>
            <div>
              <Label htmlFor="unit">Unit</Label>
              <Input id="unit" name="unit" defaultValue="ea" />
            </div>
            <div>
              <Label htmlFor="reorder_point">Reorder at</Label>
              <Input id="reorder_point" name="reorder_point" type="number" step="any" defaultValue={0} />
            </div>
            <div>
              <Label htmlFor="unit_cost">Unit cost ($)</Label>
              <Input id="unit_cost" name="unit_cost" type="number" step="any" />
            </div>
            <div>
              <Label htmlFor="vendor">Vendor</Label>
              <Input id="vendor" name="vendor" defaultValue="CED" />
            </div>
            <div>
              <Label htmlFor="location">Location</Label>
              <Input id="location" name="location" placeholder="Warehouse, Truck 2…" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Add item"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
