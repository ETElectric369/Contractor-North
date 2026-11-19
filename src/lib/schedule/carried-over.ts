/**
 * CARRIED OVER: a job booked for a day that came and went with nobody on it (cn-v1169).
 *
 * The owner, 2026-11-18. Three jobs were booked for Tuesday the 17th and nobody clocked in on
 * anything that day. On Wednesday My Day listed only the job booked for Wednesday, because My Day
 * lists a job on the days it is booked for and on no other; the crew went and did one of Tuesday's.
 * The clock's one-tap punch put the hours on the job that was on the schedule, and the sheet that
 * asks "Which Job Are You On?" did not offer the job they were standing on: it offers today's
 * schedule and the jobs already in progress, and a job that is only Scheduled for a day gone by is
 * neither. His go the next morning, to the fix as it was put to him ("a job he is on that was booked
 * for an earlier day and never worked stays on My Day under today's list with a Do Today door and is
 * offered at clock-in"): "check it and go for both", and again: "yes to slipped jobs".
 *
 * ONE RULE, TWO READERS (My Day's Today card, and the clock's sheet): a job is carried over for a
 * person when
 *   · it is still being done (to be scheduled, scheduled or in progress; never on hold, which waits
 *     with its own day) and is not waiting on somebody else (lib/waiting-on);
 *   · the person is on its crew (jobs.assigned_to). My Day's Today lists the whole company's day;
 *     this group is the reader's own, because it is a thing left for HIM to do;
 *   · nothing is ahead of it: no day of its own today or later, and no visit on the calendar for it
 *     today or later (booked or still waiting on the customer's pick; a visit that began earlier and
 *     runs into today counts). A job with a day today is in today's list; one with a day ahead is
 *     not lost;
 *   · its last booked day was no more than CARRY_DAYS days ago. Older than that it is not a day that
 *     slipped but a job nobody is planning, and Needs You's "Needs a Day" row is where that lives;
 *   · nobody worked it on or after that day and before today. Worked since, the crew has been on it
 *     and it is a job with nothing next ("Worked Nov 18"), which is Needs You's question too.
 * WORK TODAY DOES NOT TAKE IT OFF: a person who clocks out of it for lunch must find it again that
 * afternoon. It leaves the group when it gets a day (Do Today moves its day here), tomorrow because
 * it was worked today, or when it is finished.
 *
 * WHICH DAYS A JOB IS BOOKED FOR is the calendar's own rule and is not written again here
 * (lib/schedule/booked-days bookedKeys: its day rows when it has any, else its listed span). A
 * visit on the job is not one of the job's own days: it is read only as something ahead, and WHICH
 * DAYS A VISIT SITS ON is that same function's answer too (every day from its start to its end; a
 * call is not a day on site), so "ahead" here is what the calendar draws and nothing else.
 *
 * WHAT "WORKED" CAN SEE: the time entries the reader's own session can read, and the job's finished
 * visits (lib/schedule-math workedDaysFrom, the rule the schedule's move uses). The office reads
 * everyone's hours. A tech reads only his own, so for a tech "nobody worked it" means "I did not":
 * a job a crewmate covered that day can still be offered to him, which is the safe side (it is
 * offered, never picked for him, and the row says only the day it was booked for).
 *
 * The rule is pure and dated by argument. The loader below reads on the CALLER's client (RLS), asks
 * for no money column, and never throws: a read that fails comes back as `error` with no rows, for
 * the caller to file. A group that could not be read is left out; it never sinks the page or the
 * sheet it is a part of.
 */
import { NEEDS_A_DAY_STATUSES } from "@/lib/action-items/jobs-needing-a-day";
import { bookedKeys } from "@/lib/schedule/booked-days";
import { workedDaysFrom } from "@/lib/schedule-math";
import { isSchedulable } from "@/lib/waiting-on";

/** How many days back a missed day is still "carried over". My default; the owner's to change. */
export const CARRY_DAYS = 7;

/** What the rule reads of a job. Anything else on the row rides through untouched. */
export type CarryJob = {
  id: string;
  status?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  assigned_to?: readonly string[] | null;
  blocked_on?: string | null;
  blocked_since?: string | null;
  job_schedule_segments?: readonly { start_date?: string | null; end_date?: string | null }[] | null;
};

