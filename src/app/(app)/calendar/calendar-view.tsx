"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CalendarClock, CalendarSync, Briefcase, ClipboardList, ListTodo, MapPin, Users, Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented";
import { Card } from "@/components/ui/card";
import { usePlacement } from "../schedule/placement-context";
import { dayTargetLabel } from "@/lib/schedule/placement-plan";
import { dayLabel, spanLabel } from "@/lib/schedule/span-label";
import { useEndlessStack } from "@/components/use-endless-stack";
import { daysNeeded, jobBlockEnd, WORK_DAY_MINUTES } from "@/lib/schedule/work-shape";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { MoveToDay } from "@/components/move-to-day";
import { NavLink } from "@/components/nav-link";
import { TimeGrid, type TimeGridAllDay, type TimeGridEvent } from "@/components/time-grid";
import { hmToMin, todayStrInTz, tzMinutesOfDay } from "@/lib/tz";
import { formatTime } from "@/lib/utils";
import { firstNameOf } from "@/lib/employee-color";
import { shiftApptToDay } from "@/lib/appt-time";
import { placeJobOnDay, setJobScheduleRanges } from "../schedule/actions";
import { rescheduleAppointment } from "../appointments/actions";
import { updateTask, type TaskCategory } from "../tasks/actions";
import { taskHref } from "@/lib/task-href";
import { AppointmentButton, type ApptValue } from "../appointments/appointment-button";
import { ApptQuickActions } from "../appointments/appointment-status";
import { JobScheduleCard } from "../schedule/job-schedule-card";
import { jobLabel } from "@/lib/schedule-options";
import { appointmentTypeLabel, isInspectionType } from "@/lib/statuses";
import { allDayEventDays } from "@/lib/gcal-map";

// THE one forward-looking time map. WHEN-DID (clocked hours) lives on
// /timeclock + /timecards only — the old "Clocked time" layer, day-view
// "Timecard entries" and month per-person hour chips were a second display of
// that territory and are gone. Views are url-synced (?view=day|week|month +
// ?date=) via SHALLOW history writes: the server preloads a wide ±window once
// and every chevron/day tap slices it client-side — no RSC round-trip per tap.
//
// SAFETY (the deliberate-move law): a chip's MAIN tap OPENS its record — it is
// never a move. There is NO armed "tap a chip, then tap a day" mode: one stray
// tap while driving can't silently reschedule a real appointment. Every
// reschedule goes through the MoveToDay sheet (a day-strip + Cancel) hung off a
// small per-chip move handle, so it takes a deliberate two-step gesture inside
// a modal. A day tap only ever drills into that day.

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
}

// Internal-only since week-agenda.tsx (the last external importer) died in cn-v507.
interface CalMember {
  id: string;
  full_name: string | null;
}

export interface CalSegment {
  job_id: string;
  start_date: string; // yyyy-mm-dd
  end_date: string;
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
  jobs?: { job_number: string; name: string } | null;
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

/** A job with no date yet — shown in the "To schedule" tray. */
export interface CalUnscheduled {
  id: string;
  job_number: string;
  name: string;
  customer: string | null;
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
 * where is the whole question. Two weeks is the horizon a walk-through actually gets booked in,
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
const prettyYmd = (ymd: string) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

function startOfWeek(d: Date) {
  const r = new Date(d);
  r.setDate(r.getDate() - r.getDay()); // Sunday start
  r.setHours(0, 0, 0, 0);
  return r;
}

const PROPOSED_CONFIRM =
  "A pick-a-time link is out to the customer for this — moving it withdraws that link. Move it anyway?";

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
  segments = [],
  appointments = [],
  tasks = [],
  external = [],
  unscheduled = [],
  members = [],
  picker,
  now,
  tz,
  workDayStart = "08:00",
  workDayEnd = "16:00",
}: {
  jobs: CalJob[];
  segments?: CalSegment[];
  appointments?: CalAppt[];
  tasks?: CalTask[];
  /** Mirrored Google events — read-only zinc pills (0132 two-way sync). */
  external?: CalExternal[];
  unscheduled?: CalUnscheduled[];
  members?: CalMember[];
  picker: SchedulePicker;
  /** Server's "now" (ISO) — keeps SSR and first client render in sync. */
  now: string;
  /** The org's IANA timezone — EVERY instant→day/minutes mapping goes through
   *  it (the /timecards discipline), so the SSR (UTC server) and the browser
   *  place a 9 AM Pacific appointment at 9 AM on the Pacific day, always. */
  tz: string;
  /** The org's work_day_start ("HH:MM") — the all-day job time sentinel the
   *  week agenda hides. Defaults to the scheduler's original 8 AM. */
  workDayStart?: string;
  /** The org's work_day_end ("HH:MM") — an all-day job's block on the time
   *  grid spans start→end (the org's real work window, not a faked time). */
  workDayEnd?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [pending, start] = useTransition();

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
  const anchor = useMemo(
    () => new Date(`${isYmd(dateParam) ? dateParam : todayK}T00:00:00`),
    [dateParam, todayK],
  );
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
    nav(view, dayKey(d));
  }

