"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, CalendarClock, Briefcase, ClipboardList, ListTodo, MapPin, Plus, Users, Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented";
import { Card } from "@/components/ui/card";
import { usePlacement } from "../schedule/placement-context";
import { dayTargetLabel } from "@/lib/schedule/placement-plan";
import { dayLabel, spanLabel } from "@/lib/schedule/span-label";
import { useEndlessStack } from "@/components/use-endless-stack";
import { dayWords, jobDayBlock } from "@/lib/schedule/job-block";
import { crewChips, placeLine, spanShort, streetOf, townOf, visitPlace, type CrewChip, type CrewDayRow } from "@/lib/schedule/block-info";
import { jobWords } from "@/lib/action-items/words";
import { CrewInitials } from "@/components/crew-initials";
import { ownHoursByJobDay } from "@/lib/schedule/segment-hours";
import { ScheduleTileSheet, type TileTarget } from "../schedule/tile-sheet";
import { AddToScheduleSheet, type AddAt, type AddableJob } from "../schedule/add-to-schedule-sheet";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { MoveToDay } from "@/components/move-to-day";
import { NavLink } from "@/components/nav-link";
import { TimeGrid, type TimeGridAllDay, type TimeGridEvent } from "@/components/time-grid";
import { hmToMin, todayStrInTz, tzMinutesOfDay, weekDayStrs, weekdayHeadings, type WeekStart } from "@/lib/tz";
import { shortDayWords, weekViewDays } from "@/lib/schedule/week-columns";
import { formatTime } from "@/lib/utils";
import { firstNameOf } from "@/lib/employee-color";
import { shiftApptToDay } from "@/lib/appt-time";
import { rescheduleAppointment } from "../appointments/actions";
import { updateTask, type TaskCategory } from "../tasks/actions";
import { taskHref } from "@/lib/task-href";
import { AppointmentButton, type ApptValue } from "../appointments/appointment-button";
import { ApptQuickActions } from "../appointments/appointment-status";
import { JobScheduleCard } from "../schedule/job-schedule-card";
import { jobLabel } from "@/lib/schedule-options";
import { appointmentTypeLabel, isInspectionType, visitTitle } from "@/lib/statuses";
import { allDayEventDays } from "@/lib/gcal-map";
import { CAL_WINDOW_BACK_DAYS, CAL_WINDOW_FWD_DAYS } from "@/lib/schedule/cal-window";
import {
  ghostsFor,
  peopleWords,
  planVsActual,
  unpackActuals,
  type ActualsPayload,
  type BlockActual,
  type PlanBlock,
  type WorkedPerson,
} from "@/lib/schedule/plan-vs-actual";
import { GhostRow, ghostTitle, type GhostTarget } from "../schedule/ghost-sheet";
import type { TimeGridActual, TimeGridDay } from "@/components/time-grid";
import { bookedKeys, dayRange, visitDays } from "@/lib/schedule/booked-days";

// THE ONE TIME MAP. Future days show what's booked; past days show what was
// booked AND what happened, inside the same block: who clocked in as bars in
// each person's color beside it (late, over, short), the block hollow when
// nobody went, and a dashed ghost for work nobody booked (Wave 2, SV-actual and
// SV-ghost: the July rule "the calendar never shows clocked time" is retired,
// Erik 2026-09-26). No toggle, no extra layer. The timesheet (editing, pay)
// stays on /timecards. Views are url-synced (?view=day|week|month + ?date=) via
// SHALLOW history writes: the server preloads a wide ±window once and every
// chevron/day tap slices it client-side — no RSC round-trip per tap.
//
// SAFETY (the deliberate-move law): a block's tap is never a move. The office's
// tap opens the block's sheet (its day with Move, its time, its crew, Open The
// Job inside: schedule/tile-sheet); anyone else's opens its record. There is NO
// armed "tap a block, then tap a day" mode: one stray tap while driving can't
// silently reschedule a real appointment. Every reschedule is two deliberate
// steps (a day and Move in the sheet, or the MoveToDay sheet's day-strip). A day
// tap drills into that day, UNLESS the rail has armed it: ticking waiting work
// on the rail (Waiting For A Day) turns every day into a target that places it.
// The old "To Schedule" tray above the grid was cut in W2-05: the rail is the one
// door for waiting work, and its place's toast carries the Undo the tray had.

export interface CalJob {
  id: string;
  job_number: string;
  name: string;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  /** How long it was sized for (0229). The grid falls back to the org work-day end without it,
   *  which is where "5 hours" came from on a job nobody had sized. */
  planned_minutes?: number | null;
  assigned_to?: string[] | null;
  customers?: { name: string } | null;
  /** The street (jobs.address) and the town: every block says where (lib/schedule/block-info). */
  address?: string | null;
  city?: string | null;
}

// Internal-only since week-agenda.tsx (the last external importer) died in cn-v507.
interface CalMember {
  id: string;
  full_name: string | null;
}

/** Everyone the company ever had (a chip names someone who left: "No Longer On The Team"). */
export interface CalPerson {
  id: string;
  full_name: string | null;
  active?: boolean | null;
}

export interface CalSegment {
  job_id: string;
  start_date: string; // yyyy-mm-dd
  end_date: string;
  /** The days' own hours (0370, "HH:MM:SS"), both null for the job's usual hours; absent before 0370. */
  start_time?: string | null;
  end_time?: string | null;
}

export interface CalAppt {
  id: string;
  type: string; // quote | meeting | inspection | appointment | other
  title: string;
  starts_at: string;
  ends_at: string | null;
  status: string;
  job_id: string | null;
  customer_id: string | null;
  location: string | null;
  notes: string | null;
  assigned_to: string | null;
  /** `address`: where a visit with no place of its own is (its job's street). */
  jobs?: { job_number: string; name: string; address?: string | null } | null;
  customers?: { name: string } | null;
  profiles?: { full_name: string | null } | null;
}

/** An open task with a due date inside the window — the calendar shows tasks
 *  IN TIME; /tasks stays the workbench where they're edited. */
export interface CalTask {
  id: string;
  title: string;
  due_date: string; // yyyy-mm-dd
  job_id: string | null;
  category: string;
  assigned_to: string | null;
  assignee?: { full_name: string | null } | null;
  jobs?: { job_number: string; name: string } | null;
}

/** A mirrored Google event (external_events, 0132) — READ-ONLY display: it
 *  renders as a neutral zinc pill so "Erik's dentist" blocks the time without
 *  pretending to be CN work. Never editable/movable in CN (Google owns it).
 *  For all_day rows starts_at/ends_at carry Google's DATES as <date>T00:00:00Z
 *  — the day comes from the string's date part, never a local parse. */
export interface CalExternal {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
}

/** One job's presence on one day (pos = "d2/3" on multi-day spans).
 *  Internal-only (with DayData) since week-agenda.tsx died in cn-v507. */
interface JobOnDay {
  job: CalJob;
  pos: string | null;
}

interface DayData {
  jobs: JobOnDay[];
  appts: CalAppt[];
  tasks: CalTask[];
  externals: CalExternal[];
}

interface PickerOpt {
  id: string;
  label: string;
  address?: string | null;
}
export interface SchedulePicker {
  jobs: PickerOpt[];
  customers: PickerOpt[];
  staff: PickerOpt[];
}

/**
 * "2 weeks" is the DEFAULT, and that is the point of it.
 *
 * Erik: "i saw the other day was having two week view stacked and that worked for me visually and
 * i bet that will help big time here … two weeks stacked and scrollable."
 *
 * A week is too short to plan a route in — booking a Truckee run means asking "when am I next near
 * Truckee", and that answer is almost never inside the current seven days, so you page forward and
 * lose the week you were looking at. A month is the wrong shape: thirty cells are too small to
 * hold a stop, so it degrades to a density map that shows THAT a day is busy but never WHERE, and
 * where is the whole question. Two weeks is the horizon an inspection actually gets booked in,
 * and his Sept 12 trip sits eighteen days out — invisible in a week view, which is how you book
 * work into a week you are in Sunnyvale.
 */
type View = "month" | "week" | "day";

const endOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth() + 1, 0);


// PURE calendar-day math only: dayKey round-trips a local-midnight Date built
// from a "YYYY-MM-DD" back to the same string in ANY runtime zone. It must
// NEVER be fed an INSTANT (a DB timestamp / `new Date()`), because the local
// getters then answer in the server's UTC (SSR) or the browser's zone — the
// "UTC timezone problem" Erik kept hitting. Instants map through the org-tz
// helpers below (todayStrInTz / tzMinutesOfDay), same as /timecards.
const dayKey = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const isYmd = (s: string | null | undefined): s is string => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");

/** A "YYYY-MM-DD" back to the pure calendar-day Date dayKey round-trips (local midnight, no instant). */
const dayDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

/**
 * THE COMPANY'S WEEK CONTAINING `d` — seven calendar-day Dates, first day first.
 *
 * This was `startOfWeek`, a hardcoded `r.getDay()` with the comment "Sunday start", and it fed BOTH
 * the week columns and the month grid's first cell. Settings → Scheduling has said "Week starts on
 * Monday" since the setting shipped and only /timecards read it, so the one screen Erik plans the
 * crew's week on opened on a Sunday and the setting was a lie. The arithmetic lives once now, in
 * lib/tz weekDayStrs, and this just carries it back into the Dates the grid draws with.
 */
function weekDaysOf(d: Date, weekStart: WeekStart): Date[] {
  return weekDayStrs(dayKey(d), weekStart).map(dayDate);
}

/**
 * THE DAYS A JOB IS ON, ONE RULE for every surface that reads them (the week, the month, the day drill,
 * and the past blocks what happened is matched to): SEGMENTS FIRST, each range its own run of days (so a
 * gap between two work weeks stays empty); a job with no segments runs its listed span, each end
 * resolved to its ORG-TZ day first (a raw evening timestamp would land on the UTC next day).
 */
function jobDayRanges(j: Pick<CalJob, "scheduled_start" | "scheduled_end">, segs: readonly CalSegment[] | undefined, dayOf: (iso: string) => string): string[][] {
  // dayRange (lib/schedule/booked-days, the rule "booked" reads too) carries a backstop against a
  // runaway loop, sized above the widest fetch window so legitimate long jobs aren't silently clipped.
  if (segs?.length) return segs.map((s) => dayRange(s.start_date, s.end_date));
  if (!j.scheduled_start) return [];
  const startYmd = dayOf(j.scheduled_start);
  const endYmd = j.scheduled_end ? dayOf(j.scheduled_end) : startYmd;
  return [dayRange(startYmd, endYmd)];
}

/**
 * THE DAYS A VISIT IS ON: every day it covers, not just the one it starts on (Erik: "i set it for a week
 * … but it only showed up as 1 day"). The span was SIZED in working days (spanEnd/workingDaysFrom skip
 * weekends), so the days after the first skip them too; the FIRST day is exempt: a visit explicitly
 * booked on a Saturday is a Saturday visit.
 */
function apptSpanDays(a: Pick<CalAppt, "starts_at" | "ends_at">, dayOf: (iso: string) => string): string[] {
  const first = dayOf(a.starts_at);
  const last = a.ends_at ? dayOf(a.ends_at) : first;
  return visitDays(first, last);
}

/**
 * A VISIT'S BLOCK ON ONE DAY, in the company's clock: only the first day starts at the booked time and
 * only the last day ends at the booked time; the days between are whole working days; no end is an hour.
 */
function apptDayMinutes(
  a: Pick<CalAppt, "starts_at" | "ends_at">,
  k: string,
  dayOf: (iso: string) => string,
  minOf: (iso: string) => number,
  wd: { startMin: number; endMin: number },
): { startMin: number; endMin: number } {
  const firstDay = dayOf(a.starts_at) === k;
  const lastDay = !a.ends_at || dayOf(a.ends_at) === k;
  const startMin = firstDay ? minOf(a.starts_at) : wd.startMin;
  let endMin = startMin + 60;
  if (a.ends_at && new Date(a.ends_at).getTime() > new Date(a.starts_at).getTime()) {
    endMin = lastDay ? Math.max(startMin + 15, minOf(a.ends_at)) : Math.max(startMin + 15, wd.endMin);
  } else if (!lastDay) {
    endMin = Math.max(startMin + 15, wd.endMin);
  }
  return { startMin, endMin };
}