/** A carried-over job and the last day it was booked for (yyyy-mm-dd, the company's day). */
export type CarriedOver<J extends CarryJob = CarryJob> = { job: J; bookedDay: string };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/** The reader's carried-over jobs, the most recently missed day first. */
export function carriedOverJobs<J extends CarryJob>(input: {
  jobs: readonly J[] | null | undefined;
  /** The person reading: only jobs he is on the crew of. */
  readerId: string | null | undefined;
  /** Today, the company's day. */
  todayStr: string;
  /** The company's timezone: a listed span is read as the company's days. */
  tz: string;
  /** Job id → the company days it was worked, as far as the reader can see. */
  workedDays?: ReadonlyMap<string, readonly string[]>;
  /** Jobs with a visit booked today or later. */
  aheadVisitJobIds?: ReadonlySet<string>;
  carryDays?: number;
}): CarriedOver<J>[] {
  const { readerId, todayStr, tz } = input;
  if (!readerId || !YMD.test(todayStr)) return [];
  const carryDays = Math.max(1, Math.floor(input.carryDays ?? CARRY_DAYS));
  const mine = (input.jobs ?? []).filter(
    (j) =>
      !!j?.id &&
      NEEDS_A_DAY_STATUSES.includes(String(j.status ?? "")) &&
      isSchedulable(j) &&
      (j.assigned_to ?? []).includes(readerId) &&
      !input.aheadVisitJobIds?.has(j.id),
  );
  if (!mine.length) return [];

  // The job's own days, by the calendar's rule (no visits: see the header).
  const days = new Map<string, string[]>();
  const keys = bookedKeys({
    segments: mine.flatMap((j) =>
      (j.job_schedule_segments ?? []).map((s) => ({ job_id: j.id, start_date: String(s?.start_date ?? ""), end_date: String(s?.end_date ?? "") })),
    ),
    jobs: mine.map((j) => ({ id: j.id, scheduled_start: j.scheduled_start ?? null, scheduled_end: j.scheduled_end ?? null })),
    appointments: [],
    tz,
  });
  for (const k of keys) {
    const cut = k.lastIndexOf("|");
    const id = k.slice(0, cut);
    const list = days.get(id) ?? [];
    list.push(k.slice(cut + 1));
    days.set(id, list);
  }

  const out: CarriedOver<J>[] = [];
  for (const j of mine) {
    const booked = (days.get(j.id) ?? []).filter((d) => YMD.test(d)).sort();
    const last = booked.at(-1);
    if (!last) continue; // never had a day: not a day that slipped
    if (last >= todayStr) continue; // a day today or ahead
    if (daysBetween(last, todayStr) > carryDays) continue; // long gone: a job nobody is planning
    const worked = input.workedDays?.get(j.id) ?? [];
    if (worked.some((d) => d >= last && d < todayStr)) continue; // the crew has been on it since
    out.push({ job: j, bookedDay: last });
  }
  return out.sort(
    (a, b) =>
      b.bookedDay.localeCompare(a.bookedDay) ||
      String(a.job.scheduled_start ?? "").localeCompare(String(b.job.scheduled_start ?? "")) ||
      a.job.id.localeCompare(b.job.id),
  );
}

/** The columns the loader reads of a job when the caller names none: labels, the schedule, the crew
 *  and the wait. No money. */
export const CARRIED_OVER_JOB_COLUMNS =
  "id, job_number, name, status, address, city, scheduled_start, scheduled_end, planned_minutes, assigned_to, created_at, blocked_on, blocked_since, customers(name, phone)";

/** What the loader reads of a job's visits: when, how long, what state, what kind. No notes, no money. */
export const CARRIED_OVER_VISIT_COLUMNS = "job_id, starts_at, ends_at, status, absorbed, type";

/** A visit as the loader reads it. */
export type CarryVisit = {
  job_id: string | null;
  starts_at: string | null;
  ends_at?: string | null;
  status: string | null;
  absorbed?: boolean | null;
  type?: string | null;
};

/**
 * THE JOBS WITH A VISIT STILL AHEAD: on the calendar today or later (skeptic #72). A visit counts
 * while it is booked or still waiting on the customer's pick (0052's `scheduled` and `proposed`: a
 * pending visit is drawn on the calendar, and a job with one on Friday has not been forgotten). One
 * that is over, called off, or taken up by its job's own day (absorbed) is ahead of nothing, and so
 * is any state this rule has not been taught: a job is offered when in doubt, never hidden. The
 * days are the calendar's own (bookedKeys): a visit that began yesterday and ends today is on
 * today, and a call is on no day.
 */
export function aheadVisitJobIds(visits: readonly CarryVisit[] | null | undefined, todayStr: string, tz: string): Set<string> {
  const live = (visits ?? []).filter((v) => !!v?.job_id && !!v.starts_at && !v.absorbed && (v.status === "scheduled" || v.status === "proposed"));
  const out = new Set<string>();
  const keys = bookedKeys({
    segments: [],
    jobs: [],
    appointments: live.map((v) => ({ job_id: v.job_id as string, starts_at: v.starts_at as string, ends_at: v.ends_at ?? null, type: v.type ?? null })),
    tz,
  });
  for (const k of keys) {
    const cut = k.lastIndexOf("|");
    if (k.slice(cut + 1) >= todayStr) out.add(k.slice(0, cut));
  }
  return out;
}

