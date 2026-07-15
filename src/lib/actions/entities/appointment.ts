import { z } from "zod";
import { APPOINTMENT_TYPES } from "@/lib/statuses";
import { createAppointment, setAppointmentStatus, rescheduleAppointment } from "@/app/(app)/appointments/actions";
import { createClient } from "@/lib/supabase/server";
import { resolveCustomerId, resolveJobId } from "../resolve-id";
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
    // Moving a real appointment by VOICE is Erik's "swap days while driving" hazard: a stray
    // spoken word must not silently reschedule. Gate the AGENT route so Nort PROPOSES the new
    // day/time and waits for the spoken yes (the UI drag/edit path is exempt — a human tap IS
    // the consent). "destructive", not "financial" — no money, but it clobbers a scheduled time.
    confirm: "destructive",
    // Read the day/time straight off the ISO the model passed (the user's stated local time) —
    // no server-tz conversion that could read back a shifted hour. Title isn't in the input
    // (only the id is), so name the change by its new slot — the card below shows which one.
    describe: (i) => `Move this appointment to ${readbackWhen(i.starts_at)}? Check the details below before you confirm.`,
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
      type: z.enum(APPOINTMENT_TYPES as unknown as [string, ...string[]]).default("appointment"), // spine-derived (statuses.ts) — was a hand-rolled 2-value list that dropped meeting/final_inspection
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
    handler: async (i) => {
      // Forgive a job/customer NAME where an id belongs — resolve each to a single match first.
      const supabase = await createClient();
      const job = await resolveJobId(supabase, i.job_id ?? null);
      if ("error" in job) return { ok: false, error: job.error };
      const cust = await resolveCustomerId(supabase, i.customer_id ?? null);
      if ("error" in cust) return { ok: false, error: cust.error };
      const fd = new FormData();
      fd.set("title", i.title);
      fd.set("type", i.type);
      fd.set("starts_at_iso", i.starts_at);
      if (i.ends_at) fd.set("ends_at_iso", i.ends_at);
      if (job.id) fd.set("job_id", job.id);
      if (cust.id) fd.set("customer_id", cust.id);
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
    // Cancelling/completing a real appointment by voice is the same "one stray word" hazard as a
    // move — gate the AGENT route so Nort reads the change back and waits for the yes. Cancelling
    // also withdraws the live pick-a-time link, so this is not a cheap undo. UI is exempt.
    confirm: "destructive",
    describe: (i) => `${statusVerb(i.status)} this appointment? Check the details below before you confirm.`,
    handler: (i) => setAppointmentStatus(i.id, i.status),
  },
};

/** Read an ISO datetime back as a spoken day + time WITHOUT a tz conversion — pull the fields
 *  straight off the string the model passed (the user's stated local wall-clock), the same way
 *  time.fixEntry's describe avoids a shifted hour. Falls back to the raw string if it's not ISO. */
function readbackWhen(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, hh, mm] = m;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // Date-only math for the weekday name (noon UTC dodges any DST edge); the CLOCK comes from the
  // raw hh:mm above, never from this Date, so no tz shift reaches the read-back time.
  const dow = days[new Date(Date.UTC(+y, +mo - 1, +d, 12)).getUTCDay()];
  let h = +hh;
  const ampm = h < 12 ? "am" : "pm";
  h = h % 12 || 12;
  const time = +mm === 0 ? `${h}${ampm}` : `${h}:${mm}${ampm}`;
  return `${dow} ${+mo}/${+d} at ${time}`;
}

/** The verb for a setStatus read-back — "Cancel" / "Mark complete" / a generic "Set … to <status>". */
function statusVerb(status: string): string {
  const s = status.toLowerCase();
  if (s === "cancelled" || s === "canceled") return "Cancel";
  if (s === "completed") return "Mark complete";
  if (s === "scheduled") return "Re-open (mark scheduled)";
  return `Set the status to "${status}" on`;
}
