import { z } from "zod";
import { clockIn, clockOutCurrent, createManualEntry } from "@/app/(app)/timeclock/actions";
import type { ActionDef } from "../types";

// Time-logging, finally in the registry — so voice ("clock me in / out / add 2 hours
// to the Smith job") and every surface go through the SAME path the timeclock UI uses.
// Each handler just WRAPS the existing server action — no new business logic.
export const timeActions: Record<string, ActionDef> = {
  "time.clockIn": {
    name: "time.clockIn",
    group: "time",
    label: "Clock in",
    description: "Start the clock for the current user, optionally on a job. clock_in_at backdates the start (e.g. forgot to clock in).",
    input: z.object({
      job_id: z.string().nullable().optional(),
      job_code: z.string().nullable().optional(),
      clock_in_at: z.string().nullable().optional(),
    }),
    auth: "any", // a tech clocks themselves in
    effect: "write",
    handler: (i) =>
      clockIn({ job_id: i.job_id ?? null, job_code: i.job_code ?? null, gps: null, clock_in_at: i.clock_in_at ?? null }),
  },
  "time.clockOut": {
    name: "time.clockOut",
    group: "time",
    label: "Clock out",
    description:
      "Close the current user's open time entry. A FIELD TECH must say which job code(s) they worked and the hours — pass them as `allocations` (each {job_code, hours, optional job_id, optional description}); if they don't give them, ASK before clocking out (use list_job_codes to map a spoken name like 'rough-in' to its code). miles = round-trip job mileage; lunch_minutes = unpaid lunch taken.",
    input: z.object({
      miles: z.number().optional(),
      notes: z.string().optional(),
      lunch_minutes: z.number().optional(),
      allocations: z
        .array(
          z.object({
            job_id: z.string().nullable().default(null),
            job_code: z.string().nullable().default(null),
            hours: z.number(),
            description: z.string().default(""),
          }),
        )
        .optional(),
    }),
    auth: "any",
    effect: "write",
    handler: (i) =>
      clockOutCurrent({ miles: i.miles, notes: i.notes, lunch_minutes: i.lunch_minutes, allocations: i.allocations }),
  },
  "time.addEntry": {
    name: "time.addEntry",
    group: "time",
    label: "Add time entry",
    description:
      "Add a past/manual timecard entry, for any crew member via profile_id. Office correction — staff only; techs clock in/out live. TWO shapes: exact times (clock_in & clock_out as ISO timestamps) OR a duration ('Brian worked 6 hours Tuesday' → work_date YYYY-MM-DD + hours). hours must be the USER'S stated number — never estimate or infer it (that's payroll); if they didn't say the hours, ASK.",
    // Fragment-first with the payroll boundary: either a full span, or an EXPLICIT
    // day + hour count (expanded server-side to a midday-centered span and flagged in
    // notes as duration-entered). The superRefine issues use zod's "Required" message
    // so executeAction reports exactly which fields are still missing.
    input: z
      .object({
        profile_id: z.string().optional().default(""),
        clock_in: z.string().optional(),
        clock_out: z.string().optional(),
        work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
        hours: z.number().positive().max(24).optional(),
        job_id: z.string().nullable().optional(),
        job_code: z.string().nullable().optional(),
        lunch_minutes: z.number().optional().default(0),
        notes: z.string().optional().default(""),
        miles: z.number().optional(),
      })
      .superRefine((v, ctx) => {
        if ((v.clock_in && v.clock_out) || (v.work_date && v.hours != null)) return;
        const need = (path: string) =>
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "Required" });
        if (v.clock_in || v.clock_out) {
          // Halfway into the exact-times shape — name the other half.
          if (!v.clock_in) need("clock_in");
          if (!v.clock_out) need("clock_out");
        } else if (v.work_date || v.hours != null) {
          // Halfway into the duration shape — hours are NEVER inferred, only asked for.
          if (!v.work_date) need("work_date");
          if (v.hours == null) need("hours");
        } else {
          need("clock_in");
          need("clock_out");
        }
      }),
    auth: "staff", // manual/back-dated entries are office corrections, not tech self-service
    effect: "write",
    handler: (i) =>
      createManualEntry({
        profile_id: i.profile_id ?? "",
        clock_in: i.clock_in,
        clock_out: i.clock_out,
        work_date: i.work_date,
        hours: i.hours,
        job_id: i.job_id ?? null,
        job_code: i.job_code ?? null,
        lunch_minutes: i.lunch_minutes ?? 0,
        notes: i.notes ?? "",
        miles: i.miles,
      }),
  },
};
