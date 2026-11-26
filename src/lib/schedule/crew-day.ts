/**
 * ONE COMPANY'S DAY ON THE SCHEDULE, FOR A CALLER WITHOUT ROW SECURITY (cn-v1192). The two Time Clock
 * reminders ask it: the clock-out reminder for the hours of the job a person is clocked into, the
 * clock-in reminder for who is scheduled today and when they start. One read, so the two reminders can
 * never disagree about the day.
 *
 * Nothing here is a new rule. It composes the Schedule's own:
 *   A JOB ON THE DAY, AND ITS HOURS  job-day-read jobDaysInWindow: segments first (a job with any
 *       segment is on its segments' days only, with a day's own start_time/end_time when it has them),
 *       else the job's scheduled_start..scheduled_end span, in company days; the hours by jobDayBlock.
 *       It is handed EVERY segment of each job it reads, as bookedKeys needs.
 *   WHO IS ON IT  the clock's own precedence (timeclock/scheduled-job scheduledJobFor, timeclock/
 *       crew-plan pickScheduledJobForDay): (a) the person's crew_day_assignments row for the day
 *       decides: 'off' is not scheduled at all, 'job' is that job (when it is still in flight; a
 *       finished one falls through, as the clock reads it); (b) otherwise every in-flight job whose
 *       assigned_to holds the person and that is on the day, EXCEPT a job on hold: it keeps its old
 *       span (cn-v1189), which is a leftover, not a plan, so its crew is not scheduled by it (a day
 *       row naming a held job is still a person's own pick for that day, and its hours stay in `jobs`); (c) plus every visit that day assigned to
 *       the person that the Schedule draws (not cancelled or completed, not absorbed into its job, not a
 *       call; no end is an hour).
 *   A day-row job that is not on the day by its own plan has no hours that day: it is the company's
 *   work day, the answer jobDayBlock gives for a day outside the plan.
 *   A visit counts on the day it STARTS: a visit that began on an earlier day has no start today.
 *
 * Every read names the company (the service client bypasses row security), and a failed read THROWS:
 * "nobody is scheduled" from a read that never happened would remind nobody, or the wrong people.
 * Not a "use server" file; no words catalog.
 */
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { tzDayStartUtc, tzLocalHourUtc } from "@/lib/tz";
import { jobDaysInWindow } from "./job-day-read";
import { jobDayBlock, workDayMinutes } from "./job-block";
import { segmentCols, withDayHours, type SegmentRow } from "./segment-hours";

type Client = { from: (t: string) => any };

export type CrewDayJobRow = {
  id: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  planned_minutes?: number | null;
  assigned_to?: string[] | null;
  status?: string | null;
};
export type CrewDayRow = { profile_id: string; job_id: string | null; kind: string | null };
export type CrewDayVisitRow = {
  id: string;
  assigned_to: string | null;
  starts_at: string | null;
  ends_at: string | null;
  type?: string | null;
  status?: string | null;
  absorbed?: boolean | null;
};

/** A block on the day: minutes past the company's midnight, and the same moments as instants. */
export type DayBlock = { kind: "job" | "visit"; id: string; startMin: number; endMin: number; startMs: number; endMs: number };

export type CrewDay = {
  day: string;
  /** Every job ON the day by its own plan, with that day's hours. */
  jobs: Map<string, DayBlock>;
  /** Every person the day names: off (never reminded), or their blocks, first start first. */
  people: Map<string, { off: boolean; blocks: DayBlock[]; firstStartMs: number | null }>;
};

const at = (day: string, min: number, tz: string) => tzLocalHourUtc(day, min / 60, tz).getTime();

