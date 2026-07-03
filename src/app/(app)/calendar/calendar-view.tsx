"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CalendarClock, CalendarDays, CalendarSync, Briefcase, ListTodo, SquareCheck, MapPin, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";
import { MoveToDay } from "@/components/move-to-day";
import { NavLink } from "@/components/nav-link";
import { firstNameOf } from "@/lib/employee-color";
import { shiftApptToDay } from "@/lib/appt-time";
import { placeJobOnDay, setJobScheduleRanges } from "../schedule/actions";
import { rescheduleAppointment } from "../appointments/actions";
import { updateTask, type TaskCategory } from "../tasks/actions";
import { AppointmentButton, type ApptValue } from "../appointments/appointment-button";
import { ApptQuickActions } from "../appointments/appointment-status";
import { JobScheduleCard } from "../schedule/job-schedule-card";
import { WeekAgenda } from "../schedule/week-agenda";

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
  assigned_to?: string[] | null;
  customers?: { name: string } | null;
}

export interface CalMember {
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

/** A job with no date yet — shown in the "To schedule" tray. */
export interface CalUnscheduled {
  id: string;
  job_number: string;
  name: string;
  customer: string | null;
}

/** One job's presence on one day (pos = "d2/3" on multi-day spans). */
export interface JobOnDay {
  job: CalJob;
  pos: string | null;
}

export interface DayData {
  jobs: JobOnDay[];
  appts: CalAppt[];
  tasks: CalTask[];
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

type View = "month" | "week" | "day";

const dayKey = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const isYmd = (s: string | null | undefined): s is string => /^\d{4}-\d{2}-\d{2}$/.test(s ?? "");
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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

export function CalendarView({
  jobs,
  segments = [],
  appointments = [],
  tasks = [],
  unscheduled = [],
  members = [],
  picker,
  now,
}: {
  jobs: CalJob[];
  segments?: CalSegment[];
  appointments?: CalAppt[];
  tasks?: CalTask[];
  unscheduled?: CalUnscheduled[];
  members?: CalMember[];
  picker: SchedulePicker;
  /** Server's "now" (ISO) — keeps SSR and first client render in sync. */
  now: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [pending, start] = useTransition();

  // Seed "today" from the SERVER clock so SSR and hydration agree, then correct
  // to the user's actual local day on mount (the existing calendar pattern).
  const [today, setToday] = useState(() => new Date(now));
  useEffect(() => setToday(new Date()), []);
  const todayK = dayKey(today);

  // View + anchor are DERIVED from the URL (single source of truth) so the
  // browser back button walks the day-drill history; nav() below writes the
  // URL shallowly and Next syncs useSearchParams without an RSC fetch.
  const rawView = searchParams.get("view");
  const view: View = rawView === "day" || rawView === "month" ? rawView : "week";
  const dateParam = searchParams.get("date");
  const anchor = useMemo(
    () => (isYmd(dateParam) ? new Date(`${dateParam}T00:00:00`) : today),
    [dateParam, today],
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
      tasks.filter((t) => !t.assigned_to && isYmd(t.due_date)).length
    );
  }, [personFilter, jobs, segments, appointments, tasks]);

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
      if (!m.has(k)) m.set(k, { jobs: [], appts: [], tasks: [] });
      return m.get(k)!;
    };
    const pf = personFilter;

