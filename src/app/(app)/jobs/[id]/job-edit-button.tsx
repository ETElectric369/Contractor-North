"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Textarea, Select } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { updateJob } from "../actions";
import type { Job } from "@/lib/types";

/** ISO → yyyy-mm-dd in local time for a date input. */
function toLocalDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function JobEditButton({
  job,
  customers,
  techs,
}: {
  job: Job;
  customers: { id: string; name: string }[];
  techs: { id: string; full_name: string | null }[];
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [newCust, setNewCust] = useState(false);
  const [city, setCity] = useState(job.city ?? "");
  const [state, setState] = useState(job.state ?? "");
  const [zip, setZip] = useState(job.zip ?? "");
  const [startDate, setStartDate] = useState(toLocalDate(job.scheduled_start));
  const [endDate, setEndDate] = useState(toLocalDate(job.scheduled_end));
  const router = useRouter();

  function onSubmit(formData: FormData) {
    setError(null);
    // Convert local dates to ISO here so the server never guesses the timezone.
    formData.set("scheduled_start", startDate ? new Date(`${startDate}T08:00:00`).toISOString() : "");
    formData.set("scheduled_end", endDate ? new Date(`${endDate}T16:00:00`).toISOString() : "");
    start(async () => {
      const res = await updateJob(job.id, formData);
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
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" /> Edit job
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Edit job">
        <form action={onSubmit} className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          <div>
            <Label htmlFor="ej-name">Job name *</Label>
            <Input id="ej-name" name="name" required defaultValue={job.name} />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="ej-customer">Customer</Label>
              <button
                type="button"
                onClick={() => setNewCust((v) => !v)}
                className="text-xs font-medium text-brand hover:underline"
              >
                {newCust ? "Pick existing" : "+ New customer"}
              </button>
            </div>
            {newCust ? (
              <div className="space-y-2">
                <Input name="new_customer_name" placeholder="New customer name" autoFocus />
                <div className="grid grid-cols-2 gap-2">
                  <Input name="new_customer_phone" placeholder="Phone (optional)" />
                  <Input name="new_customer_email" type="email" placeholder="Email (optional)" />
                </div>
              </div>
            ) : (
              <Select id="ej-customer" name="customer_id" defaultValue={job.customer_id ?? ""}>
                <option value="">— None —</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            )}
          </div>

          <div>
            <Label htmlFor="ej-address">Site address</Label>
            <AddressAutocomplete
              id="ej-address"
              name="address"
              streetOnly
              defaultValue={job.address ?? ""}
              onResolved={(p) => {
                setCity(p.city);
                setState(p.state);
                setZip(p.zip);
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="col-span-2">
              <Label htmlFor="ej-city">City</Label>
              <Input id="ej-city" name="city" value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ej-state">State</Label>
              <Input id="ej-state" name="state" maxLength={2} value={state} onChange={(e) => setState(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ej-zip">Zip</Label>
              <Input id="ej-zip" name="zip" value={zip} onChange={(e) => setZip(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ej-start">Start date</Label>
              <Input id="ej-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ej-end">End date</Label>
              <Input id="ej-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>

          <div>
            <Label>Assigned staff</Label>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5 rounded-lg border border-slate-200 px-3 py-2">
              {techs.length === 0 && <span className="text-sm text-slate-400">No team members yet.</span>}
              {techs.map((t) => (
                <label key={t.id} className="flex items-center gap-1.5 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="assigned_to"
                    value={t.id}
                    defaultChecked={job.assigned_to?.includes(t.id)}
                    className="h-4 w-4 rounded border-slate-300 text-brand"
                  />
                  {t.full_name ?? "Unnamed"}
                </label>
              ))}
            </div>
          </div>

          <div>
            <Label htmlFor="ej-desc">Description</Label>
            <Textarea id="ej-desc" name="description" rows={3} defaultValue={job.description ?? ""} />
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
