import { z } from "zod";
import { clockIn, clockOutCurrent, createManualEntry, updateTimeEntry } from "@/app/(app)/timeclock/actions";
import { createClient } from "@/lib/supabase/server";
import { visibleJobIdOrNull } from "@/lib/job-visibility";
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
  "time.fixEntry": {
    name: "time.fixEntry",
    group: "time",
    label: "Fix timecard entry",
    description:
      "Fix a crew member's EXISTING timecard entry the user described ('Brian left at 4:30', 'close Brian's open entry', 'his lunch was 45 minutes'). Sets the clock-out (closing an open entry), corrects the clock-in, the lunch minutes, or the entry's job — anything not passed stays exactly as stored. Times and lunch must come FROM THE USER, never inferred (this is payroll); if they didn't say the time, ASK. Resolve entry_id via hours_summary / listed-entries context first — if no entry id is in context or more than one entry could match, say so and ask instead of guessing.",
    // The other person's-timecard edit (time.addEntry is the CREATE): closing Brian's
    // still-open shift is the headline case. Fragment-first with the payroll boundary —
    // at least one CHANGE must be stated; the "Required" message rides the same
    // missing-fields channel as time.addEntry so voice asks for exactly what's absent.
    input: z
      .object({
        entry_id: z.string().uuid(),
        clock_in: z.string().optional(),
        clock_out: z.string().optional(),
        job_id: z.string().uuid().nullable().optional(),
        lunch_minutes: z.number().min(0).optional(),
      })
      .superRefine((v, ctx) => {
        if (v.clock_in != null || v.clock_out != null || v.lunch_minutes != null || v.job_id !== undefined) return;
        // No change stated. The commonest fix is closing an open entry — ask for the
        // clock-out (zod's "Required" message so executeAction names the missing field).
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["clock_out"], message: "Required" });
      }),
    auth: "staff", // editing someone else's times is an office correction, same as addEntry
    effect: "write",
    confirm: "financial", // edits a wage record → tier-2: propose, user confirms, then write
    describe: (i) => {
      // Read the clock time straight off the ISO as the model passed it (the user's stated
      // local time) — no server-tz conversion that could read back a shifted hour.
      const hm = (iso: string) => iso.match(/T(\d{2}:\d{2})/)?.[1] ?? iso;
      const parts: string[] = [];
      if (i.clock_in) parts.push(`start ${hm(i.clock_in)}`);
      if (i.clock_out) parts.push(`clock-out ${hm(i.clock_out)}`);
      if (i.lunch_minutes != null) parts.push(`lunch ${i.lunch_minutes} min`);
      if (i.job_id !== undefined) parts.push(i.job_id ? "move it to a different job" : "clear its job");
      return `Fix this timecard entry — set ${parts.join(", ")} — say yes to confirm. Check the details below.`;
    },
    handler: async (i) => {
      // Resolve the entry through the caller's RLS-scoped client (staff-gated above), merge
      // the user's stated changes over what's stored, then write through the ONE canonical
      // office write path — updateTimeEntry, the same the timecards edit modal uses — so the
      // allocation/lunch/rate semantics are never forked. rate_override / allocations /
      // profile_id are NOT sent: updateTimeEntry treats omission as "leave untouched"
      // (the cn-v291 rate-wipe fix depends on exactly that contract).
      const supabase = await createClient();
      const { data: entry } = await supabase
        .from("time_entries")
        .select("id, clock_in, clock_out, lunch_minutes, job_code, notes, miles, profiles(full_name)")
        .eq("id", i.entry_id)
        .maybeSingle();
      if (!entry) return { ok: false, error: "I can't find that time entry." };
      const e = entry as unknown as {
        clock_in: string;
        clock_out: string | null;
        lunch_minutes: number | null;
        job_code: string | null;
        notes: string | null;
        miles: number | null;
        profiles?: { full_name: string | null } | { full_name: string | null }[] | null;
      };

      const clockOut = i.clock_out ?? e.clock_out;
      if (!clockOut) {
        // Open entry and the user didn't say when they left — NEVER invent a clock-out
        // (the payroll boundary). missingFields lets the surface ask for exactly this.
        return { ok: false, missingFields: ["clock_out"], error: "That entry is still open — what time did they clock out?" };
      }

      // A job change must land on a job the caller can actually see — refuse (don't
      // silently drop to no-job) so the hours never end up attributed nowhere.
      if (i.job_id) {
        const visible = await visibleJobIdOrNull(supabase, i.job_id);
        if (!visible) return { ok: false, error: "That job isn't available." };
      }

      const res = await updateTimeEntry({
        id: i.entry_id,
        clock_in: i.clock_in ?? e.clock_in,
        clock_out: clockOut,
        lunch_minutes: i.lunch_minutes ?? e.lunch_minutes ?? 0, // preserve a stored 45/60 lunch — never collapse it
        ...(i.job_id !== undefined ? { job_id: i.job_id } : {}), // omitted = leave the job alone; null clears it
        job_code: e.job_code ?? null,
        notes: e.notes ?? "",
        miles: e.miles ?? 0,
      });
      if (!res.ok) return res;
      const prof = Array.isArray(e.profiles) ? e.profiles[0] : e.profiles;
      return { ok: true, speak: `Fixed — ${prof?.full_name ?? "the crew member"}'s timecard entry is updated.` };
    },
  },
};
