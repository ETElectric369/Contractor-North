/**
 * HOURS ON NO JOB: every closed shift that nobody put on a job, until somebody does.
 *
 * The duplicate punches (2026-09-26) all started here. Brian's clock went in with no job on 9/11
 * (the schedule said J-028 was 9/10 only), the "entry has no job" line left Needs You three days
 * later, and on 9/19 the office, billing 85 Whitney, found no 9/11 hours on the job and typed the
 * day again. The punch was still there, on nobody's list, and payroll paid both.
 *
 * So a no-job shift stays findable until a person decides what it was: put it on its job, or file
 * it as company time (a time code the company marked non-billable, Shop or PTO). No age limit: a
 * window is how it went quiet. The read is capped (newest first) and says so when the cap is hit,
 * even when every row inside the cap turned out billed or empty: then there is no list to put a "+"
 * on, and both places say they could not list them all instead of going quiet.
 *
 * Not on the list:
 *   - a shift with a NON-BILLABLE code (the company's own time, filed on purpose; labor billing's
 *     own predicate, job_codes.billable = false);
 *   - a shift some non-void invoice already claims (billed by hand on an invoice with no job);
 *   - a zero-hour shift (0193's forgotten punch closed at zero: Fix These lists it as auto-closed);
 *   - today's: the day is not over and the crew may still put it on the job.
 *
 * One read for both places that show it: the Timecards Fix These box (each shift, with its doors)
 * and Needs You (one rolled-up line, "Hours On No Job · 17", that opens it).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { hoursBetween } from "@/lib/utils";
import { todayStrInTz } from "@/lib/tz";
import { claimedSourcesOnJob } from "@/lib/unbilled-work";

/** Newest first, at most this many. The count says when there were more. */
export const NO_JOB_READ_CAP = 200;

export type NoJobRow = {
  id: string;
  profile_id?: string | null;
  clock_in: string;
  clock_out: string | null;
  lunch_minutes?: number | null;
  job_code?: string | null;
  auto_closed_reason?: string | null;
  profiles?: { full_name?: string | null } | { full_name?: string | null }[] | null;
};

export type NoJobShift = {
  id: string;
  profileId: string;
  name: string;
  clockIn: string;
  clockOut: string;
  hours: number;
  /** A BILLABLE code with no job (ROUGH on nobody's job) is still hours nobody bills. */
  jobCode: string | null;
  /** The org-local day it started, yyyy-mm-dd. */
  day: string;
};

export type NoJobHours = {
  shifts: NoJobShift[];
  hours: number;
  /** The read hit NO_JOB_READ_CAP: there may be older ones than these. Said, never hidden. */
  capped: boolean;
};

const nameOf = (p: NoJobRow["profiles"]): string => {
  const one = Array.isArray(p) ? p[0] : p;
  return (one?.full_name ?? "").trim() || "Someone";
};

/**
 * The rule, pure: which closed, job-less rows are still waiting on a person. `rows` are closed
 * entries with no job (the read's filter); newest first in, newest first out.
 */
export function noJobShiftsFrom(
  rows: NoJobRow[],
  opts: { nonBillableCodes: ReadonlySet<string>; claimed: ReadonlySet<string>; todayStr: string; tz: string },
): NoJobShift[] {
  const out: NoJobShift[] = [];
  const seen = new Set<string>();
  for (const r of rows ?? []) {
    if (!r?.id || seen.has(r.id) || !r.clock_in || !r.clock_out) continue;
    seen.add(r.id);
    const code = (r.job_code ?? "").trim();
    if (code && opts.nonBillableCodes.has(code)) continue;
    if (opts.claimed.has(r.id)) continue;
    const hours = hoursBetween(r.clock_in, r.clock_out, r.lunch_minutes ?? 0);
    if (hours <= 0) continue;
    const day = todayStrInTz(opts.tz, new Date(r.clock_in));
    if (day >= opts.todayStr) continue;
    out.push({
      id: r.id,
      profileId: String(r.profile_id ?? ""),
      name: nameOf(r.profiles),
      clockIn: r.clock_in,
      clockOut: r.clock_out,
      hours,
      jobCode: code || null,
      day,
    });
  }
  return out;
}

/**
 * The PostgREST filter that keeps the company's own time out of the read: a row with no code, or a
 * code that is none of these. Each code is quoted (a code may hold a comma or a bracket). Null when
 * the company has no such code, so the read needs no filter.
 */
export function notCompanyTimeFilter(nonBillableCodes: Iterable<string>): string | null {
  const codes = Array.from(new Set(Array.from(nonBillableCodes, (c) => String(c ?? "").trim()).filter(Boolean))).sort();
  const quoted = codes.map((c) => `"${c.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return quoted.length ? `job_code.is.null,job_code.not.in.(${quoted.join(",")})` : null;
}

/**
 * Read them, RLS-scoped to the caller's company (office staff read every entry of it). A failed
 * read is null, never an empty list: "nothing on no job" and "could not look" are different facts.
 *
 * THE CAP COUNTS ONLY ROWS THAT COULD BE LISTED. The codes are read first, and the company's own
 * time (Shop, PTO) is left out by the query itself. Filtered after the read instead, every shift
 * Company Time filed stayed inside the newest 200 for good, and once 200 of them were newer than a
 * real no-job punch, that punch dropped off the list with nothing saying so.
 */
export async function readNoJobHours(supabase: SupabaseClient, opts: { tz: string; todayStr: string }): Promise<NoJobHours | null> {
  const codesR = await supabase.from("job_codes").select("code").eq("billable", false);
  if (codesR.error) return null;
  const nonBillableCodes = new Set(((codesR.data ?? []) as { code?: string | null }[]).map((c) => String(c.code ?? "").trim()).filter(Boolean));
  let read = supabase
    .from("time_entries")
    .select("id, profile_id, clock_in, clock_out, lunch_minutes, job_code, auto_closed_reason, profiles:profile_id(full_name)")
    .eq("status", "closed")
    .is("job_id", null)
    .not("clock_out", "is", null);
  const notCompanyTime = notCompanyTimeFilter(nonBillableCodes);
  if (notCompanyTime) read = read.or(notCompanyTime);
  const rowsR = await read.order("clock_in", { ascending: false }).limit(NO_JOB_READ_CAP);
  if (rowsR.error) return null;
  const rows = (rowsR.data ?? []) as NoJobRow[];
  let claimed = new Set<string>();
  if (rows.length) {
    try {
      const claims = await claimedSourcesOnJob(supabase, null, null, rows.map((r) => r.id));
      claimed = new Set(claims.owner.keys());
    } catch {
      return null;
    }
  }
  const shifts = noJobShiftsFrom(rows, { nonBillableCodes, claimed, todayStr: opts.todayStr, tz: opts.tz });
  return {
    shifts,
    hours: Math.round(shifts.reduce((s, x) => s + x.hours, 0) * 100) / 100,
    capped: rows.length >= NO_JOB_READ_CAP,
  };
}

/** The first non-billable code to file company time under: SHOP when the company has it (the
 *  common name), else the first one in code order. Null when the company has none. */
export function companyTimeCode(codes: { code?: string | null; billable?: boolean | null; active?: boolean | null }[]): string | null {
  const off = codes
    .filter((c) => c.billable === false && c.active !== false)
    .map((c) => String(c.code ?? "").trim())
    .filter(Boolean)
    .sort();
  if (!off.length) return null;
  return off.find((c) => c.toUpperCase() === "SHOP") ?? off[0];
}
