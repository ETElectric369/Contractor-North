import { z } from "zod";
import { setAppointmentStatus } from "@/app/(app)/appointments/actions";
import type { ActionDef } from "../types";

export const appointmentActions: Record<string, ActionDef> = {
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
