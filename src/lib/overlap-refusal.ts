/**
 * THE OVERLAP TEST, ONE COPY. Lifted out of timeclock/actions.ts (a "use server" file, where every
 * export is a callable action) so a door outside the Timeclock that opens a shift in the past, the
 * visit page's Start The Job And Clock In, asks the very same question in the very same words.
 */
import { dbError } from "@/lib/db-error";
import { getOrgSettings } from "@/lib/org-settings";
import { clockDoorWords, clockedOutWords } from "@/lib/long-shift";
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
  opts?: {
    /** The row being edited or copied — it is allowed to overlap itself. */
    excludeId?: string;
    /** Already in the caller's hand (the copy reads both to name its target); else read here. */
    name?: string;
    tz?: string;
    /** A copy onto the SAME person: the exact match it finds IS the original, so say that. */
    samePerson?: boolean;
  },
): Promise<string | null> {
  if (!profileId || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  // 0217 caps a shift at 18 hours, so a day back catches every entry that could still be running
  // into this one.
  const { data: near, error: nearErr } = await supabase
    .from("time_entries")
    .select("id, clock_in, clock_out")
    .eq("profile_id", profileId)
    .gte("clock_in", new Date(startMs - 24 * 3_600_000).toISOString())
    .lte("clock_in", new Date(endMs).toISOString())
    .limit(100);
  // A FAILED READ IS NOT A CLEAR DAY. Waving the write through on the one occasion the check could
  // not be made is how the pair in the ledger got there; 0278 would still refuse it, but the
  // office would be reading the database's words instead of ours.
  if (nearErr) return dbError(nearErr);

  const rows = ((near ?? []) as { id: string; clock_in: string; clock_out: string | null }[]).filter(
    (r) => r.id !== opts?.excludeId && Number.isFinite(new Date(r.clock_in).getTime()),
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

  if (exact) {
    const when = shiftWhen(new Date(startMs).toISOString(), new Date(endMs).toISOString(), tz);
    return opts?.samePerson
      ? `${name} already has ${when}. Pick the person who worked it with them, or edit that entry.`
      : `${name} already has ${when} on another entry. Open that one to change it.`;
  }
  // An open shift has no finish to name, so it gets its start instead of a made-up one.
  const startedAt = shiftWhen(clash.clock_in, clash.clock_in, tz).split(" to ")[0];
  return clash.clock_out
    ? `${name} is already on the clock ${shiftWhen(clash.clock_in, clash.clock_out, tz)}, so these hours would be counted twice. Edit that entry instead.`
    : `${name} has been clocked in since ${startedAt}, so these hours would be counted twice. ${clockedOutWords(fullName, false).clockOutFirst}: tap their shift on Timecards and use ${clockDoorWords(fullName).clockOut}.`;
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
