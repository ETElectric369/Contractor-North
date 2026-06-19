"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { createJob } from "./actions";

interface CustomerOption {
  id: string;
  name: string;
}

export function NewJobButton({
  customers,
  defaultCustomerId,
}: {
  customers: CustomerOption[];
  defaultCustomerId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [newCust, setNewCust] = useState(false);
  const [name, setName] = useState("");
  // "Auto pick a date for you" — default to today, still changeable.
  const today = (() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const [startDate, setStartDate] = useState(today);
  const router = useRouter();

  function onSubmit(formData: FormData) {
    setError(null);
    // Convert the local date to ISO here so the server never guesses the timezone.
    formData.set("scheduled_start", startDate ? new Date(`${startDate}T08:00:00`).toISOString() : "");
    start(async () => {
      const res = await createJob(formData);
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
        <Plus className="h-4 w-4" /> New job
      </Button>

      <form action={onSubmit}>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="New job"
          footer={
            <ModalActions
              onCancel={() => setOpen(false)}
              submit
              saving={pending}
              saveLabel="Create job"
            />
          }
        >
          <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div>
            <Label htmlFor="name">Job name *</Label>
            <Input
              id="name"
              name="name"
              required
              placeholder="e.g. Smith panel upgrade"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="customer_id">Customer</Label>
                <button
                  type="button"
                  onClick={() => setNewCust((v) => !v)}
                  className="text-xs font-medium text-brand hover:underline"
                >
                  {newCust ? "Pick existing" : "+ New customer"}
                </button>
              </div>
              {newCust ? (
                <Input name="new_customer_name" placeholder="New customer name" autoFocus />
              ) : (
                <Select id="customer_id" name="customer_id" defaultValue={defaultCustomerId ?? ""}>
                  <option value="">— None —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <div>
              <Label htmlFor="status">Status</Label>
              <Select id="status" name="status" defaultValue="estimate">
                <option value="estimate">Estimate</option>
                <option value="scheduled">Scheduled</option>
                <option value="in_progress">In progress</option>
                <option value="on_hold">On hold</option>
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="billing_type">Billing</Label>
            <Select id="billing_type" name="billing_type" defaultValue="fixed">
              <option value="fixed">Fixed price</option>
              <option value="tm">Time &amp; Material</option>
            </Select>
            <p className="mt-1 text-xs text-slate-400">Time &amp; Material bills actual labor + materials; the estimate is a reference, not a cap.</p>
          </div>
          {newCust && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="new_customer_phone">Customer phone</Label>
                <Input id="new_customer_phone" name="new_customer_phone" placeholder="(optional)" />
              </div>
              <div>
                <Label htmlFor="new_customer_email">Customer email</Label>
                <Input id="new_customer_email" name="new_customer_email" type="email" placeholder="(optional)" />
              </div>
            </div>
          )}
          <div>
            <Label htmlFor="address">Site address</Label>
            <AddressAutocomplete
              id="address"
              name="address"
              onResolved={(p) => {
                // Auto-fill the job name with "number + street" when empty.
                if (!name.trim() && p.line1) setName(p.line1);
              }}
            />
          </div>
          <div>
            <Label htmlFor="scheduled_start">Scheduled date</Label>
            <Input id="scheduled_start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" name="description" rows={2} />
          </div>
          </div>
        </Modal>
      </form>
    </>
  );
}
