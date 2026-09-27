/**
 * THE OVERLAP TEST, ONE COPY. Lifted out of timeclock/actions.ts (a "use server" file, where every
 * export is a callable action) so a door outside the Timeclock that opens a shift in the past, the
 * visit page's Start The Job And Clock In, asks the very same question in the very same words.
 */
import { dbError } from "@/lib/db-error";
import { getOrgSettings } from "@/lib/org-settings";
import { clockDoorWords, clockedOutWords } from "@/lib/long-shift";
import { jobLabel } from "@/lib/schedule-options";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * ONE PERSON, TWO SHIFTS OVER THE SAME HOURS, IS ONE SHIFT PAID TWICE.
 *
 * aggregatePayrollEntries (payroll-math.ts) buckets time_entries by profile_id and sums every row
 * it is handed. No identity check, no overlap check, and nothing above it has one either — so two
 * rows describing one afternoon are earned twice, owed twice and paid twice, and the man writing
 * the cheque has nothing on screen telling him so. Brian has an identical 1.5h pair on Aug 18
 * sitting unpaid in the ledger right now; that pair alone is $60 of his Owed figure.
 *
 * cn-v959 built this exact test — but INSIDE the copy button, because that is the door somebody
 * happened to file a bug about. Add Entry and the edit modal write the same table with the same
 * consequence and had no check of any kind. So the test lives here now and all three doors call
 * it: one rule, one wording, and the next door that writes a shift has it already waiting.
 *
 * 0278 puts the same rule under the database, which is where it stops being a convention and
 * becomes a boundary. This layer is not the boundary — it exists so the office reads a sentence
 * naming the shift the way the timecard shows it, instead of a Postgres exception.
 *
 * Returns the sentence to refuse with, or null when the hours are clear.
 */
export async function overlapRefusal(
  supabase: SupabaseClient,
  profileId: string,
  startMs: number,
  endMs: number,
  opts?: OverlapOpts,
): Promise<string | null> {
  return (await findOverlap(supabase, profileId, startMs, endMs, opts))?.sentence ?? null;
}

type OverlapOpts = {
  /** The row being edited or copied — it is allowed to overlap itself. */
  excludeId?: string;
  /** Already in the caller's hand (the copy reads both to name its target); else read here. */
  name?: string;
  tz?: string;
  /** A copy onto the SAME person: the exact match it finds IS the original, so say that. */
  samePerson?: boolean;
  /** Leave running clocks out: a clock-in's check, where a stale open shift is closed at zero by the
   *  punch itself (0193) and a live one is the database's "You're already clocked in." */
  ignoreOpen?: boolean;
  /**
   * ADD ENTRY ONLY: asked about a closed no-job clash, true when "Put that shift on the job" is a
   * move the office can actually make (the form's Put This On door): no invoice bills that shift.
   * Every other door (an edit, a copy, a start) and a billed shift keep "Edit that entry instead":
   * the put-on-job words there pointed at a door that does not exist.
   */
  putOnJobIf?: (clashId: string) => Promise<boolean>;
};

/**
 * THE SHIFT IN THE WAY, not just a sentence about it (the duplicate punches, 2026-09-26).
 *
 * "Edit that entry instead" was a dead end: it named no entry and linked nowhere, and the one in
 * the way was usually a clock punch with NO JOB that the job page never shows. So the refusal
 * carries the shift itself, and the form that got refused can offer the real move: put that punch
 * on the job (keeping its clock times) instead of typing the day a second time.
 */
export type OverlapClash = {
  id: string;
  clockIn: string;
  /** Null: the clock is still running. */
  clockOut: string | null;
  jobId: string | null;
  jobCode: string | null;
  /** The job's name (jobLabel, the SSOT), when it is on one. */
  jobLabel: string | null;
  /** Closed, on no job and no code: the door is "put it on the job". */
  noJob: boolean;
  /** The very same times: a double submit. */
  exact: boolean;
};

type NearRow = {
  id: string;
  clock_in: string;
  clock_out: string | null;
  job_id?: string | null;
  job_code?: string | null;
  job?: { job_number?: string | null; name?: string | null } | { job_number?: string | null; name?: string | null }[] | null;
};

/** The overlap test with the clashing shift attached. `clash` is null only when the check itself
 *  could not be made (the sentence then says so: a failed read is not a clear day). */
