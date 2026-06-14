"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { createAppointment, updateAppointment, deleteAppointment } from "./actions";

interface Opt { id: string; label: string }

export interface ApptValue {
  id: string;
  type: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  job_id: string | null;
  customer_id: string | null;
  location: string | null;
  notes: string | null;
  assigned_to: string | null;
}

function toLocal(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

/** Create or edit an appointment / inspection. */
export function AppointmentButton({
  jobs,
  customers,
  staff,
  appointment,
  defaultDate,
}: {
  jobs: Opt[];
  customers: Opt[];
  staff: Opt[];
  appointment?: ApptValue;
  defaultDate?: string;
}) {
  const router = useRouter();
  const editing = !!appointment;
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const s = appointment ? toLocal(appointment.starts_at) : { date: defaultDate ?? "", time: "08:00" };
  const e = appointment ? toLocal(appointment.ends_at) : { date: "", time: "" };

  function submit(formData: FormData) {
    setError(null);
    // Resolve the picked date+time to ISO here in the browser, so the user's own
    // timezone is honored (the server action runs in UTC).
    const date = String(formData.get("date") ?? "");
    if (date) {
      const st = String(formData.get("start_time") ?? "") || "08:00";
      const startD = new Date(`${date}T${st}:00`);
      if (!isNaN(startD.getTime())) formData.set("starts_at_iso", startD.toISOString());
      const et = String(formData.get("end_time") ?? "");
      if (et) {
        const endD = new Date(`${date}T${et}:00`);
        if (!isNaN(endD.getTime())) formData.set("ends_at_iso", endD.toISOString());
      }
    }
    start(async () => {
      const res = editing
        ? await updateAppointment(appointment!.id, formData)
        : await createAppointment(formData);
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setOpen(false);
      router.refresh();
    });
  }

  function remove() {
    if (!appointment) return;
    start(async () => {
      await deleteAppointment(appointment.id);
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
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> New appointment
        </Button>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? "Edit appointment" : "New appointment"}>
        <form action={submit} className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ap-type">Type</Label>
              <Select id="ap-type" name="type" defaultValue={appointment?.type ?? "appointment"}>
                <option value="appointment">Appointment</option>
                <option value="inspection">Inspection</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="ap-assigned">Assigned to</Label>
              <Select id="ap-assigned" name="assigned_to" defaultValue={appointment?.assigned_to ?? ""}>
                <option value="">— Anyone —</option>
                {staff.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="ap-title">Title</Label>
            <Input id="ap-title" name="title" defaultValue={appointment?.title ?? ""} placeholder="e.g. Rough-in inspection, estimate walk-through" required />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="ap-date">Date</Label>
              <Input id="ap-date" name="date" type="date" defaultValue={s.date} required />
            </div>
            <div>
              <Label htmlFor="ap-start">Start</Label>
              <Input id="ap-start" name="start_time" type="time" defaultValue={s.time || "08:00"} />
            </div>
            <div>
              <Label htmlFor="ap-end">End</Label>
              <Input id="ap-end" name="end_time" type="time" defaultValue={e.time} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ap-cust">Customer</Label>
              <Select id="ap-cust" name="customer_id" defaultValue={appointment?.customer_id ?? ""}>
                <option value="">—</option>
                {customers.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="ap-job">Job</Label>
              <Select id="ap-job" name="job_id" defaultValue={appointment?.job_id ?? ""}>
                <option value="">—</option>
                {jobs.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="ap-loc">Location</Label>
            <Input id="ap-loc" name="location" defaultValue={appointment?.location ?? ""} placeholder="Address or site" />
          </div>
          <div>
            <Label htmlFor="ap-notes">Notes</Label>
            <Textarea id="ap-notes" name="notes" rows={2} defaultValue={appointment?.notes ?? ""} />
          </div>

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
