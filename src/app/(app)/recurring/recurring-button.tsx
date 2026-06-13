"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { saveRecurring, deleteRecurring } from "./actions";

interface CustomerOpt { id: string; name: string }

export interface RecurringValue {
  id: string;
  kind: string;
  title: string;
  frequency: string;
  next_date: string;
  customer_id: string | null;
  description: string | null;
  amount: number | null;
  category: string | null;
  vendor: string | null;
}

export function RecurringButton({
  customers,
  template,
}: {
  customers: CustomerOpt[];
  template?: RecurringValue;
}) {
  const router = useRouter();
  const editing = !!template;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(template?.kind ?? "job");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(formData: FormData) {
    setError(null);
    start(async () => {
      const res = await saveRecurring(formData, template?.id);
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      router.refresh();
    });
  }
  function remove() {
    if (!template) return;
    start(async () => {
      await deleteRecurring(template.id);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      {editing ? (
        <button onClick={() => setOpen(true)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Edit">
          <Pencil className="h-4 w-4" />
        </button>
      ) : (
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New recurring</Button>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? "Edit recurring" : "New recurring"}>
        <form action={submit} className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="r-kind">Type</Label>
              <Select id="r-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="job">Recurring job</option>
                <option value="expense">Recurring expense</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="r-freq">Repeats</Label>
              <Select id="r-freq" name="frequency" defaultValue={template?.frequency ?? "monthly"}>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every 2 weeks</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="yearly">Yearly</option>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="r-title">Title</Label>
            <Input id="r-title" name="title" defaultValue={template?.title ?? ""} placeholder={kind === "job" ? "e.g. Monthly maintenance — Acme" : "e.g. Shop rent"} required />
          </div>

          <div>
            <Label htmlFor="r-next">Next date</Label>
            <Input id="r-next" name="next_date" type="date" defaultValue={template?.next_date ?? ""} required />
          </div>

          {kind === "job" ? (
            <>
              <div>
                <Label htmlFor="r-cust">Customer</Label>
                <Select id="r-cust" name="customer_id" defaultValue={template?.customer_id ?? ""}>
                  <option value="">—</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </div>
              <div>
                <Label htmlFor="r-desc">Description</Label>
                <Textarea id="r-desc" name="description" rows={2} defaultValue={template?.description ?? ""} />
              </div>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Label htmlFor="r-vendor">Vendor</Label>
                <Input id="r-vendor" name="vendor" defaultValue={template?.vendor ?? ""} placeholder="e.g. landlord" />
              </div>
              <div>
                <Label htmlFor="r-amt">Amount</Label>
                <Input id="r-amt" name="amount" type="number" step="0.01" min="0" defaultValue={template?.amount ?? ""} />
              </div>
              <div className="col-span-3">
                <Label htmlFor="r-cat">Category</Label>
                <Input id="r-cat" name="category" defaultValue={template?.category ?? ""} placeholder="e.g. Rent, Insurance, Software" />
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            {editing ? (
              <Button type="button" variant="outline" onClick={remove} disabled={pending} className="text-red-600">Delete</Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
            </div>
          </div>
        </form>
      </Modal>
    </>
  );
}
