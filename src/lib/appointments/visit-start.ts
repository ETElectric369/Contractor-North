/**
 * THE VISIT THAT TURNS INTO WORK. Erik, 2026-09-25, on Tom Goodman's inspection: "when I showed up, I
 * didn't need the inspector or the estimator. I just needed a job linked to that lead to start the
 * clock, simple."
 *
 * The appointment page led with the Inspector, and the only door that made a job out of the visit
 * was buried in Edit Details. So he made J-055 by hand on the Jobs page, and backdated his clock to
 * noon on it, and the visit was left pointing at nothing.
 *
 * This file holds the rules the appointment page's top card and its server actions share, so the
 * card never offers what the action would refuse:
 *
 *   - which job the visit could be linked to INSTEAD of making a new one (linkInsteadPick): the same
 *     customer's one open job made on the visit's own day. Exactly one or nothing; the app suggests,
 *     a person taps, and nothing links itself;
 *   - when a clock-in may start (startedAtProblem): never in the future, never before midnight
 *     yesterday on the ORG's clock (older hours are a Timecards entry, not a clock-in);
 *   - the words said afterwards (startedWords), in the org's time zone.
 *
 * Pure: no database, no React.
 */
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";

export type LinkInsteadJob = {
  id: string;
  job_number: string | null;
  name: string | null;
  status: string | null;
  created_at: string | null;
};

/** The org-local day the visit belongs to: its scheduled day, or today when it has no date. */
export function visitDay(startsAt: string | null | undefined, tz: string, nowMs: number = Date.now()): string {
  const d = startsAt ? new Date(startsAt) : null;
  return todayStrInTz(tz, d && !isNaN(d.getTime()) ? d : new Date(nowMs));
}

/**
 * The one job to offer as "Link To J-055 Instead", or null.
 *
 * `jobs` are the SAME customer's jobs (the caller filters by customer and org). Offered only when
 * exactly one of them is still open AND was made on the visit's own org-local day: that is the
 * Tom Goodman case (a job made by hand the afternoon of the visit). Two candidates is a question the
 * app cannot answer, so it offers neither; Edit Details still links any job by hand.
 */
export function linkInsteadPick(jobs: LinkInsteadJob[], day: string, tz: string): LinkInsteadJob | null {
  const open = new Set<string>(ACTIVE_JOB_STATUSES);
  const hits = jobs.filter((j) => {
    if (!j.status || !open.has(j.status)) return false;
    if (!j.created_at) return false;
    const made = new Date(j.created_at);
    if (isNaN(made.getTime())) return false;
    return todayStrInTz(tz, made) === day;
  });
  return hits.length === 1 ? hits[0] : null;
}

/** Midnight at the start of yesterday, on the org's clock, as epoch ms. */
export function startFloorMs(nowMs: number, tz: string): number {
  const today = todayStrInTz(tz, new Date(nowMs));
  const y = new Date(`${today}T12:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  return tzDayStartUtc(y.toISOString().slice(0, 10), tz).getTime();
}

/**
 * What is wrong with this start time, as the sentence to show, or null when it is a real start.
 * The same window on the sheet and on the server.
 */
export function startedAtProblem(iso: string | null | undefined, nowMs: number, tz: string): string | null {
  if (iso == null) return null; // "now"
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "Pick a start time.";
  if (ms > nowMs + 60_000) return "That time hasn't happened yet.";
  if (ms < startFloorMs(nowMs, tz)) {
    return "Pick a time since midnight yesterday. For older hours, add them on Timecards.";
  }
  return null;
}

/** "12:00 PM", on the org's clock. ICU's narrow no-break space is made a plain space. */
export function clockWords(iso: string, tz: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(/\s/g, " ");
}

/** "J-055", or the job's name when it has no number yet. */
export function jobShort(j: { job_number?: string | null; name?: string | null } | null | undefined): string {
  const num = (j?.job_number ?? "").trim();
  const name = (j?.name ?? "").trim();
  return num || name || "the job";
}

/**
 * What happened to the tapper's clock:
 *   in      a fresh clock-in at `at`;
 *   switch  the running entry was CUT at `at` and a new one opened on the job (0288's cut);
 *   move    the running entry had no job (or had just opened), so switch_job RE-POINTED it whole:
 *           the shift since `since` now sits on the job. Nothing was cut.
 */
export type StartedClock =
  | { kind: "in"; at: string }
  | { kind: "switch"; at: string; from: string | null }
  | { kind: "move"; since: string };

/**
 * What the app says after the tap, in one sentence:
 *   "Started J-056 for Tom Goodman and clocked you in at 12:00 PM."
 *   "Started J-056 for Tom Goodman and switched your clock here from J-050 at 3:32 PM."
 *   "Started J-056 for Tom Goodman and moved your shift since 12:00 PM onto it."
 *   "Started J-056 for Tom Goodman."
 */
export function startedWords(input: {
  jobNumber: string;
  customer: string | null;
  tz: string;
  clock?: StartedClock | null;
  /** The visit already had a job (someone else started it a moment ago): say so, never "Started". */
  existing?: boolean;
}): string {
  const who = input.customer?.trim() ? ` for ${input.customer.trim()}` : "";
  const c = input.clock;
  const at = c ? clockWords(c.kind === "move" ? c.since : c.at, input.tz) : "";
  if (input.existing) {
    // Somebody started it a moment ago: the job is theirs, the clock is this tap's.
    const head = `This visit already had ${input.jobNumber}${who}.`;
    if (!c) return head;
    if (c.kind === "in") return `${head} Clocked you in on it at ${at}.`;
    if (c.kind === "move") return `${head} Moved your shift since ${at} onto it.`;
    return `${head} Switched your clock to it${c.from ? ` from ${c.from}` : ""} at ${at}.`;
  }
  const head = `Started ${input.jobNumber}${who}`;
  if (!c) return `${head}.`;
  if (c.kind === "in") return `${head} and clocked you in at ${at}.`;
  if (c.kind === "move") return `${head} and moved your shift since ${at} onto it.`;
  return `${head} and switched your clock here${c.from ? ` from ${c.from}` : ""} at ${at}.`;
}
