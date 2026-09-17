import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { todayStrInTz } from "@/lib/tz";
import { jobLabel } from "@/lib/schedule-options";
import { Card, CardContent } from "@/components/ui/card";
import { pickScheduledJobForDay } from "./crew-plan";

/**
 * "NEXT UP" — the second question a tech brings to this app.
 *
 * A man on the clock only ever asks two things here: am I clocked in, and what am I on next. The
 * clock answered the first one from day one. The second one had no answer anywhere in the app for
 * anybody but the office: Brian wanting to know where he is tomorrow had to phone Erik, and Erik
 * is usually up a ladder. So the answer goes on the page where the question is actually asked,
 * directly under the button he is already pressing, and it is two rows: today and tomorrow.
 *
 * IT SAYS WHICH ANSWER IT IS USING, because a DECISION and a DEFAULT are different things:
 *
 *   1. THE DECISION — this person's crew_day_assignments row for that org-local day. kind='job'
 *      names the job; kind='off' says they are deliberately away (0170). Somebody in the office
 *      sat down and decided this, and it beats everything below it. That is migration 0139's
 *      PRECEDENCE LAW, and it is the same order timeclock/actions.ts (resolveTechJobToday) walks
 *      when a job-less punch has to resolve itself — including the "still in flight" check below,
 *      so the row a man reads at 6am and the job his punch lands on cannot disagree.
 *   2. THE JOB SCHEDULE — no decision yet, so: of the jobs this person is ASSIGNED to, the one the
 *      schedule puts on that day (a job_schedule_segments range covering it; or, when those rows
 *      are not readable — which is every tech, see the mirror note at rangesByJob below — the
 *      job's own scheduled_start→scheduled_end window). This is real, somebody scheduled it, but
 *      nobody has put HIM on it for that day — so the row says so out loud rather than dressing a
 *      default up as a plan.
 *   3. NOTHING. Said plainly. A blank where the answer lives is itself an answer.
 *
 * AND IT STOPS THERE. No "newest active job", no in-progress fallback, no dashed suggestion pill.
 * cn-v590 deleted exactly that on Erik's own instruction: "i dont think we should suggest crew
 * assignments, theres too much complication going on here and its confusing with the pills and
 * suggestions." A job somebody actually scheduled is a fact; anything past that is a guess, and a
 * guess does not belong on the page a man reads while he is deciding when to leave the house.
 * (The punch has one more tier than this — the org's single in_progress job, timeclock/actions.ts
 * tier 2 — on purpose: that is a convenience for a button being pressed right now, not a plan
 * anyone made, so it is not drawn here as one.)
 *
 * WHOSE DAY: yours. Always, staff included. Every read below is keyed to the caller, this is not a
 * staff surface, and it must never show another person's day — the office's all-crew view is
 * Everyone's Day on /schedule, which the staff door row on this page already opens.
 *
 * WHY IT ALWAYS RENDERS, even when both days are blank. The crew board's "Off today" line hides
 * when it has nothing to say, because that is an EXCEPTION report about other people, and a line
 * that reads "nobody" every day is a line you stop seeing. This is the opposite: it is the answer
 * to a standing question you are asking on purpose, in the same place every morning. A card that
 * vanished on the quiet days would just mean re-asking the office whether the app knows.
 */

/** Tomorrow's org-local day string. UTC-noon arithmetic on the day STRING (the house pattern —
 *  weekDayStrs, prettyDay, crew-board-panel's own day paging) so no DST edge can shift it. */
function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

type Answer =
  | { kind: "job"; source: "assigned" | "schedule"; jobId: string; label: string }
  | { kind: "off"; reason: string | null }
  | { kind: "none" };

type DayRow = { when: string; answer: Answer };

type AssignRow = {
  work_date: string;
  kind: string | null;
  off_reason: string | null;
  job_id: string | null;
  job: { id: string; job_number: string | null; name: string | null; status: string } | null;
};

type MyJob = {
  id: string;
  job_number: string | null;
  name: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
};

