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
    description: "Add a past/manual timecard entry (clock_in & clock_out are ISO timestamps), for any crew member via profile_id. Office correction — staff only; techs clock in/out live.",
    input: z.object({
      profile_id: z.string().optional().default(""),
      clock_in: z.string(),
      clock_out: z.string(),
      job_id: z.string().nullable().optional(),
      job_code: z.string().nullable().optional(),
      lunch_minutes: z.number().optional().default(0),
      notes: z.string().optional().default(""),
      miles: z.number().optional(),
    }),
    auth: "staff", // manual/back-dated entries are office corrections, not tech self-service
    effect: "write",
    handler: (i) =>
      createManualEntry({
        profile_id: i.profile_id ?? "",
        clock_in: i.clock_in,
        clock_out: i.clock_out,
        job_id: i.job_id ?? null,
        job_code: i.job_code ?? null,
        lunch_minutes: i.lunch_minutes ?? 0,
        notes: i.notes ?? "",
        miles: i.miles,
      }),
  },
};
