// Shared, SERVER-SAFE helpers + types for the crew day-assignment planner
// (the /timeclock board in crew-assignments.tsx + the CrewWeekGrid). PURE
// module — no hooks, no "use client" — so server code (page.tsx,
// crew-actions.ts) can import the types and the week math without an RSC
// boundary crash (the /timecards lesson: hmToMin lives in lib/tz, not the
// client time-grid).

import { todayStrInTz, weekDayStrs } from "@/lib/tz";
import { jobLabel, jobSiteLabel } from "@/lib/schedule-options";

/** The job label fields every assignment surface needs — the jobLabel /
 *  jobSiteLabel SSOT inputs (customer_name feeds the codes-off identity).
 *  Nullable to match crew-actions' CrewDayAssignmentRow.job join shape. */
export interface CrewJobOpt {
  id: string;
  job_number: string | null;
  name: string | null;
  address?: string | null;
  customer_name?: string | null;
}

/** One crew_day_assignments row as the UI consumes it. listWeekAssignments
 *  joins the job label fields on as `job`; optimistic client patches fill it
 *  from the active-jobs options list. */
export interface CrewAssignmentRow {
  profile_id: string;
  work_date: string; // "YYYY-MM-DD" (org-local day)
  job_id: string;
  is_crew_lead: boolean;
  job?: CrewJobOpt | null;
}

export interface CrewActionResult {
  ok: boolean;
  error?: string;
}

/** memberId → dayStr → jobId: the CURRENT week's inferred (non-explicit) jobs,
 *  built server-side in page.tsx — TODAY is the full pickMemberCurrentJob
 *  inference (what a job-less Clock In resolves to), later days are
 *  schedule-only (pickScheduledJobForDay). Both surfaces render these as muted
 *  "auto" hints; an explicit crew_day_assignments row always wins. Keyed by
 *  real day strings, so paged-away weeks simply have no hints. */
export type CrewAutoPlan = Record<string, Record<string, string>>;

/** The setCrewDayAssignment server action (crew-actions.ts), passed into the
 *  client components as a prop. jobId null = clear the member's row for that
 *  day (the lead flag clears with it — a lead with no job has no meaning). */
export type SetCrewDayAssignment = (input: {
  profileId: string;
  workDate: string;
  jobId: string | null;
  isCrewLead: boolean;
}) => Promise<CrewActionResult>;

/** The listWeekAssignments server action — rows for the org week `weekOffset`
 *  weeks from the current one. SIGNED: 0 = this week, +1 = NEXT week (the
 *  planning-ahead case), -1 = last week. */
export type ListWeekAssignments = (
  weekOffset: number,
) => Promise<CrewActionResult & { rows?: CrewAssignmentRow[] }>;

/** The 7 org-local day strings ("YYYY-MM-DD") of the org week `offset` weeks
 *  from the one containing today — anchored on the ORG-tz day, week_start
 *  honored, SIGNED (+1 = NEXT week: planning looks ahead). A thin wrapper over
 *  lib/tz's weekDayStrs (the SSOT week math listWeekAssignments uses
 *  server-side, so board chips and action rows can never disagree on what
 *  "next week" is). `now` is injectable for tests. */
export function orgWeekDayStrs(
  offset: number,
  tz: string,
  weekStart: "sunday" | "monday",
  now: Date = new Date(),
): string[] {
  return weekDayStrs(todayStrInTz(tz, now), weekStart, offset);
}

/** "Jul 20 – Jul 26" for a week's day strings (noon-UTC trick = tz-stable). */
export function weekRangeLabel(days: string[]): string {
  if (!days.length) return "";
  const f = (ds: string) =>
    new Date(`${ds}T12:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `${f(days[0])} – ${f(days[days.length - 1])}`;
}

/** Day-chip / column-header parts for a "YYYY-MM-DD": { dow: "Mon", dom: "20" }. */
export function dayParts(ds: string): { dow: string; dom: string } {
  const d = new Date(`${ds}T12:00:00Z`);
  return {
    dow: d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }),
    dom: d.toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" }),
  };
}

/** "Tue, Jul 21" — the grid editor bar's day tag. */
export function dayTag(ds: string): string {
  return new Date(`${ds}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** THE full assignment job label — the same codes-flag fork every timeclock
 *  surface uses (jobLabel / jobSiteLabel SSOT), kept here so the board's
 *  options and the grid's tooltips can't drift. */
export function assignmentJobLabel(j: CrewJobOpt, codesOn: boolean): string {
  return codesOn ? jobLabel(j) : jobSiteLabel(j);
}

/** The grid cell's SHORT job tag (a pill has ~80px): the job number (codes on,
 *  matching the /timecards pills) or the customer/site identity's lead part
 *  (codes off — orgs that think "whose house", not numbers). */
export function shortJobTag(
  j:
    | {
        job_number?: string | null;
        name?: string | null;
        address?: string | null;
        customer_name?: string | null;
      }
    | null
    | undefined,
  codesOn: boolean,
): string {
  if (!j) return "Job";
  if (codesOn) return j.job_number || j.name || "Job";
  return (
    (j.customer_name ?? "").trim() ||
    (j.address ?? "").trim() ||
    j.name ||
    j.job_number ||
    "Job"
  );
}

/** SCHEDULE-only pick for a FUTURE day's muted "auto" hint: among the member's
 *  jobs, the one the schedule puts on `ds` — a job_schedule_segments range
 *  covering the day, or a scheduled_start falling on it (org-local day
 *  precomputed by the caller into schedDayByJob — tz stays a server concern).
 *  Earliest scheduled_start wins, mirroring pickJobScheduledToday's tie-break
 *  (segment-only jobs sort last, same "9999" sentinel). TODAY's hint
 *  deliberately does NOT use this — it's the full pickMemberCurrentJob
 *  inference (tier-0 day-assignment included). PAST days get no hints at all:
 *  a hint on a past day would read as "was there", and that's /timecards'
 *  (time-entry) truth to tell, not the schedule's. */
export function pickScheduledJobForDay<
  T extends { id: string; scheduled_start?: string | null },
>(
  jobs: T[],
  ds: string,
  segsByJob: ReadonlyMap<string, { start: string; end: string }[]>,
  schedDayByJob: ReadonlyMap<string, string | null>,
): T | null {
  const hits = jobs
    .filter(
      (j) =>
        (segsByJob.get(j.id) ?? []).some((r) => r.start <= ds && ds <= r.end) ||
        schedDayByJob.get(j.id) === ds,
    )
    .sort((a, b) => (a.scheduled_start ?? "9999").localeCompare(b.scheduled_start ?? "9999"));
  return hits[0] ?? null;
}

/** Pure optimistic patch: replace/insert/remove the (profile, day) row in a
 *  week's rows. `next` null clears the row (mirrors jobId-null in the action).
 *  Leaves every other row untouched, so a failed save rolls back per-row. */
export function patchWeekRows(
  rows: CrewAssignmentRow[],
  profileId: string,
  workDate: string,
  next: { job_id: string; is_crew_lead: boolean; job?: CrewJobOpt | null } | null,
): CrewAssignmentRow[] {
  const rest = rows.filter(
    (r) => !(r.profile_id === profileId && r.work_date === workDate),
  );
  return next
    ? [...rest, { profile_id: profileId, work_date: workDate, ...next }]
    : rest;
}