/** THE PURE PART: the day's rows in, the day's jobs and each person's blocks out. */
export function crewDayFrom(p: {
  day: string;
  tz: string;
  workDay: { start: string; end: string };
  /** In-flight jobs only (ACTIVE_JOB_STATUSES), each with EVERY one of its segments below. */
  jobs: readonly CrewDayJobRow[];
  segments: readonly SegmentRow[];
  dayRows: readonly CrewDayRow[];
  visits: readonly CrewDayVisitRow[];
}): CrewDay {
  const { day, tz } = p;
  const dayStartMs = tzDayStartUtc(day, tz).getTime();
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const dayEndMs = tzDayStartUtc(next.toISOString().slice(0, 10), tz).getTime();

  const jobs = new Map<string, DayBlock>();
  for (const d of jobDaysInWindow({ jobs: p.jobs, segments: p.segments, firstDay: day, lastDay: day, tz, workDay: p.workDay })) {
    jobs.set(d.job.id, { kind: "job", id: d.job.id, startMin: d.startMin, endMin: d.endMin, startMs: at(day, d.startMin, tz), endMs: at(day, d.endMin, tz) });
  }
  const byId = new Map(p.jobs.map((j) => [j.id, j]));
  const wd = workDayMinutes(p.workDay);

  const people = new Map<string, { off: boolean; blocks: DayBlock[]; firstStartMs: number | null }>();
  const person = (id: string) => {
    let v = people.get(id);
    if (!v) people.set(id, (v = { off: false, blocks: [], firstStartMs: null }));
    return v;
  };

  // (a) THE DAY ROW DECIDES. Off fails closed; a job row is that job (still in flight), else falls through.
  const decided = new Set<string>();
  for (const r of p.dayRows) {
    if (!r?.profile_id) continue;
    if (r.kind === "off") {
      const v = person(r.profile_id);
      v.off = true;
      v.blocks = [];
      decided.add(r.profile_id);
      continue;
    }
    const job = r.job_id ? byId.get(r.job_id) : undefined;
    if (!job) continue;
    let block = jobs.get(job.id);
    if (!block) {
      // Pinned that day but not on its plan: no hours of its own that day, the company's work day.
      const b = jobDayBlock({ day, scheduledStart: null, scheduledEnd: null, tz, wd });
      block = { kind: "job", id: job.id, startMin: b.startMin, endMin: b.endMin, startMs: at(day, b.startMin, tz), endMs: at(day, b.endMin, tz) };
    }
    person(r.profile_id).blocks.push(block);
    decided.add(r.profile_id);
  }

  // (b) Otherwise every in-flight job on the day whose crew holds the person; a held job's span is a leftover.
  for (const [jobId, block] of jobs) {
    const job = byId.get(jobId);
    if (job?.status === "on_hold") continue;
    for (const pid of job?.assigned_to ?? []) {
      if (!pid || decided.has(pid)) continue;
      person(pid).blocks.push(block);
    }
  }

  // (c) Plus every visit that day on the person's name that the Schedule draws.
  for (const a of p.visits) {
    if (!a?.assigned_to || !a.starts_at || a.absorbed || a.type === "call") continue;
    if (a.status === "cancelled" || a.status === "completed") continue;
    const startMs = Date.parse(a.starts_at);
    if (!Number.isFinite(startMs) || startMs < dayStartMs || startMs >= dayEndMs) continue;
    const endParsed = a.ends_at ? Date.parse(a.ends_at) : NaN;
    const endMs = Number.isFinite(endParsed) && endParsed > startMs ? endParsed : startMs + 60 * 60_000;
    const v = person(a.assigned_to);
    if (v.off) continue;
    const startMin = Math.round((startMs - dayStartMs) / 60_000);
    v.blocks.push({ kind: "visit", id: a.id, startMin, endMin: startMin + Math.round((endMs - startMs) / 60_000), startMs, endMs });
  }

  for (const v of people.values()) {
    v.blocks.sort((x, y) => x.startMs - y.startMs);
    v.firstStartMs = v.blocks.length ? v.blocks[0].startMs : null;
  }
  return { day, jobs, people };
}

const fail = (what: string, error: unknown) => {
  const msg = String((error as { message?: unknown })?.message ?? error ?? "unknown error");
  return new Error(`readCrewDay: the ${what} read failed: ${msg}`);
};

