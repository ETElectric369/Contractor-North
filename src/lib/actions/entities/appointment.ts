import { z } from "zod";
import { setAppointmentStatus } from "@/app/(app)/appointments/actions";
import { createClient } from "@/lib/supabase/server";
import type { ActionDef } from "../types";

export const appointmentActions: Record<string, ActionDef> = {
  "appointment.create": {
    name: "appointment.create",
    group: "appointment",
    label: "Add appointment",
    description: "Create an appointment or inspection with a title and ISO start time.",
    input: z.object({
      title: z.string().min(1),
      type: z.enum(["appointment", "inspection"]).default("appointment"),
      starts_at: z.string().min(1),
    }),
    auth: "staff",
    effect: "write",
    handler: async (i, ctx) => {
      const supabase = await createClient();
      const { error } = await supabase
        .from("appointments")
        .insert({ type: i.type, title: i.title.trim(), starts_at: i.starts_at, status: "scheduled", created_by: ctx.userId });
      return error ? { ok: false, error: error.message } : { ok: true, speak: `Scheduled ${i.title}.` };
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