export async function NextUp({ userId, tz }: { userId: string; tz: string }) {
  const supabase = await createClient();
  const today = todayStrInTz(tz);
  const tomorrow = nextDay(today);

  const [{ data: assignRows, error: assignErr }, { data: jobRows }] = await Promise.all([
    // THE DECISION, both days in one read. The join carries `status` because the decision is only
    // honored while the job is still in flight — exactly the check resolveTechJobToday makes
    // before it lets a day-assignment win (it re-reads the job `.in("status", ACTIVE_JOB_STATUSES)`).
    // Without status in this select the row would happily send a man to a job that closed last
    // week while his punch quietly fell through to the schedule. PROJECTION: the missing field is
    // always a select list.
    supabase
      .from("crew_day_assignments")
      .select("work_date, kind, off_reason, job_id, job:job_id(id, job_number, name, status)")
      .eq("profile_id", userId)
      .in("work_date", [today, tomorrow]),
    // THE SCHEDULE'S CANDIDATES: the jobs this person is on the roster for. `scheduled_start` rides
    // along because pickScheduledJobForDay sorts on it (earliest start wins the day), and
    // `scheduled_end` because the two of them ARE the job's window whenever the segment rows can't
    // speak for themselves (see the mirror fallback below). PROJECTION: a missing field is always
    // a select list, and leaving scheduled_end out of this one is what made a three-day job answer
    // on one day and go silent on the other two.
    supabase
      .from("jobs")
      .select("id, job_number, name, scheduled_start, scheduled_end")
      .contains("assigned_to", [userId])
      .in("status", ACTIVE_JOB_STATUSES as unknown as string[]),
  ]);

  const myJobs = (jobRows ?? []) as MyJob[];

  // Every segment of those jobs THE CALLER CAN SEE, not just the two days' worth:
  // pickScheduledJobForDay wants the RANGES and decides the day itself, and one read serves both
  // rows (the crew-board-panel call site builds segsByJob the same way). For a tech this comes
  // back empty by policy, not by fact — that is the whole subject of the block below.
  let segs: { job_id: string; start_date: string; end_date: string }[] = [];
  if (myJobs.length) {
    const { data: segRows } = await supabase
      .from("job_schedule_segments")
      .select("job_id, start_date, end_date")
      .in("job_id", myJobs.map((j) => j.id));
    segs = (segRows ?? []) as typeof segs;
  }
  const segsByJob = new Map<string, { start: string; end: string }[]>();
  for (const s of segs) {
    if (!s.job_id) continue;
    const list = segsByJob.get(s.job_id) ?? [];
    list.push({ start: s.start_date, end: s.end_date });
    segsByJob.set(s.job_id, list);
  }

  /**
   * THE DAYS EACH JOB RUNS. Segments-first, and the scheduled_start→scheduled_end MIRROR when
   * segments have nothing to say about that job.
   *
   * SEGMENTS-FIRST (the calendar's law, mirrored by crew-board-panel): a job that HAS visible
   * segments is scheduled only on the days a segment covers, because its mirror is stretched
   * min-start→max-end and a Mon+Fri job would otherwise claim Wednesday too.
   *
   * WHY THE MIRROR HAS TO BACK IT UP, AND WHY IT MATTERS MOST TO THE MAN THIS CARD IS FOR.
   * job_schedule_segments has exactly ONE policy and has had it since the table was created:
   * `job_schedule_segments_rw ... for all using (org_id = auth_org_id() and is_org_staff())`
   * (0040, untouched since). is_org_staff() is owner/admin/office (0004, re-declared in 0158), so
   * Brian and Jimmy select that table and get ZERO ROWS AND NO ERROR. RLS does not raise; it
   * filters. An empty `segs` for a tech therefore means "you cannot see them", not "there are
   * none", and the two are opposite answers.
   *
   * Reading absence out of rows you are not allowed to read is how this card told the truth to
   * Erik and a lie to his crew. setJobScheduleRanges (schedule/actions.ts) writes a segment row
   * for EVERY scheduled job, single-day included, and mirrors scheduled_start/scheduled_end to
   * min-start/max-end; so a tech, seeing no segments, used to fall back to the scheduled_start DAY
   * alone. A Tue–Thu job answered on Tuesday and read "nothing scheduled yet" on Wednesday and
   * Thursday: Brian opens the clock on the middle day of a three-day job, the app says he has
   * nothing, and he phones Erik on the ladder, which is the exact call this card exists to stop.
   *
   * So: when segments do not answer for a job, the job's OWN scheduled window does. That is not a
   * new guess and it does not reach past the schedule (cn-v590) — it is the same fact the same
   * writer wrote, read at a coarser grain, and it is the identical legacy fallback
   * loadJobDaySegments already performs in schedule/actions.ts. For the ordinary single-range job
   * the mirror IS the segment, to the day. The only place it is coarser is a NON-CONTIGUOUS job
   * (Mon–Thu, then Tue–Fri), where a tech may see a gap day claimed; over-claiming one gap day of
   * a rare shape is a smaller harm than going blank on every middle day of every multi-day job,
   * and the row is a link to the job, where the real dates are.
   *
   * THIS ALSO COVERS STAFF: a job with no segment rows at all (scheduled before 0040, or one whose
   * segment insert failed after the mirror update landed) now answers across its window instead of
   * on its start day only.
   *
   * THAT MIGRATION LANDED: 0266 gives every org member a SELECT policy on job_schedule_segments,
   * mirroring crew_day_assignments_read (0139 — "a tech may see where the week puts them"), and
   * keeps the staff-only write. So a tech now reads the REAL segment rows here, exactly as the
   * office does, and the mirror below is no longer a workaround for a blind caller: it is the
   * fallback for a job whose segments were never written.
   *
   * The job-less punch (timeclock/actions.ts, migration 0139's tier 1) resolves through the same
   * rows and the same window, widened in the same commit — it had been mirroring only a job's
   * START day, so on day two of a three-day job this card and that punch named different jobs.
   * They agree because they read the same thing, not because they are wrong in the same way.
   */
  const rangesByJob = new Map<string, { start: string; end: string }[]>();
  for (const j of myJobs) {
    const visible = segsByJob.get(j.id);
    if (visible?.length) {
      rangesByJob.set(j.id, visible);
      continue;
    }
    if (!j.scheduled_start) continue; // unscheduled: it says nothing about any day, and that stands
    // The org-local days are resolved HERE because tz is a server concern and crew-plan.ts stays
    // pure. No end mirrored (or a backwards one) = a single day, same clamp loadJobDaySegments uses.
    const start = todayStrInTz(tz, new Date(j.scheduled_start));
    const end = j.scheduled_end ? todayStrInTz(tz, new Date(j.scheduled_end)) : start;
    rangesByJob.set(j.id, [{ start, end: end < start ? start : end }]);
  }
  /** pickScheduledJobForDay's other input: the single scheduled_start DAY of a job with no ranges.
   *  Empty on purpose. Every job that has a scheduled_start now arrives above as a range whose
   *  first day IS that day, so there is nothing left for this map to add, and one code path
   *  answering "which days does this job run" beats two that can disagree. */
  const NO_SINGLE_DAYS: ReadonlyMap<string, string | null> = new Map();

  // Fail-soft on the decision read (the 0128 precedent the crew board uses): if that table
  // hiccups, the rows still tell the truth about what the SCHEDULE says, labelled as the
  // schedule's answer. They just have nothing to overrule it with.
  const decisions = new Map<string, AssignRow>();
  if (!assignErr) {
    for (const r of (assignRows ?? []) as unknown as AssignRow[]) {
      if (r?.work_date) decisions.set(r.work_date, r);
    }
  }

  const answerFor = (ds: string): Answer => {
    const row = decisions.get(ds);
    // OFF SHORT-CIRCUITS EVERYTHING (0170). A deliberate "not on a job" must beat the roster
    // underneath it, or the page sends a man on vacation to the very job the office took him off.
    if (row?.kind === "off") return { kind: "off", reason: row.off_reason ?? null };
    if (row?.kind === "job" && row.job && (ACTIVE_JOB_STATUSES as unknown as string[]).includes(row.job.status)) {
      return { kind: "job", source: "assigned", jobId: row.job.id, label: jobLabel(row.job) };
    }
    // A decision pointing at a finished or deleted job falls THROUGH rather than resurrecting it —
    // same as the punch. The schedule answers next, or nothing does.
    const sched = pickScheduledJobForDay(myJobs, ds, rangesByJob, NO_SINGLE_DAYS);
    if (sched) return { kind: "job", source: "schedule", jobId: sched.id, label: jobLabel(sched) };
    return { kind: "none" };
  };

  const rows: DayRow[] = [
    { when: "Today", answer: answerFor(today) },
    { when: "Tomorrow", answer: answerFor(tomorrow) },
  ];

  return (
    <Card>
      <CardContent className="py-4">
        <h3 className="mb-1 text-sm font-semibold text-slate-900">Next up</h3>
        <div className="divide-y divide-slate-100">
          {rows.map((r) => (
            <NextUpRow key={r.when} row={r} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** One day. A row that leads somewhere is a LINK and the whole row is the target (44px, one thumb,
 *  easier to hit than a chip inside it); a row with no job is plain text, because a control that
 *  goes nowhere is the dead end the house rule exists to stop. */
function NextUpRow({ row }: { row: DayRow }) {
  const a = row.answer;

  // The job NAME, never J-0xx (jobLabel is the SSOT and prefers the name). Erik has said this
  // three times: three dwellings at one address read as J-009 / J-013 / J-017, and the only text
  // that tells them apart lives in the name.
  const rest =
    a.kind === "job"
      ? a.label
      : a.kind === "off"
        // 'other' is a real off_reason value and reads like a shrug in a parenthesis, so it stays
        // off the line; vacation and sick are worth the four words.
        ? `Off${a.reason && a.reason !== "other" ? ` (${a.reason})` : ""}`
        : "nothing scheduled yet";

  const why =
    a.kind === "job"
      ? a.source === "assigned"
        ? "The office put you on this job"
        : "From the job schedule, not assigned yet"
      : a.kind === "off"
        ? "The office marked you off"
        : null;

  const body = (
    <>
      {/* min-w-0 so a long job name truncates instead of shoving the chevron off a 375px screen. */}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-slate-900">
          <span className="font-semibold">{row.when}</span> · {rest}
        </span>
        {why && <span className="mt-0.5 block text-xs text-slate-500">{why}</span>}
      </span>
      {a.kind === "job" && <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />}
    </>
  );

  if (a.kind === "job") {
    return (
      <Link
        href={`/jobs/${a.jobId}`}
        className="flex min-h-[44px] items-center justify-between gap-3 py-2 active:bg-slate-50"
      >
        {body}
      </Link>
    );
  }
  return <div className="flex min-h-[44px] items-center justify-between gap-3 py-2">{body}</div>;
}