/** A past block's worked time as the grid draws it: HOLLOW is decided before the person filter (a
 *  block somebody else worked is "not them", never hollow); with the filter on, only that person's bars. */
function gridActualOf(a: BlockActual | undefined, personFilter: string | null): TimeGridActual | undefined {
  if (!a) return undefined;
  const people = (personFilter ? a.people.filter((p) => p.profileId === personFilter) : a.people).map((p) => ({
    key: p.profileId,
    initials: p.initials,
    dot: p.dot,
    spans: p.spans,
  }));
  return { people, hollow: a.state === "hollow", sentence: a.sentence };
}

const PROPOSED_CONFIRM =
  "A pick-a-time link is out to the customer for this — moving it withdraws that link. Move it anyway?";

// Stable empties for the optional data props: a fresh `{}` / `[]` default each render would change
// every memo and cache keyed on them.
const EMPTY_DAY_ROWS: Record<string, CrewDayRow[]> = {};
const EMPTY_PEOPLE: CalPerson[] = [];
/* AND FOR THE LIST PROPS, for the same reason and one more. The week cache's key holds these arrays'
   IDENTITY, and so does the release of a just-placed day's held column — a caller that leaves one of
   them off used to get a brand new `[]` every render, which emptied the cache on every keystroke and
   would let go of a held weekend column before its booking ever reached the screen. One shared empty:
   nothing here ever writes to a list prop (the day buckets it fills are its own). */
const NO_ROWS: never[] = [];

// ── Time-grid pill colors (Erik wants blocks IN their time allotment) ──
// Appointments color by TYPE; jobs stay slate so the crew's work blocks read
// as one family and the appointment types pop against them.
const APPT_GRID_TONE: Record<string, string> = {
  inspection: "border-amber-300 bg-amber-100 text-amber-900",
  final_inspection: "border-violet-300 bg-violet-100 text-violet-900",
  meeting: "border-blue-300 bg-blue-100 text-blue-900",
  quote: "border-teal-300 bg-teal-100 text-teal-900",
};
const APPT_GRID_DEFAULT = "border-cyan-300 bg-cyan-100 text-cyan-900";
const JOB_GRID_TONE = "border-slate-300 bg-slate-200/80 text-slate-800";
// WORK NOBODY BOOKED (a ghost): slate, 2px dashed, white. Kept apart from a proposed visit on purpose,
// which keeps its type's tone with a thin dashed border, faded: a ghost is never a booking's look.
const GHOST_GRID_TONE = "border-2 border-dashed border-slate-400 bg-white/60 text-slate-700";
const TASK_TRAY_TONE = "border-slate-300 bg-slate-100 text-slate-700";
// Mirrored Google events: deliberately the flattest tone on the grid — real CN
// work stays visually louder than "Erik's dentist".
const EXTERNAL_GRID_TONE = "border-zinc-300 bg-zinc-100 text-zinc-600";

const apptGridColor = (a: CalAppt) =>
  `${APPT_GRID_TONE[a.type] ?? APPT_GRID_DEFAULT}${a.status === "proposed" ? " border-dashed opacity-75" : ""}${
    a.status === "completed" ? " opacity-60" : ""
  }`;

/**
 * ARMED, OR NOT.
 *
 * On /schedule the rail wraps this in a PlacementProvider, so ticking work there turns every day
 * here into a target. On /calendar there is no provider and this reads an inert default — armedCount
 * 0, day taps keep drilling in, nothing changes. One component, two contexts, no flag to pass down
 * six levels.
 */
function useDayTarget() {
  const pl = usePlacement();
  return pl.armedCount > 0
    ? { armed: true as const, pl, prop: { label: dayTargetLabel(pl.armedCount), onPlace: pl.placeOn } }
    : { armed: false as const, pl, prop: undefined };
}

