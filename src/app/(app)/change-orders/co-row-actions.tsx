"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { updateChangeOrder, deleteChangeOrder } from "./actions";

/**
 * Edit and Delete on a change order's row (the job's Change Orders tab). THE EDIT HAS NO JOB BOX
 * (W2-12): a change order stays on its job, so the edit sends only its description and amount, and
 * nothing here can unlink it. `jobs` is still handed in by the job page (its one job); it's unused.
 */
export function CoRowActions({
  co,
}: {
  co: { id: string; co_number: string; description: string; amount: number; job_id: string | null };
  jobs?: { id: string; job_number: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [amount, setAmount] = useState(Number(co.amount) || 0);
  const [pending, start] = useTransition();
  const router = useRouter();

  function onSubmit(formData: FormData) {
    setError(null);
    formData.set("amount", String(amount));
    start(async () => {
      const res = await updateChangeOrder(co.id, formData);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  function onDelete() {
    if (!confirm(`Delete change order ${co.co_number}?`)) return;
    setDeleteError(null);
    start(async () => {
      // Nothing silent: a delete that changed nothing says so beside the row.
      const res = await deleteChangeOrder(co.id);
      if (!res.ok) {
        setDeleteError(res.error ?? "That didn't delete. Try again.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      {deleteError && <span className="text-xs text-rose-600">{deleteError}</span>}
      <button
        onClick={() => setOpen(true)}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        title="Edit"
        aria-label="Edit"
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        onClick={onDelete}
        disabled={pending}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
        title="Delete"
        aria-label="Delete"
      >
        <Trash2 className="h-4 w-4" />
      </button>

      <form action={onSubmit}>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title={`Edit ${co.co_number}`}
          footer={
            <ModalActions onCancel={() => setOpen(false)} submit saving={pending} saveLabel="Save Changes" />
          }
        >
          <div className="space-y-4">
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <div>
              <Label htmlFor="co-desc">Description *</Label>
              <Textarea id="co-desc" name="description" rows={3} required defaultValue={co.description} />
            </div>
            <div>
              <Label htmlFor="co-amount">Amount</Label>
              <NumberInput id="co-amount" value={amount} onValueChange={setAmount} />
            </div>
          </div>
        </Modal>
      </form>
    </>
  );
}
