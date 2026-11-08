/**
 * WHAT ELSE THE BOX SAYS (cn-v1151; Erik: "on schedule im thinking we should also have totals of hours
 * worked and any job notes displayed in the space inside the box and closed and paid or if its open and
 * needing attention with the hold details etc"). The three newer lines of a schedule block
 * (components/time-grid TimeGridInfo `hours` / `state` / `note`; lib/schedule/block-info blockRows draws
 * them in its order, each whole or absent), worked out here — ONE pure rule per kind of block — so the
 * week grid, the day grid and any later surface say them the same way:
 *
 *   the hours   what was WORKED on it THAT DAY, by the ONE hours rule (lib/utils hoursBetween: in to out,
 *               lunch off), from the block's own people ("8 h worked"; a punch still running adds nothing
 *               and says "on the clock"), and — the office only — the job's hours over every day it has
 *               ("22 h on the job"). THE BARS AND THE NUMBER CAN DIFFER, AND THAT IS RIGHT (skeptic #55,
 *               cn-v1151): the bars beside the block are clock time — a bar is where the person was, 8 to
 *               4:30 — while the figure is what /timecards pays for it, 8 h, the 30-minute lunch off; each
 *               person's `workedMin` (lib/schedule/plan-vs-actual mergePeople) carries that, and the
 *               bars' own length stands in only for a caller that hands spans alone. One basis per line:
 *               "8 h worked · 22 h on the job" are both hours paid. The whole-job figure is read on the
 *               server for the office alone (schedule/calendar-panel, under canEdit): time_entries RLS
 *               hands a member their own rows, so a member's "whole job" would be a short number wearing
 *               the job's name. Nothing to say → no line.
 *   the state   where the job stands, in a tone, SHORT (it is one `truncate` line in a week column). On
 *               hold (amber) with the day it comes back in the rail's own words (lib/come-back-days
 *               backWords, never re-derived); its REASON leads the note, below. Done (emerald), and for
 *               the office whether its bills are paid or one is still open. In progress and cancelled
 *               plain. A job scheduled or still to be scheduled says nothing: the block itself says that.
 *               A visit: done, or waiting on the customer's pick.
 *   the note    the hold's reason FIRST, on its own line, when the job is on hold (skeptic #55: Erik asked
 *               for the hold details, and "On Hold · Waiting on the permit and the inspector's callback ·
 *               Back Oct 3" was cut to one line; the note draws in as many whole lines as the block has
 *               room for and the title carries all of it), then the job's own words: its Notes
 *               (jobs.notes, the box the job page labels Notes — the gate code, the dog), else its
 *               Description (the scope, the other box); a visit's notes. Trimmed; nothing when all blank.
 *
 * NO MONEY HERE (block-info's law: the crew reads the same blocks). "Paid" and "Bill Open" are a bill's
 * STATE, never a figure, and only the office's block carries them (`canEdit`): a tech's done job says
 * "Done" alone. A library never imports a catalog: the English is inline and the Spanish comes through
 * the caller's translator (lib/lang-words say), the ag_ catalog's words (lib/words/agenda).
 */
import { backWords } from "@/lib/come-back-days";
import { say, type Words } from "@/lib/lang-words";
import type { Lang } from "@/lib/locale";
import { hoursBetween } from "@/lib/utils";

/** The state line: its words and its tone (components/time-grid TimeGridInfo.state). */
export type BlockState = { text: string; tone: "good" | "warn" | "plain" };

/** The three lines a block may say beyond where and who. Each null when there is nothing to say. */
export type BlockExtras = { hours: string | null; state: BlockState | null; note: string | null };

/** The worked spans a block carries, as the grid holds them (components/time-grid TimeGridActual: each
 *  person's stretches in minutes; `open` = never clocked out; `running` = open on today, still on the
 *  clock). Structural, so this file imports nothing from the components. */
export type WorkedSpans = {
  people: readonly {
    spans: readonly { startMin: number; endMin: number; open: boolean; running?: true }[];
    /** The minutes the ONE hours rule pays this person that day (clock time less lunch, closed stretches
     *  only; plan-vs-actual mergePeople). Absent: the stretches' own length stands in. */
    workedMin?: number;
  }[];
};

/** A closed time entry as the panel's hours read returns it: the three columns of the ONE hours rule
 *  (lib/utils hoursBetween) and the job it was on. No pay column, ever. */
export type ClosedEntryRow = { job_id: string | null; clock_in: string; clock_out: string | null; lunch_minutes?: number | null };

/**
 * The panel's hours read goes a PAGE at a time to this bound (lib/schedule/plan-vs-actual readPagesCapped,
 * the same instrument as the clocked-time read and for the same reason: a bare .limit() is cut at
 * PostgREST's own ceiling with no error, so a count can never see the cut). Past the bound the read says
 * it was capped, and the panel drops the figure for EVERY job rather than show a short one.
 */