    for (const a of appointments) {
      if (pf && a.assigned_to !== pf) continue;
      get(dayKey(new Date(a.starts_at))).appts.push(a);
    }
    for (const t of tasks) {
      if (pf && t.assigned_to !== pf) continue;
      if (isYmd(t.due_date)) get(t.due_date).tasks.push(t);
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
        pushSpan(j, new Date(j.scheduled_start), new Date(j.scheduled_end ?? j.scheduled_start));
      }
    }

    for (const v of m.values()) v.appts.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    return m;
  }, [jobs, segments, appointments, tasks, personFilter]);

  /** The job's current ranges as seen by this render — the tray-place undo
   *  snapshot. An empty result means "was unscheduled", which undo restores by
   *  writing []. */
  function snapshotJobRanges(jobId: string): { start: string; end: string }[] {
    const segs = segments.filter((s) => s.job_id === jobId).map((s) => ({ start: s.start_date, end: s.end_date }));
    if (segs.length) return segs;
    const j = jobs.find((x) => x.id === jobId);
    if (j?.scheduled_start) {
      const startYmd = dayKey(new Date(j.scheduled_start));
      const endYmd = j.scheduled_end ? dayKey(new Date(j.scheduled_end)) : startYmd;
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
  function handleDayTap(d: Date) {
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

  const title =
    view === "month"
      ? anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : view === "week"
        ? `${weekDays[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekDays[6].toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
        : anchor.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

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
            To schedule · {unscheduled.length} <ChevronDown className="h-3.5 w-3.5" />
          </button>
        ))}

      {view === "month" && <MonthGrid anchor={anchor} byDay={byDay} todayK={todayK} onPick={handleDayTap} />}
      {view === "week" && (
        <WeekAgenda days={weekDays} byDay={byDay} todayK={todayK} members={members} onDayTap={handleDayTap} />
      )}
      {view === "day" && <DayDetail dayK={anchorK} data={byDay.get(anchorK)} members={members} picker={picker} />}

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
function MonthGrid({
  anchor,
  byDay,
  todayK,
  onPick,
}: {
  anchor: Date;
  byDay: Map<string, DayData>;
  todayK: string;
  onPick: (d: Date) => void;
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
          const jobN = data?.jobs.length ?? 0;
          const apptN = data?.appts.length ?? 0;
          const taskN = data?.tasks.length ?? 0;
          // A hollow calendar ring means at least one appointment is still
          // awaiting the customer's pick (○, matching the chip/legend symbol).
          const anyProposed = (data?.appts ?? []).some((a) => a.status === "proposed");
          const total = jobN + apptN + taskN;
          return (
            <button
              key={i}
              onClick={() => onPick(d)}
              className={`flex min-h-[84px] flex-col items-start justify-start border-b border-r border-slate-100 p-1 text-left hover:bg-slate-50 ${
                inMonth ? "" : "bg-slate-50/60"
              }`}
            >
              <div
                className={`text-xs ${
                  k === todayK
                    ? "inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand font-semibold text-white"
                    : inMonth ? "text-slate-500" : "text-slate-300"
                }`}
              >
                {d.getDate()}
              </div>
              {total > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-0.5">
                  {total > 6 ? (
                    // Too much to itemize without overflowing a 375px cell —
                    // one neutral total; the day drill breaks it down.
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-slate-500">
                      <CalendarDays className="h-3 w-3 shrink-0" />
                      {total}
                    </span>
                  ) : (
                    <>
                      {jobN > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-blue-600" title={`${jobN} job${jobN > 1 ? "s" : ""}`}>
                          <Briefcase className="h-3 w-3 shrink-0" />
                          {jobN}
                        </span>
                      )}
                      {apptN > 0 && (
                        <span
                          className={`inline-flex items-center gap-0.5 text-[10px] font-semibold ${anyProposed ? "text-violet-400" : "text-violet-600"}`}
                          title={
                            anyProposed
                              ? `${apptN} appointment${apptN > 1 ? "s" : ""} — some awaiting pick`
                              : `${apptN} appointment${apptN > 1 ? "s" : ""}`
                          }
                        >
                          {/* Hollow calendar = something's still awaiting the
                              customer's pick; filled = all booked. */}
                          <CalendarDays className={`h-3 w-3 shrink-0 ${anyProposed ? "opacity-70" : ""}`} strokeWidth={anyProposed ? 1.5 : 2} />
                          {apptN}
                        </span>
                      )}
                      {taskN > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-slate-500" title={`${taskN} task${taskN > 1 ? "s" : ""}`}>
                          <SquareCheck className="h-3 w-3 shrink-0" />
                          {taskN}
                        </span>
                      )}
                    </>
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
}: {
  dayK: string;
  data?: DayData;
  members?: CalMember[];
  picker: SchedulePicker;
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
            <ApptRow key={a.id} a={a} picker={picker} />
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
function ApptRow({ a, picker }: { a: CalAppt; picker: SchedulePicker }) {
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
      <div className="w-16 shrink-0 text-sm font-medium text-slate-700">
        {fmtTime(a.starts_at)}
        {a.ends_at ? <span className="block text-[11px] font-normal text-slate-400">{fmtTime(a.ends_at)}</span> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {/* Inspection = teal everywhere; amber belongs to move-mode alone. */}
          <Badge tone="blue" className={a.type === "inspection" ? "bg-teal-100 text-teal-800" : undefined}>{a.type}</Badge>
          <span className="truncate text-sm font-medium text-slate-900">{a.title}</span>
          {a.status === "completed" && <Badge tone="green">done</Badge>}
          {a.status === "proposed" && <Badge tone="amber">pending pick</Badge>}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
          {a.customers?.name && <span>{a.customers.name}</span>}
          {a.jobs && (
            <Link href={`/jobs/${a.job_id}`} className="text-brand hover:underline">
              {a.jobs.job_number} {a.jobs.name}
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
  const sub = [t.assignee?.full_name ?? null, t.jobs ? `${t.jobs.job_number} · ${t.jobs.name}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Badge tone="slate">task</Badge>
      <Link href={t.job_id ? `/jobs/${t.job_id}?tab=tasks` : `/tasks/${t.category}`} className="min-w-0 flex-1 hover:opacity-80">
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
