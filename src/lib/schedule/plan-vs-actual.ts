/**
 * WHAT HAPPENED, INSIDE THE BLOCK (Wave 2, SV-actual; Erik's approval 2026-09-26, "yes yes").
 *
 * The July rule "the calendar never shows clocked time" is retired. The schedule is the one time map:
 * future days show what's booked; PAST days show what was booked AND what happened, inside the same
 * block, with no toggle and no extra layer. The timesheet (editing, pay) stays on /timecards.
 *
 * Pure. The calendar panel turns time entries into past-day SPANS on the company's clock (actualSpans,
 * on the server), hands them over compact (packActuals / unpackActuals), and the calendar matches them
 * to the blocks it draws (planVsActual) and finds the work nobody booked (ghostsFor, part D).
 *
 *   an entry        lands on the day and minutes the company's clock gives it (lib/tz, the same pair
 *                   timeEntryGridSpan uses); an overnight shift splits at midnight and its tail is drawn
 *                   on the next day from minute 0 (display only, instead of the 1440 clamp);
 *   no job          never guessed onto a block (it stays on Timecards and on Needs You's Hours On No Job);
 *   only past days  today and later draw no worked time;
 *   a block         takes the entries whose job is its job that day; with no job block that day, a
 *                   visit block on the same job (a return visit) takes them; otherwise they are
 *                   UNPLANNED (part D draws them as a dashed ghost);
 *   one person      their split shifts and several entries merge into their intervals, overlaps
 *                   unioned, so a leftover duplicate pair draws and counts once;
 *   never clocked   an open entry on a past day (a runaway clock) runs to the block's end, is marked
 *   out             open, and the sentence says "never clocked out";
 *   late/over/short compare the block's edges with the first in and the last out, on the wall clock,
 *                   never person-hours. No hour total is ever printed, so this can never disagree with
 *                   /timecards.
 *
 * The sentence is at most 140 characters of plain words: "Booked 9–5 · Erik 10–7:30 · Jimmy 10–7:30 ·
 * 1h late · 2.5h over"; a block nobody worked is "Booked 9–5 · Nobody clocked in" (HOLLOW).
 * No money here: no rate, no pay column, ever.
 */
import { todayStrInTz, tzMinutesOfDay } from "@/lib/tz";
import { pillColorForPerson } from "@/lib/employee-color";
import { initialsOf } from "./block-info";

/** A time entry as the schedule reads it: who, on which job, in and out. */
export type ActualEntry = {
  profileId: string;
  /** The person's name, from the entry's own profiles join (a person who left still has one). */
  name?: string | null;
  jobId: string | null;
  clockIn: string;
  clockOut: string | null;
};

/** One entry's piece of one past day, in minutes past the company's midnight. `endMin` null: the
 *  entry was never clocked out. */
export type ActualSpan = {
  profileId: string;
  name: string;
  jobId: string;
  dayStr: string;
  startMin: number;
  endMin: number | null;
};

const DAY_MIN = 24 * 60;
const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const nextDay = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/**
 * PAST-DAY SPANS, on the company's clock. An entry with no job is dropped (never guessed onto a block);
 * so is any day that is today or later. A shift over midnight is split: its first day runs to 24:00 and
 * every following day it covers starts at 0 (a runaway that was later closed spans at most `maxDays`).
 * An open entry is one span on its clock-in day, open.
 */
export function actualSpans(entries: readonly ActualEntry[], tz: string, todayStr: string, maxDays = 7): ActualSpan[] {
  const out: ActualSpan[] = [];
  for (const e of entries ?? []) {
    if (!e?.jobId || !e.profileId || !e.clockIn) continue;
    const inAt = new Date(e.clockIn);
    if (isNaN(inAt.getTime())) continue;
    const name = String(e.name ?? "").trim() || "Someone";
    const day = todayStrInTz(tz, inAt);
    const startMin = tzMinutesOfDay(inAt, tz);
    const push = (dayStr: string, s: number, en: number | null) => {
      if (dayStr >= todayStr) return;
      out.push({ profileId: e.profileId, name, jobId: e.jobId as string, dayStr, startMin: s, endMin: en });
    };
    if (!e.clockOut) {
      push(day, startMin, null);
      continue;
    }
    const outAt = new Date(e.clockOut);
    if (isNaN(outAt.getTime()) || outAt.getTime() <= inAt.getTime()) {
      // An out before the in is bad data: a sliver where it started, never a day-long bar.
      push(day, startMin, Math.min(DAY_MIN, startMin + 1));
      continue;
    }
    const outDay = todayStrInTz(tz, outAt);
    const outMin = tzMinutesOfDay(outAt, tz);
    if (outDay === day) {
      push(day, startMin, Math.max(startMin + 1, outMin));
      continue;
    }
    push(day, startMin, DAY_MIN);
    let d = day;
    for (let i = 1; i <= maxDays; i++) {
      d = nextDay(d);
      if (d > outDay) break;
      if (d === outDay) {
        if (outMin > 0) push(d, 0, outMin);
        break;
      }
      push(d, 0, DAY_MIN);
    }
  }
  return out;
}

