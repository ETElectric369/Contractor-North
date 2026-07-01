import { z } from "zod";
import { createAppointment, setAppointmentStatus, rescheduleAppointment } from "@/app/(app)/appointments/actions";
import type { ActionDef } from "../types";

export const appointmentActions: Record<string, ActionDef> = {
  "appointment.update": {
    name: "appointment.update",
    group: "appointment",
    label: "Reschedule appointment",
    description:
      "Reschedule an appointment / inspection to a new time — e.g. 'move the Smith inspection to Thursday at 9am'. Find it first with schedule_overview (it returns the id), then pass that id plus the new starts_at as an ISO datetime (optionally ends_at). Keeps everything else; no cancel+recreate.",
    input: z.object({ id: z.string(), starts_at: z.string().min(1), ends_at: z.string().nullable().optional() }),
    auth: "staff",
    effect: "write",
    handler: (i) => rescheduleAppointment(i.id, i.starts_at, i.ends_at ?? null),
  },
  "appointment.create": {
    name: "appointment.create",
    group: "appointment",
    label: "Add appointment",
    description:
      "Create an appointment or inspection with a title and ISO start time. Optionally capture whatever else was given: job_id (resolve with list_jobs), customer_id (resolve with list_customers), location, ends_at (ISO), notes.",
    // Fragment-first: the columns are nullable and createAppointment already reads every
    // one of these — the old 3-field schema silently DROPPED a spoken job/location/end time.
    // Only starts_at stays required (an appointment without a time isn't schedulable).
    input: z.object({
      title: z.string().trim().min(1),
      type: z.enum(["appointment", "inspection"]).default("appointment"),
      starts_at: z.string().min(1),
      ends_at: z.string().nullable().optional(),
      job_id: z.string().nullable().optional(),
      customer_id: z.string().nullable().optional(),
      location: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    }),
    auth: "staff",
    effect: "write",
    // Wrap the canonical createAppointment (trim+validate, org-tz ISO, revalidate, the
    // nullable fields) via a FormData — no duplicated write-path.
    handler: (i) => {
      const fd = new FormData();
      fd.set("title", i.title);
      fd.set("type", i.type);
      fd.set("starts_at_iso", i.starts_at);
      if (i.ends_at) fd.set("ends_at_iso", i.ends_at);
      if (i.job_id) fd.set("job_id", i.job_id);
      if (i.customer_id) fd.set("customer_id", i.customer_id);
      if (i.location) fd.set("location", i.location);
      if (i.notes) fd.set("notes", i.notes);
      return createAppointment(fd);
    },
  },
  "appointment.setStatus": {
    name: "appointment.setStatus",
    group: "appointment",
    label: "Set appointment status",
    description: "Set an appointment's status (e.g. completed, cancelled, scheduled).",
    input: z.object({ id: z.string(), status: z.string() }),
    auth: "staff", // appointments are staff-only in RLS — the registry gate now matches (Phase C)
    effect: "write",
    handler: (i) => setAppointmentStatus(i.id, i.status),
  },
};
