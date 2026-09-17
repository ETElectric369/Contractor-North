import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { listActiveTechs, jobLabel } from "@/lib/schedule-options";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { isStaffRole } from "@/lib/actions/perms";
import { tzDayStartUtc, todayStrInTz, prettyDay } from "@/lib/tz";
import { pickScheduledJobForDay } from "../timeclock/crew-plan";
import { CrewBoard, type Lane, type CrewJob, type CrewAppt, type JobOption } from "./crew-board";

/** "Everyone's Day" — the all-crew board: one lane per person for the chosen day, showing every job
 *  and appointment assigned to them (plus an Unassigned lane), so you can see the whole crew's load
 *  side-by-side and spot who has room to take another job. Reads jobs.assigned_to (an array — a job
 *  can have several people) + appointments.assigned_to. Retired back on 2026-06-17; rebuilt here.
 *
 *  IT IS ALSO THE PLACE A DAY GETS DECIDED NOW (cn-v951). The /timeclock week grid — a second,
 *  per-day editor over crew_day_assignments — is gone. It had held 13 job rows and 11 off rows in
 *  its whole life, nothing since 2026-08-07, and cn-v590 ("Stop guessing, one calendar") had
 *  removed both of its population mechanisms in one commit, so a correctly-blank grid and a dead
 *  one had looked identical for seven weeks. Erik: "do we need the crew week? lets try and mold as
 *  much together as possible and simplify, i lean towards the schedule".
 *
 *  So the ROW survives the grid. crew_day_assignments is load-bearing in two places that never had
 *  a UI of their own: timeclock/actions.ts reads the day's row FIRST when somebody clocks in
 *  without picking a job (THE PRECEDENCE LAW, migration 0139), and /timecards feeds the week's
 *  rows to comparePlanToActual for the "Fix These" plan-drift card. This board is now the only
 *  writer, and it writes through the same crew-actions.ts verbs the grid called.
 *
 *  WHAT IT DOES NOT DO: guess. There is no "newest active job" fallback and no dashed suggestion
 *  pill inside a person's row. cn-v590 deleted those on Erik's own instruction ("i dont think we
 *  should suggest crew assignments, theres too much complication going on here"). A job somebody
 *  actually SCHEDULED is a fact, not a guess, and that is the only thing drawn uncalled-for. */