  // "To schedule" tray: a collapsed one-line chip by default — the calendar
  // grid is the point of the page, not the backlog rail.
  const [trayOpen, setTrayOpen] = useState(false);

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

  // Undo for a tray placement — snapshot taken client-side BEFORE the write, so
  // "Schedule" a backlog job is one deliberate pick with a safety net. (Chip
  // moves run through the MoveToDay sheet's own confirm/error affordances.)
  const [undo, setUndo] = useState<{ label: string; run: () => Promise<{ ok: boolean; error?: string } | void> } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(t);
  }, [undo]);

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
         overbooking the sizes exist to prevent, on the days he is most likely to fill. */
      const first = dayOf(a.starts_at);
      const last = a.ends_at ? dayOf(a.ends_at) : first;
      get(first).appts.push(a);
      if (isYmd(first) && isYmd(last) && last > first) {
        const d = new Date(`${first}T12:00:00`);
        for (let i = 0; i < 60; i++) {
          d.setDate(d.getDate() + 1);
          // The span was SIZED in working days (spanEnd/workingDaysFrom skip weekends), so the
          // draw skips them too — a 3-day visit booked Friday runs Fri+Mon+Tue, and Saturday
          // stays blank instead of wearing a pill nobody scheduled. The FIRST day is exempt
          // above: a visit explicitly booked on a Saturday is a Saturday visit.
          if (d.getDay() === 0 || d.getDay() === 6) continue;
          const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          if (k > last) break;
          get(k).appts.push(a);
        }
      }
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

    // Segments-first day expansion: a job with segments is placed only on the
    // days its ranges cover, so gaps (e.g. between two work weeks) stay empty.
    const segByJob = new Map<string, CalSegment[]>();
    for (const s of segments) {
      if (!segByJob.has(s.job_id)) segByJob.set(s.job_id, []);
      segByJob.get(s.job_id)!.push(s);
    }
    const pushSpan = (j: CalJob, startD: Date, endD: Date) => {
      const d = new Date(startD);
      d.setHours(0, 0, 0, 0);
      const last = new Date(endD);
      last.setHours(0, 0, 0, 0);
      // Backstop against a runaway loop; sized above the widest fetch window
      // so legitimate long jobs aren't silently clipped.
      const keys: string[] = [];
      let guard = 0;
      while (d <= last && guard++ < 540) {
        keys.push(dayKey(d));
        d.setDate(d.getDate() + 1);
      }
      keys.forEach((k, i) => get(k).jobs.push({ job: j, pos: keys.length > 1 ? `d${i + 1}/${keys.length}` : null }));
    };
    for (const j of jobs) {
      if (pf && !(j.assigned_to ?? []).includes(pf)) continue;
      const segs = segByJob.get(j.id);
      if (segs?.length) {
        for (const s of segs) pushSpan(j, new Date(`${s.start_date}T00:00:00`), new Date(`${s.end_date}T00:00:00`));
      } else if (j.scheduled_start) {
        // scheduled_start/_end are INSTANTS: resolve each to its ORG-TZ day
        // first, then hand pushSpan pure local-midnight day anchors. Feeding
        // the raw timestamps in put an evening-scheduled Pacific job on the
        // UTC (next) day when server-rendered.
        const startYmd = dayOf(j.scheduled_start);
        const endYmd = j.scheduled_end ? dayOf(j.scheduled_end) : startYmd;
        pushSpan(j, new Date(`${startYmd}T00:00:00`), new Date(`${endYmd < startYmd ? startYmd : endYmd}T00:00:00`));
      }
    }

    for (const v of m.values()) {
      v.appts.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      v.externals.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, segments, appointments, tasks, external, personFilter, tz]);

  /** The job's current ranges as seen by this render — the tray-place undo
   *  snapshot. An empty result means "was unscheduled", which undo restores by
   *  writing []. */
  function snapshotJobRanges(jobId: string): { start: string; end: string }[] {
    const segs = segments.filter((s) => s.job_id === jobId).map((s) => ({ start: s.start_date, end: s.end_date }));
    if (segs.length) return segs;
    const j = jobs.find((x) => x.id === jobId);
    if (j?.scheduled_start) {
      const startYmd = dayOf(j.scheduled_start); // org-tz day, matching the grid placement
      const endYmd = j.scheduled_end ? dayOf(j.scheduled_end) : startYmd;
      return [{ start: startYmd, end: endYmd < startYmd ? startYmd : endYmd }];
    }
    return [];
  }

  /** Place a backlog (dateless) job on a day — the tray's "Schedule" gesture,
   *  routed to placeJobOnDay (a UNION write: a needs-return job keeps its
   *  worked-history segments). Runs inside the MoveToDay sheet, so it's already
   *  a deliberate two-step pick; undo restores the exact pre-place snapshot.
   *  Returns the MoveToDay result shape so the sheet reports errors inline. */
  async function placeOnDay(job: CalUnscheduled, targetYmd: string) {
    const prior = snapshotJobRanges(job.id);
    const res = await placeJobOnDay(job.id, targetYmd);
    if (!res.ok) return res;
    setUndo({ label: `${job.name} → ${prettyYmd(targetYmd)}`, run: () => setJobScheduleRanges(job.id, prior) });
    router.refresh();
    return res;
  }

  function runUndo() {
    if (!undo || pending) return;
    const u = undo;
    setUndo(null);
    start(async () => {
      const res = await u.run();
      if (res && !res.ok) return toast(res.error ?? "Couldn't undo — check the schedule.", "error");
      toast("Put back where it was.", "success");
      router.refresh();
    });
  }

  /** A day tap only ever drills into that day — never a move. */
  const target = useDayTarget();

  /* THE SAME TAP, TWO MEANINGS — and the armed one wins. Armed, a day places the picked work;
     otherwise it drills in as it always has. Navigating away mid-pick would also throw the picks
     away, which is exactly the "leaving page and back page" churn Erik called frustrating. */
  function handleDayTap(d: Date) {
    if (target.armed) { target.pl.placeOn(dayKey(d)); return; }
    nav("day", dayKey(d), { push: true });
  }

  const weekDays = useMemo(() => {
    const ws = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(ws);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [anchor]);

  // ── Time-grid data: week + day render through the shared TimeGrid, so a
  // morning inspection SITS at 9 AM instead of reading like any other chip
  // (Erik: "I can't differentiate a morning appointment from anything").
  const wdStartMin = hmToMin(workDayStart);
  const wdEndMin = Math.max(wdStartMin + 60, hmToMin(workDayEnd));

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
    if (!data) return { events, allDay: tray };
    for (const { job, pos } of data.jobs) {
      let startMin = wdStartMin;
      let endMin = wdEndMin;
      if (job.scheduled_start && dayOf(job.scheduled_start) === k) {
        // Org-tz minutes: the all-day sentinel is STORED as the org's local
        // work-day start (tzLocalHourUtc), so only an org-tz read can spot it.
        const sMin = minOf(job.scheduled_start);
        const eMin =
          job.scheduled_end && dayOf(job.scheduled_end) === k ? minOf(job.scheduled_end) : null;
        /* THE SENTINEL NEEDS BOTH ENDS. Erik: "the service calls arent matching the timeframes
           assigned." Nora's call is 9–11 — and the shop opens at 9, so a start-only test read her
           real 9:00 as the all-day sentinel and stretched a two-hour visit across the whole day.
           A job is all-day only when START and END both sit on the work-day window; a real end
           that differs makes it timed, wherever it starts. */
        const explicit = sMin !== wdStartMin || (eMin != null && eMin !== wdEndMin && eMin > sMin);
        const sized = Number(job.planned_minutes ?? 0);
        if (explicit) {
          startMin = sMin;
          // What was scheduled, then what he sized it at, then the shop's hours — see jobBlockEnd.
          endMin = jobBlockEnd(startMin, {
            scheduledEndMin: eMin,
            plannedMinutes: job.planned_minutes,
            workDayEndMin: wdEndMin,
          });
          if (endMin <= startMin) endMin = startMin + 60;
        } else if (sized > 0 && daysNeeded(sized) === 1) {
          /* A SIZED JOB IS NEVER THE BARE SENTINEL. A 2h job placed at the shop's opening hour
             reads exactly like the all-day marker on both ends (start = wdStart, mirrored end =
             wdEnd) — and drew all day, silently ignoring the number a person entered. The size
             breaks the tie: it draws its real span from the open. Multi-day sizes stay all-day
             per covered day, which is what a day of a multi-day job IS. */
          startMin = wdStartMin;
          endMin = Math.min(wdEndMin, wdStartMin + Math.min(sized, WORK_DAY_MINUTES));
          if (endMin <= startMin) endMin = startMin + 60;
        }
      }
      events.push({
        id: `j-${job.id}-${k}`,
        dayStr: k,
        startMin,
        endMin,
        label: job.name,
        sub: [job.customers?.name, pos].filter(Boolean).join(" · ") || null,
        color: JOB_GRID_TONE,
        href: `/jobs/${job.id}`,
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
          label: a.title,
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
      const firstDay = dayOf(a.starts_at) === k;
      const lastDay = !a.ends_at || dayOf(a.ends_at) === k;
      const startMin = firstDay ? minOf(a.starts_at) : wdStartMin;
      let endMin = startMin + 60;
      if (a.ends_at && new Date(a.ends_at).getTime() > new Date(a.starts_at).getTime()) {
        endMin = lastDay ? Math.max(startMin + 15, minOf(a.ends_at)) : Math.max(startMin + 15, wdEndMin);
      } else if (!lastDay) {
        endMin = Math.max(startMin + 15, wdEndMin);
      }
      events.push({
        id: `a-${a.id}-${k}`, // keyed per day — a span appears on several
        dayStr: k,
        startMin,
        endMin,
        label: a.title,
        sub: a.customers?.name ?? a.jobs?.name ?? null,
        color: apptGridColor(a),
        /* STRAIGHT TO THE THING, from every view. Erik, on a booking whose length was wrong:
           "i now have now way to adjust the time." There WAS a way — tap the pill, land in the day
           drill, find the edit pencil — but a control you have to already know about is not a way,
           it is a rumour. The record page carries the full form (start, end, type, notes), so the
           pill goes there and the fix is one tap from seeing the problem. */
        href: `/appointments/${a.id}`,
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
   * two weeks from today, which is the planning horizon a walk-through gets booked in.
   */
  /* ONE HOOK, TWO STACKS — the week's and the month's — so a fix to the scroll can only be made
     once. Keyed on the anchor, so pressing Today collapses the span back to where he is. */
  /* CAPPED AT THE DATA'S EDGE. CalendarPanel preloads −120..+400 days and paging never refetches
     — so a stack allowed to grow past that window rendered real-looking weeks and months that were
     silently EMPTY, which reads as "nothing scheduled" rather than "nothing loaded". The caps now
     mirror the fetch window: ~17 weeks / ~4 months back, ~52 weeks / ~13 months forward. Scrolling
     further is a real ask (widen the panel window), never a quiet lie. */
  const weekStack = useEndlessStack(anchorK, 17, 52);
  const monthStack = useEndlessStack(anchorK, 3, 12);

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


  const weekGridDays = weekDays.map((d) => {
    const k = dayKey(d);
    return { dayStr: k, label: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }), isToday: k === todayK };
  });
  // Server-computed now in the ORG tz, so SSR and hydration agree on the now
  // line; TimeGrid's own minute ticker (also org-tz via the tz prop) takes over.
  const gridNow = { dayStr: todayStrInTz(tz, new Date(now)), min: tzMinutesOfDay(new Date(now), tz) };

  /** WHERE the day's committed work is. Jobs carry a town; a walk-through's `location` is a bare
   *  street with no city, and inventing one would be worse than saying nothing. Jobs are the right
   *  anchor anyway — his ride-along case is "a walk through near a JOB that day". */
  const townFor = (dayStr: string): string | undefined => {
    const towns = new Set<string>();
    for (const j of jobs ?? []) {
      const city = String((j as { city?: string | null }).city ?? "").trim();
      if (!city) continue;
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
  const withTowns = (ds: typeof weekGridDays) => ds.map((d) => ({ ...d, sublabel: townFor(d.dayStr) }));

  const dayGrid = view === "day" ? gridDataFor(anchorK, { openApptRecords: true }) : { events: [], allDay: [] };

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

  const iconBtn = "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg";

  return (
    <div className="space-y-3">
      {/* ROW 1 — paging + title + the two door icons (map, person filter).
          The SectionSubnav pill above stays the ONLY brand-lit chrome. */}
      <div className="flex items-center gap-1">
        <Button size="sm" variant="outline" onClick={() => shiftAnchor(-1)} aria-label="Previous">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => nav(view, todayK)}>
          Today
        </Button>
        <Button size="sm" variant="outline" onClick={() => shiftAnchor(1)} aria-label="Next">
          <ChevronRight className="h-4 w-4" />
        </Button>
        {/* The way back out of the day drill — the PWA has no back chrome. */}
        {view === "day" && (
          <button onClick={() => nav("week", anchorK)} className="ml-1 shrink-0 text-xs font-medium text-brand hover:underline">
            ← Week
          </button>
        )}
        <span className="ml-1 min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">{title}</span>
        <Link
          href="/schedule?view=crew"
          aria-label="Everyone's Day (crew board)"
          title="Everyone's Day — the whole crew, side by side"
          className={`${iconBtn} text-slate-400 hover:bg-slate-100 hover:text-slate-700`}
        >
          <Columns3 className="h-4 w-4" />
        </Link>
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
          <button
            onClick={() => setPersonFilter(null)}
            className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
              personFilter === null ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            Everyone
          </button>
          {members.map((m) => (
            <button
              key={m.id}
              onClick={() => setPersonFilter((p) => (p === m.id ? null : m.id))}
              className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
                personFilter === m.id ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {firstNameOf(m.full_name)}
            </button>
          ))}
          {personFilter && unassignedHidden > 0 && (
            <span className="shrink-0 text-[11px] text-slate-400">· {unassignedHidden} unassigned hidden</span>
          )}
        </div>
      )}

      {/* ROW 3 — the "To schedule" tray: a collapsed amber chip (hidden at 0),
          expanding to the backlog. Each job carries its OWN Schedule handle →
          the MoveToDay sheet → placeJobOnDay (a UNION write, so a needs-return
          job keeps its history segments). No arming: pick the day right there. */}
      {unscheduled.length > 0 &&
        (trayOpen ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-2">
            <div className="mb-1.5 flex items-center justify-between px-1 text-xs">
              <span className="font-semibold text-amber-700">To schedule · {unscheduled.length}</span>
              <button onClick={() => setTrayOpen(false)} className="rounded p-0.5 text-amber-700 hover:bg-amber-100" aria-label="Collapse">
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {unscheduled.map((j) => (
                <div
                  key={j.id}
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-white pl-2.5 text-xs"
                >
                  <Link href={`/jobs/${j.id}`} className="min-w-0 py-1.5 text-left">
                    <div className="max-w-[160px] truncate font-medium text-slate-800">{j.name}</div>
                    <div className="truncate text-[11px] text-slate-400">{j.customer ?? j.job_number}</div>
                  </Link>
                  {/* The Schedule handle — a deliberate day pick, undo-safe. */}
                  <MoveToDay
                    label={`Schedule ${j.name}`}
                    triggerClassName="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-amber-600 hover:bg-amber-100"
                    onPick={async (iso) => {
                      if (!iso) return { ok: false, error: "Pick a day." };
                      return placeOnDay(j, iso);
                    }}
                  >
                    <CalendarSync className="h-4 w-4" />
                  </MoveToDay>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <button
            onClick={() => setTrayOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100"
          >
            To Schedule · {unscheduled.length} <ChevronDown className="h-3.5 w-3.5" />
          </button>
        ))}

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
            className="ml-auto text-xs font-semibold text-slate-600 underline-offset-2 hover:underline"
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
          className="max-h-[max(70dvh,calc(100dvh-14rem))] space-y-3 overflow-y-auto"
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
                  todayK={todayK}
                  tz={tz}
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
          className="max-h-[max(70dvh,calc(100dvh-14rem))] space-y-3 overflow-y-auto"
        >
          {stackWeeks.map((wk) => {
            const days = wk.map((d) => {
              const k = dayKey(d);
              return {
                dayStr: k,
                label: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
                isToday: k === todayK,
                sublabel: townFor(k),
              };
            });
            const ev: TimeGridEvent[] = [];
            const tray: TimeGridAllDay[] = [];
            for (const d of days) {
              const g = gridDataFor(d.dayStr);
              ev.push(...g.events);
              tray.push(...g.allDay);
            }
            /* WHICH MONTH AM I LOOKING AT. Erik, scrolling: "i dont know what month it is on the
               schedule." Day headers read "Mon 25" — fine in a fixed week, useless once the span
               scrolls through months. The header sticks to the top of the scroller so the answer
               is always on screen, and it names both months when a week straddles them. */
            /* The year was CONDITIONAL here — shown only when it differed from today's. That is
               the overdue-badge mistake again: a fact you can only read if you remember the rule
               that governs its absence. Now it is simply always there, and a week that crosses a
               year names both. */
            const label = spanLabel(wk[0], wk[6], { month: "long" });
            const hasToday = days.some((d) => d.isToday);
            return (
              /* overflow-CLIP, not hidden. `hidden` makes this Card a scroll container, and a
                 sticky child resolves against its NEAREST scrollport — so the month header stuck to
                 a box that never scrolls, i.e. it did not stick at all, and scrolled away with its
                 week. `clip` still trims the grid to the rounded corners without creating a
                 scrollport, so the header pins to the real scroller and answers "what month is
                 this" the whole way down, which was the entire point of adding it. */
              <Card key={days[0].dayStr} className="overflow-clip">
                <div
                  className={`sticky top-0 z-20 border-b px-3 py-1.5 text-xs font-semibold backdrop-blur ${
                    hasToday
                      ? "border-brand/30 bg-brand-light/70 text-brand"
                      : "border-slate-100 bg-white/90 text-slate-500"
                  }`}
                >
                  {label}
                  {hasToday && <span className="ml-2 text-[10px] font-bold uppercase tracking-wide">this week</span>}
                </div>
                <TimeGrid
                  days={days}
                  events={ev}
                  allDay={tray}
                  workStartMin={wdStartMin}
                  workEndMin={wdEndMin}
                  tz={tz}
                  initialNow={gridNow}
                  onDayClick={(ds) => nav("day", ds, { push: true })}
                  placement={target.prop}
                />
              </Card>
            );
          })}
        </div>
      )}
      {view === "day" && (
        <>
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
                placement={target.prop}
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
          <DayDetail dayK={anchorK} data={byDay.get(anchorK)} members={members} picker={picker} tz={tz} />
        </>
      )}

      {/* Undo — the safety net under a tray placement. */}
      {undo && (
        <div className="fixed inset-x-0 bottom-[calc(9rem+env(safe-area-inset-bottom))] z-[120] flex justify-center px-4">
          <div className="flex max-w-sm items-center gap-3 rounded-full bg-slate-900 px-4 py-2 text-sm text-white shadow-lg">
            <span className="min-w-0 truncate">Moved {undo.label}</span>
            <button onClick={runUndo} className="shrink-0 font-semibold text-amber-300 hover:text-amber-200">
              Undo
            </button>
          </div>
        </div>
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

const PILL_TONE: Record<"job" | "appt" | "apptProposed" | "task" | "external", string> = {
  job: "bg-blue-50 text-blue-700",
  appt: "bg-violet-50 text-violet-700",
  apptProposed: "bg-violet-50 text-violet-400",
  task: "bg-slate-100 text-slate-600",
  external: "bg-zinc-100 text-zinc-500", // mirrored Google events — read-only
};

/** Order a day's jobs/appts/tasks into labelled pills (timed first), for the month grid. */
function monthPills(data: DayData | undefined, tz: string, dayK?: string): { label: string; tone: keyof typeof PILL_TONE; sort: number }[] {
  if (!data) return [];
  const dayOf = (iso: string) => todayStrInTz(tz, new Date(iso)); // org-tz, same rule as the grid
  const out: { label: string; tone: keyof typeof PILL_TONE; sort: number }[] = [];
  for (const { job, pos } of data.jobs) {
    const t = job.scheduled_start ? new Date(job.scheduled_start).getTime() : Number.MAX_SAFE_INTEGER;
    const cust = job.customers?.name;
    // WHICH DAY OF IT THIS IS — the week view says "d2/3" and the month said nothing, so a
    // three-day job read as three unrelated jobs.
    const base = cust ? `${job.name} · ${cust}` : job.name;
    out.push({ label: pos ? `${base} · ${pos}` : base, tone: "job", sort: t });
  }
  for (const a of data.appts) {
    // Absorbed rows are filtered at byDay (0237); an inspection hides only beside its own job.
    if (a.job_id && data.jobs.some((x) => x.job.id === a.job_id)) continue;

    const who = a.customers?.name || a.jobs?.name || a.title;
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
  todayK,
  tz,
  onPick,
  armedLabel,
}: {
  anchor: Date;
  byDay: Map<string, DayData>;
  todayK: string;
  tz: string;
  onPick: (d: Date) => void;
  /** Set while work is picked in the rail — every cell becomes a target and says so. */
  armedLabel?: string;
}) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    cells.push(d);
  }

  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="py-1.5">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d, i) => {
          const k = dayKey(d);
          const data = byDay.get(k);
          const inMonth = d.getMonth() === anchor.getMonth();
          const pills = monthPills(data, tz, k);
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
}: {
  dayK: string;
  data?: DayData;
  members?: CalMember[];
  picker: SchedulePicker;
  tz: string;
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
            <ApptRow key={a.id} a={a} picker={picker} tz={tz} />
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
                assigned_to: job.assigned_to ?? null,
                customers: job.customers ?? null,
              }}
              members={members}
              date={dayK}
            />
          ))}
          {!jobsOn.length && (
            <div className="col-span-full py-5 text-center text-sm text-slate-400">Nothing scheduled.</div>
          )}
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
function ApptRow({ a, picker, tz }: { a: CalAppt; picker: SchedulePicker; tz: string }) {
  const router = useRouter();
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
            {a.title}
          </Link>
          {a.status === "completed" && <Badge tone="green">done</Badge>}
          {a.status === "proposed" && <Badge tone="amber">pending pick</Badge>}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
          {a.customers?.name && <span>{a.customers.name}</span>}
          {a.jobs && (
            <Link href={`/jobs/${a.job_id}`} className="text-brand hover:underline">
              {jobLabel(a.jobs)}
            </Link>
          )}
          {a.profiles?.full_name && <span>· {a.profiles.full_name}</span>}
          {a.location && (
            <NavLink address={a.location} className="inline-flex items-center gap-0.5 text-brand hover:underline">
              <MapPin className="h-3 w-3" /> {a.location}
            </NavLink>
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
            className="rounded-md p-1 text-slate-400 hover:bg-teal-50 hover:text-teal-700"
            title="Inspection capture — notes, measurements, photos"
          >
            <ClipboardList className="h-4 w-4" />
          </Link>
        )}
        <ApptQuickActions id={a.id} status={a.status} title={a.title} />
        <AppointmentButton jobs={picker.jobs} customers={picker.customers} staff={picker.staff} appointment={appt} />
        <MoveToDay
          label={`Move ${a.title}`}
          triggerClassName="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          onPick={async (iso) => {
            if (!iso) return { ok: false, error: "Pick a day." };
            if (a.status === "proposed" && !confirm(PROPOSED_CONFIRM)) return { ok: true, note: "Left it alone — the link is still live." };
            const t = shiftApptToDay(a.starts_at, a.ends_at, iso);
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
        triggerClassName="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        onPick={async (iso) => {
          const res = await updateTask(t.id, { due_date: iso }, { jobId: t.job_id, category: t.category as TaskCategory });
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </li>
  );
}
