"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Textarea, Select } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { StateSelect } from "@/components/ui/state-select";
import { MANAGE_ROW_CLS } from "./job-manage-menu";
import { updateJob } from "../actions";
import type { Job } from "@/lib/types";

/** ISO → yyyy-mm-dd in local time for a date input. */
function toLocalDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** HH:MM of an ISO timestamp in the viewer's local time, for a <input type="time">. */
function toLocalTime(iso: string | null, fallback: string): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function JobEditButton({
  job,
  customers,
  techs,
  templates = [],
  menuItem = false,
}: {
  job: Job;
  customers: { id: string; name: string }[];
  techs: { id: string; full_name: string | null }[];
  templates?: { id: string; name: string }[];
  /** Render the trigger as a Manage-menu row instead of a standalone button. */
  menuItem?: boolean;
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
  const [startTime, setStartTime] = useState(toLocalTime(job.scheduled_start, "08:00"));
  const [endTime, setEndTime] = useState(toLocalTime(job.scheduled_end, "16:00"));
  const router = useRouter();

  function onSubmit(formData: FormData) {
    setError(null);
    // Convert local date + time-of-day to ISO here so the server never guesses the
    // timezone. The time-of-day is what the planner/Agenda lays the day out by.
    formData.set("scheduled_start", startDate ? new Date(`${startDate}T${startTime || "08:00"}:00`).toISOString() : "");
    formData.set("scheduled_end", endDate ? new Date(`${endDate}T${endTime || "16:00"}:00`).toISOString() : "");
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
      {menuItem ? (
        <button type="button" onClick={() => setOpen(true)} className={MANAGE_ROW_CLS}>
          <Pencil className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> Edit Job
        </button>
      ) : (
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Pencil className="h-4 w-4" /> Edit Job
        </Button>
      )}

      {/* portal + a form-INSIDE-the-modal (submitted by id) so this opens correctly even though the
          trigger lives in the glass Manage menu — whose backdrop-filter would otherwise trap the
          overlay. See Modal's `portal` prop. */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Edit job"
        portal
        footer={
          <ModalActions onCancel={() => setOpen(false)} submit formId="job-edit-form" saving={pending} saveLabel="Save Changes" />
        }
      >
        <form id="job-edit-form" action={onSubmit} className="space-y-4">
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
                {newCust ? "Pick Existing" : "+ New Customer"}
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
              <StateSelect id="ej-state" name="state" value={state} onChange={setState} />
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
              <Label htmlFor="ej-start-time">Start time</Label>
              <Input id="ej-start-time" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} disabled={!startDate} />
            </div>
            <div>
              <Label htmlFor="ej-end">End date</Label>
              <Input id="ej-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ej-end-time">End time</Label>
              <Input id="ej-end-time" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} disabled={!endDate} />
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

          <div>
            <Label htmlFor="ej-billing">Billing</Label>
            <Select id="ej-billing" name="billing_type" defaultValue={(job as any).billing_type ?? "fixed"}>
              <option value="fixed">Fixed price</option>
              <option value="tm">Time &amp; Material</option>
            </Select>
            <p className="mt-1 text-xs text-slate-400">Time &amp; Material bills actual labor + materials; the estimate is a reference, not a cap.</p>
          </div>

          {templates.length > 0 && (
            <div>
              <Label htmlFor="ej-template">Job-code template</Label>
              <Select id="ej-template" name="code_template_id" defaultValue={(job as any).code_template_id ?? ""}>
                <option value="">All codes</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-slate-400">Limits the crew&apos;s clock-in/out code picker to this job&apos;s codes.</p>
            </div>
          )}
        </form>
      </Modal>
    </>
  );
}