export async function findOverlap(
  supabase: SupabaseClient,
  profileId: string,
  startMs: number,
  endMs: number,
  opts?: OverlapOpts,
): Promise<{ sentence: string; clash: OverlapClash | null } | null> {
  if (!profileId || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  // 0217 caps a shift at 18 hours, so a day back catches every entry that could still be running
  // into this one.
  const { data: near, error: nearErr } = await supabase
    .from("time_entries")
    .select("id, clock_in, clock_out, job_id, job_code, job:job_id(job_number, name)")
    .eq("profile_id", profileId)
    .gte("clock_in", new Date(startMs - 24 * 3_600_000).toISOString())
    .lte("clock_in", new Date(endMs).toISOString())
    .limit(100);
  // A FAILED READ IS NOT A CLEAR DAY. Waving the write through on the one occasion the check could
  // not be made is how the pair in the ledger got there; 0278 would still refuse it, but the
  // office would be reading the database's words instead of ours.
  if (nearErr) return { sentence: dbError(nearErr), clash: null };

  const rows = ((Array.isArray(near) ? near : []) as NearRow[]).filter(
    (r) => r.id !== opts?.excludeId && Number.isFinite(new Date(r.clock_in).getTime()) && !(opts?.ignoreOpen && !r.clock_out),
  );
  // An OPEN entry has no end, so it counts as running until now — a man still clocked in cannot
  // also have worked these hours somewhere else.
  const endOf = (r: { clock_out: string | null }) => (r.clock_out ? new Date(r.clock_out).getTime() : Date.now());
  const exact = rows.find((r) => new Date(r.clock_in).getTime() === startMs && r.clock_out != null && endOf(r) === endMs);
  const clash =
    exact ??
    rows.find((r) => {
      const s = new Date(r.clock_in).getTime();
      const e = endOf(r);
      // A MINUTE OF SLACK — the same tolerance 0248 uses and 0278 enforces underneath. Clocking
      // out and straight back in on the next job is the most ordinary move of the day, and the
      // second or two of overlap a double tap leaves behind is not a double shift.
      return s < endMs && e > startMs && Math.min(e, endMs) - Math.max(s, startMs) > 60_000;
    });
  if (!clash) return null;

  // Only now, with something to actually say, pay for the two reads the sentence needs.
  let fullName: string | null = opts?.name ?? null;
  if (!fullName) {
    const { data: p } = await supabase.from("profiles").select("full_name").eq("id", profileId).maybeSingle();
    fullName = (p as { full_name?: string | null } | null)?.full_name ?? null;
  }
  const name = fullName || "That person";
  let tz = opts?.tz;
  if (!tz) {
    const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
    tz = getOrgSettings((org as { settings?: unknown } | null)?.settings).timezone;
  }

  const job = Array.isArray(clash.job) ? (clash.job[0] ?? null) : (clash.job ?? null);
  const code = (clash.job_code ?? "").trim() || null;
  const found: OverlapClash = {
    id: clash.id,
    clockIn: clash.clock_in,
    clockOut: clash.clock_out ?? null,
    jobId: clash.job_id ?? null,
    jobCode: code,
    jobLabel: clash.job_id && job ? jobLabel(job) : null,
    noJob: !!clash.clock_out && !clash.job_id && !code,
    exact: !!exact,
  };

  if (exact) {
    const when = shiftWhen(new Date(startMs).toISOString(), new Date(endMs).toISOString(), tz);
    return {
      clash: found,
      sentence: opts?.samePerson
        ? `${name} already has ${when}. Pick the person who worked it with them, or edit that entry.`
        : `${name} already has ${when} on another entry. Open that one to change it.`,
    };
  }
  // An open shift has no finish to name, so it gets its start instead of a made-up one.
  const startedAt = shiftWhen(clash.clock_in, clash.clock_in, tz).split(" to ")[0];
  if (!clash.clock_out) {
    return {
      clash: found,
      sentence: `${name} has been clocked in since ${startedAt}, so these hours would be counted twice. ${clockedOutWords(fullName, false).clockOutFirst}: tap their shift on Timecards and use ${clockDoorWords(fullName).clockOut}.`,
    };
  }
  const when = shiftWhen(clash.clock_in, clash.clock_out, tz);
  // A punch with NO JOB is the 85 Whitney case: the hours are real and already recorded, they are
  // just not on the job. On Add Entry, where the door is, the move is to put that punch on the job,
  // not to type them again; only there, and only while no invoice bills it (putOnJobIf).
  let putOnJob = false;
  if (found.noJob && opts?.putOnJobIf) {
    try {
      putOnJob = await opts.putOnJobIf(found.id);
    } catch {
      putOnJob = false;
    }
  }
  const where = found.jobLabel ? ` on ${found.jobLabel}` : code ? ` (${code})` : found.noJob ? " with no job" : "";
  return {
    clash: found,
    sentence: putOnJob
      ? `${name} is already on the clock ${when} with no job, so these hours would be counted twice. Put that shift on the job instead of adding them again.`
      : `${name} is already on the clock ${when}${where}, so these hours would be counted twice. Edit that entry instead.`,
  };
}

/**
 * THE CLOCK-IN'S OWN SENTENCE for a start time over hours already recorded (a back-dated staff
 * clock-in, an offline punch delivered late). 0360 refuses it underneath; this says it the way the
 * person tapping the clock can act on: start after the other shift ends, or have it fixed.
 */
export function clockInClashWords(input: {
  clash: OverlapClash;
  startIso: string;
  tz: string;
  isStaff: boolean;
  /** What the refused tap did not do: a punch records nothing; the visit's Start The Job starts nothing. */
  nothing?: string;
}): string {
  const { clash, startIso, tz, isStaff } = input;
  const nothing = input.nothing ?? "Nothing was recorded.";
  const at = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
  const when = clash.clockOut ? shiftWhen(clash.clockIn, clash.clockOut, tz) : shiftWhen(clash.clockIn, clash.clockIn, tz).split(" to ")[0];
  const where = clash.jobLabel ? ` on ${clash.jobLabel}` : clash.noJob ? " with no job" : "";
  const fix = isStaff ? "fix that shift on Timecards" : "ask the office to fix that shift";
  return clash.clockOut
    ? `You already have hours recorded ${when}${where}, so a clock started at ${at(startIso)} would count them twice. ${nothing} Start the clock at ${at(clash.clockOut)} or later, or ${fix}.`
    : `You already have a clock running since ${when}${where}. ${nothing}`;
}

/** "Thursday Sep 17, 11:00 AM to 9:00 PM" in the ORG's day (days are org-local, never the
 *  UTC server's), for the sentence a copy answers with. */
export function shiftWhen(clockIn: string, clockOut: string, tz: string): string {
  const a = new Date(clockIn);
  const b = new Date(clockOut);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return "";
  // ICU puts a narrow no-break space before AM/PM; normalize it so the sentence reads,
  // copies and compares as plain text.
  const at = (d: Date) =>
    d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
  const weekday = a.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
  const monthDay = a.toLocaleDateString("en-US", { timeZone: tz, month: "short", day: "numeric" });
  return `${weekday} ${monthDay}, ${at(a)} to ${at(b)}`;
}