/** The spans as the server hands them to the calendar: each person and job once, each span a tuple
 *  [job index, person index, day, start minute, end minute or null]. */
export type ActualsPayload = {
  people: { id: string; name: string }[];
  jobs: { id: string; name: string; job_number: string | null; customer: string | null }[];
  spans: [number, number, string, number, number | null][];
};

export type ActualJob = { name: string; job_number: string | null; customer: string | null };

export function packActuals(spans: readonly ActualSpan[], jobs: ReadonlyMap<string, ActualJob>): ActualsPayload {
  const people: ActualsPayload["people"] = [];
  const jobList: ActualsPayload["jobs"] = [];
  const pIdx = new Map<string, number>();
  const jIdx = new Map<string, number>();
  const tuples: ActualsPayload["spans"] = [];
  for (const s of spans) {
    let p = pIdx.get(s.profileId);
    if (p === undefined) {
      p = people.push({ id: s.profileId, name: s.name }) - 1;
      pIdx.set(s.profileId, p);
    }
    let j = jIdx.get(s.jobId);
    if (j === undefined) {
      const w = jobs.get(s.jobId);
      j = jobList.push({ id: s.jobId, name: w?.name ?? "A Job", job_number: w?.job_number ?? null, customer: w?.customer ?? null }) - 1;
      jIdx.set(s.jobId, j);
    }
    tuples.push([j, p, s.dayStr, s.startMin, s.endMin]);
  }
  return { people, jobs: jobList, spans: tuples };
}

/** The clocked-time read's cap (calendar-panel): past it, the oldest days in the window aren't all loaded. */
export const ACTUALS_LIMIT = 4000;

/** A time entry as the calendar's read returns it: no pay column, ever (no rate, paid, miles or notes). */
export type ActualEntryRow = {
  profile_id: string;
  job_id: string | null;
  clock_in: string;
  clock_out: string | null;
  profiles?: { full_name: string | null } | null;
  job?: { id: string; job_number: string | null; name: string | null; customers?: { name: string | null } | null } | null;
};

/**
 * THE READ, AS THE CALENDAR GETS IT: past-day spans on the company's clock, packed (each person and job
 * once), and, when the read came back full (newest first, so the OLDEST days are the ones cut), the
 * first day it holds WHOLE: the day after the oldest clock-in it reached. Every day before that may be
 * missing time, so none of them is ever drawn hollow. A failed read (null) stays null: no bars, and the
 * calendar says so.
 */
export function actualsFrom(
  rows: readonly ActualEntryRow[] | null,
  tz: string,
  todayStr: string,
  limit = ACTUALS_LIMIT,
): { actuals: ActualsPayload | null; actualsCappedBefore: string | null } {
  if (!rows) return { actuals: null, actualsCappedBefore: null };
  const entries: ActualEntry[] = rows.map((r) => ({
    profileId: String(r.profile_id),
    name: r.profiles?.full_name ?? null,
    jobId: r.job_id ? String(r.job_id) : null,
    clockIn: r.clock_in,
    clockOut: r.clock_out ?? null,
  }));
  const jobsById = new Map<string, ActualJob>();
  for (const r of rows) {
    if (r.job?.id) jobsById.set(String(r.job.id), { name: r.job.name ?? "A Job", job_number: r.job.job_number ?? null, customer: r.job.customers?.name ?? null });
  }
  let actualsCappedBefore: string | null = null;
  const oldest = rows.length >= limit ? rows[rows.length - 1]?.clock_in : null;
  if (oldest) actualsCappedBefore = nextDay(todayStrInTz(tz, new Date(oldest)));
  return { actuals: packActuals(actualSpans(entries, tz, todayStr), jobsById), actualsCappedBefore };
}

