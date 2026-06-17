"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { updateChangeOrder, deleteChangeOrder } from "./actions";

export function CoRowActions({
  co,
  jobs,
}: {
  co: { id: string; co_number: string; description: string; amount: number; job_id: string | null };
  jobs: { id: string; job_number: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    start(async () => {
      await deleteChangeOrder(co.id);
      router.refresh();
    });
  }

  return (
    <>
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

      <form action={onSubmit}>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title={`Edit ${co.co_number}`}
          footer={
            <ModalActions onCancel={() => setOpen(false)} submit saving={pending} saveLabel="Save changes" />
          }
        >
          <div className="space-y-4">
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <div>
              <Label htmlFor="co-desc">Description *</Label>
              <Textarea id="co-desc" name="description" rows={3} required defaultValue={co.description} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="co-amount">Amount</Label>
                <NumberInput id="co-amount" value={amount} onValueChange={setAmount} />
              </div>
              <div>
                <Label htmlFor="co-job">Job</Label>
                <Select id="co-job" name="job_id" defaultValue={co.job_id ?? ""}>
                  <option value="">— None —</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>{j.job_number} — {j.name}</option>
                  ))}
                </Select>
              </div>
            </div>
          </div>
        </Modal>
      </form>
    </>
  );
}
