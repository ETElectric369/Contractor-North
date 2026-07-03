"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Plus, Pencil, Copy, Check, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { useDraft } from "@/lib/use-draft";
import {
  createAppointment,
  updateAppointment,
  deleteAppointment,
  createJobFromAppointment,
  createAppointmentProposal,
} from "./actions";

const p2 = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** Next three weekdays at 8 AM — sensible default slots to propose. */
function defaultSlots(): { date: string; time: string }[] {
  const out: { date: string; time: string }[] = [];
  const d = new Date();
  while (out.length < 3) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) out.push({ date: ymd(d), time: "08:00" });
  }
  return out;
}

/** The day we should open the create form on: the viewed day if the caller passed one, else
 *  today if it's a weekday, else roll forward to the next weekday. Never a blind empty date. */
function suggestedDate(defaultDate?: string): string {
  if (defaultDate) return defaultDate;
  const d = new Date();
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return ymd(d);
}

/** A sensible START time for a new appointment on `date`: if that day already has appointments
 *  (dayStarts = their ISO starts), suggest the next hour AFTER the last one so a fresh entry
 *  doesn't blindly collide at 08:00; otherwise the honest 08:00 default. Caps at 17:00. */
function suggestedTime(date: string, dayStarts: string[]): string {
  const sameDay = dayStarts
    .map((iso) => new Date(iso))
    .filter((d) => !isNaN(d.getTime()) && ymd(d) === date);
  if (!sameDay.length) return "08:00";
  const last = sameDay.reduce((a, b) => (b > a ? b : a));
  const h = Math.min(last.getHours() + 1, 17);
  return `${p2(h)}:00`;
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

// The whole form as ONE serializable object so useDraft can mirror it. All
// fields keep their `name` attributes — controlled values still serialize
// into the <form>'s FormData.
interface ApptForm {
  type: string;
  assigned_to: string;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  customer_id: string;
  job_id: string;
  new_customer_name: string;
  new_customer_phone: string;
  location: string;
  notes: string;
}

// A page can mount several "new appointment" buttons; only the FIRST mounted
// instance may answer ?new=1 or two modals would stack.
let newParamClaimed = false;

/** Create or edit an appointment / inspection. */
export function AppointmentButton({
  jobs,
  customers,
  staff,
  appointment,
  defaultDate,
  defaultCustomerId,
  defaultJobId,
  fromLead = false,
  dayStarts,
  compact = false,
}: {
  jobs: Opt[];
  customers: Opt[];
  staff: Opt[];
  appointment?: ApptValue;
  defaultDate?: string;
  /** Preselect a customer in create mode (e.g. mounted on that customer's page). */
  defaultCustomerId?: string;
  /** Preselect a job in create mode (e.g. mounted on that job's page) — prefills the
   *  location from the job address and suggests an "Inspection — <job#>" title. */
  defaultJobId?: string;
  /** Mounted from a lead → default the TYPE to a quote/estimate instead of a plain appointment. */
  fromLead?: boolean;
  /** ISO starts of appointments already on the viewed day — lets the create form suggest a
   *  time AFTER the last one instead of a blind 08:00. Optional; empty → 08:00. */
  dayStarts?: string[];
  /** Tight card-header variant: small button that stays on one line. */
  compact?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const toast = useToast();
  const editing = !!appointment;
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // "Propose times" mode: offer the customer up to 3 date+time slots to pick.
  const [mode, setMode] = useState<"set" | "propose">("set");
  const [slots, setSlots] = useState(defaultSlots);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const emptyForm = (): ApptForm => {
    // CREATE-with-logic (an entry that "could go anywhere" gets a starting point, never a blank):
    // when mounted from a job or customer, prefill the location + a title from that context, and
    // suggest a real day/time rather than a blind empty date or a blind 08:00. Editing an existing
    // appointment always shows its OWN stored values untouched — none of this fires.
    const ctxJob = !appointment && defaultJobId ? jobs.find((j) => j.id === defaultJobId) : undefined;
    const ctxCust = !appointment && defaultCustomerId ? customers.find((c) => c.id === defaultCustomerId) : undefined;
    // Title: job context reads back the job (its label starts with the job number), else the
    // customer name; a lead is a quote walk-through, a job/customer is an on-site inspection.
    const suggestedTitle = ctxJob
      ? `Inspection — ${ctxJob.label}`
      : ctxCust
      ? `${fromLead ? "Estimate" : "Appointment"} — ${ctxCust.label}`
      : "";
    const date = appointment ? toLocal(appointment.starts_at).date : suggestedDate(defaultDate);
    const st = appointment ? toLocal(appointment.starts_at) : { date, time: suggestedTime(date, dayStarts ?? []) };
    const en = appointment ? toLocal(appointment.ends_at) : { date: "", time: "" };
    return {
      // Default TYPE: a lead → quote/estimate; anywhere else → a plain appointment (NOT the old
      // blind "quote" default that mislabeled every hand-added entry as an estimate).
      type: appointment?.type ?? (fromLead ? "quote" : "appointment"),
      assigned_to: appointment?.assigned_to ?? "",
      title: appointment?.title ?? suggestedTitle,
      date,
      start_time: st.time || "08:00",
      end_time: en.time,
      customer_id: appointment?.customer_id ?? defaultCustomerId ?? "",
      job_id: appointment?.job_id ?? defaultJobId ?? "",
      new_customer_name: "",
      new_customer_phone: "",
      // Location from the job address when we have a job context (customer Opt carries no address).
      location: appointment?.location ?? ctxJob?.address ?? "",
      notes: appointment?.notes ?? "",
    };
  };
  const [form, setForm] = useState<ApptForm>(emptyForm);
  const patch = (p: Partial<ApptForm>) => setForm((f) => ({ ...f, ...p }));
  const newCust = form.customer_id === "__new__";

  // Interruption recovery: a deploy reload / iOS killing the tab restores the
  // half-typed appointment (fields + propose-times slots). Keyed per record
  // when editing so two appointments never share a draft.
  const draftState = useMemo(() => ({ form, mode, slots }), [form, mode, slots]);
  const draft = useDraft(
    editing ? "appt-edit:" + appointment!.id : "appt-new",
    draftState,
    (d) => {
      setForm({ ...emptyForm(), ...(d.form ?? {}) });
      setMode(d.mode === "propose" ? "propose" : "set");
      setSlots(Array.isArray(d.slots) && d.slots.length ? d.slots : defaultSlots());
    },
  );
  // Dirty = anything differs from a fresh form (covers typed input AND a
  // restored draft). The link-ready screen has nothing left to lose.
  const initialSnap = useRef<string | null>(null);
  if (initialSnap.current === null) initialSnap.current = JSON.stringify(draftState);
  const dirty = !linkToken && JSON.stringify(draftState) !== initialSnap.current;

  // Open straight from the quick-add menu's "New appointment"
  // (/schedule?view=appointments&new=1), then strip the param so a refresh or
  // back-button doesn't reopen the form. Edit instances never answer it.
  useEffect(() => {
    if (editing) return;
    if (searchParams.get("new") !== "1") {
      newParamClaimed = false; // param gone → release for the next quick-add tap
      return;
    }
    if (newParamClaimed) return;
    newParamClaimed = true;
    setOpen(true);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("new");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, pathname, router, editing]);

  function openModal() {
    if (draft.restored && dirty) toast("Draft restored — pick up where you left off", "info");
    setOpen(true);
  }

  // Confirmed close (the Modal's two-tap guard has already asked when dirty) —
  // an explicit discard, so the stored draft goes too and the form resets.
  function closeAll() {
    draft.clear();
    setForm(emptyForm());
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
        draft.clear();
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
      // Saved — drop the draft. New mode resets so reopening doesn't offer a
      // duplicate; edit mode keeps the just-saved values as the new baseline.
      draft.clear();
      if (editing) {
        initialSnap.current = JSON.stringify(draftState);
      } else {
        setForm(emptyForm());
        setMode("set");
        setSlots(defaultSlots());
      }
      setOpen(false);
      router.refresh();
    });
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const pickLink = linkToken && origin ? `${origin}/pick/${linkToken}` : null;

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
    if (!confirm(`Delete the appointment "${appointment.title}"? This can't be undone.`)) return;
    start(async () => {
      const res = await deleteAppointment(appointment.id);
      if (!res?.ok) { toast(res?.error ?? "Couldn't delete appointment — try again.", "error"); return; }
      draft.clear();
      toast("Appointment deleted", "success");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      {editing ? (
        <button onClick={openModal} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Edit">
          <Pencil className="h-4 w-4" />
        </button>
      ) : (
        <Button onClick={openModal} size={compact ? "sm" : undefined} className="shrink-0 whitespace-nowrap">
          <Plus className="h-4 w-4" /> New Appointment
        </Button>
      )}

      <Modal
        open={open}
        onClose={closeAll}
        title={editing ? "Edit appointment" : linkToken ? "Text the customer these times" : "New appointment"}
        dirty={dirty}
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
              <Select id="ap-type" name="type" value={form.type} onChange={(e) => patch({ type: e.target.value })}>
                <option value="quote">Quote / estimate a job</option>
                <option value="meeting">Meet with customer</option>
                <option value="inspection">Inspection</option>
                <option value="appointment">Appointment</option>
                <option value="other">Other</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="ap-assigned">Assigned to</Label>
              <Select id="ap-assigned" name="assigned_to" value={form.assigned_to} onChange={(e) => patch({ assigned_to: e.target.value })}>
                <option value="">— Anyone —</option>
                {staff.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="ap-title">Title</Label>
            <Input id="ap-title" name="title" value={form.title} onChange={(e) => patch({ title: e.target.value })} placeholder="e.g. Rough-in inspection, estimate walk-through" required />
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
                <Input id="ap-date" name="date" type="date" value={form.date} onChange={(e) => patch({ date: e.target.value })} required />
              </div>
              <div>
                <Label htmlFor="ap-start">Start</Label>
                <Input id="ap-start" name="start_time" type="time" value={form.start_time} onChange={(e) => patch({ start_time: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="ap-end">End</Label>
                <Input id="ap-end" name="end_time" type="time" value={form.end_time} onChange={(e) => patch({ end_time: e.target.value })} />
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
                value={form.customer_id}
                onChange={(e) => patch({ customer_id: e.target.value })}
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
                value={form.job_id}
                onChange={(e) => {
                  // Auto-fill the location from the job's address when it's empty.
                  const job = jobs.find((j) => j.id === e.target.value);
                  patch({
                    job_id: e.target.value,
                    ...(job?.address && !form.location.trim() ? { location: job.address } : {}),
                  });
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
                <Input id="ap-newname" name="new_customer_name" value={form.new_customer_name} onChange={(e) => patch({ new_customer_name: e.target.value })} placeholder="Name" required />
              </div>
              <div>
                <Label htmlFor="ap-newphone">Phone</Label>
                <Input id="ap-newphone" name="new_customer_phone" type="tel" value={form.new_customer_phone} onChange={(e) => patch({ new_customer_phone: e.target.value })} placeholder="Optional" />
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="ap-loc">Location</Label>
            <Input id="ap-loc" name="location" value={form.location} onChange={(e) => patch({ location: e.target.value })} placeholder="Address or site" />
          </div>
          <div>
            <Label htmlFor="ap-notes">Notes</Label>
            <Textarea id="ap-notes" name="notes" rows={2} value={form.notes} onChange={(e) => patch({ notes: e.target.value })} />
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