export function unpackActuals(p: ActualsPayload | null | undefined): ActualSpan[] {
  if (!p) return [];
  const out: ActualSpan[] = [];
  for (const t of p.spans ?? []) {
    const job = p.jobs?.[t[0]];
    const person = p.people?.[t[1]];
    if (!job || !person || !isYmd(t[2])) continue;
    out.push({ jobId: job.id, profileId: person.id, name: person.name, dayStr: t[2], startMin: t[3], endMin: t[4] });
  }
  return out;
}

/** A block the grid draws on a past day: a job's day (its own hours, else its usual) or a visit. */
export type PlanBlock = { key: string; jobId: string | null; dayStr: string; startMin: number; endMin: number; kind: "job" | "visit" };

/** One stretch a person worked: minutes past midnight; `open` = never clocked out (it runs to an end
 *  drawn for display: the block's end, or an hour for a ghost). */
export type WorkedSpan = { startMin: number; endMin: number; open: boolean };

/** A person on a worked block, in their own color, with their merged stretches. */
export type WorkedPerson = {
  profileId: string;
  name: string;
  first: string;
  initials: string;
  /** The person's color (the /timecards person color): the same on the tile, the card, the sheet and the bars. */
  dot: string;
  spans: WorkedSpan[];
  /** The first in; the last out (null: the last stretch was never clocked out). */
  startMin: number;
  endMin: number | null;
};

export type BlockActual = {
  people: WorkedPerson[];
  /** Hollow: booked, and nobody clocked in. */
  state: "hollow" | "worked";
  /** First in minus the block's start (negative: early). Null when hollow. */
  lateMin: number | null;
  /** Last out minus the block's end. Null when hollow or never clocked out. */
  overMin: number | null;
  /** The block's end minus the last out. Null when hollow or never clocked out. */
  shortMin: number | null;
  /** The block's edges and every stretch, for the grid's visible range. */
  extent: { lo: number; hi: number };
  sentence: string;
};

export type UnplannedGroup = { jobId: string; dayStr: string; people: WorkedPerson[] };

/** Under this, a late start or an early finish is noise, not news: the sentence says nothing of it. */
export const NOTE_MIN = 15;
export const SENTENCE_MAX = 140;

/** "9", "9:30", "12", "12:15": a wall-clock minute in as few letters as it reads (12-hour, no suffix). */
export function clockShort(min: number): string {
  const m = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h % 12 || 12}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
}