export const JOB_HOURS_PAGES = 4;

/** "7.5", "8", "0.25", "7.33": hours in as few digits as they read (two places at most, no trailing
 *  zeros). A figure that is not a number, or is below zero, reads "0". */
export function hoursShort(h: number): string {
  const n = Number.isFinite(h) && h > 0 ? Math.round(h * 100) / 100 : 0;
  return String(n);
}

/**
 * THE DAY'S WORKED TIME, from the block's people: each person's `workedMin` when it is a number — the ONE
 * hours rule's minutes, clock time less lunch (plan-vs-actual mergePeople) — else the length of every
 * stretch with an end (a stretch never clocked out adds nothing — its end is only where it is drawn to);
 * how many closed stretches there are (`closed`: none, and the block has no figure to say); and whether a
 * punch is still running. The bars stay clock time; the figure is what is paid (see the header).
 */
export function dayClocked(actual: WorkedSpans | null | undefined): { hours: number; closed: number; running: boolean } {
  let minutes = 0;
  let closed = 0;
  let running = false;
  for (const p of actual?.people ?? []) {
    let clock = 0;
    for (const s of p.spans) {
      if (s.running) running = true;
      if (s.open) continue;
      const len = s.endMin - s.startMin;
      if (!(len > 0)) continue;
      clock += len;
      closed += 1;
    }
    minutes += typeof p.workedMin === "number" ? Math.max(0, p.workedMin) : clock;
  }
  return { hours: Math.round((minutes / 60) * 100) / 100, closed, running };
}

/**
 * THE HOURS LINE: "8 h worked", then "on the clock" when a punch is still running, then — when the
 * caller has it — "22 h on the job"; dots between; null when there is nothing to say. The day's facts
 * come first and the job's last. A block with no closed stretch says no day figure (a hollow block's
 * sentence already says no time was clocked to it; a runaway's says it was never clocked out). "Worked",
 * not "clocked": the figure is hours paid, lunch off, the same basis as the whole-job figure beside it.
 */
export function hoursLine(
  p: { day?: { hours: number; closed: number; running: boolean } | null; jobHours?: number | null },
  lang: Lang = "en",
  words?: Words,
): string | null {
  const parts: string[] = [];
  if (p.day && p.day.closed > 0) {
    const h = hoursShort(p.day.hours);
    parts.push(say(lang, words, "ag_hWorked", `${h} h worked`, { h }));
  }
  if (p.day?.running) parts.push(say(lang, words, "ag_onTheClock", "on the clock"));
  if (p.jobHours != null && Number.isFinite(p.jobHours)) {
    const h = hoursShort(p.jobHours);
    parts.push(say(lang, words, "ag_hOnTheJob", `${h} h on the job`, { h }));
  }
  return parts.length ? parts.join(" · ") : null;
}

/**
 * WHERE A DONE JOB'S BILLS STAND, from its invoices' statuses (0003's enum: draft, sent, partial, paid,
 * overdue, void). A void bill is no bill. "open": one is out and unpaid (sent, partial, overdue) — the
 * office's attention. "paid": there is at least one and every one is paid. null: none, or drafts only
 * (a draft is the office's own paper still; nothing to say on the block).
 */
export function billState(invoices: readonly { status: string | null }[] | null | undefined): "paid" | "open" | null {
  const live = (invoices ?? []).map((i) => String(i?.status ?? "")).filter((s) => s && s !== "void");
  if (live.some((s) => s === "sent" || s === "partial" || s === "overdue")) return "open";
  if (live.length && live.every((s) => s === "paid")) return "paid";
  return null;
}

/** The person's own words as the block draws them: line ends unified, trimmed, null when blank. */
export function noteOf(text: string | null | undefined): string | null {
  const t = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  return t || null;
}

/** The job row's columns the state and the note turn on (schedule/calendar-panel JOB_COLS carries each). */
export type ExtrasJob = {
  status?: string | null;
  hold_reason?: string | null;
  /** The day the hold comes back (0366, a date). */
  hold_until?: string | null;
  notes?: string | null;
  description?: string | null;
  invoices?: readonly { status: string | null }[] | null;
};

/**
 * WHERE THE JOB STANDS, as the state line (jobBlockExtras' middle line, its own function so a table test
 * reads every branch). `todayStr` is the company's today (the hold's "Back Today" / "Back Oct 3" is
 * judged against it, as the rail judges it). `canEdit`: the office, whose done job also says whether it
 * is paid or a bill is still open; a tech's says "Done" alone.
 */
