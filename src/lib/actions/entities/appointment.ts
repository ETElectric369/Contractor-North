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
    description: "Create an appointment or inspection with a title and ISO start time.",
    input: z.object({
      title: z.string().trim().min(1),
      type: z.enum(["appointment", "inspection"]).default("appointment"),
      starts_at: z.string().min(1),
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
