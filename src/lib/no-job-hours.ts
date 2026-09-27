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
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";
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
  /** The code Company Time files under (companyTimeCode), or null when the company has no
   *  not-billed code yet: then no door files company time, and no sentence may offer one. */
  companyCode: string | null;
};

const nameOf = (p: NoJobRow["profiles"]): string => {
  const one = Array.isArray(p) ? p[0] : p;
  return (one?.full_name ?? "").trim() || "Someone";
};

/**
 * The rule, pure: which closed, job-less rows are still waiting on a person. `rows` are closed
 * entries with no job (the read's filter); newest first in, newest first out. `includeToday`: a
 * shift that closed today counts too (the job's Time tab, where the office is looking at the job
 * the punch may belong to; Needs You still waits for the day to end).
 */
export function noJobShiftsFrom(
  rows: NoJobRow[],
  opts: { nonBillableCodes: ReadonlySet<string>; claimed: ReadonlySet<string>; todayStr: string; tz: string; includeToday?: boolean },
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
    if (opts.includeToday ? day > opts.todayStr : day >= opts.todayStr) continue;
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
  const codesR = await supabase.from("job_codes").select("code, active").eq("billable", false);
  if (codesR.error) return null;
  const codeRows = (codesR.data ?? []) as { code?: string | null; active?: boolean | null }[];
  const nonBillableCodes = new Set(codeRows.map((c) => String(c.code ?? "").trim()).filter(Boolean));
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
    companyCode: companyTimeCode(codeRows.map((c) => ({ ...c, billable: false }))),
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

// ── PUNCHES WITH NO JOB, NEAR ONE JOB (the job's Time tab) ────────────────────────────────────
//
// On 9/19 the office billing 85 Whitney looked at the job's Time tab, found no 9/11 hours and typed
// the day again: Brian's own 9/11 punch was in the book on no job, and the job page never showed
// it. So the job's Time tab lists the shifts on no job that its crew clocked around its days, each
// with "Put This On <job>": the same shifts Hours On No Job lists (this file's rule), cut to this
// job's people and dates, today's included.

/** At most this many on one job's Time tab, newest first. */
export const NEAR_JOB_CAP = 50;

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The days this job's crew may have worked it without the punch saying so: from the day BEFORE its
 * first worked or scheduled day to TWO days after its last (a job scheduled for one day that ran
 * into a second, the case that started this). Org-local "yyyy-mm-dd", both ends included. Null when
 * the job has no day at all (never scheduled, never worked): nothing to be near.
 */
export function nearJobWindow(input: {
  tz: string;
  /** The job's own time entries. */
  entries: { clock_in?: string | null; clock_out?: string | null }[];
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  /** job_schedule_segments rows: already org-local dates. */
  segments?: { start_date?: string | null; end_date?: string | null }[];
}): { from: string; to: string } | null {
  const days: string[] = [];
  const instant = (v: string | null | undefined) => {
    const ms = Date.parse(String(v ?? ""));
    if (Number.isFinite(ms)) days.push(todayStrInTz(input.tz, new Date(ms)));
  };
  for (const e of input.entries ?? []) {
    instant(e.clock_in);
    instant(e.clock_out);
  }
  instant(input.scheduledStart);
  instant(input.scheduledEnd);
  for (const s of input.segments ?? []) {
    for (const d of [s.start_date, s.end_date]) {
      const ymd = String(d ?? "").slice(0, 10);
      if (YMD.test(ymd)) days.push(ymd);
    }
  }
  if (!days.length) return null;
  days.sort();
  return { from: addDays(days[0], -1), to: addDays(days[days.length - 1], 2) };
}

/** This job's crew: the people assigned to it, and anyone with hours on it. */
export function jobCrewIds(assigned: (string | null | undefined)[] | null | undefined, entries: { profile_id?: string | null }[]): string[] {
  const ids = new Set<string>();
  for (const a of assigned ?? []) if (a) ids.add(String(a));
  for (const e of entries ?? []) if (e?.profile_id) ids.add(String(e.profile_id));
  return [...ids].sort();
}

/**
 * Read them: closed shifts on no job, not the company's own time, not billed, by `crewIds`, that
 * started inside `window` (org-local days). RLS-scoped (the office reads every entry of its
 * company). Newest first, at most NEAR_JOB_CAP. A failed read is null, never an empty list: "none"
 * hides the list, "could not look" says so.
 */
export async function readNoJobPunchesNearJob(
  supabase: SupabaseClient,
  opts: { crewIds: string[]; window: { from: string; to: string } | null; tz: string; todayStr: string },
): Promise<NoJobShift[] | null> {
  if (!opts.window || !opts.crewIds.length) return [];
  const codesR = await supabase.from("job_codes").select("code").eq("billable", false);
  if (codesR.error) return null;
  const nonBillableCodes = new Set(((codesR.data ?? []) as { code?: string | null }[]).map((c) => String(c.code ?? "").trim()).filter(Boolean));
  let read = supabase
    .from("time_entries")
    .select("id, profile_id, clock_in, clock_out, lunch_minutes, job_code, auto_closed_reason, profiles:profile_id(full_name)")
    .in("profile_id", opts.crewIds)
    .eq("status", "closed")
    .is("job_id", null)
    .not("clock_out", "is", null)
    .gte("clock_in", tzDayStartUtc(opts.window.from, opts.tz).toISOString())
    .lt("clock_in", tzDayStartUtc(addDays(opts.window.to, 1), opts.tz).toISOString());
  const notCompanyTime = notCompanyTimeFilter(nonBillableCodes);
  if (notCompanyTime) read = read.or(notCompanyTime);
  const rowsR = await read.order("clock_in", { ascending: false }).limit(NEAR_JOB_CAP);
  if (rowsR.error) return null;
  const rows = (rowsR.data ?? []) as NoJobRow[];
  if (!rows.length) return [];
  let claimed: Set<string>;
  try {
    const claims = await claimedSourcesOnJob(supabase, null, null, rows.map((r) => r.id));
    claimed = new Set(claims.owner.keys());
  } catch {
    return null;
  }
  return noJobShiftsFrom(rows, { nonBillableCodes, claimed, todayStr: opts.todayStr, tz: opts.tz, includeToday: true });
}