export function jobState(job: ExtrasJob, p: { canEdit?: boolean; todayStr: string }, lang: Lang = "en", words?: Words): BlockState | null {
  switch (job.status) {
    case "on_hold": {
      // SHORT: the state is one `truncate` line in a week column, so it says On Hold and the day it comes
      // back, nothing more; the reason — the hold details Erik asked for — leads the note (jobNote), which
      // draws in whole lines and rides whole in the title.
      const parts = [say(lang, words, "ag_stateOnHold", "On Hold")];
      if (job.hold_until) parts.push(backWords(job.hold_until, p.todayStr, lang, words));
      return { text: parts.join(" · "), tone: "warn" };
    }
    case "complete": {
      const parts = [say(lang, words, "ag_stateDone", "Done")];
      if (p.canEdit) {
        const bills = billState(job.invoices);
        if (bills === "open") parts.push(say(lang, words, "ag_stateBillOpen", "Bill Open"));
        else if (bills === "paid") parts.push(say(lang, words, "ag_statePaid", "Paid"));
      }
      return { text: parts.join(" · "), tone: "good" };
    }
    case "in_progress":
      return { text: say(lang, words, "ag_stateInProgress", "In Progress"), tone: "plain" };
    case "cancelled":
      return { text: say(lang, words, "ag_stateCancelled", "Cancelled"), tone: "plain" };
    default:
      return null;
  }
}

/** The hold's reason as one line (its line ends and runs of spaces folded), null when blank or when the
 *  job is not on hold: a reason left on a job that came off hold is history, not the block's news. */
export function holdReason(job: ExtrasJob): string | null {
  if (job.status !== "on_hold") return null;
  const why = String(job.hold_reason ?? "").replace(/\s+/g, " ").trim();
  return why || null;
}

/**
 * THE NOTE: the hold's reason FIRST, on its own line, when the job is on hold (skeptic #55, cn-v1151: the
 * state line is `truncate`, and "On Hold · Waiting on the permit and the inspector's callback · Back Oct 3"
 * was cut in a week column; the owner asked for the hold details, and the note is the one part of the box
 * drawn in as many whole lines as it has room for, with the title carrying all of it), then the job's own
 * words: its Notes, else its Description. The reason alone when both are blank; null when there is nothing.
 */
export function jobNote(job: ExtrasJob): string | null {
  const own = noteOf(job.notes) ?? noteOf(job.description);
  const why = holdReason(job);
  if (!why) return own;
  return own ? `${why}\n${own}` : why;
}

/**
 * A JOB BLOCK'S THREE LINES. `actual` is the block's own worked spans that day (absent on a day not
 * judged: no day figure); `jobHours` the job's hours over every day, which only the office's panel hands
 * in (null or absent: no such figure); `canEdit` the office; `todayStr` the company's today.
 */
export function jobBlockExtras(
  job: ExtrasJob,
  p: { actual?: WorkedSpans | null; jobHours?: number | null; canEdit?: boolean; todayStr: string },
  lang: Lang = "en",
  words?: Words,
): BlockExtras {
  return {
    hours: hoursLine({ day: p.actual ? dayClocked(p.actual) : null, jobHours: p.jobHours ?? null }, lang, words),
    state: jobState(job, p, lang, words),
    note: jobNote(job),
  };
}

/** WHERE A VISIT STANDS: done (emerald), or waiting on the customer's pick (amber); otherwise nothing. */
export function visitState(visit: { status?: string | null }, lang: Lang = "en", words?: Words): BlockState | null {
  if (visit.status === "completed") return { text: say(lang, words, "ag_stateDoneVisit", "Done"), tone: "good" };
  if (visit.status === "proposed") return { text: say(lang, words, "ag_statePendingPick", "Pending Pick"), tone: "warn" };
  return null;
}

/**
 * A VISIT BLOCK'S THREE LINES: the time clocked to its job that day when the visit's block carries it
 * (never a whole-job figure: a visit is one stop, not the job), where it stands, its notes.
 */
export function visitBlockExtras(
  visit: { status?: string | null; notes?: string | null },
  p: { actual?: WorkedSpans | null },
  lang: Lang = "en",
  words?: Words,
): BlockExtras {
  return {
    hours: hoursLine({ day: p.actual ? dayClocked(p.actual) : null }, lang, words),
    state: visitState(visit, lang, words),
    note: noteOf(visit.notes),
  };
}

/**
 * EVERY JOB'S HOURS, from its closed entries: the ONE hours rule per entry (lib/utils hoursBetween — the
 * clock-in to the clock-out less the lunch, the figure /timecards and the job page read), summed per job
 * and kept to two places. An entry with no job or no clock-out adds nothing (an open punch is not hours
 * yet). The server folds the office's read with this and hands the record to the view as `hoursByJob`.
 */
export function foldHoursByJob(rows: readonly ClosedEntryRow[] | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows ?? []) {
    if (!r?.job_id || !r.clock_in || !r.clock_out) continue;
    out[r.job_id] = (out[r.job_id] ?? 0) + hoursBetween(r.clock_in, r.clock_out, r.lunch_minutes ?? 0);
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}
