"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Copy, Check, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import {
  createAppointment,
  updateAppointment,
  deleteAppointment,
  createJobFromAppointment,
  createAppointmentProposal,
} from "./actions";

/** Next three weekdays at 8 AM — sensible default slots to propose. */
function defaultSlots(): { date: string; time: string }[] {
  const out: { date: string; time: string }[] = [];
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  while (out.length < 3) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6)
      out.push({ date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: "08:00" });
  }
  return out;
}

interface Opt { id: string; label: string; address?: string | null }

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
  compact = false,
}: {
  jobs: Opt[];
  customers: Opt[];
  staff: Opt[];
  appointment?: ApptValue;
  defaultDate?: string;
  /** Tight card-header variant: small button that stays on one line. */
  compact?: boolean;
}) {
  const router = useRouter();
  const editing = !!appointment;
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newCust, setNewCust] = useState(false);
  // Location is controlled so picking a job can auto-fill it from the job address.
  const [location, setLocation] = useState(appointment?.location ?? "");
  // "Propose times" mode: offer the customer up to 3 date+time slots to pick.
  const [mode, setMode] = useState<"set" | "propose">("set");
  const [slots, setSlots] = useState(defaultSlots);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const pickLink = linkToken && origin ? `${origin}/pick/${linkToken}` : null;

  function closeAll() {
    setOpen(false);
    setLinkToken(null);
    setMode("set");
    setSlots(defaultSlots());
  }

  function convertToJob() {
    if (!appointment) return;
    setError(null);
    start(async () => {
      const res = await createJobFromAppointment(appointment.id);
      if (!res.ok || !res.id) return setError(res.error ?? "Could not create job.");
      setOpen(false);
      router.push(`/jobs/${res.id}`);
    });
  }

  const s = appointment ? toLocal(appointment.starts_at) : { date: defaultDate ?? "", time: "08:00" };
  const e = appointment ? toLocal(appointment.ends_at) : { date: "", time: "" };

  function submit(formData: FormData) {
    setError(null);

    // "Propose times" — create a tentative appointment + a pick-a-time link.
    if (mode === "propose" && !editing) {
      const clean = slots.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date));
      if (!clean.length) return setError("Add at least one date option.");
      formData.set("slots_json", JSON.stringify(clean));
      const first = new Date(`${clean[0].date}T${clean[0].time || "08:00"}:00`);
      if (!isNaN(first.getTime())) formData.set("starts_at_iso", first.toISOString());
      start(async () => {
        const res = await createAppointmentProposal(formData);
        if (!res.ok || !res.token) return setError(res.error ?? "Could not create the link.");
        setLinkToken(res.token);
        router.refresh();
      });
      return;
    }

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

  async function copyLink() {
    if (!pickLink) return;
    try {
      await navigator.clipboard.writeText(pickLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied — link is visible to select */
    }
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
        <Button onClick={() => setOpen(true)} size={compact ? "sm" : undefined} className="shrink-0 whitespace-nowrap">
          <Plus className="h-4 w-4" /> New Appointment
        </Button>
      )}

      <Modal
        open={open}
        onClose={closeAll}
        title={editing ? "Edit appointment" : linkToken ? "Text the customer these times" : "New appointment"}
        footer={
          linkToken ? (
            <ModalActions onCancel={closeAll} onSave={closeAll} saveLabel="Done" hideCancel />
          ) : (
            <ModalActions
              onCancel={closeAll}
              submit
              formId="appt-form"
              saving={pending}
              saveLabel={mode === "propose" ? "Create link" : "Save appointment"}
              extra={
                editing ? (
                  <Button type="button" variant="outline" onClick={remove} disabled={pending} className="text-red-600">
                    Delete
                  </Button>
                ) : undefined
              }
            />
          )
        }
      >
        <form id="appt-form" action={submit}>
          <div className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          {linkToken && (
            <div className="space-y-3">
              <div className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
                Link ready — text it to the customer. The appointment confirms onto your calendar the
                moment they tap a time.
              </div>
              <code className="block break-all rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-700">{pickLink}</code>
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={copyLink}>
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <a
                  href={`sms:?body=${encodeURIComponent(`Hi! Pick a time that works and we'll lock it in: ${pickLink}`)}`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-dark"
                >
                  <MessageSquare className="h-3.5 w-3.5" /> Text it
                </a>
              </div>
            </div>
          )}

          {!linkToken && (
          <>
          {/* fields */}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ap-type">Type</Label>
              <Select id="ap-type" name="type" defaultValue={appointment?.type ?? "quote"}>
                <option value="quote">Quote / estimate a job</option>
                <option value="meeting">Meet with client</option>
                <option value="inspection">Inspection</option>
                <option value="appointment">Appointment</option>
                <option value="other">Other</option>
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

          {!editing && (
            <SegmentedControl
              stretch
              activeId={mode}
              onSelect={(id) => setMode(id as typeof mode)}
              items={[
                { id: "set", label: "Set a time" },
                { id: "propose", label: "Propose times" },
              ]}
            />
          )}

          {editing || mode === "set" ? (
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
          ) : (
            <div className="space-y-2 rounded-lg border border-brand/30 bg-brand-light/20 p-3">
              <Label>Offer up to 3 times — the customer taps one</Label>
              {slots.map((sl, i) => (
                <div key={i} className="grid grid-cols-2 gap-2">
                  <Input
                    type="date"
                    value={sl.date}
                    onChange={(ev) => setSlots((a) => a.map((x, xi) => (xi === i ? { ...x, date: ev.target.value } : x)))}
                    aria-label={`Option ${i + 1} date`}
                  />
                  <Input
                    type="time"
                    value={sl.time}
                    onChange={(ev) => setSlots((a) => a.map((x, xi) => (xi === i ? { ...x, time: ev.target.value } : x)))}
                    aria-label={`Option ${i + 1} time`}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ap-cust">Customer</Label>
              <Select
                id="ap-cust"
                name="customer_id"
                defaultValue={appointment?.customer_id ?? ""}
                onChange={(e) => setNewCust(e.target.value === "__new__")}
              >
                <option value="">—</option>
                {customers.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                <option value="__new__">+ New customer…</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="ap-job">Job</Label>
              <Select
                id="ap-job"
                name="job_id"
                defaultValue={appointment?.job_id ?? ""}
                onChange={(e) => {
                  // Auto-fill the location from the job's address when it's empty.
                  const job = jobs.find((j) => j.id === e.target.value);
                  if (job?.address && !location.trim()) setLocation(job.address);
                }}
              >
                <option value="">—</option>
                {jobs.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </Select>
            </div>
          </div>

          {newCust && (
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-brand/30 bg-brand-light/30 p-3">
              <div>
                <Label htmlFor="ap-newname">New customer name</Label>
                <Input id="ap-newname" name="new_customer_name" placeholder="Name" required />
              </div>
              <div>
                <Label htmlFor="ap-newphone">Phone</Label>
                <Input id="ap-newphone" name="new_customer_phone" type="tel" placeholder="Optional" />
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="ap-loc">Location</Label>
            <Input id="ap-loc" name="location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Address or site" />
          </div>
          <div>
            <Label htmlFor="ap-notes">Notes</Label>
            <Textarea id="ap-notes" name="notes" rows={2} defaultValue={appointment?.notes ?? ""} />
          </div>

          {editing && appointment && !appointment.job_id && (
            <Button type="button" variant="outline" onClick={convertToJob} disabled={pending} className="w-full">
              Convert to job →
            </Button>
          )}
          </>
          )}
          </div>
        </form>
      </Modal>
    </>
  );
}