/**
 * THE READ: the company's day, every read naming the company; THROWS on a failed read. `workDay` is
 * the company's work day ("HH:MM", org-settings workDayWindowHm).
 */
export async function readCrewDay(
  supabase: Client,
  p: { orgId: string; tz: string; workDay: { start: string; end: string }; day: string },
): Promise<CrewDay> {
  const { orgId, tz, day } = p;
  const dayStart = tzDayStartUtc(day, tz);
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const dayEnd = tzDayStartUtc(next.toISOString().slice(0, 10), tz);
  const JOB_COLS = "id, status, scheduled_start, scheduled_end, planned_minutes, assigned_to";

  const [segToday, spanJobs, dayRows, visits] = await Promise.all([
    // The ranges that cover the day (a job with segments is on those days only).
    withDayHours((h) =>
      supabase
        .from("job_schedule_segments")
        .select(segmentCols("job_id, start_date, end_date", h))
        .eq("org_id", orgId)
        .lte("start_date", day)
        .gte("end_date", day),
    ),
    // In-flight jobs whose own span reaches the day (the rule for a job with no segments).
    supabase
      .from("jobs")
      .select(JOB_COLS)
      .eq("org_id", orgId)
      .in("status", ACTIVE_JOB_STATUSES)
      .lt("scheduled_start", dayEnd.toISOString())
      .or(`scheduled_end.gte.${dayStart.toISOString()},and(scheduled_end.is.null,scheduled_start.gte.${dayStart.toISOString()})`),
    supabase.from("crew_day_assignments").select("profile_id, job_id, kind").eq("org_id", orgId).eq("work_date", day),
    // The visits that start on the day, on a person's name, still scheduled.
    supabase
      .from("appointments")
      .select("id, assigned_to, starts_at, ends_at, type, status, absorbed")
      .eq("org_id", orgId)
      .eq("status", "scheduled")
      .not("assigned_to", "is", null)
      .gte("starts_at", dayStart.toISOString())
      .lt("starts_at", dayEnd.toISOString()),
  ]);
  if (segToday.error) throw fail("job day", segToday.error);
  if (spanJobs.error) throw fail("jobs", spanJobs.error);
  if (dayRows.error) throw fail("crew day", dayRows.error);
  if (visits.error) throw fail("visits", visits.error);

  const jobs = new Map<string, CrewDayJobRow>();
  for (const j of (spanJobs.data ?? []) as CrewDayJobRow[]) if (j?.id) jobs.set(j.id, j);
  // The jobs a covering range or a day row names that the span read did not bring.
  const missing = new Set<string>();
  for (const s of (segToday.data ?? []) as unknown as SegmentRow[]) if (s?.job_id && !jobs.has(s.job_id)) missing.add(s.job_id);
  for (const r of (dayRows.data ?? []) as CrewDayRow[]) if (r?.job_id && !jobs.has(r.job_id)) missing.add(r.job_id);
  if (missing.size) {
    const more = await supabase.from("jobs").select(JOB_COLS).eq("org_id", orgId).in("status", ACTIVE_JOB_STATUSES).in("id", [...missing]);
    if (more.error) throw fail("jobs", more.error);
    for (const j of (more.data ?? []) as CrewDayJobRow[]) if (j?.id) jobs.set(j.id, j);
  }

  // EVERY range of each job read, not only today's: a job with ranges elsewhere and none today is not on today.
  let segments: SegmentRow[] = [];
  if (jobs.size) {
    const all = await withDayHours((h) =>
      supabase
        .from("job_schedule_segments")
        .select(segmentCols("job_id, start_date, end_date", h))
        .eq("org_id", orgId)
        .in("job_id", [...jobs.keys()]),
    );
    if (all.error) throw fail("job days", all.error);
    segments = (all.data ?? []) as unknown as SegmentRow[];
  }

  return crewDayFrom({
    day,
    tz,
    workDay: p.workDay,
    jobs: [...jobs.values()],
    segments,
    dayRows: (dayRows.data ?? []) as CrewDayRow[],
    visits: (visits.data ?? []) as CrewDayVisitRow[],
  });
}
