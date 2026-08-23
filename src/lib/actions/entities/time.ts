import { z } from "zod";
import { clockIn, clockOutCurrent, createManualEntry, updateTimeEntry } from "@/app/(app)/timeclock/actions";
import { hoursBetween } from "@/lib/utils";
import { autoLunchMinutes } from "@/lib/lunch-rule";
import { createClient } from "@/lib/supabase/server";
import { visibleJobIdOrNull } from "@/lib/job-visibility";
import { resolveJobId, resolveProfileId } from "../resolve-id";
import { tzNaiveIsoToUtc } from "@/lib/tz";
import { getOrgSettings } from "@/lib/org-settings";

/**
 * ONE CONVERTER FOR EVERY TIME VERB (audit 7). cn-v728 converted addEntry and left fixEntry and
 * clockIn's backdate writing model wall-clock times as UTC — the exact half-fix a copy-paste
 * sibling pair produces. The org-tz lookup + tzNaiveIsoToUtc now live here; every handler that
 * accepts a model-supplied timestamp goes through it, and a fourth verb can't skip it by accident.
 */
async function orgLocalConverter(supabase: Awaited<ReturnType<typeof createClient>>): Promise<(v?: string) => string | undefined> {
  const { data: orgRow } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).timezone || "America/Los_Angeles";
  return (v?: string) => tzNaiveIsoToUtc(v, tz);
}
import type { ActionDef } from "../types";

