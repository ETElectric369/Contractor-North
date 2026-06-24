import { z } from "zod";
import { createAppointment, setAppointmentStatus } from "@/app/(app)/appointments/actions";
import type { ActionDef } from "../types";

export const appointmentActions: Record<string, ActionDef> = {
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