function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`); // noon avoids any DST edge when stepping days
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The raw job shape both reads project — `scheduled_start` rides along because
 *  pickScheduledJobForDay sorts on it (earliest start wins the day). */
type RawJob = {
  id: string;
  job_number: string | null;
  name: string | null;
  status: string;
  assigned_to: string[] | null;
  scheduled_start: string | null;
  customers?: { name?: string | null } | null;
};

const JOB_COLS = "id, job_number, name, status, assigned_to, scheduled_start, customers(name)";

export async function CrewBoardPanel({ date }: { date?: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings((org as any)?.settings).timezone;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? (date as string) : todayStrInTz(tz);

  const dayStart = tzDayStartUtc(day, tz);
  const dayEnd = tzDayStartUtc(shiftYmd(day, 1), tz);
  const startIso = dayStart.toISOString();
  const endIso = dayEnd.toISOString();

  const [
    { data: staffRows },
    { data: meRow },
    { data: rangeJobs },
    { data: segRows },
    { data: appts },
    { data: assignRows, error: assignErr },
    { data: activeJobRows },
  ] = await Promise.all([
    listActiveTechs(supabase),
    // A control a role cannot use must not render. The page already sends techs to My Day, but the
    // board owns its own answer too — and crew-actions.ts refuses a non-staff caller regardless.
    supabase.from("profiles").select("role").eq("id", user?.id ?? "").maybeSingle(),
    // Jobs whose scheduled range overlaps the day (active only).
    supabase
      .from("jobs")
      .select(JOB_COLS)
      .in("status", ACTIVE_JOB_STATUSES as unknown as string[])
      .lte("scheduled_start", endIso)
      .or(`scheduled_end.gte.${startIso},and(scheduled_end.is.null,scheduled_start.gte.${startIso})`),
    // Segments that COVER this calendar day (date-only, tz-clean). The dates ride along because
    // pickScheduledJobForDay wants the RANGE, not just the fact of a hit.
    supabase
      .from("job_schedule_segments")
      .select("job_id, start_date, end_date")
      .lte("start_date", day)
      .gte("end_date", day),
    supabase
      .from("appointments")
      .select("id, type, title, starts_at, assigned_to, job_id, jobs(name), customers(name)")
      .gte("starts_at", startIso)
      .lt("starts_at", endIso)
      .neq("status", "cancelled")
      // Not the ghost of a booking that BECAME a job (0237): a converted visit keeps its row
      // with absorbed=true at the job's own start time. The calendar, My Day, feeders, Google
      // sync and reminders all drop it; the crew board did not, so the assignee's lane showed
      // both the visit card and the job card and the load pill counted twice (audit v921 high).
      .eq("absorbed", false)
      .order("starts_at"),
    // THE OVERRIDE (0139/0170). One row per person per org-local day: kind='job' pins the job,
    // kind='off' says they are deliberately away. This is the DECISION; everything else on the
    // board is the job calendar's default.
    supabase
      .from("crew_day_assignments")
      .select("profile_id, job_id, kind, off_reason, job:job_id(id, job_number, name)")
      .eq("work_date", day),
    // The "Put On A Job" picker. Active jobs only — you cannot send a man to a closed job.
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .in("status", ACTIVE_JOB_STATUSES as unknown as string[])
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const canEdit = isStaffRole((meRow as { role?: string } | null)?.role ?? "");

  // SEGMENTS-FIRST (mirror the calendar, calendar-view.tsx): a job with multi-day segments is
  // scheduled ONLY on the days a segment covers. Its base scheduled_start/scheduled_end is stretched
  // min-start→max-end, so a non-contiguous job (Mon + Fri) would otherwise wrongly show on the Wed
  // GAP day and inflate that person's load — wrecking the board's "who has room today". So: a
  // segmented job appears only if a segment covers `day`; an unsegmented job uses the base-range
  // overlap the query already applied.
  const rangeArr = (rangeJobs ?? []) as RawJob[];
  const coverSegs = (segRows ?? []) as { job_id: string; start_date: string; end_date: string }[];
  const coverIds = new Set(coverSegs.map((s) => s.job_id).filter(Boolean));
  const rangeIds = rangeArr.map((j) => j.id);
  let segmentedIds = new Set<string>();
  let allSegs: { job_id: string; start_date: string; end_date: string }[] = [];
  if (rangeIds.length) {
    const { data: anySeg } = await supabase
      .from("job_schedule_segments")
      .select("job_id, start_date, end_date")
      .in("job_id", rangeIds);
    allSegs = (anySeg ?? []) as { job_id: string; start_date: string; end_date: string }[];
    segmentedIds = new Set(allSegs.map((s) => s.job_id));
  }
  const byId = new Map<string, RawJob>();
  for (const j of rangeArr) {
    if (!segmentedIds.has(j.id) || coverIds.has(j.id)) byId.set(j.id, j);
  }
  // Defensive: a covering-segment job whose base range somehow didn't match the query — pull it in.
  const missing = [...coverIds].filter((id) => id && !byId.has(id));
  if (missing.length) {
    const { data: segJobs } = await supabase
      .from("jobs")
      .select(JOB_COLS)
      .in("id", missing)
      .in("status", ACTIVE_JOB_STATUSES as unknown as string[]);
    for (const j of (segJobs ?? []) as RawJob[]) byId.set(j.id, j);
  }
  const jobRows = [...byId.values()];

  // The two maps pickScheduledJobForDay reads. Both covering segments and the full per-job fetch
  // feed segsByJob — a duplicate range only makes the same `.some()` true twice. The org-local day
  // of a job's scheduled_start is precomputed here because tz stays a SERVER concern (crew-plan is
  // a pure module shared with client code).
  const segsByJob = new Map<string, { start: string; end: string }[]>();
  for (const s of [...coverSegs, ...allSegs]) {
    if (!s.job_id) continue;
    const list = segsByJob.get(s.job_id) ?? [];
    list.push({ start: s.start_date, end: s.end_date });
    segsByJob.set(s.job_id, list);
  }
  const schedDayByJob = new Map<string, string | null>();
  for (const j of jobRows) {
    schedDayByJob.set(j.id, j.scheduled_start ? todayStrInTz(tz, new Date(j.scheduled_start)) : null);
  }

  const jobs: CrewJob[] = jobRows.map((j) => ({
    id: j.id,
    label: jobLabel(j),
    status: j.status,
    customer: j.customers?.name ?? null,
    assigned: (j.assigned_to ?? []).filter(Boolean),
  }));
  const appointments: CrewAppt[] = (appts ?? []).map((a: any) => ({
    id: a.id,
    title: a.title,
    type: a.type,
    time: new Date(a.starts_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }),
    jobId: a.job_id ?? null,
    who: a.jobs?.name ?? a.customers?.name ?? null,
    assigned: a.assigned_to ?? null,
  }));

  // Fail-soft on the override read (the 0128 precedent): a board that draws the schedule is still
  // worth having if the assignment table hiccups — it just has nothing to overrule it with.
  type AssignRow = {
    profile_id: string;
    job_id: string | null;
    kind: string | null;
    off_reason: string | null;
    job: { id: string; job_number: string | null; name: string | null } | null;
  };
  const decisions = new Map<string, AssignRow>();
  if (!assignErr) {
    for (const r of (assignRows ?? []) as unknown as AssignRow[]) {
      if (r?.profile_id) decisions.set(r.profile_id, r);
    }
  }

  const members = (staffRows ?? []) as { id: string; full_name: string | null }[];
  const memberIds = new Set(members.map((m) => m.id));
  const lanes: Lane[] = members.map((m) => {
    const mine = jobRows.filter((j) => (j.assigned_to ?? []).includes(m.id));
    // THE schedule's own answer for this person on this day — the engine that was written,
    // unit-tested and never called (crew-plan.ts). It names the job "Follow The Schedule" hands
    // the day back to, so that button can say what it will do instead of just doing it.
    const sched = pickScheduledJobForDay(mine, day, segsByJob, schedDayByJob);
    const row = decisions.get(m.id);
    const off = row?.kind === "off";
    return {
      id: m.id,
      name: m.full_name ?? "Unnamed",
      jobs: jobs.filter((j) => j.assigned.includes(m.id)),
      appts: appointments.filter((a) => a.assigned === m.id),
      decision: row
        ? {
            kind: off ? ("off" as const) : ("job" as const),
            jobId: off ? null : (row.job_id ?? null),
            label: off ? null : row.job ? jobLabel(row.job) : "A job",
            reason: off ? (row.off_reason ?? null) : null,
          }
        : null,
      scheduledJobId: sched?.id ?? null,
      scheduledLabel: sched ? jobLabel(sched) : null,
    };
  });
  // Unassigned = nobody on the CURRENT roster is on it. Catches empty assignments AND ones left on a
  // former/inactive employee — those must still show here, never silently vanish from the board.
  const unassigned: Lane = {
    id: "__unassigned__",
    name: "Unassigned",
    jobs: jobs.filter((j) => !j.assigned.some((id) => memberIds.has(id))),
    appts: appointments.filter((a) => !a.assigned || !memberIds.has(a.assigned)),
    decision: null,
    scheduledJobId: null,
    scheduledLabel: null,
  };

  // THE FIRST PLACE IN THE APP THAT SAYS WHO IS AWAY. One line, and only when it has something to
  // say — a line that reads "Off today: nobody" every day is a line you stop seeing.
  const offToday = lanes
    .filter((l) => l.decision?.kind === "off")
    .map((l) => `${l.name}${l.decision?.reason ? ` (${l.decision.reason})` : ""}`);

  // Today's scheduled jobs float to the top of the picker as their own group: the overwhelmingly
  // common decision is "put him on one of the jobs already booked for today".
  const todayIds = new Set(jobRows.map((j) => j.id));
  const jobOptions: JobOption[] = ((activeJobRows ?? []) as { id: string; job_number: string | null; name: string | null }[])
    .map((j) => ({ id: j.id, label: jobLabel(j), today: todayIds.has(j.id) }));

  return (
    <CrewBoard
      day={day}
      dayLabel={prettyDay(day)}
      isToday={day === todayStrInTz(tz)}
      prevHref={`/schedule?view=crew&date=${shiftYmd(day, -1)}`}
      nextHref={`/schedule?view=crew&date=${shiftYmd(day, 1)}`}
      todayHref="/schedule?view=crew"
      lanes={lanes}
      unassigned={unassigned}
      canEdit={canEdit}
      jobOptions={jobOptions}
      offToday={offToday}
    />
  );
}