// Time-logging, finally in the registry — so voice ("clock me in / out / add 2 hours
// to the Smith job") and every surface go through the SAME path the timeclock UI uses.
// Each handler just WRAPS the existing server action — no new business logic.
export const timeActions: Record<string, ActionDef> = {
  "time.clockIn": {
    name: "time.clockIn",
    group: "time",
    label: "Clock in",
    description: "Start the clock for the current user, optionally on a job — ONLY for work happening NOW (or a still-running shift that started earlier TODAY, via clock_in_at backdate). NEVER use clockIn+clockOut to record FINISHED past work ('3 hours yesterday') — that is time.addEntry (work_date + hours); a clockIn/clockOut pair fired together records a seconds-long entry on today, not the stated hours. clock_in_at is a NAIVE local timestamp, YYYY-MM-DDTHH:MM in the company's own timezone, NO Z, NO offset; the app converts.",
    input: z.object({
      job_id: z.string().nullable().optional(),
      job_code: z.string().nullable().optional(),
      clock_in_at: z.string().nullable().optional(),
    }),
    auth: "any", // a tech clocks themselves in
    effect: "write",
    handler: async (i) => {
      // The backdate is a model-supplied wall-clock time — third sibling, same conversion.
      const toUtc = i.clock_in_at ? await orgLocalConverter(await createClient()) : null;
      return clockIn({ job_id: i.job_id ?? null, job_code: i.job_code ?? null, gps: null, clock_in_at: (toUtc ? toUtc(i.clock_in_at ?? undefined) : null) ?? null });
    },
  },
  "time.clockOut": {
    name: "time.clockOut",
    group: "time",
    label: "Clock out",
    description:
      "Close the current user's open time entry — the end of a LIVE shift, never a way to log finished past work (that is time.addEntry). A FIELD TECH must say which job code(s) they worked and the hours — pass them as `allocations` (each {job_code, hours, optional job_id, optional description}); if they don't give them, ASK before clocking out (use list_job_codes to map a spoken name like 'rough-in' to its code). miles = round-trip job mileage; lunch_minutes = unpaid lunch taken. ALWAYS announce what the RESULT says was recorded (span and date) — not what you intended.",
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
    handler: async (i) => {
      const res = await clockOutCurrent({ miles: i.miles, notes: i.notes, lunch_minutes: i.lunch_minutes, allocations: i.allocations });
      if (!res || (res as { ok?: boolean }).ok === false) return res;
      // ANNOUNCE THE DEED, NOT THE INTENT (Erik's phantom "3 hours yesterday": the model
      // clocked in and straight out — a 3.4-second entry on the wrong day with no job — then
      // announced the hours it meant to log). Read back what was actually recorded; a
      // seconds-long entry gets an explicit warning the model must surface.
      try {
        const supabase = await createClient();
        // SCOPED TO THE CALLER (audit v800). Unscoped, a staff caller's RLS view spans the whole
        // org, so the "most recently closed entry" could be someone ELSE's shift — and Nort would
        // announce another person's hours as what it had just recorded for you.
        const { data: me } = await supabase.auth.getUser();
        const meId = me?.user?.id;
        if (!meId) return res;
        const { data: last } = await supabase
          .from("time_entries")
          .select("clock_in, clock_out, job_id")
          .eq("profile_id", meId)
          .not("clock_out", "is", null)
          .order("clock_out", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (last?.clock_in && last?.clock_out) {
          const hrs = hoursBetween(new Date(last.clock_in), new Date(last.clock_out));
          const recorded = `Recorded: ${last.clock_in} → ${last.clock_out} (${hrs.toFixed(2)}h${last.job_id ? "" : ", NO job attached"}).`;
          if (hrs < 0.05) {
            return {
              ...res,
              warning:
                `${recorded} That is a seconds-long LIVE entry — if the user asked to log past work hours, this was the wrong tool: use time.addEntry (work_date + hours) and fix this stub with time.updateEntry. Do NOT tell the user their hours were logged.`,
            };
          }
          return { ...res, recorded };
        }
      } catch {
        /* read-back is best-effort */
      }
      return res;
    },
  },
  "time.addEntry": {
    name: "time.addEntry",
    group: "time",
    label: "Add time entry",
    description:
      "Add a past/manual timecard entry, for any crew member via profile_id. Office correction — staff only; techs clock in/out live. TWO shapes: exact times (clock_in & clock_out as NAIVE local timestamps, YYYY-MM-DDTHH:MM in the company's own timezone — NO Z, NO offset; the app converts) OR a duration ('Brian worked 6 hours Tuesday' → work_date YYYY-MM-DD + hours). hours must be the USER'S stated number — never estimate or infer it (that's payroll); if they didn't say the hours, ASK.",
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
        // No .default(0): unstated lunch must reach the server as "wasn't stated" so the
        // auto rule (>5h ⇒ 30 min) decides; an explicit 0 ("no lunch") is still honored.
        lunch_minutes: z.number().optional(),
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
    handler: async (i) => {
      // Forgive a crew-member NAME ("Brian") passed as profile_id, and a job name as job_id.
      // Resolving WHO the hours belong to is a lookup, never a money inference — the hours
      // themselves still come only from the user's stated number. A single match resolves;
      // zero/several ASK (attributing hours to the wrong person is a real payroll error).
      const supabase = await createClient();
      const person = await resolveProfileId(supabase, i.profile_id ?? null);
      if ("error" in person) return { ok: false, error: person.error };
      const job = await resolveJobId(supabase, i.job_id ?? null);
      if ("error" in job) return { ok: false, error: job.error };
      /**
       * "10 AM" MEANS 10 AM WHERE THE CREW WORKS — converted in CODE, never by the model.
       *
       * Erik: "Nort submitted brians time card in UTC time." He said "10:00 AM"; the model,
       * asked for "ISO timestamps", helpfully stamped a Z on it — so Brian's card read a 10:00
       * UTC clock-in, which is 3 AM Pacific, and payroll math ran off it. The model must never
       * do timezone arithmetic (ONE LAW, TWO CLOCKS, ONE MAP): a NAIVE timestamp (no Z, no
       * offset) is taken as org-local and converted here; a timestamp that carries an explicit
       * offset is honored as-is, because stripping a correct one would double-shift it.
       */
      const localToUtc = await orgLocalConverter(supabase);
      return createManualEntry({
        profile_id: person.id ?? "",
        clock_in: localToUtc(i.clock_in),
        clock_out: localToUtc(i.clock_out),
        work_date: i.work_date,
        hours: i.hours,
        job_id: job.id,
        job_code: i.job_code ?? null,
        // Pass "unstated" through as null — createManualEntry's auto rule decides.
        lunch_minutes: i.lunch_minutes ?? null,
        notes: i.notes ?? "",
        miles: i.miles,
      });
    },
  },
  "time.fixEntry": {
    name: "time.fixEntry",
    group: "time",
    label: "Fix timecard entry",
    description:
      "Fix a crew member's EXISTING timecard entry the user described ('Brian left at 4:30', 'close Brian's open entry', 'his lunch was 45 minutes'). Sets the clock-out (closing an open entry), corrects the clock-in, the lunch minutes, or the entry's job — anything not passed stays exactly as stored. clock_in/clock_out are NAIVE local timestamps, YYYY-MM-DDTHH:MM in the company's own timezone — NO Z, NO offset; the app converts. Times and lunch must come FROM THE USER, never inferred (this is payroll); if they didn't say the time, ASK. Resolve entry_id via hours_summary / listed-entries context first — if no entry id is in context or more than one entry could match, say so and ask instead of guessing.",
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

      // "4:30" MEANS 4:30 WHERE THE CREW WORKS (audit 7 — the cn-v728 fix, applied to the
      // sibling verb it missed). Model-supplied times convert ONCE, up front; stored values
      // already carry offsets and pass through tzNaiveIsoToUtc untouched, so the merges below
      // can never double-shift.
      const toUtc = await orgLocalConverter(supabase);
      const ciIn = toUtc(i.clock_in);
      const coIn = toUtc(i.clock_out);
      const clockOut = coIn ?? e.clock_out;
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

      // Lunch: an explicitly stated number (incl. 0 = "no lunch") is an office correction,
      // honored. Otherwise preserve a stored 45/60 — never collapse it. And when this call
      // CLOSES a previously-open entry (the "Brian forgot to clock out" case) with no stored
      // lunch, apply the SAME auto rule every clock-out door applies (>5h ⇒ 30) — otherwise
      // office-closed forgotten shifts would systematically pay the meal half-hour.
      const closingOpenEntry = !e.clock_out && !!clockOut;
      const lunchMinutes =
        i.lunch_minutes ??
        (closingOpenEntry && !(e.lunch_minutes && e.lunch_minutes > 0)
          ? autoLunchMinutes(hoursBetween(ciIn ?? e.clock_in, clockOut, 0))
          : (e.lunch_minutes ?? 0));

      const res = await updateTimeEntry({
        id: i.entry_id,
        clock_in: ciIn ?? e.clock_in,
        clock_out: clockOut,
        lunch_minutes: lunchMinutes,
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