/** "11:04 AM", "1:46 PM". */
export function clockWords(min: number): string {
  const m = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "11:04 AM–1:46 PM", "12:30–5:30 PM" (the half said once when both ends share it). */
export function rangeWords(a: number, b: number): string {
  const A = clockWords(a);
  const B = clockWords(b);
  const half = (w: string) => w.slice(-2);
  return half(A) === half(B) ? `${A.slice(0, -3)}–${B}` : `${A}–${B}`;
}

/** "45m", "1h", "1.5h", "2.5h", "1h 10m". */
export function durShort(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  if (m % 30 === 0) return `${m / 60}h`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A person's first name ("Erik" from "Erik Taylor"). */
function firstOf(name: string): string {
  return String(name ?? "").trim().split(/\s+/)[0] || "Someone";
}

/**
 * EACH PERSON'S STRETCHES, merged: sorted, overlapping or touching intervals unioned (a switch-back
 * or a leftover duplicate pair counts once). `openEnd(start)` is where an open (never clocked out)
 * stretch is drawn to. People sort by their first clock-in.
 */
export function mergePeople(spans: readonly ActualSpan[], openEnd: (startMin: number) => number): WorkedPerson[] {
  const byPerson = new Map<string, { name: string; iv: WorkedSpan[] }>();
  for (const s of spans) {
    const p = byPerson.get(s.profileId) ?? { name: s.name, iv: [] };
    const open = s.endMin == null;
    const end = open ? Math.max(s.startMin + 1, openEnd(s.startMin)) : Math.max(s.startMin + 1, s.endMin as number);
    p.iv.push({ startMin: s.startMin, endMin: end, open });
    byPerson.set(s.profileId, p);
  }
  const out: WorkedPerson[] = [];
  for (const [profileId, p] of byPerson) {
    const sorted = [...p.iv].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    const merged: WorkedSpan[] = [];
    for (const iv of sorted) {
      const last = merged[merged.length - 1];
      if (last && iv.startMin <= last.endMin) {
        if (iv.endMin > last.endMin) {
          last.endMin = iv.endMin;
          last.open = iv.open;
        } else if (iv.endMin === last.endMin) {
          last.open = last.open || iv.open;
        }
      } else {
        merged.push({ ...iv });
      }
    }
    const lastSpan = merged[merged.length - 1];
    out.push({
      profileId,
      name: p.name,
      first: firstOf(p.name),
      initials: initialsOf(p.name),
      dot: pillColorForPerson(profileId).dot,
      spans: merged,
      startMin: merged[0].startMin,
      endMin: lastSpan.open ? null : lastSpan.endMin,
    });
  }
  return out.sort((a, b) => a.startMin - b.startMin || a.name.localeCompare(b.name));
}

/** One person's part of a sentence: "Erik 10–7:30", "Erik 8–12, 1–5", "Erik in at 10, never clocked out". */
function personPart(p: WorkedPerson): string {
  const parts = p.spans.map((s) => (s.open ? `in at ${clockShort(s.startMin)}, never clocked out` : `${clockShort(s.startMin)}–${clockShort(s.endMin)}`));
  return `${p.first} ${parts.join(", ")}`;
}

/** Fit a sentence in SENTENCE_MAX: drop the last people into "+N more", then cut with an ellipsis. */
function fitSentence(head: string, people: string[], tail: string[]): string {
  const build = (shown: string[], hidden: number) =>
    [head, ...shown, ...(hidden ? [`+${hidden} more`] : []), ...tail].join(" · ");
  let shown = [...people];
  let s = build(shown, 0);
  while (s.length > SENTENCE_MAX && shown.length > 1) {
    shown = shown.slice(0, -1);
    s = build(shown, people.length - shown.length);
  }
  return s.length > SENTENCE_MAX ? `${s.slice(0, SENTENCE_MAX - 1)}…` : s;
}

/** The block's sentence: "Booked 9–5 · Erik 10–7:30 · Jimmy 10–7:30 · 1h late · 2.5h over". */
export function blockSentence(b: { startMin: number; endMin: number }, a: Pick<BlockActual, "people" | "lateMin" | "overMin" | "shortMin">): string {
  const head = `Booked ${clockShort(b.startMin)}–${clockShort(b.endMin)}`;
  if (!a.people.length) return `${head} · Nobody clocked in`;
  const tail: string[] = [];
  if (a.lateMin != null && a.lateMin >= NOTE_MIN) tail.push(`${durShort(a.lateMin)} late`);
  if (a.overMin != null && a.overMin >= NOTE_MIN) tail.push(`${durShort(a.overMin)} over`);
  if (a.shortMin != null && a.shortMin >= NOTE_MIN) tail.push(`${durShort(a.shortMin)} short`);
  return fitSentence(head, a.people.map(personPart), tail);
}

/**
 * THE BLOCKS AND WHAT HAPPENED IN THEM. `blocks` are exactly the ones the grid draws on past days;
 * `spans` the past-day stretches (actualSpans). Returns each block's actual by its key, and the groups
 * of work on a (job, day) that no drawn block took (part D's ghosts, when nothing was booked).
 */
export function planVsActual(p: { blocks: readonly PlanBlock[]; spans: readonly ActualSpan[]; todayStr: string }): {
  byKey: Map<string, BlockActual>;
  unplanned: UnplannedGroup[];
} {
  // Only a block ON A JOB is judged: time is clocked to jobs, so a visit with no job (a pre-sale
  // walk-through) has nothing to be compared with, and "Nobody clocked in" would be a false zero.
  const past = p.blocks.filter((b) => b.dayStr < p.todayStr && !!b.jobId);
  const jobBlock = new Map<string, PlanBlock>();
  const visitBlock = new Map<string, PlanBlock>();
  for (const b of past) {
    const k = `${b.jobId}|${b.dayStr}`;
    if (b.kind === "job") {
      if (!jobBlock.has(k)) jobBlock.set(k, b);
    } else if (!visitBlock.has(k)) visitBlock.set(k, b);
  }
  const groups = new Map<string, ActualSpan[]>();
  for (const s of p.spans) {
    if (!s.jobId || s.dayStr >= p.todayStr) continue;
    const k = `${s.jobId}|${s.dayStr}`;
    const g = groups.get(k) ?? [];
    g.push(s);
    groups.set(k, g);
  }
  const taken = new Map<string, ActualSpan[]>();
  const unplanned: UnplannedGroup[] = [];
  for (const [k, g] of groups) {
    const b = jobBlock.get(k) ?? visitBlock.get(k);
    if (b) taken.set(b.key, [...(taken.get(b.key) ?? []), ...g]);
    else {
      const [jobId, dayStr] = k.split("|");
      unplanned.push({ jobId, dayStr, people: mergePeople(g, (s) => s + 60) });
    }
  }
  const byKey = new Map<string, BlockActual>();
  for (const b of past) {
    const g = taken.get(b.key) ?? [];
    const people = mergePeople(g, (s) => Math.max(b.endMin, s + 15));
    let lo = b.startMin;
    let hi = b.endMin;
    for (const person of people) for (const s of person.spans) {
      lo = Math.min(lo, s.startMin);
      hi = Math.max(hi, s.endMin);
    }
    if (!people.length) {
      const a = { people, lateMin: null, overMin: null, shortMin: null };
      byKey.set(b.key, { ...a, state: "hollow", extent: { lo, hi }, sentence: blockSentence(b, a) });
      continue;
    }
    const firstIn = Math.min(...people.map((x) => x.startMin));
    const neverOut = people.some((x) => x.endMin == null);
    const lastOut = neverOut ? null : Math.max(...people.map((x) => x.endMin as number));
    const a = {
      people,
      lateMin: firstIn - b.startMin,
      overMin: lastOut == null ? null : lastOut - b.endMin,
      shortMin: lastOut == null ? null : b.endMin - lastOut,
    };
    byKey.set(b.key, { ...a, state: "worked", extent: { lo, hi }, sentence: blockSentence(b, a) });
  }
  return { byKey, unplanned };
}

/** Work nobody booked: one per (job, past day), with who worked it and when. */
export type Ghost = {
  jobId: string;
  dayStr: string;
  /** The earliest in. */
  startMin: number;
  /** The latest out; null when someone never clocked out. */
  endMin: number | null;
  /** Who, each with their stretches (an open one drawn an hour long, and faded). */
  people: WorkedPerson[];
};

/**
 * GHOSTS (part D): a (job, past day) with clocked time and NO booking that day. `booked` holds
 * "jobId|YYYY-MM-DD" for every day a job was booked, built from the raw data (lib/schedule/booked-days),
 * never from what the grid happens to draw. Today and later never get one.
 */
export function ghostsFor(spans: readonly ActualSpan[], booked: ReadonlySet<string>, todayK: string): Ghost[] {
  const groups = new Map<string, ActualSpan[]>();
  for (const s of spans) {
    if (!s.jobId || s.dayStr >= todayK) continue;
    const k = `${s.jobId}|${s.dayStr}`;
    if (booked.has(k)) continue;
    const g = groups.get(k) ?? [];
    g.push(s);
    groups.set(k, g);
  }
  const out: Ghost[] = [];
  for (const [k, g] of groups) {
    const [jobId, dayStr] = k.split("|");
    const people = mergePeople(g, (s) => s + 60);
    const neverOut = people.some((x) => x.endMin == null);
    out.push({
      jobId,
      dayStr,
      startMin: Math.min(...people.map((x) => x.startMin)),
      endMin: neverOut ? null : Math.max(...people.map((x) => x.endMin as number)),
      people,
    });
  }
  return out.sort((a, b) => a.dayStr.localeCompare(b.dayStr) || a.startMin - b.startMin);
}

/** Who worked, in words, for a ghost's sheet and the day drill: "Brian 11:04 AM–1:46 PM · Erik
 *  12:30–5:30 PM" ("in at 7:00 AM, never clocked out" for a runaway). */
export function peopleWords(people: readonly WorkedPerson[]): string {
  return people
    .map((p) => `${p.first} ${p.spans.map((s) => (s.open ? `in at ${clockWords(s.startMin)}, never clocked out` : rangeWords(s.startMin, s.endMin))).join(", ")}`)
    .join(" · ");
}
