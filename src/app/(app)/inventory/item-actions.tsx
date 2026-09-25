"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Pencil, Trash2 } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { updateInventoryItem, deleteInventoryItem, setInventoryItemActive } from "./actions";
import type { InventoryItem } from "@/lib/types";

/**
 * `hasHistory`: the item has rolls or moves on the shelf's record, so 0304 will never let it be
 * deleted. It gets Mark Inactive in Delete's place (a button that can only refuse is a dead door),
 * and an inactive item gets Make Active.
 */
export function ItemActions({ item, hasHistory = false }: { item: InventoryItem; hasHistory?: boolean }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();

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
    if (!confirm(`Delete "${item.name}" from Shop Stock?`)) return;
    start(async () => {
      // NOTHING SILENT: an item with rolls on the shelf's record can't be deleted (0304), and the
      // refusal says to mark it inactive instead.
      const res = await deleteInventoryItem(item.id);
      if (!res.ok) toast(res.error ?? "That item wasn't deleted.", "error");
      router.refresh();
    });
  }

  function onActive(next: boolean) {
    start(async () => {
      const res = await setInventoryItemActive(item.id, next);
      if (!res.ok) toast(res.error ?? "That item didn't change.", "error");
      else toast(next ? `${item.name} is active again.` : `${item.name} is inactive. Show Inactive Items to find it again.`, "success");
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
        {!item.active ? (
          <button
            onClick={() => onActive(true)}
            disabled={pending}
            className="flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            <ArchiveRestore className="h-4 w-4" /> Make Active
          </button>
        ) : hasHistory ? (
          <button
            onClick={() => onActive(false)}
            disabled={pending}
            className="flex min-h-11 items-center gap-1 rounded-md px-2 text-sm text-slate-600 hover:bg-slate-100"
          >
            <Archive className="h-4 w-4" /> Mark Inactive
          </button>
        ) : (
          <button
            onClick={onDelete}
            disabled={pending}
            className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <form action={onSubmit}>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Edit Item"
          footer={
            <ModalActions
              onCancel={() => setOpen(false)}
              submit
              saving={pending}
              saveLabel="Save Changes"
            />
          }
        >
          <div className="space-y-4">
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
              <Label htmlFor="ii-vendor">Vendor</Label>
              <Input id="ii-vendor" name="vendor" defaultValue={item.vendor ?? ""} />
            </div>
            <div className="col-span-2">
              <Label htmlFor="ii-loc">Location</Label>
              <Input id="ii-loc" name="location" defaultValue={item.location ?? ""} />
            </div>
          </div>
          </div>
        </Modal>
      </form>
    </>
  );
}
