/**
 * PLAN vs ACTUAL — what the plan said, against what the timecards recorded.
 *
 * WHAT THE PLAN IS, AND THE BUG THAT TAUGHT US (2026-09-18). This function used to take the plan
 * from ONE table, crew_day_assignments, and call any day with hours and no row "unplanned". ET
 * Electric has written 24 of those rows in the app's whole life and none since 2026-08-07, so
 * every single day anybody worked became a finding. Erik, looking at five of them in one card:
 * "we worked on the job that was in the schedule and the time cards say Jason Waldow. Is this box
 * accurate in any way that can help us?" Five findings, five false, and a warning that fires on
 * every ordinary day trains a man to ignore the one that matters.
 *
 * So the plan has TWO layers now, and the caller feeds both:
 *   crew_day_assignments   the OVERRIDE  — a human decision for one person on one day (0139/0170)
 *   the JOB SCHEDULE       the PLAN      — the calendar Erik actually keeps, per job
 *   time_entries           the HISTORY   — where the hours really landed
 *
 * A PlannedDay carries `source` so this file knows which one it is holding, because the two are
 * not equally strong and must not be read as if they were:
 *
 *   An ASSIGNMENT is a decision about a PERSON on a DAY. Contradicting it is worth saying out
 *   loud, and so is nobody turning up for it (no_show).
 *
 *   The SCHEDULE is a JOB'S RANGE. It runs Monday to Friday over a weekend, it is rostered by a
 *   jobs.assigned_to list nobody grooms, and it says nothing about who was expected to put hours
 *   on it on any particular day. So a schedule day with no hours on it is SILENCE, not a no_show
 *   — otherwise every Saturday inside a two-week job becomes a row somebody has to dismiss.
 *
 * AND ONE RULE ABOVE BOTH: a job the calendar had RUNNING that day is a planned place for
 * anybody's hours, whoever the roster names (`calendarJobsByDay`). Erik's sentence, in code. It
 * applies only where the plan is the schedule's (or absent) — an explicit assignment still beats
 * everything, which is THE PRECEDENCE LAW (0139) read in the other direction.
 *
 * WHAT IT IS NOT: a discipline tool. A mismatch is almost always the plan being stale, not somebody
 * lying — a crew gets pulled to a callback, a job finishes early. The value is that the OFFICE
 * finds out on Friday instead of at invoicing, when the hours are already on the wrong job and the
 * customer is already looking at the number.
 */

/** Which layer of the plan a day came from. Absent means "assignment" — the only kind that
 *  existed before the schedule fallback, so the older callers and tests still read true. */
export type PlanSource = "assignment" | "schedule";

export type PlannedDay = {
  profileId: string;
  workDate: string;
  /** null on an OFF day — deliberately not on a job. */
  jobId: string | null;
  kind: "job" | "off";
  /** Defaults to "assignment". Only an assignment can produce a no_show or survive the calendar. */
  source?: PlanSource;
};

export type ActualEntry = {
  profileId: string;
  workDate: string;
  jobId: string | null;
  hours: number;
};

export type DayComparison = {
  profileId: string;
  workDate: string;
  plannedJobId: string | null;
  plannedOff: boolean;
  /** Where plannedJobId came from, or null when nothing planned that day at all. */
  planSource: PlanSource | null;
  actualJobIds: string[];
  hours: number;
  /**
   * matched      — the hours went where the plan put them, or onto a job the calendar had
   *                running that day. Not a finding.
   * moved        — worked, but on a job neither the plan nor (for a schedule plan) the calendar
   *                had for that day
   * unplanned    — worked, and nothing anywhere had that job on that day. Rare now, and the one
   *                thing it says is that the calendar is missing a day of real work.
   * worked_off   — worked on a day marked OFF (vacation/sick) — worth a look either way
   * no_show      — ASSIGNED to a job, no hours recorded. Schedule days never reach here: a range
   *                over a weekend is not a promise anyone made.
   * off          — planned off, no hours. Exactly right; not a finding.
   * idle         — nothing to say: no hours, and nothing stronger than a job range covering the
   *                day. A blank is never a finding.
   */
  status: "matched" | "moved" | "unplanned" | "worked_off" | "no_show" | "off" | "idle";
};

const key = (p: string, d: string) => `${p}|${d}`;

