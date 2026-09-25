"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { SHELF_UNITS } from "@/lib/shelf-plan";
import { createInventoryItem } from "./actions";

/**
 * NEW ITEM (back in Shop Stock, Phase 2). An item is a name and a unit; what is on hand comes from
 * rolls, never a typed count (0303). So a new item can bring its first roll with it, counted in,
 * with what it cost and where it came from: a manual add is an OPENING roll, never a bare number.
 * A roll off a receipt goes on from the receipt instead, so its cost comes off the paper.
 */
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
        <Plus className="h-4 w-4" /> New Item
      </Button>

      <form action={onSubmit} id="new-shelf-item">
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="New Item On The Shelf"
          footer={<ModalActions onCancel={() => setOpen(false)} submit formId="new-shelf-item" saving={pending} saveLabel="Create Item" />}
        >
          <div className="space-y-4">
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label htmlFor="name">Name *</Label>
                <Input id="name" name="name" required placeholder="e.g. 12/2 NM-B" />
              </div>
              <div>
                <Label htmlFor="part_number">Part #</Label>
                <Input id="part_number" name="part_number" />
              </div>
              <div>
                <Label htmlFor="unit">Counted In</Label>
                <Select id="unit" name="unit" defaultValue="ea" className="h-11">
                  {SHELF_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="category">Category</Label>
                <Input id="category" name="category" placeholder="Wire, Connectors…" />
              </div>
              <div>
                <Label htmlFor="reorder_point">Reorder At</Label>
                <Input id="reorder_point" name="reorder_point" type="number" step="any" defaultValue={0} />
              </div>
              <div className="col-span-2">
                <Label htmlFor="location">Where It Lives</Label>
                <Input id="location" name="location" placeholder="Shop, Truck 2…" />
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-900">Already on the shelf? (optional)</p>
              <p className="mt-0.5 text-xs text-slate-500">A count, what it cost all together ($0 if you don&apos;t know), and where it came from.</p>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="opening_pieces">How Many</Label>
                  <Input id="opening_pieces" name="opening_pieces" type="number" step="any" min={0} defaultValue="" />
                </div>
                <div>
                  <Label htmlFor="opening_cost">What It Cost ($)</Label>
                  <Input id="opening_cost" name="opening_cost" type="number" step="0.01" min={0} defaultValue="" />
                </div>
                <div className="col-span-2">
                  <Label htmlFor="opening_note">Where It Came From</Label>
                  <Input id="opening_note" name="opening_note" placeholder="Counted in the truck, 9/24" />
                </div>
              </div>
            </div>
          </div>
        </Modal>
      </form>
    </>
  );
}