/**
 * ONE ROW PER JOB ON MY DAY (skeptic #72). A carried-over job is also a job with nothing ahead of
 * it, so Needs You lists it too ("Dated Nov 17, never worked", with its own Pick a Day), and My Day
 * would draw the one job twice with two doors to the same thing. The Carried Over row is the one
 * that stays: it sits under the day, and its door is one tap. The Needs You row is left off My
 * Day's board ONLY when it says nothing more than that. A row that also carries the job's lines
 * still to buy stays: that phrase rides this row and no other (lib/action-items/query: "one job,
 * one row"), so dropping the row would drop the fact.
 *
 * It is applied to the list My Day draws and to nothing else. The read behind the shell's badge is
 * not touched, so the badge still counts the job: it is open, and it is on the page the badge opens.
 */
export const NEEDS_A_DAY_KIND = "job_to_schedule";
export const TO_BUY_PHRASE = "ny_w_nToBuy";
export function needsYouWithoutCarried<I extends { id: string; kind: string; what?: { vars?: Record<string, unknown> | null } | null }>(
  items: readonly I[] | null | undefined,
  carriedJobIds: ReadonlySet<string>,
): I[] {
  const list = [...(items ?? [])];
  if (!carriedJobIds.size) return list;
  return list.filter((i) => !(i.kind === NEEDS_A_DAY_KIND && carriedJobIds.has(i.id) && i.what?.vars?.andKey !== TO_BUY_PHRASE));
}

/** What the loader needs of a client: the caller's own (RLS) Supabase client. */
type Reader = { from: (table: string) => any };

/**
 * READ THE CALLER'S CARRIED-OVER JOBS. Three small reads at most, and for nearly everyone on nearly
 * every day only the first: the jobs he is on whose schedule began before today and reached into the
 * last CARRY_DAYS days. Only when one of those passes the rule on its days alone are its hours and
 * its visits read, for those jobs and that window (a visit that BEGAN before the window and is still
 * running is not read: a visit longer than a week is not a thing this product books).
 *
 * `columns` must hold what the rule reads (id, status, scheduled_start, scheduled_end, assigned_to,
 * blocked_on); the day rows are added here.
 */
export async function loadCarriedOver<J extends CarryJob = CarryJob>(
  supabase: Reader,
  p: {
    userId: string | null | undefined;
    todayStr: string;
    tz: string;
    /** The first instant of today, the company's day (lib/tz todayBoundsInTz). */
    dayStartIso: string;
    columns?: string;
    carryDays?: number;
  },
): Promise<{ rows: CarriedOver<J>[]; error: string | null }> {
  const none = { rows: [] as CarriedOver<J>[], error: null as string | null };
  if (!p.userId) return none;
  const carryDays = Math.max(1, Math.floor(p.carryDays ?? CARRY_DAYS));
  const dayStartMs = Date.parse(p.dayStartIso);
  if (!Number.isFinite(dayStartMs)) return none;
  // A day of slack on the far side (a clock change, a job read by its end): the rule does the day math.
  const sinceIso = new Date(dayStartMs - (carryDays + 1) * 86_400_000).toISOString();
  try {
    const jobsR = await supabase
      .from("jobs")
      .select(`${p.columns ?? CARRIED_OVER_JOB_COLUMNS}, job_schedule_segments(start_date, end_date)`)
      .contains("assigned_to", [p.userId])
      .in("status", [...NEEDS_A_DAY_STATUSES])
      .lt("scheduled_start", p.dayStartIso)
      .or(`scheduled_end.gte.${sinceIso},scheduled_start.gte.${sinceIso}`);
    if (jobsR.error) return { rows: [], error: String(jobsR.error.message ?? jobsR.error) };
    const jobs = (Array.isArray(jobsR.data) ? jobsR.data : []) as J[];
    const rule = { jobs, readerId: p.userId, todayStr: p.todayStr, tz: p.tz, carryDays };
    const maybe = carriedOverJobs(rule);
    if (!maybe.length) return none;

    const ids = maybe.map((c) => c.job.id);
    const [entriesR, visitsR] = await Promise.all([
      supabase.from("time_entries").select("job_id, clock_in").in("job_id", ids).gte("clock_in", sinceIso).lt("clock_in", p.dayStartIso),
      supabase.from("appointments").select(CARRIED_OVER_VISIT_COLUMNS).in("job_id", ids).gte("starts_at", sinceIso),
    ]);
    if (entriesR.error) return { rows: [], error: String(entriesR.error.message ?? entriesR.error) };
    if (visitsR.error) return { rows: [], error: String(visitsR.error.message ?? visitsR.error) };
    const entries = (Array.isArray(entriesR.data) ? entriesR.data : []) as { job_id: string | null; clock_in: string | null }[];
    const visits = (Array.isArray(visitsR.data) ? visitsR.data : []) as CarryVisit[];

    const workedDays = new Map<string, string[]>();
    for (const id of ids) {
      workedDays.set(
        id,
        workedDaysFrom(
          entries.filter((e) => e.job_id === id),
          visits.filter((v) => v.job_id === id),
          p.tz,
        ),
      );
    }
    return { rows: carriedOverJobs({ ...rule, workedDays, aheadVisitJobIds: aheadVisitJobIds(visits, p.todayStr, p.tz) }), error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}