export function comparePlanToActual(
  planned: PlannedDay[],
  actual: ActualEntry[],
  /** Day string → the job ids the calendar had running that day, for ANYONE. The roster
   *  (jobs.assigned_to) is a coarse list nobody grooms; the calendar's day is the fact. */
  calendarJobsByDay?: ReadonlyMap<string, ReadonlySet<string>>,
): DayComparison[] {
  /* THE PRECEDENCE LAW (0139), and it lives HERE rather than in whichever feeder happens to be
   * calling: when both layers speak for the same person on the same day, the ASSIGNMENT wins,
   * whatever order the two arrive in. A Map built straight from the list would have let the last
   * row through, which is a silent dependence on array order for the one rule the punch itself
   * obeys. Same source twice? The later row wins, as it always did. */
  const rank = (p: PlannedDay) => ((p.source ?? "assignment") === "assignment" ? 1 : 0);
  const plan = new Map<string, PlannedDay>();
  for (const p of planned) {
    const k = key(p.profileId, p.workDate);
    const cur = plan.get(k);
    if (!cur || rank(p) >= rank(cur)) plan.set(k, p);
  }

  // Roll the day's entries up per person — a split shift across two jobs is ONE day with two jobs
  // on it, not two half-days, and treating it as two would manufacture a false "moved".
  const byDay = new Map<string, { jobs: Set<string>; hours: number; profileId: string; workDate: string }>();
  for (const e of actual) {
    const k = key(e.profileId, e.workDate);
    const cur = byDay.get(k) ?? { jobs: new Set<string>(), hours: 0, profileId: e.profileId, workDate: e.workDate };
    if (e.jobId) cur.jobs.add(e.jobId);
    cur.hours += Number(e.hours) || 0;
    byDay.set(k, cur);
  }

  /** Did the day's hours land on a job the calendar was running? An empty day (hours on no job at
   *  all) is never on the calendar — there is nothing to be on it. */
  const onCalendar = (workDate: string, jobIds: string[]): boolean => {
    const running = calendarJobsByDay?.get(workDate);
    return !!running && jobIds.some((id) => running.has(id));
  };

  const out: DayComparison[] = [];
  for (const k of new Set([...plan.keys(), ...byDay.keys()])) {
    const p = plan.get(k) ?? null;
    const a = byDay.get(k) ?? null;
    const [profileId, workDate] = k.split("|");
    const actualJobIds = a ? [...a.jobs] : [];
    const hours = a?.hours ?? 0;
    const plannedOff = p?.kind === "off";
    const plannedJobId = p?.kind === "job" ? p.jobId : null;
    const planSource: PlanSource | null = p ? (p.source ?? "assignment") : null;
    const decided = planSource === "assignment"; // a human said this, about this person, on this day

    let status: DayComparison["status"];
    if (hours <= 0) {
      // No hours. Only a finding if somebody was actually PUT on a job that day — a job range
      // covering the day is not a promise, so it stays silent.
      status = plannedOff ? "off" : plannedJobId && decided ? "no_show" : "idle";
    } else if (plannedOff) {
      status = "worked_off";
    } else if (plannedJobId && actualJobIds.includes(plannedJobId)) {
      // Worked the planned job at ANY point in the day counts as matched — a crew that starts on
      // the planned job and gets pulled to a callback did not fail the plan.
      status = "matched";
    } else if (!decided && onCalendar(workDate, actualJobIds)) {
      // The job was on the calendar that day. Whether the roster named this person for it or not,
      // these hours are on work that was genuinely scheduled, and that is not a warning.
      status = "matched";
    } else if (!plannedJobId) {
      status = "unplanned";
    } else {
      status = "moved";
    }

    out.push({ profileId, workDate, plannedJobId, plannedOff, planSource, actualJobIds, hours, status });
  }
  return out.sort((x, y) => x.workDate.localeCompare(y.workDate) || x.profileId.localeCompare(y.profileId));
}

/** Only the rows worth a human's attention — the rest is the plan working. */
export function needsAttention(rows: DayComparison[]): DayComparison[] {
  return rows.filter((r) => r.status === "moved" || r.status === "unplanned" || r.status === "worked_off" || r.status === "no_show");
}

/** One line a contractor would actually say, per status.
 *
 *  THESE ARE NOT ACCUSATIONS. Every one of them is far more likely to mean the calendar is stale
 *  than that anybody did anything wrong, so each says what the records hold and stops there. */
export function explain(r: DayComparison, jobName: (id: string) => string, who: string): string {
  const worked = r.actualJobIds.map(jobName).join(", ");
  switch (r.status) {
    case "moved": {
      // THE SAME EMPTY-JOB SHAPE AS "unplanned" BELOW. The rollup only collects a job id when the
      // entry carries one, so a day of hours with no job on them leaves `worked` an empty string
      // and this sentence used to trail off into nothing: "the hours went to ." Name what is
      // actually true instead, which is a different and more useful thing to tell somebody: the
      // plan said a job and the hours were logged against none.
      const planned = jobName(r.plannedJobId!);
      if (r.actualJobIds.length === 0) {
        return r.planSource === "schedule"
          ? `The schedule has ${who} on ${planned} that day, but the hours have no job on them.`
          : `${who} was put on ${planned} but the hours have no job on them.`;
      }
      return r.planSource === "schedule"
        ? `The schedule has ${who} on ${planned} that day, but the hours went to ${worked}.`
        : `${who} was put on ${planned} but the hours went to ${worked}.`;
    }
    case "unplanned":
      // Hours with no job on them at all are their own thing: nothing to name, and nothing for
      // the calendar to have been missing. Say the actual shape of it.
      return r.actualJobIds.length === 0
        ? `${who} worked ${r.hours.toFixed(1)}h with no job on the hours.`
        : `${who} worked ${r.hours.toFixed(1)}h on ${worked}, which was not on the calendar for that day.`;
    case "worked_off":
      return `${who} was marked off but recorded ${r.hours.toFixed(1)}h.`;
    case "no_show":
      return `${who} was put on ${jobName(r.plannedJobId!)} for that day. No hours recorded.`;
    default:
      return "";
  }
}