export function CalendarView({
  jobs,
  segments = NO_ROWS,
  appointments = NO_ROWS,
  tasks = NO_ROWS,
  external = NO_ROWS,
  members = NO_ROWS,
  picker,
  now,
  tz,
  weekStart = "monday",
  workDayStart = "08:00",
  workDayEnd = "16:00",
  crewBoard = true,
  canEdit = false,
  perDayHours = false,
  addableJobs = NO_ROWS,
  dayRows = EMPTY_DAY_ROWS,
  people = EMPTY_PEOPLE,
  actuals,
  actualsCappedBefore = null,
}: {
  jobs: CalJob[];
  segments?: CalSegment[];
  appointments?: CalAppt[];
  tasks?: CalTask[];
  /** Mirrored Google events — read-only zinc pills (0132 two-way sync). */
  external?: CalExternal[];
  members?: CalMember[];
  picker: SchedulePicker;
  /** Server's "now" (ISO) — keeps SSR and first client render in sync. */
  now: string;
  /** The org's IANA timezone — EVERY instant→day/minutes mapping goes through
   *  it (the /timecards discipline), so the SSR (UTC server) and the browser
   *  place a 9 AM Pacific appointment at 9 AM on the Pacific day, always. */
  tz: string;
  /** Settings → Scheduling, "Week starts on" (org settings week_start). The week's columns AND the
   *  month grid's first cell come from it, through the one rule in lib/tz — this view used to start
   *  both on a hardcoded Sunday while the setting said Monday. Absent: the org default, Monday. */
  weekStart?: WeekStart;
  /** The org's work_day_start ("HH:MM") — the all-day job time sentinel the
   *  week agenda hides. Defaults to the scheduler's original 8 AM. */
  workDayStart?: string;
  /** The org's work_day_end ("HH:MM") — an all-day job's block on the time
   *  grid spans start→end (the org's real work window, not a faked time). */
  workDayEnd?: string;
  /** Crew Board's switch (0352): off, no Everyone's Day door in the header. Absent = on. */
  crewBoard?: boolean;
  /** The office: a tap on a block opens its sheet (day, time, crew). Absent (anyone else): the
   *  blocks are the links to their records they always were. */
  canEdit?: boolean;
  /** 0370 is applied: a day can keep its own hours, so the tile's time edit is This Day's. */
  perDayHours?: boolean;
  /** The office's Add To Schedule list: every job still in flight (schedule/add-to-schedule-sheet). */
  addableJobs?: AddableJob[];
  /** Everyone's Day's rows by day (crew_day_assignments, both kinds): THE DAY ROW WINS for that day on
   *  the chips (off that day, on another job, put on for the day). Absent: the job's crew as it stands. */
  dayRows?: Record<string, CrewDayRow[]>;
  /** Everyone the company ever had, so a chip names a person who left. */
  people?: CalPerson[];
  /** What happened on past days: the clocked time as compact spans (lib/schedule/plan-vs-actual).
   *  null: the read failed (no bars, and one quiet line says so). Absent: nothing was read. */
  actuals?: ActualsPayload | null;
  /** When the clocked-time read hit its cap: the first day it holds whole. Older days say "Clocked time
   *  loads back to <date>." and are never drawn hollow (blank is not zero). */
  actualsCappedBefore?: string | null;
}) {
  const searchParams = useSearchParams();
  const toast = useToast();

  // Seed "today" from the SERVER clock so SSR and hydration agree, then correct
  // to the actual now on mount (the existing calendar pattern). The DAY is
  // always derived in the ORG tz — not the server's UTC day, not the browser's.
  const [today, setToday] = useState(() => new Date(now));
  useEffect(() => setToday(new Date()), []);
  const todayK = todayStrInTz(tz, today);

  // Instant → org-tz day / minutes-of-day. The ONLY lawful way to place a DB
  // timestamp on the calendar (dayKey is for pure "YYYY-MM-DD" math only).
  const dayOf = (iso: string) => todayStrInTz(tz, new Date(iso));
  const minOf = (iso: string) => tzMinutesOfDay(iso, tz);

  // View + anchor are DERIVED from the URL (single source of truth) so the
  // browser back button walks the day-drill history; nav() below writes the
  // URL shallowly and Next syncs useSearchParams without an RSC fetch.
  const rawView = searchParams.get("view");
  const view: View =
    // 2weeks folded INTO week — it IS the week view now, so an old link still lands somewhere real.
    rawView === "day" || rawView === "month" ? rawView : "week";
  const dateParam = searchParams.get("date");
  /* THE ANCHOR STAYS INSIDE THE LOADED WINDOW. The panel fetches −120..+400 days around today and
     paging never refetches — an anchor past the edge (14 Next taps, a stale bookmark) rendered a
     fully drawn month that was silently empty. Clamped here so every derived surface (grids,
     stacks, drill) inherits the bound. All YMD-string arithmetic at local noon — never raw
     instants (timezone law). */
  const winFrom = useMemo(() => {
    const d = new Date(`${todayK}T12:00:00`);
    d.setDate(d.getDate() - CAL_WINDOW_BACK_DAYS);
    return dayKey(d);
  }, [todayK]);
  const winTo = useMemo(() => {
    const d = new Date(`${todayK}T12:00:00`);
    d.setDate(d.getDate() + CAL_WINDOW_FWD_DAYS);
    return dayKey(d);
  }, [todayK]);
  const anchor = useMemo(() => {
    const raw = isYmd(dateParam) ? dateParam! : todayK;
    const clamped = raw < winFrom ? winFrom : raw > winTo ? winTo : raw;
    return new Date(`${clamped}T00:00:00`);
  }, [dateParam, todayK, winFrom, winTo]);
  const anchorK = dayKey(anchor);

  /** Shallow url-sync: replace for paging/zoom, push for the day drill (so
   *  Back leaves the drill instead of leaving /schedule). */
  function nav(v: View, ymd: string, opts?: { push?: boolean }) {
    const url = `${window.location.pathname}?view=${v}&date=${ymd}`;
    if (opts?.push) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }

  function shiftAnchor(dir: -1 | 1) {
    const d = new Date(anchor);
    if (view === "month") d.setMonth(d.getMonth() + dir);
    else if (view === "week") d.setDate(d.getDate() + 7 * dir);
    else d.setDate(d.getDate() + dir);
    let ymd = dayKey(d);
    // NOTHING SILENT: the edge of the loaded window is announced, never rendered as empty days.
    if (ymd > winTo || ymd < winFrom) {
      ymd = ymd > winTo ? winTo : winFrom;
      toast(ymd === winTo ? "That's the edge of the loaded schedule — about 13 months out." : "That's the edge of the loaded schedule — about 4 months back.");
      if (ymd === anchorK) return;
    }
    nav(view, ymd);
  }

  // Person filter (the Users icon) — "who works where tomorrow" by filtering,
  // not by decoding a color legend. Client-only state; color = record TYPE.
  const [filterOpen, setFilterOpen] = useState(false);
  const [personFilter, setPersonFilter] = useState<string | null>(null);

  // Filter honesty: a person filter also hides everything with NO assignee —
  // say so, or an unassigned job silently vanishes from "Mike's week".
  const unassignedHidden = useMemo(() => {
    if (!personFilter) return 0;
    const segJobIds = new Set(segments.map((s) => s.job_id));
    return (
      jobs.filter((j) => (j.scheduled_start || segJobIds.has(j.id)) && !(j.assigned_to ?? []).length).length +
      appointments.filter((a) => !a.assigned_to).length +
      tasks.filter((t) => !t.assigned_to && isYmd(t.due_date)).length +
      external.length // Google events carry no CN assignee — a person filter hides them all
    );
  }, [personFilter, jobs, segments, appointments, tasks, external]);

  /* THE TILE'S SHEET (schedule/tile-sheet): which block was tapped, on which day. The record is looked
     up in the loaded jobs and visits at render, so the refresh after a save shows the sheet what was
     saved, and a job whose date was cleared simply leaves (and the sheet with it). */
  const [sheet, setSheet] = useState<{ kind: "job" | "visit" | "ghost"; id: string; day: string } | null>(null);

  /* ADD TO SCHEDULE (Erik: "theres no way to add to the schedule from the schedule page unless its
     already scripted"): an open spot tapped on a day, or the day's "+", opens the sheet at that day and
     half hour (schedule/add-to-schedule-sheet). The office only. */
  const [adding, setAdding] = useState<AddAt | null>(null);
  const onSlotTap = useCallback((day: string, minute: number | null) => setAdding({ day, minute }), []);

  /* EACH DAY'S OWN HOURS (0370), by job and day: the grid draws a day by them, the day drill reads
     them, and the tile's time is that day's. Empty before 0370 (every day is the job's usual hours). */
  const ownHours = useMemo(() => ownHoursByJobDay(segments), [segments]);
  /** The team by id, for the crew's initials on every block (a visit's person too, when the roster
   *  doesn't carry them: their name rides on the visit). */
  const team = useMemo(() => {
    const byId = new Map<string, CalMember>();
    for (const m of members) byId.set(m.id, m);
    for (const a of appointments) {
      if (a.assigned_to && !byId.has(a.assigned_to)) byId.set(a.assigned_to, { id: a.assigned_to, full_name: a.profiles?.full_name ?? null });
    }
    return [...byId.values()];
  }, [members, appointments]);
  /** Job words by id ("12 Elm St · J-048"), for a chip whose person is on ANOTHER job that day. */
  const jobNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const j of addableJobs) m.set(j.id, jobWords(j));
    for (const j of jobs) m.set(j.id, jobWords(j));
    return m;
  }, [jobs, addableJobs]);
  /** WHO'S ON IT THAT DAY, as chips (lib/schedule/block-info crewChips): the job's crew with that day's
   *  Everyone's Day rows applied (the day row wins), a person who left still named. A visit carries
   *  one person, and only an 'off' row applies to it. */
  const jobCrewOn = useCallback(
    (job: Pick<CalJob, "id" | "assigned_to">, day: string): CrewChip[] =>
      crewChips(job.assigned_to, team, { rows: dayRows[day], jobId: job.id, jobNames, people }),
    [team, dayRows, jobNames, people],
  );
  const visitCrewOn = useCallback(
    (a: Pick<CalAppt, "assigned_to">, day: string): CrewChip[] =>
      crewChips(a.assigned_to ? [a.assigned_to] : [], team, { rows: dayRows[day], jobId: null, people }),
    [team, dayRows, people],
  );
  /* A block's tap: its kind and record ("job:<id>", "visit:<id>", "ghost:<job id>") and the day. One
     sheet per block: a ghost opens inside the same sheet (schedule/ghost-sheet). */
  const onEventTap = useCallback((tapId: string, day: string) => {
    const [kind, id] = tapId.split(":");
    if ((kind === "job" || kind === "visit" || kind === "ghost") && id) setSheet({ kind, id, day });
  }, []);

  /** Each job's segments, by job: the days it is on (segments first), for the grid, the towns and the
   *  past blocks what happened is matched to. */
  const segByJob = useMemo(() => {
    const m = new Map<string, CalSegment[]>();
    for (const s of segments) {
      if (!m.has(s.job_id)) m.set(s.job_id, []);
      m.get(s.job_id)!.push(s);
    }
    return m;
  }, [segments]);

  const byDay = useMemo(() => {
    const m = new Map<string, DayData>();
    const get = (k: string) => {
      if (!m.has(k)) m.set(k, { jobs: [], appts: [], tasks: [], externals: [] });
      return m.get(k)!;
    };
    const pf = personFilter;

    for (const a of appointments) {
      if (pf && a.assigned_to !== pf) continue;
      /* ABSORBED = converted INTO its job (0237): the job is the one calendar presence, on every
         surface at once — filtered HERE so the grid, the month, and the day drill can never
         disagree. A visit merely ATTACHED to a job (a return trip) is not absorbed and draws. */
      if ((a as { absorbed?: boolean }).absorbed) continue;
      /* ON EVERY DAY IT COVERS, not just the one it starts on. Erik: "i set it for a week … but it
         only showed up as 1 day." A booking was filed under its start day alone, so a Monday-to-
         Friday job was drawn on Monday and Tuesday through Friday looked free — which is the
         overbooking the sizes exist to prevent, on the days he is most likely to fill. The days
         after the first skip weekends (apptSpanDays: the span was sized in working days). */
      for (const k of apptSpanDays(a, dayOf)) get(k).appts.push(a);
    }
    for (const t of tasks) {
      if (pf && t.assigned_to !== pf) continue;
      if (isYmd(t.due_date)) get(t.due_date).tasks.push(t);
    }
    // Mirrored Google events (read-only). All-day rows carry DATE strings as
    // <date>T00:00:00Z — slice the date out (a local parse would shift a
    // west-of-UTC viewer to the previous day); timed rows place like appts.
    // Google events have no CN assignee, so any person filter hides them.
    if (!pf) {
      for (const x of external) {
        if (x.all_day) {
          for (const day of allDayEventDays(x.starts_at.slice(0, 10), x.ends_at ? x.ends_at.slice(0, 10) : null)) {
            get(day).externals.push(x);
          }
        } else {
          get(dayOf(x.starts_at)).externals.push(x);
        }
      }
    }

    // Segments-first day expansion (jobDayRanges): a job with segments is placed only on the days its
    // ranges cover, so gaps (e.g. between two work weeks) stay empty; "d2/3" counts within its range.
    for (const j of jobs) {
      if (pf && !(j.assigned_to ?? []).includes(pf)) continue;
      for (const keys of jobDayRanges(j, segByJob.get(j.id), dayOf)) {
        keys.forEach((k, i) => get(k).jobs.push({ job: j, pos: keys.length > 1 ? `d${i + 1}/${keys.length}` : null }));
      }
    }

    for (const v of m.values()) {
      v.appts.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      v.externals.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, segByJob, appointments, tasks, external, personFilter, tz]);

  /** A day tap drills into that day, unless the rail has armed it (then it places the picked work). */
  const target = useDayTarget();
  /** Work is picked in the rail. Read out as a plain boolean because the week's columns depend on it:
   *  a weekend day is always drawn while armed, or there would be nothing there to drop a job onto. */
  const armed = target.armed;
  /** Days the rail just placed work on, whose bookings are not in `jobs`/`appointments` yet. Armed
   *  goes false the instant the writes return, a whole round trip before the refreshed data arrives,
   *  so without this an empty Saturday's column folded away under its own "Placed on Sat" toast. */
  const justPlaced = target.pl.justPlaced;
  const releasePlaced = target.pl.releasePlaced;
  /* LET GO WHEN THE SCREEN CATCHES UP. The provider cannot see this data, so the view that owns it
     says when it changed: a new RSC payload is new arrays, and from then on the held day stands on
     its own work like every other day — which is what lets an Undo fold the column back. */
  useEffect(() => {
    releasePlaced();
  }, [jobs, segments, appointments, tasks, external, releasePlaced]);

  /* THE SAME TAP, TWO MEANINGS — and the armed one wins. Armed, a day places the picked work;
     otherwise it drills in as it always has. Navigating away mid-pick would also throw the picks
     away, which is exactly the "leaving page and back page" churn Erik called frustrating. */
  function handleDayTap(d: Date) {
    if (target.armed) { target.pl.placeOn(dayKey(d)); return; }
    nav("day", dayKey(d), { push: true });
  }

  /** THE WHOLE WEEK, ALWAYS SEVEN — the week the anchor is in, in the company's own order. What the
   *  grid DRAWS is a subset of this (weekViewDays folds an empty weekend away), but every figure the
   *  week names about itself — its span label, whether today is in it, how far the stack may grow —
   *  is answered from here. A label computed from the drawn days would rename the week when a
   *  Saturday emptied out. */
  const weekDays = useMemo(() => weekDaysOf(anchor, weekStart), [anchor, weekStart]);

  // ── Time-grid data: week + day render through the shared TimeGrid, so a
  // morning inspection SITS at 9 AM instead of reading like any other chip
  // (Erik: "I can't differentiate a morning appointment from anything").
  const wdStartMin = hmToMin(workDayStart);
  const wdEndMin = Math.max(wdStartMin + 60, hmToMin(workDayEnd));

  /** A job's block on day `k` as the grid draws it (lib/schedule/job-block jobDayBlock: its own hours
   *  that day when it keeps them, else its usual hours), never zero-length. */
  const jobBlockOn = useCallback(
    (job: CalJob, k: string) => {
      const b = jobDayBlock({
        day: k,
        scheduledStart: job.scheduled_start,
        scheduledEnd: job.scheduled_end,
        plannedMinutes: job.planned_minutes,
        tz,
        wd: { startMin: wdStartMin, endMin: wdEndMin },
        dayHours: ownHours.get(job.id)?.get(k) ?? null,
      });
      return { startMin: b.startMin, endMin: b.endMin > b.startMin ? b.endMin : b.startMin + 60 };
    },
    [tz, wdStartMin, wdEndMin, ownHours],
  );

  /* ── WHAT HAPPENED (Wave 2, SV-actual) ───────────────────────────────────────────────────────────
     The past days' clocked time, matched to EXACTLY the blocks the grid draws (every job's days, each
     by its own hours; every visit on a job), for EVERYONE: hollow is decided before the person filter.
     Only days that are loaded whole are judged; with no clocked time in the window at all (a company
     that doesn't use the clock), nothing is: missing data is never "nobody went". */
  const spans = useMemo(() => unpackActuals(actuals), [actuals]);
  const clockInUse = spans.length > 0;
  /** Is this past day's clocked time loaded whole (so a block with none of it is truly hollow)? */
  const actualsWhole = useCallback(
    (k: string) => clockInUse && k < todayK && (!actualsCappedBefore || k >= actualsCappedBefore),
    [clockInUse, todayK, actualsCappedBefore],
  );
  const pastBlocks = useMemo(() => {
    const out: PlanBlock[] = [];
    const seen = new Set<string>();
    const add = (b: PlanBlock) => {
      if (seen.has(b.key) || !actualsWhole(b.dayStr)) return;
      seen.add(b.key);
      out.push(b);
    };
    for (const job of jobs) {
      for (const keys of jobDayRanges(job, segByJob.get(job.id), dayOf)) {
        for (const k of keys) {
          if (k >= todayK || k < winFrom) continue;
          add({ key: `j-${job.id}-${k}`, jobId: job.id, dayStr: k, ...jobBlockOn(job, k), kind: "job" });
        }
      }
    }
    for (const a of appointments) {
      // Drawn visits only: not absorbed into their job, not a call (a call is pinned, not a block).
      if ((a as { absorbed?: boolean }).absorbed || a.type === "call" || !a.job_id) continue;
      for (const k of apptSpanDays(a, dayOf)) {
        if (k >= todayK || k < winFrom) continue;
        add({ key: `a-${a.id}-${k}`, jobId: a.job_id, dayStr: k, ...apptDayMinutes(a, k, dayOf, minOf, { startMin: wdStartMin, endMin: wdEndMin }), kind: "visit" });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, segByJob, appointments, jobBlockOn, actualsWhole, todayK, winFrom, tz, wdStartMin, wdEndMin]);
  const pva = useMemo(
    () => (clockInUse ? planVsActual({ blocks: pastBlocks, spans, todayStr: todayK }) : null),
    [clockInUse, pastBlocks, spans, todayK],
  );
  /** A past day's worked time for the day drill's card (the track under the block): the booked span
   *  and who clocked in (person-filtered, like the grid), with the sentence. Null when not judged. */
  const dayActualFor = useCallback(
    (job: CalJob, k: string) => {
      if (!actualsWhole(k)) return null;
      const a = pva?.byKey.get(`j-${job.id}-${k}`);
      if (!a) return null;
      return {
        booked: jobBlockOn(job, k),
        people: personFilter ? a.people.filter((p) => p.profileId === personFilter) : a.people,
        sentence: a.sentence,
      };
    },
    [actualsWhole, pva, personFilter, jobBlockOn],
  );
  /* ── WORK NOBODY BOOKED (Wave 2, SV-ghost) ────────────────────────────────────────────────────────
     A job's past day with clocked time and NO booking that day draws as a dashed ghost. "Booked" is
     read from the raw rows (lib/schedule/booked-days), never from what the grid draws after the person
     filter. Only days loaded whole; today and later never get one. */
  const booked = useMemo(() => bookedKeys({ segments, jobs, appointments, tz }), [segments, jobs, appointments, tz]);
  /** The jobs the clocked time names (its job embed): a ghost can name a job the window's reads didn't bring. */
  const actualJobs = useMemo(() => new Map((actuals?.jobs ?? []).map((j) => [j.id, j])), [actuals]);
  const ghostsByDay = useMemo(() => {
    const m = new Map<string, GhostTarget[]>();
    if (!clockInUse) return m;
    for (const g of ghostsFor(spans, booked, todayK)) {
      if (!actualsWhole(g.dayStr) || g.dayStr < winFrom) continue;
      const known = actualJobs.get(g.jobId);
      const job = jobs.find((j) => j.id === g.jobId);
      const t: GhostTarget = {
        jobId: g.jobId,
        name: known?.name ?? job?.name ?? "A Job",
        jobNumber: known?.job_number ?? job?.job_number ?? null,
        customer: known?.customer ?? job?.customers?.name ?? null,
        people: g.people,
      };
      m.set(g.dayStr, [...(m.get(g.dayStr) ?? []), t]);
    }
    return m;
  }, [clockInUse, spans, booked, todayK, actualsWhole, winFrom, actualJobs, jobs]);
  /* The tapped block's sheet target, looked up in what's loaded now (so the refresh after a save shows
     the sheet what was saved; a job whose date was cleared, or a ghost booked into a real block, simply
     leaves, and the sheet with it). */
  const sheetTarget = useMemo<TileTarget | null>(() => {
    if (!sheet) return null;
    if (sheet.kind === "job") {
      const job = jobs.find((j) => j.id === sheet.id);
      // The tapped day's own hours ride along: the sheet's time is This Day's (0370). So does the crew
      // as that day's rows leave it: the sheet says who is off or on another job that day.
      return job
        ? { kind: "job", day: sheet.day, job, dayHours: ownHours.get(job.id)?.get(sheet.day) ?? null, dayCrew: jobCrewOn(job, sheet.day) }
        : null;
    }
    if (sheet.kind === "ghost") {
      const ghost = (ghostsByDay.get(sheet.day) ?? []).find((g) => g.jobId === sheet.id);
      return ghost ? { kind: "ghost", day: sheet.day, ghost } : null;
    }
    const visit = appointments.find((a) => a.id === sheet.id);
    return visit ? { kind: "visit", day: sheet.day, visit } : null;
  }, [sheet, jobs, appointments, ownHours, jobCrewOn, ghostsByDay]);
  /** A day's ghosts as the person filter leaves them: one shows only when that person has time in it,
   *  and only their bars. */
  const ghostsOn = useCallback(
    (k: string): GhostTarget[] =>
      (ghostsByDay.get(k) ?? []).flatMap((g) => {
        if (!personFilter) return [g];
        const mine = g.people.filter((p) => p.profileId === personFilter);
        return mine.length ? [{ ...g, people: mine }] : [];
      }),
    [ghostsByDay, personFilter],
  );
  /** The past job days with no time clocked TO THEM (the month's hollow tone). */
  const hollowKeys = useMemo(() => {
    const out = new Set<string>();
    for (const [key, a] of pva?.byKey ?? []) if (a.state === "hollow" && key.startsWith("j-")) out.add(key);
    return out;
  }, [pva]);

  /** THE DAY'S GHOSTS, dashed, as the person filter leaves them: the job's name on top, who it's for
   *  under it, the bars of who worked it; a tap opens it in the one sheet (the office), or the job. */
  function pushGhosts(k: string, events: TimeGridEvent[]) {
    for (const g of ghostsOn(k)) {
      const ends = g.people.flatMap((p) => p.spans.map((s) => s.endMin));
      const startMin = Math.min(...g.people.map((p) => p.startMin));
      const endMin = Math.max(startMin + 15, ...ends);
      const who = String(g.customer ?? "").trim();
      events.push({
        id: `g-${g.jobId}-${k}`,
        dayStr: k,
        startMin,
        endMin,
        label: g.name,
        sub: who && ghostTitle(g) !== g.name ? who : null,
        color: GHOST_GRID_TONE,
        ghost: true,
        actual: { people: g.people.map((p) => ({ key: p.profileId, initials: p.initials, dot: p.dot, spans: p.spans })), sentence: peopleWords(g.people) },
        href: `/jobs/${g.jobId}`,
        ...(canEdit ? { tapId: `ghost:${g.jobId}` } : {}),
      });
    }
  }

  /** One day's grid pills + all-day tray items. Jobs take their scheduled
   *  window — an explicit (non-sentinel) start time on their start day — or
   *  the org work-day window when all-day; appointments run starts_at →
   *  ends_at (or +1h); tasks have no time of day, so they ride the tray
   *  (never faked into a slot). `openApptRecords`: in the DAY view an appt
   *  pill opens the appointment itself (/appointments/[id] — view + Edit
   *  Details, like a job pill opens its job); in the WEEK view it keeps
   *  drilling into the day (the drill list carries the edit/move handles). */
  function gridDataFor(k: string, opts?: { openApptRecords?: boolean }): { events: TimeGridEvent[]; allDay: TimeGridAllDay[] } {
    const data = byDay.get(k);
    const events: TimeGridEvent[] = [];
    const tray: TimeGridAllDay[] = [];
    if (!data) {
      // A day nothing was booked on can still have been worked.
      pushGhosts(k, events);
      return { events, allDay: tray };
    }
    /* A PAST DAY LOADED WHOLE shows what happened (the bars, hollow) instead of the crew as planned;
       today and later, and a past day whose clocked time isn't loaded, show who's on it. */
    const judged = actualsWhole(k);
    for (const { job, pos } of data.jobs) {
      /* THE BLOCK IS WHAT WAS SAVED: its start, and the end its length gives it, in the org's clock
         (lib/schedule/job-block jobDayBlock, the one rule the writer, the fitter and the time
         controls share; jobBlockOn). THE SENTINEL NEEDS BOTH ENDS (Nora's 9–11 at a 9 o'clock shop
         is timed); a sized job never draws the closing-time stamp older writes put on every end; a
         job over several days draws its hours on each of them. A DAY WITH ITS OWN HOURS (0370) draws
         exactly those. */
      const { startMin, endMin } = jobBlockOn(job, k);
      const id = `j-${job.id}-${k}`;
      const actual = judged ? gridActualOf(pva?.byKey.get(id), personFilter) : undefined;
      events.push({
        id,
        dayStr: k,
        startMin,
        endMin,
        label: job.name,
        /* WHERE AND WHO, IN THE BLOCK (Erik: "we definitly need the address showing up on the job
           block with info too"): the street (or who, when the name is the street), the crew as
           initials (a dashed Nobody), the time, the town; as much as the block has room for. A past
           day's crew is what happened: its bars (below), never the plan's chips. */
        info: {
          place: placeLine({ name: job.name, street: job.address, customer: job.customers?.name })?.text ?? null,
          town: job.city ?? null,
          time: pos ? `${spanShort(startMin, endMin)} · ${pos}` : spanShort(startMin, endMin),
          crew: judged ? null : jobCrewOn(job, k),
        },
        ...(actual ? { actual } : {}),
        color: JOB_GRID_TONE,
        href: `/jobs/${job.id}`,
        // Staff tap the block for its day, its time and its crew (the tile's sheet); Open The Job is inside.
        ...(canEdit ? { tapId: `job:${job.id}` } : {}),
      });
    }
    /* Jobs drawn on THIS day, so an appointment that became one isn't drawn beside itself. */
    const jobsHere = new Set(data.jobs.map((x) => x.job.id));

    for (const a of data.appts) {
      /* Absorbed rows never reach here (filtered at byDay, 0237). What remains: an INSPECTION
         that spawned a job hides only where its job draws the same day — two real events on two
         days stay two events. */
      if (a.job_id && jobsHere.has(a.job_id)) continue;

      /* A CALL IS NOT A STOP. Erik: "lets have phone call just pin to the top of that day."
         He is right and it is not cosmetic. A call is the one kind of work you do from wherever
         you already are — the truck, the supply house counter, a job you are standing on. Giving it
         a slot in the timed grid makes it compete for the day's TRAVEL, so a ten-minute call to the
         PUD drew a block beside a service call and made a free afternoon look booked. In the tray
         it is on the day, visible, first thing, and costs the route nothing. */
      if (a.type === "call") {
        tray.push({
          id: `a-${a.id}`,
          dayStr: k,
          label: visitTitle(a.title),
          color: apptGridColor(a),
          href: opts?.openApptRecords ? `/appointments/${a.id}` : `/schedule?view=day&date=${k}`,
        });
        continue;
      }
      // Org-tz placement: a 9 AM Pacific inspection sits at minute 540 on the
      // Pacific day — Date#getHours here answered in the server's UTC on SSR
      // (and React doesn't re-verify style attrs on hydration, so the pills
      // STAYED at UTC positions — the "UTC problem in the new calendars").
      /* A DAY IN THE MIDDLE OF A SPAN IS A WHOLE WORKING DAY. Only the first day starts at the
         booked time and only the last day ends at the booked time; the days between are full. */
      const { startMin, endMin } = apptDayMinutes(a, k, dayOf, minOf, { startMin: wdStartMin, endMin: wdEndMin });
      const id = `a-${a.id}-${k}`; // keyed per day — a span appears on several
      /* A RETURN VISIT ON A JOB draws the time clocked to its job that day, unless that job has its own
         block that day (hidden by the person filter here: the time went to the job's block). A visit is
         NEVER drawn hollow: a city inspection or a meeting on a job is booked time nobody clocks, and
         a hollow sentence there would be a false zero. A visit with no job is never judged. */
      const visitActual = judged && a.job_id && !pva?.byKey.has(`j-${a.job_id}-${k}`) ? pva?.byKey.get(id) : undefined;
      const actual = visitActual?.state === "worked" ? gridActualOf(visitActual, personFilter) : undefined;
      events.push({
        id,
        dayStr: k,
        startMin,
        endMin,
        // A block titled during the three days the visit was a "Walk-Through" reads today's word
        // here too (lib/statuses visitTitle); a title a person typed is untouched.
        label: visitTitle(a.title),
        // A visit likewise: its street (or who, when the title is the street), its one person going.
        info: {
          place: placeLine({ name: a.title, street: streetOf(visitPlace(a)), customer: a.customers?.name ?? a.jobs?.name ?? null })?.text ?? null,
          town: townOf(visitPlace(a)) || null,
          time: spanShort(startMin, endMin),
          crew: actual ? null : visitCrewOn(a, k),
        },
        ...(actual ? { actual } : {}),
        color: apptGridColor(a),
        /* STRAIGHT TO THE THING, from every view. Erik, on a booking whose length was wrong:
           "i now have now way to adjust the time." There WAS a way — tap the pill, land in the day
           drill, find the edit pencil — but a control you have to already know about is not a way,
           it is a rumour. Staff get the tile's sheet (the day, the start, the length and who's
           going, with Open The Visit inside), so the fix is on the tap that saw the problem; the record
           page is the href underneath. */
        href: `/appointments/${a.id}`,
        ...(canEdit ? { tapId: `visit:${a.id}` } : {}),
      });
    }
    for (const t of data.tasks) {
      tray.push({
        id: `t-${t.id}`,
        dayStr: k,
        label: t.title,
        color: TASK_TRAY_TONE,
        href: taskHref(t),
      });
    }
    pushGhosts(k, events);
    // Mirrored Google events: zinc, NO href — read-only display, Google owns
    // them. All-day ones ride the tray; timed ones sit in their slot.
    for (const x of data.externals) {
      if (x.all_day) {
        tray.push({ id: `x-${x.id}-${k}`, dayStr: k, label: x.title, color: EXTERNAL_GRID_TONE });
        continue;
      }
      const startMin = minOf(x.starts_at);
      let endMin = startMin + 60;
      if (x.ends_at) {
        if (dayOf(x.ends_at) === k && new Date(x.ends_at).getTime() > new Date(x.starts_at).getTime())
          endMin = Math.max(startMin + 15, minOf(x.ends_at));
      }
      events.push({
        id: `x-${x.id}`,
        dayStr: k,
        startMin,
        endMin,
        label: x.title,
        sub: "Google",
        color: EXTERNAL_GRID_TONE,
      });
    }
    return { events, allDay: tray };
  }

  /**
   * CONTINUOUS SCROLL. Erik: "the two week scroll needs to keep scrolling forward and back so i
   * can see everything, default to today of course."
   *
   * Two fixed weeks meant paging the moment he looked past them — and paging is a decision, you
   * commit to leaving what you were reading. `back`/`fwd` grow as he reaches either end, so the
   * span extends under him and the week he was looking at stays where it was. Starts at exactly
   * two weeks from today, which is the planning horizon an inspection gets booked in.
   */
  /* ONE HOOK, TWO STACKS — the week's and the month's — so a fix to the scroll can only be made
     once. Keyed on the anchor, so pressing Today collapses the span back to where he is. */
  /* CAPPED AT THE DATA'S EDGE — derived from the anchor's real distance to the shared window
     bounds, not hand-mirrored literals. The old fixed 17/52 and 3/12 were right only when the
     anchor WAS today: chevron ten weeks out first and the scroll could still overrun the fetch
     window, rendering real-looking weeks that were silently empty. Scrolling further is a real
     ask (widen cal-window), never a quiet lie. */
  const daysBetween = (a: string, z: string) =>
    Math.round((new Date(`${z}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / 86_400_000);
  const monthsBetween = (a: string, z: string) =>
    (Number(z.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(z.slice(5, 7)) - Number(a.slice(5, 7)));
  /* EVERY DAY OF THE OUTERMOST ROW MUST BE LOADED — the rows are calendar-aligned but the window
     is an instant span, so each cap measures from the row's own EDGE day, not the anchor: a week
     row's first day ≥ winFrom going back, its LAST day (start+6) ≤ winTo going forward, and a
     month counts only when winFrom sits on its 1st (mirroring the forward −1) — otherwise the
     window month's early days would draw as real-looking empty cells. */
  const weekStartK = dayKey(weekDays[0] ?? anchor);
  const weekStack = useEndlessStack(
    anchorK,
    Math.max(0, Math.floor(daysBetween(winFrom, weekStartK) / 7)),
    Math.max(1, Math.floor((daysBetween(weekStartK, winTo) - 6) / 7)),
  );
  const monthStack = useEndlessStack(
    anchorK,
    Math.max(0, monthsBetween(winFrom, anchorK) - (winFrom.slice(8, 10) === "01" ? 0 : 1)),
    Math.max(1, monthsBetween(anchorK, winTo) - 1),
  );

  const stackWeeks = useMemo(() => {
    const out: Date[][] = [];
    for (let w = -weekStack.back; w <= weekStack.fwd; w++) {
      out.push(weekDays.map((d) => { const x = new Date(d); x.setDate(x.getDate() + 7 * w); return x; }));
    }
    return out;
  }, [weekDays, weekStack.back, weekStack.fwd]);

  /* THE MONTH SCROLLS TOO. Erik: "lets make the month view apply all the same new rules." A month
     that pages is the dead end the fixed week was — you had to commit to leaving what you were
     reading just to see whether the job you are about to book runs into next month. */
  const stackMonths = useMemo(() => {
    const out: Date[] = [];
    for (let i = -monthStack.back; i <= monthStack.fwd; i++) {
      out.push(new Date(anchor.getFullYear(), anchor.getMonth() + i, 1));
    }
    return out;
  }, [anchor, monthStack.back, monthStack.fwd]);


  // Server-computed now in the ORG tz, so SSR and hydration agree on the now
  // line; TimeGrid's own minute ticker (also org-tz via the tz prop) takes over. Memoized: a fresh
  // object each render would defeat TimeGrid's memo on every mounted week.
  const gridNow = useMemo(() => ({ dayStr: todayStrInTz(tz, new Date(now)), min: tzMinutesOfDay(new Date(now), tz) }), [now, tz]);

  /** WHERE the day's committed work is. Jobs carry a town; an inspection's `location` is a bare
   *  street with no city, and inventing one would be worse than saying nothing. Jobs are the right
   *  anchor anyway — his ride-along case is "a walk through near a JOB that day".
   *  THE SAME PLACEMENT RULE AS THE PILLS: segments-first, person-filtered. This used to read only
   *  the scheduled_start/_end mirror, so a segmented Fri+Mon+Tue job drew pills on Monday with no
   *  town under them, a two-range job advertised its town on the empty gap week, and another
   *  tech's job steered ride-along placement while the person filter hid its pill. */
  const townSegs = segByJob;
  const townFor = (dayStr: string): string | undefined => {
    const towns = new Set<string>();
    for (const j of jobs ?? []) {
      if (personFilter && !(j.assigned_to ?? []).includes(personFilter)) continue;
      const city = String((j as { city?: string | null }).city ?? "").trim();
      if (!city) continue;
      const segs = townSegs.get(j.id);
      if (segs?.length) {
        // Date columns compare as YMD words (timezone law). Segments-first means the mirror
        // window below must NOT also apply — that else-if is the load-bearing shape.
        if (segs.some((sg) => dayStr >= sg.start_date && dayStr <= sg.end_date)) towns.add(city);
        continue;
      }
      /* ORG-TZ DAYS, like the pills right beside this label. Raw UTC slices put the town one day
         late: scheduled_end mirrors the org work-day end (17:00 Pacific = 00:00Z TOMORROW), so a
         job's town appeared on the day after it finished and missed its real last day. */
      const from = j.scheduled_start ? dayOf(j.scheduled_start) : "";
      const rawTo = j.scheduled_end ? dayOf(j.scheduled_end) : from;
      const to = rawTo && from && rawTo < from ? from : rawTo;
      if (from && dayStr >= from && dayStr <= (to || from)) towns.add(city);
    }
    return towns.size ? [...towns].sort().join(" · ") : undefined;
  };

  const dayGrid = view === "day" ? gridDataFor(anchorK, { openApptRecords: true }) : { events: [], allDay: [] };

  /* ONE WEEK'S GRID DATA, BUILT ONCE PER (WEEK, DATA) (the timecard-stack pattern). The endless stack
     re-renders on every growth, and TimeGrid's memo only bails when a mounted week's props keep their
     identity: its days, its blocks, its tray. So each week's data lives in a cache keyed by its first
     day, emptied only when the DATA changes (every array the blocks are drawn from, the day rows, the
     clocked time, the person filter, the clock and the company's day), never on a growth. The key holds
     every input's identity: a stale cache after router.refresh would draw yesterday's bars. */
  type WeekData = { days: TimeGridDay[]; events: TimeGridEvent[]; allDay: TimeGridAllDay[]; label: string; key: string; hasToday: boolean; loadsBack: boolean; hiddenWeekend: string[] };
  const weekCacheRef = useRef<{ key: unknown[]; map: Map<string, WeekData> }>({ key: [], map: new Map() });
  const weekData = useMemo(() => {
    /* `armed` is part of the key because it changes WHICH COLUMNS EXIST (below): a weekend day is
       always drawn while work is picked in the rail, so arming rebuilds every mounted week once.
       `justPlaced` is in it for the same reason and at the other end of the same gesture — the day a
       place just landed on keeps its column while un-arming and the refresh pass each other. */
    const key = [
      jobs, segments, appointments, tasks, external, actuals, actualsCappedBefore, dayRows, people, members, addableJobs,
      personFilter, tz, todayK, canEdit, workDayStart, workDayEnd, armed, justPlaced,
    ];
    const cache = weekCacheRef.current;
    if (key.length !== cache.key.length || key.some((v, i) => v !== cache.key[i])) weekCacheRef.current = { key, map: new Map() };
    const map = weekCacheRef.current.map;
    return stackWeeks.map((wk) => {
      /* THE WEEK'S IDENTITY IS ITS REAL FIRST DAY, drawn or not. Keying the cache (and the Card) on
         the first SHOWN column would renumber a Sunday-start week the moment its Sunday emptied out —
         the same week would arrive under two keys and the stack would remount it. */
      const first = dayKey(wk[0]);
      const had = map.get(first);
      if (had) return had;
      const all = wk.map((d) => {
        const k = dayKey(d);
        return {
          dayStr: k,
          label: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
          isToday: k === todayK,
          sublabel: townFor(k),
        };
      });
      /* WHAT EACH DAY HAS ON IT, before deciding which days get a column: exactly what this view
         would draw there (gridDataFor — jobs, visits, a call or a task in the tray, a ghost of work
         nobody booked, a mirrored Google event). Asked of all seven, because a day only folds away
         once its own bucket is known to be empty. */
      const drawn = new Map(all.map((d) => [d.dayStr, gridDataFor(d.dayStr)]));
      const { shown, hidden } = weekViewDays(all.map((d) => d.dayStr), {
        hasWork: (k) => {
          const g = drawn.get(k);
          return !!g && (g.events.length > 0 || g.allDay.length > 0);
        },
        todayStr: todayK,
        armed,
        justPlaced,
      });
      const keep = new Set(shown);
      const days = all.filter((d) => keep.has(d.dayStr));
      const events: TimeGridEvent[] = [];
      const allDay: TimeGridAllDay[] = [];
      for (const d of days) {
        const g = drawn.get(d.dayStr);
        if (!g) continue;
        events.push(...g.events);
        allDay.push(...g.allDay);
      }
      const built: WeekData = {
        days,
        events,
        allDay,
        /* FROM THE WHOLE WEEK, NOT THE DRAWN DAYS. The span the header names, whether this is "this
           week", and how far back the clocked time reaches are facts about the WEEK; reading them off
           `days` would make a week rename itself when its Saturday went quiet. */
        label: spanLabel(wk[0], wk[6], { month: "long" }),
        key: first,
        hasToday: all.some((d) => d.isToday),
        // A week with a past day older than the loaded clocked time says so (never drawn hollow).
        loadsBack: !!actualsCappedBefore && clockInUse && first < actualsCappedBefore && first < todayK,
        hiddenWeekend: hidden,
      };
      map.set(first, built);
      return built;
    });
    // gridDataFor and townFor read only what the key names (and what is derived from it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackWeeks, jobs, segments, appointments, tasks, external, actuals, actualsCappedBefore, dayRows, people, members, addableJobs, personFilter, tz, todayK, canEdit, workDayStart, workDayEnd, armed, justPlaced]);
  /** The day header's tap: drill into that day (stable, so a mounted week's grid never redraws for it). */
  const drillInto = useCallback((ds: string) => {
    window.history.pushState(null, "", `${window.location.pathname}?view=day&date=${ds}`);
  }, []);
  /** The armed day target, stable between renders (a fresh object would redraw every mounted week). */
  const armedProp = useMemo(
    () => (target.armed ? { label: dayTargetLabel(target.pl.armedCount), onPlace: target.pl.placeOn } : undefined),
    [target.armed, target.pl.armedCount, target.pl.placeOn],
  );

  /* THE YEAR, ALWAYS. Erik: "we have to put the year on there no way around it." Every one of
     these except the month view used to name a span with no year in it — fine when the calendar
     could only show the fortnight you had just arrived at, wrong the moment it scrolls a year in
     each direction. See lib/schedule/span-label for why it isn't hidden when it matches today. */
  const title =
    view === "month"
      ? spanLabel(stackMonths[0], endOfMonth(stackMonths[stackMonths.length - 1]), { month: "long" })
      : view === "week"
        ? spanLabel(stackWeeks[0][0], stackWeeks[stackWeeks.length - 1][6])
        : dayLabel(anchor);

  /* EVERY HEADER DOOR IS A 44px TARGET (W2-01). At 375px the row holds the three paging buttons, the
     title and three icons (four with the day drill's ← Week), so each keeps its 32px look and takes a
     transparent bleed to 44 (the icon-sm grammar: a ::before past every edge) rather than widening the
     row until it scrolls sideways. Everyone's Day's icon is first: once the Timeclock page's card is cut
     (lane 2), it is that board's only door. */
  const iconBtn =
    "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg before:absolute before:-inset-1.5 before:content-['']";

  return (
    <div className="space-y-3 turned:space-y-2">
      {/* SIDEWAYS, THE TWO HEADER ROWS ARE ONE ROW (Erik, 2026-10-01). Held sideways a phone has
          ~402pt of height and the paging row and the Day/Week/Month row cost ~90 of it stacked. There
          is width to spare in that orientation and no height at all, so they sit side by side: same
          buttons, same order, same 44px targets, one row less of the screen spent on chrome. */}
      <div className="space-y-3 turned:flex turned:items-center turned:gap-2 turned:space-y-0">
        {/* ROW 1 — paging + title + the door icons (Everyone's Day, map, person filter), every one a
            44px target. The SectionSubnav pill above stays the ONLY brand-lit chrome. */}
        <div className="flex min-w-0 items-center gap-1 turned:flex-1">
          <Button size="icon-sm" variant="outline" onClick={() => shiftAnchor(-1)} aria-label="Previous" title="Previous">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => nav(view, todayK)}
            className="relative overflow-visible! before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-['']"
          >
            Today
          </Button>
          <Button size="icon-sm" variant="outline" onClick={() => shiftAnchor(1)} aria-label="Next" title="Next">
            <ChevronRight className="h-4 w-4" />
          </Button>
          {/* The way back out of the day drill — the PWA has no back chrome. */}
          {view === "day" && (
            <button
              onClick={() => nav("week", anchorK)}
              className="relative ml-1 shrink-0 text-xs font-medium text-brand hover:underline before:absolute before:-inset-x-1 before:-inset-y-3.5 before:content-['']"
            >
              ← Week
            </button>
          )}
          <span className="ml-1 min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{title}</span>
          {crewBoard && (
            <Link
              href="/schedule?view=crew"
              aria-label="Everyone's Day (crew board)"
              title="Everyone's Day — the whole crew, side by side"
              className={`${iconBtn} text-slate-400 hover:bg-slate-100 hover:text-slate-700`}
            >
              <Columns3 className="h-4 w-4" />
            </Link>
          )}
          <Link
            href="/schedule?view=map"
            aria-label="Job map"
            title="Job map"
            className={`${iconBtn} text-slate-400 hover:bg-slate-100 hover:text-slate-700`}
          >
            <MapPin className="h-4 w-4" />
          </Link>
          <button
            onClick={() => setFilterOpen((v) => !v)}
            aria-label="Filter by person"
            title="Filter by person"
            className={`${iconBtn} ${personFilter ? "bg-brand-light/50 text-brand" : "text-slate-400 hover:bg-slate-100 hover:text-slate-700"}`}
          >
            <Users className="h-4 w-4" />
          </button>
        </div>

        {/* ROW 2 — zoom. Url-synced, not brand-lit (sub-toggle grammar). */}
        <SegmentedControl
          activeId={view}
          onSelect={(id) => nav(id as View, anchorK)}
          items={[
            { id: "day", label: "Day" },
            { id: "week", label: "Week" },
            { id: "month", label: "Month" },
          ]}
        />
      </div>

      {/* The type-color legend is GONE: month cells now carry a labeled
          icon+count per type (briefcase/calendar/checkbox), and week/day chips
          are already color + text — so nothing needs a dot key to decode. The
          one glyph that still means something on its own, ◌ = awaiting the
          customer's pick, is titled on the chip/dot itself. */}

      {/* Person filter chips — only when summoned (or active), so the header
          stays three rows. Filtering answers "who works where"; nothing on the
          calendar is color-coded by person anymore. */}
      {(filterOpen || personFilter) && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {/* Each chip a 44px tap (the button), the pill its look (W2-01). */}
          <button onClick={() => setPersonFilter(null)} aria-pressed={personFilter === null} className="flex h-11 shrink-0 items-center">
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                personFilter === null ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              Everyone
            </span>
          </button>
          {members.map((m) => (
            <button
              key={m.id}
              onClick={() => setPersonFilter((p) => (p === m.id ? null : m.id))}
              aria-pressed={personFilter === m.id}
              className="flex h-11 shrink-0 items-center"
            >
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  personFilter === m.id ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {firstNameOf(m.full_name)}
              </span>
            </button>
          ))}
          {personFilter && unassignedHidden > 0 && (
            <span className="shrink-0 text-[11px] text-slate-400">· {unassignedHidden} unassigned hidden</span>
          )}
        </div>
      )}

      {/* NOTHING SILENT: the clocked time didn't load, so no past block shows what happened (and
          none is drawn hollow: missing data is not nobody). One quiet line says so. */}
      {actuals === null && (
        <p className="text-xs text-slate-500">Clocked time didn&apos;t load, so past days show only what was booked.</p>
      )}

      {/* ARMED, AND SAYING SO WHERE THE TAP HAPPENS.
          The rail's bar is pinned to the bottom of the RAIL, which on a phone sits above the
          calendar — so by the time you have scrolled down to the day you want, the only thing
          telling you the calendar is loaded is the calendar itself. This strip rides with it, and
          carries the way OUT: without it, disarming from down here meant scrolling back up to find
          Clear, which is a dead end at the exact moment somebody changes their mind. */}
      {target.armed && (
        <div className="sticky top-0 z-30 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-brand/40 bg-brand-light/90 px-3 py-2 text-sm backdrop-blur">
          <span className="font-semibold text-brand">{dayTargetLabel(target.pl.armedCount)}</span>
          <span className="text-xs font-medium uppercase tracking-wide text-brand/70">
            {/* An exact time beats the half — the strip must not read "morning" while the write is
                about to book 3pm. Same precedence as the rail's footer and the write itself. */}
            {/^\d{2}:\d{2}$/.test(target.pl.startAt)
              ? `at ${target.pl.startAt}`
              : target.pl.half === "am" ? "morning" : "afternoon"}
          </span>
          <span className="text-xs text-slate-600">Tap any day below.</span>
          {target.pl.pending && <span className="text-xs font-medium text-brand">Placing…</span>}
          <button
            type="button"
            onClick={target.pl.clear}
            className="ml-auto inline-flex min-h-11 items-center px-1 text-xs font-semibold text-slate-600 underline-offset-2 hover:underline"
          >
            Cancel
          </button>
        </div>
      )}

      {view === "month" && (
        /* THE SAME RULES AS THE WEEK. Scrolls both ways without paging, each month names itself
           with its year, and a picked rail turns every cell into a target. One MonthGrid per month
           rather than a new grid, so nothing about a month cell can drift from the single one. */
        <div
          ref={monthStack.scrollRef}
          onScroll={monthStack.onScroll}
          className="cal-stack max-h-[max(70dvh,calc(100dvh-14rem))] space-y-3 overflow-y-auto turned:space-y-2"
        >
          {stackMonths.map((m) => {
            const isNow = m.getFullYear() === anchor.getFullYear() && m.getMonth() === anchor.getMonth();
            return (
              <Card key={`${m.getFullYear()}-${m.getMonth()}`} className="overflow-clip">
                <div
                  className={`sticky top-0 z-20 border-b px-3 py-1.5 text-xs font-semibold backdrop-blur ${
                    isNow ? "border-brand/30 bg-brand-light/70 text-brand" : "border-slate-100 bg-white/90 text-slate-500"
                  }`}
                >
                  {m.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
                </div>
                <MonthGrid
                  anchor={m}
                  byDay={byDay}
                  hollow={hollowKeys}
                  ghostsOn={ghostsOn}
                  todayK={todayK}
                  tz={tz}
                  weekStart={weekStart}
                  onPick={handleDayTap}
                  armedLabel={target.prop?.label}
                />
              </Card>
            );
          })}
        </div>
      )}
      {view === "week" && (
        /* THE WEEK VIEW *IS* THE STACK. Erik: "lets keep the scroll as week view and get rid of the
           fixed week view." The fixed one was a second answer to the same question and the one
           nobody reached for — a week you cannot scroll out of is a week you have to page away
           from, and paging is a decision. Same TimeGrid per week, so every behaviour (the now line,
           the all-day tray, work-day shading, tap-to-place) is inherited, never reimplemented. */
        <div
          ref={weekStack.scrollRef}
          onScroll={weekStack.onScroll}
          className="cal-stack max-h-[max(70dvh,calc(100dvh-14rem))] space-y-3 overflow-y-auto turned:space-y-2"
        >
          {weekData.map(({ days, events: ev, allDay: tray, label, key: weekKey, hasToday, loadsBack, hiddenWeekend }) => {
            /* WHICH MONTH AM I LOOKING AT. Erik, scrolling: "i dont know what month it is on the
               schedule." Day headers read "Mon 25" — fine in a fixed week, useless once the span
               scrolls through months. The header sticks to the top of the scroller so the answer
               is always on screen, and it names both months when a week straddles them. */
            /* The year was CONDITIONAL here — shown only when it differed from today's. That is
               the overdue-badge mistake again: a fact you can only read if you remember the rule
               that governs its absence. Now it is simply always there, and a week that crosses a
               year names both. (Built once per week and data: weekData.) */
            return (
              /* overflow-CLIP, not hidden. `hidden` makes this Card a scroll container, and a
                 sticky child resolves against its NEAREST scrollport — so the month header stuck to
                 a box that never scrolls, i.e. it did not stick at all, and scrolled away with its
                 week. `clip` still trims the grid to the rounded corners without creating a
                 scrollport, so the header pins to the real scroller and answers "what month is
                 this" the whole way down, which was the entire point of adding it. */
              <Card key={weekKey} className="overflow-clip">
                <div
                  className={`sticky top-0 z-20 border-b px-3 py-1.5 text-xs font-semibold backdrop-blur ${
                    hasToday
                      ? "border-brand/30 bg-brand-light/70 text-brand"
                      : "border-slate-100 bg-white/90 text-slate-500"
                  }`}
                >
                  {label}
                  {hasToday && <span className="ml-2 text-[10px] font-bold uppercase tracking-wide">this week</span>}
                  {/* THE WEEKEND IT FOLDED AWAY, NAMED AND STILL A DOOR. Nothing is drawn with work on
                      it, so a hidden day is a day that is clear — but the week says which days those
                      are (so growing a Saturday column next time is something it already warned you
                      about), and each one opens as a day, where Add To Schedule lives. 20px of look and
                      44px of thumb through the bleed idiom (`before` past every edge, the header's own
                      grammar), so the law is kept without the header growing a line. */}
                  {hiddenWeekend.length > 0 && (
                    <span className="ml-2 text-[11px] font-normal text-slate-400">
                      Nothing on{" "}
                      {hiddenWeekend.map((k, i) => (
                        <span key={k}>
                          {i > 0 && ", "}
                          <button
                            type="button"
                            onClick={() => drillInto(k)}
                            title={`Open ${shortDayWords(k)}`}
                            className="relative inline-flex h-5 items-center align-middle underline-offset-2 hover:text-slate-600 hover:underline before:absolute before:-inset-x-1.5 before:-inset-y-3 before:content-['']"
                          >
                            {shortDayWords(k)}
                          </button>
                        </span>
                      ))}
                    </span>
                  )}
                  {/* NOTHING SILENT: older than the clocked time loaded, a past block is never drawn
                      hollow (missing data is not nobody), and the week says why it shows no bars. */}
                  {loadsBack && actualsCappedBefore && (
                    <span className="block text-[11px] font-normal text-slate-500">
                      Clocked time loads back to {dayWords(actualsCappedBefore)}.
                    </span>
                  )}
                </div>
                <TimeGrid
                  days={days}
                  events={ev}
                  allDay={tray}
                  workStartMin={wdStartMin}
                  workEndMin={wdEndMin}
                  tz={tz}
                  initialNow={gridNow}
                  onDayClick={drillInto}
                  placement={armedProp}
                  onEventTap={canEdit ? onEventTap : undefined}
                  onSlotTap={canEdit && !target.armed ? onSlotTap : undefined}
                />
              </Card>
            );
          })}
        </div>
      )}
      {view === "day" && (
        <>
          {/* ADD TO SCHEDULE ON THIS DAY: any job, at the work day's start (or tap an open time on the
              grid below for that time). Here even on an empty day, where there is no grid to tap. */}
          {canEdit && !target.armed && (
            <button
              type="button"
              onClick={() => onSlotTap(anchorK, null)}
              className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-brand/40 bg-white px-4 text-sm font-semibold text-brand hover:bg-brand-light/40"
            >
              <Plus className="h-4 w-4" /> Add To Schedule
            </button>
          )}
          {(dayGrid.events.length > 0 || dayGrid.allDay.length > 0) && (
            <Card className="overflow-hidden">
              <TimeGrid
                days={[
                  {
                    dayStr: anchorK,
                    label: anchor.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
                    isToday: anchorK === todayK,
                  },
                ]}
                events={dayGrid.events}
                allDay={dayGrid.allDay}
                workStartMin={wdStartMin}
                workEndMin={wdEndMin}
                tz={tz}
                initialNow={gridNow}
                placement={armedProp}
                onEventTap={canEdit ? onEventTap : undefined}
                onSlotTap={canEdit && !target.armed ? onSlotTap : undefined}
              />
            </Card>
          )}
          {/* AN EMPTY DAY IS STILL A DAY YOU CAN PLACE ON. The grid above only renders when there
              is something to draw, so on a free day an armed person would have had nothing to tap —
              a dead end at the exact moment of deciding. */}
          {target.armed && (
            <button
              type="button"
              onClick={() => target.pl.placeOn(anchorK)}
              className="w-full rounded-xl border-2 border-dashed border-brand/50 bg-brand-light/30 px-4 py-3 text-sm font-semibold text-brand hover:bg-brand-light"
            >
              {dayTargetLabel(target.pl.armedCount)}
            </button>
          )}
          {/* The drill cards below keep every create/edit/move affordance. */}
          <DayDetail
            dayK={anchorK}
            data={byDay.get(anchorK)}
            members={members}
            picker={picker}
            tz={tz}
            workDay={{ start: workDayStart, end: workDayEnd }}
            ownHours={ownHours}
            onOpenJob={canEdit ? (jobId) => setSheet({ kind: "job", id: jobId, day: anchorK }) : undefined}
            onOpenVisit={canEdit ? (visitId) => setSheet({ kind: "visit", id: visitId, day: anchorK }) : undefined}
            jobCrewOn={jobCrewOn}
            visitCrewOn={visitCrewOn}
            actualFor={dayActualFor}
            ghosts={ghostsOn(anchorK)}
            canEdit={canEdit}
          />
        </>
      )}

      {/* THE TILE'S SHEET — day, time, crew — for the block just tapped (the office only). */}
      {canEdit && (
        <ScheduleTileSheet
          target={sheetTarget}
          onClose={() => setSheet(null)}
          tz={tz}
          workDay={{ start: workDayStart, end: workDayEnd }}
          team={members}
          canEdit={canEdit}
          crewBoard={crewBoard}
          perDayHours={perDayHours}
        />
      )}

      {/* ADD TO SCHEDULE — any job onto the day (and half hour) tapped (the office only). */}
      {canEdit && (
        <AddToScheduleSheet
          at={adding}
          jobs={addableJobs}
          team={members}
          workDay={{ start: workDayStart, end: workDayEnd }}
          onClose={() => setAdding(null)}
        />
      )}

    </div>
  );
}

/** Month = density map: date numeral + compact icon+count chips per record
 *  TYPE (briefcase=jobs blue, calendar=appts violet, checkbox=tasks slate) —
 *  the glyph carries the type, so a cell reads without a legend. A count shows
 *  ONLY when it's > 0; if the three together would crowd the cell (total > 6),
 *  it collapses to a single neutral total badge so 375px never overflows.
 *  Names live one tap down in the day drill — 10px truncated chips were noise. */
/** Compact time like "8a" / "2:30p" for a month-cell pill — ORG-tz, so the
 *  server render and every browser print the same clock time. */
function pillTime(iso: string, tz: string): string {
  const min = tzMinutesOfDay(iso, tz);
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ap = h >= 12 ? "p" : "a";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")}${ap}` : `${h}${ap}`;
}

const PILL_TONE: Record<"job" | "jobHollow" | "ghost" | "appt" | "apptProposed" | "task" | "external", string> = {
  job: "bg-blue-50 text-blue-700",
  // A past job day with no time clocked to it (hollow): its hue in a faint outline, the fill gone.
  jobHollow: "bg-white/40 text-blue-400 ring-1 ring-inset ring-blue-200",
  // Work nobody booked (a ghost, part D): dashed, slate, white — never a booking's look.
  ghost: "border border-dashed border-slate-400 bg-white/60 text-slate-700",
  appt: "bg-violet-50 text-violet-700",
  apptProposed: "bg-violet-50 text-violet-400",
  task: "bg-slate-100 text-slate-600",
  external: "bg-zinc-100 text-zinc-500", // mirrored Google events — read-only
};

/** Order a day's jobs/appts/tasks into labelled pills (timed first), for the month grid. */
function monthPills(
  data: DayData | undefined,
  tz: string,
  dayK?: string,
  /** Past job days with no time clocked to them (block keys, "j-<job>-<day>"), drawn hollow. */
  hollow?: ReadonlySet<string>,
  /** The day's work nobody booked: a dashed pill, "<job name> · <customer>". */
  ghosts?: readonly GhostTarget[],
): { label: string; tone: keyof typeof PILL_TONE; sort: number }[] {
  const out: { label: string; tone: keyof typeof PILL_TONE; sort: number }[] = [];
  for (const g of ghosts ?? []) out.push({ label: ghostTitle(g), tone: "ghost", sort: Number.MAX_SAFE_INTEGER - 2 });
  if (!data) return out;
  const dayOf = (iso: string) => todayStrInTz(tz, new Date(iso)); // org-tz, same rule as the grid
  for (const { job, pos } of data.jobs) {
    const t = job.scheduled_start ? new Date(job.scheduled_start).getTime() : Number.MAX_SAFE_INTEGER;
    const cust = job.customers?.name;
    // WHICH DAY OF IT THIS IS — the week view says "d2/3" and the month said nothing, so a
    // three-day job read as three unrelated jobs.
    const base = cust ? `${job.name} · ${cust}` : job.name;
    out.push({ label: pos ? `${base} · ${pos}` : base, tone: dayK && hollow?.has(`j-${job.id}-${dayK}`) ? "jobHollow" : "job", sort: t });
  }
  for (const a of data.appts) {
    // Absorbed rows are filtered at byDay (0237); an inspection hides only beside its own job.
    if (a.job_id && data.jobs.some((x) => x.job.id === a.job_id)) continue;

    const who = a.customers?.name || a.jobs?.name || visitTitle(a.title);
    /* A SPAN'S START TIME BELONGS TO ITS FIRST DAY ONLY. A Mon-9am three-day booking used to read
       "9a Karen" on Wednesday too — asserting a 9am visit on a day the week view correctly draws
       as a full working day. Mid-span days carry the name alone and sort to the top like all-day
       work. */
    const firstDay = !dayK || dayOf(a.starts_at) === dayK;
    /* A CALL HAS NO TIME WORTH PRINTING. It is pinned to the top of the day in the week view
       because it is made from wherever you already are; stamping "9:00" on it in the month would
       re-assert exactly the slot the week view stopped pretending it occupies. */
    const isCall = a.type === "call";
    out.push({
      label: isCall ? `☎ ${who}` : firstDay ? `${pillTime(a.starts_at, tz)} ${who}` : who,
      tone: a.status === "proposed" ? "apptProposed" : "appt",
      // Calls sort to the top of the cell, which is where the week view puts them too; a mid-span
      // day sorts like all-day work rather than by a start instant it doesn't own.
      sort: isCall ? -1 : firstDay ? new Date(a.starts_at).getTime() : 0,
    });
  }
  for (const t of data.tasks) out.push({ label: t.title, tone: "task", sort: Number.MAX_SAFE_INTEGER });
  for (const x of data.externals) {
    out.push(
      x.all_day
        ? { label: x.title, tone: "external", sort: Number.MAX_SAFE_INTEGER - 1 }
        : { label: `${pillTime(x.starts_at, tz)} ${x.title}`, tone: "external", sort: new Date(x.starts_at).getTime() },
    );
  }
  return out.sort((x, y) => x.sort - y.sort);
}

const MONTH_MAX_PILLS = 3;

function MonthGrid({
  anchor,
  byDay,
  hollow,
  ghostsOn,
  todayK,
  tz,
  weekStart,
  onPick,
  armedLabel,
}: {
  anchor: Date;
  byDay: Map<string, DayData>;
  /** Past job days with no time clocked to them (the hollow tone; no bars in a month cell). */
  hollow?: ReadonlySet<string>;
  /** A day's work nobody booked, person-filtered (a dashed pill). */
  ghostsOn?: (k: string) => GhostTarget[];
  todayK: string;
  tz: string;
  /** The company's week start — the month's rows begin on it, and so do the headings below. */
  weekStart: WeekStart;
  onPick: (d: Date) => void;
  /** Set while work is picked in the rail — every cell becomes a target and says so. */
  armedLabel?: string;
}) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  /* THE SAME WEEK START AS THE WEEK VIEW. The month's first cell and its column headings both come
     from the one rule now; they used to be a hardcoded Sunday and a hardcoded ["Sun", …] beside a
     week view this lane moved to Monday — two answers to "when does the week start" on one screen,
     and the headings would have been off by one the moment either moved alone.
     THE WHOLE MONTH IS ALWAYS DRAWN. The weekend rule folds away a weekend COLUMN on the week view,
     where a column is 92 pixels of a phone; a month cell is a seventh of one row, and a month missing
     its Saturdays would be a calendar you cannot count on. */
  const start = weekDaysOf(first, weekStart)[0];
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    cells.push(d);
  }

  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {weekdayHeadings(weekStart).map((d) => (
          <div key={d} className="py-1.5">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d, i) => {
          const k = dayKey(d);
          const data = byDay.get(k);
          const inMonth = d.getMonth() === anchor.getMonth();
          const pills = monthPills(data, tz, k, hollow, ghostsOn?.(k));
          return (
            <button
              key={i}
              onClick={() => onPick(d)}
              title={armedLabel ? `${armedLabel} — ${d.toLocaleDateString()}` : undefined}
              className={`flex min-h-[92px] flex-col items-stretch justify-start gap-1 overflow-hidden border-b border-r border-slate-100 p-1 text-left ${
                armedLabel
                  ? "bg-brand-light/25 hover:bg-brand-light"
                  : `hover:bg-slate-50 ${inMonth ? "" : "bg-slate-50/60"}`
              }`}
            >
              <div
                className={`shrink-0 text-xs ${
                  k === todayK
                    ? "inline-flex h-5 w-5 items-center justify-center self-start rounded-full bg-[rgb(var(--glass-ink))] font-semibold text-white"
                    : inMonth ? "text-slate-500" : "text-slate-300"
                }`}
              >
                {d.getDate()}
              </div>
              {/* Horizontal pills — the day's jobs/appointments/tasks with real labels (timed first),
                  so the month reads at a glance. Capped per cell; the day drill shows the rest. */}
              {pills.length > 0 && (
                <div className="w-full space-y-0.5 overflow-hidden">
                  {pills.slice(0, MONTH_MAX_PILLS).map((p, pi) => (
                    <span
                      key={pi}
                      title={p.label}
                      className={`block w-full truncate rounded px-1 py-[1px] text-[10px] font-medium leading-snug ${PILL_TONE[p.tone]}`}
                    >
                      {p.label}
                    </span>
                  ))}
                  {pills.length > MONTH_MAX_PILLS && (
                    <span className="block px-1 text-[10px] font-semibold text-slate-400">+{pills.length - MONTH_MAX_PILLS} more</span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/** Day drill: timed appointments (edit pencil + quick done/cancel live HERE
 *  now — the appointments tab is gone), all-day job cards, then tasks due. */
function DayDetail({
  dayK,
  data,
  members = [],
  picker,
  tz,
  workDay,
  ownHours,
  onOpenJob,
  onOpenVisit,
  jobCrewOn,
  visitCrewOn,
  actualFor,
  ghosts = [],
  canEdit = false,
}: {
  dayK: string;
  data?: DayData;
  members?: CalMember[];
  picker: SchedulePicker;
  tz: string;
  workDay: { start: string; end: string };
  /** Each job's own hours by day (0370): the card reads the day as the grid draws it. */
  ownHours?: Map<string, Map<string, { start: string; end: string }>>;
  /** The office: a job card opens the tile's sheet (day, time, crew) for this day. */
  onOpenJob?: (jobId: string) => void;
  /** The office: a visit row's person opens the same sheet for that visit (its day, time, who's going). */
  onOpenVisit?: (visitId: string) => void;
  /** The crew as that day's rows leave it (Everyone's Day), for the cards and the rows. */
  jobCrewOn?: (job: Pick<CalJob, "id" | "assigned_to">, day: string) => CrewChip[];
  visitCrewOn?: (a: Pick<CalAppt, "assigned_to">, day: string) => CrewChip[];
  /** A past day: what happened on a job's block (the card draws it as a small track). */
  actualFor?: (job: CalJob, day: string) => { booked: { startMin: number; endMin: number }; people: WorkedPerson[]; sentence: string } | null;
  /** The day's work nobody booked (SV-ghost): a dashed "Worked, Not Booked" row under the booked cards. */
  ghosts?: GhostTarget[];
  /** The office: Book This Day on a ghost's row. */
  canEdit?: boolean;
}) {
  const appts = data?.appts ?? [];
  const jobsOn = data?.jobs ?? [];
  const tasksDue = data?.tasks ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-brand" />
            <h3 className="text-sm font-semibold text-slate-900">Appointments</h3>
          </div>
          {/* keyed per day so a fresh open prefills the VIEWED day, and the
              first mounted create instance answers /schedule?…&new=1 */}
          <AppointmentButton key={dayK} compact jobs={picker.jobs} customers={picker.customers} staff={picker.staff} defaultDate={dayK} />
        </div>
        <ul className="divide-y divide-slate-100">
          {appts.map((a) => (
            <ApptRow
              key={a.id}
              a={a}
              picker={picker}
              tz={tz}
              crew={visitCrewOn ? visitCrewOn(a, dayK) : undefined}
              onOpenPerson={onOpenVisit ? () => onOpenVisit(a.id) : undefined}
            />
          ))}
          {!appts.length && (
            <li className="px-5 py-5 text-center text-sm text-slate-400">Nothing booked this day.</li>
          )}
        </ul>
      </Card>

      <Card>
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <Briefcase className="h-4 w-4 text-brand" />
          <h3 className="text-sm font-semibold text-slate-900">Scheduled jobs</h3>
        </div>
        <div className="grid gap-2 p-3 sm:grid-cols-2">
          {jobsOn.map(({ job }) => (
            <JobScheduleCard
              key={job.id}
              job={{
                id: job.id,
                name: job.name,
                job_number: job.job_number,
                status: job.status,
                scheduled_start: job.scheduled_start,
                scheduled_end: job.scheduled_end,
                planned_minutes: job.planned_minutes ?? null,
                assigned_to: job.assigned_to ?? null,
                customers: job.customers ?? null,
                address: job.address ?? null,
                city: job.city ?? null,
              }}
              members={members}
              tz={tz}
              workDay={workDay}
              day={dayK}
              dayHours={ownHours?.get(job.id)?.get(dayK) ?? null}
              onOpen={onOpenJob ? () => onOpenJob(job.id) : undefined}
              crew={jobCrewOn ? jobCrewOn(job, dayK) : undefined}
              actual={actualFor ? actualFor(job, dayK) : null}
            />
          ))}
          {!jobsOn.length && (
            <div className="col-span-full py-5 text-center text-sm text-slate-400">Nothing scheduled.</div>
          )}
          {/* WORKED, NOT BOOKED (SV-ghost): under the booked cards, each dashed, with its track, its
              words and the same two doors as its sheet (44px each: the guaranteed door when a ghost is
              squeezed in a week). */}
          {ghosts.map((g) => (
            <GhostRow key={`ghost-${g.jobId}`} day={dayK} ghost={g} canEdit={canEdit} />
          ))}
        </div>
      </Card>

      {tasksDue.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
            <ListTodo className="h-4 w-4 text-brand" />
            <h3 className="text-sm font-semibold text-slate-900">Tasks due</h3>
          </div>
          <ul className="divide-y divide-slate-100">
            {tasksDue.map((t) => (
              <TaskRow key={t.id} t={t} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** One appointment on the day drill — the old appointments-tab row, relocated:
 *  quick done/cancel + edit pencil + the Move-to-day glyph. */
function ApptRow({
  a,
  picker,
  tz,
  crew,
  onOpenPerson,
}: {
  a: CalAppt;
  picker: SchedulePicker;
  tz: string;
  /** Who's going, as that day's rows leave them (an 'off' row dims them). Absent: the one person as saved. */
  crew?: CrewChip[];
  /** The office: the person opens the tile's sheet for this visit (its day, time and who's going). */
  onOpenPerson?: () => void;
}) {
  const router = useRouter();
  const place = visitPlace(a);
  const going: CrewChip[] =
    crew ?? (a.assigned_to ? crewChips([a.assigned_to], [{ id: a.assigned_to, full_name: a.profiles?.full_name ?? null }]) : []);
  // What a person READS; `appt.title` below stays the STORED string, because that one is the edit
  // form's value and a display word must never be written back over a row (lib/statuses visitTitle).
  const shownTitle = visitTitle(a.title);
  const appt: ApptValue = {
    id: a.id,
    type: a.type,
    title: a.title,
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    job_id: a.job_id,
    customer_id: a.customer_id,
    location: a.location,
    notes: a.notes,
    assigned_to: a.assigned_to,
  };
  return (
    <li className="flex flex-wrap items-start gap-3 px-4 py-3">
      {/* Time + title open the appointment itself (view + Edit Details) — an appt
          row is clickable exactly like a job card (Erik 7/15). The pencil/move
          handles on the right stay for in-place edits. */}
      <Link href={`/appointments/${a.id}`} className="w-16 shrink-0 text-sm font-medium text-slate-700 hover:text-brand">
        {formatTime(a.starts_at, tz)}
        {a.ends_at ? <span className="block text-[11px] font-normal text-slate-400">{formatTime(a.ends_at, tz)}</span> : null}
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {/* Inspection = teal everywhere; amber belongs to move-mode alone. Type label +
              inspection-shape come from the statuses.ts spine (isInspectionType covers
              final_inspection too — a raw a.type === "inspection" check dropped it). */}
          <Badge tone="blue" className={isInspectionType(a.type) ? "bg-teal-100 text-teal-800" : undefined}>
            {appointmentTypeLabel(a.type)}
          </Badge>
          <Link href={`/appointments/${a.id}`} className="truncate text-sm font-medium text-slate-900 hover:text-brand hover:underline">
            {shownTitle}
          </Link>
          {a.status === "completed" && <Badge tone="green">done</Badge>}
          {a.status === "proposed" && <Badge tone="amber">pending pick</Badge>}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
          {a.customers?.name && <span>{a.customers.name}</span>}
          {a.jobs && (
            <Link href={`/jobs/${a.job_id}`} className="text-brand hover:underline">
              {jobLabel(a.jobs)}
            </Link>
          )}
          {/* WHERE, as the visit's block says it: the street (the town small), never the zip; the
              whole line still drives Navigate. WHO'S GOING as the one initials chip, or Nobody. */}
          {place && (
            <NavLink address={place} className="inline-flex items-center gap-0.5 text-brand hover:underline">
              <MapPin className="h-3 w-3" /> {streetOf(place) || place}
              {townOf(place) && <span className="text-[11px] text-slate-400"> · {townOf(place)}</span>}
            </NavLink>
          )}
          {/* WHO'S GOING: marks, in the person's own color. For the office they sit in one 44px tap
              that opens the visit's sheet (its day, its time and who's going), the job card's twin. */}
          {onOpenPerson ? (
            <button
              type="button"
              onClick={onOpenPerson}
              aria-label={`${shownTitle}: day, time and who's going`}
              className="inline-flex min-h-11 items-center rounded-md px-1 hover:bg-slate-50"
            >
              <CrewInitials crew={going} />
            </button>
          ) : (
            <CrewInitials crew={going} />
          )}
        </div>
        {a.notes && <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-slate-500">{a.notes}</p>}
      </div>
      <div className="flex items-center gap-1">
        {/* Inspections get a capture surface: field notes/measurements/materials/photos
            that "Start estimate" carries into the estimator scope. Spine predicate so
            final_inspection keeps the shortcut too. */}
        {isInspectionType(a.type) && (
          <Link
            href={`/appointments/${a.id}`}
            className="flex h-11 w-11 items-center justify-center rounded-md text-slate-400 hover:bg-teal-50 hover:text-teal-700"
            title="Inspection — notes, measurements, photos"
            aria-label="Inspection — notes, measurements, photos"
          >
            <ClipboardList className="h-4 w-4" />
          </Link>
        )}
        <ApptQuickActions id={a.id} status={a.status} title={shownTitle} />
        <AppointmentButton jobs={picker.jobs} customers={picker.customers} staff={picker.staff} appointment={appt} />
        <MoveToDay
          label={`Move ${shownTitle}`}
          triggerClassName="flex h-11 w-11 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          onPick={async (iso) => {
            if (!iso) return { ok: false, error: "Pick a day." };
            if (a.status === "proposed" && !confirm(PROPOSED_CONFIRM)) return { ok: true, note: "Left it alone — the link is still live." };
            const t = shiftApptToDay(a.starts_at, a.ends_at, iso, tz); // org tz (audit v921 review)
            const res = await rescheduleAppointment(a.id, t.start, t.end);
            if (res.ok) router.refresh();
            return res; // a returned `note` (withdrawn link) surfaces as a toast
          }}
        />
      </div>
    </li>
  );
}

/** One task due this day — link to where it's worked + the Move glyph
 *  (due_date only; the /tasks workbench owns everything else). */
function TaskRow({ t }: { t: CalTask }) {
  const router = useRouter();
  const sub = [t.assignee?.full_name ?? null, t.jobs ? jobLabel(t.jobs) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Badge tone="slate">task</Badge>
      <Link href={taskHref(t)} className="min-w-0 flex-1 hover:opacity-80">
        <div className="truncate text-sm font-medium text-slate-900">{t.title}</div>
        {sub && <div className="truncate text-xs text-slate-400">{sub}</div>}
      </Link>
      <MoveToDay
        label={`Move ${t.title}`}
        clearable
        triggerClassName="flex h-11 w-11 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        onPick={async (iso) => {
          const res = await updateTask(t.id, { due_date: iso }, { jobId: t.job_id, category: t.category as TaskCategory });
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </li>
  );
}
