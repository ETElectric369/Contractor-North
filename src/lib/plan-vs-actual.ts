/**
 * PLAN vs ACTUAL — what the calendar said, against what the timecards recorded.
 *
 * This is the payoff of making the calendar the single source of truth, and it is why the ghost
 * pill had to go first: you cannot diff the plan against reality while half the plan was never
 * written down. A guess that vanishes on refresh is not something you can be wrong about.
 *
 * Three stores, three different questions — and this function is where two of them finally meet:
 *   crew_day_assignments  the PLAN    — who was meant to be where
 *   time_entries          the HISTORY — where the hours actually landed
 *
 * WHAT IT IS NOT: a discipline tool. A mismatch is almost always the plan being stale, not somebody
 * lying — a crew gets pulled to a callback, a job finishes early. The value is that the OFFICE
 * finds out on Friday instead of at invoicing, when the hours are already on the wrong job and the
 * customer is already looking at the number.
 */

export type PlannedDay = {
  profileId: string;
  workDate: string;
  /** null on an OFF day — deliberately not on a job. */
  jobId: string | null;
  kind: "job" | "off";
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
  actualJobIds: string[];
  hours: number;
  /**
   * matched      — worked the job that was planned
   * moved        — worked, but on a different job than planned
   * unplanned    — worked with nothing planned for the day
   * worked_off   — worked on a day marked OFF (vacation/sick) — worth a look either way
   * no_show      — planned onto a job, no hours recorded
   * off          — planned off, no hours. Exactly right; not a finding.
   * idle         — nothing planned, nothing worked. Not a finding either.
   */
  status: "matched" | "moved" | "unplanned" | "worked_off" | "no_show" | "off" | "idle";
};

const key = (p: string, d: string) => `${p}|${d}`;

export function comparePlanToActual(planned: PlannedDay[], actual: ActualEntry[]): DayComparison[] {
  const plan = new Map(planned.map((p) => [key(p.profileId, p.workDate), p]));

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

  const out: DayComparison[] = [];
  for (const k of new Set([...plan.keys(), ...byDay.keys()])) {
    const p = plan.get(k) ?? null;
    const a = byDay.get(k) ?? null;
    const [profileId, workDate] = k.split("|");
    const actualJobIds = a ? [...a.jobs] : [];
    const hours = a?.hours ?? 0;
    const plannedOff = p?.kind === "off";
    const plannedJobId = p?.kind === "job" ? p.jobId : null;

    let status: DayComparison["status"];
    if (hours <= 0) {
      // No hours. Only a finding if somebody was expected on a job.
      status = plannedOff ? "off" : plannedJobId ? "no_show" : "idle";
    } else if (plannedOff) {
      status = "worked_off";
    } else if (!plannedJobId) {
      status = "unplanned";
    } else {
      // Worked the planned job at ANY point in the day counts as matched — a crew that starts on
      // the planned job and gets pulled to a callback did not fail the plan.
      status = actualJobIds.includes(plannedJobId) ? "matched" : "moved";
    }

    out.push({ profileId, workDate, plannedJobId, plannedOff, actualJobIds, hours, status });
  }
  return out.sort((x, y) => x.workDate.localeCompare(y.workDate) || x.profileId.localeCompare(y.profileId));
}

/** Only the rows worth a human's attention — the rest is the plan working. */
export function needsAttention(rows: DayComparison[]): DayComparison[] {
  return rows.filter((r) => r.status === "moved" || r.status === "unplanned" || r.status === "worked_off" || r.status === "no_show");
}

/** One line a contractor would actually say, per status. */
export function explain(r: DayComparison, jobName: (id: string) => string, who: string): string {
  switch (r.status) {
    case "moved":
      return `${who} was planned on ${jobName(r.plannedJobId!)} but the hours went to ${r.actualJobIds.map(jobName).join(", ")}.`;
    case "unplanned":
      return `${who} worked ${r.hours.toFixed(1)}h on ${r.actualJobIds.map(jobName).join(", ")} with nothing planned.`;
    case "worked_off":
      return `${who} was marked off but recorded ${r.hours.toFixed(1)}h.`;
    case "no_show":
      return `${who} was planned on ${jobName(r.plannedJobId!)} — no hours recorded.`;
    default:
      return "";
  }
}
