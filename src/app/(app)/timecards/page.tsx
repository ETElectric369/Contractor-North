import { attachRates, payRateMap, payRateMapRead } from "@/lib/profile-columns";
import Link from "next/link";
import type { ReactNode } from "react";
import { isStaffRole } from "@/lib/actions/perms";
import { redirect } from "next/navigation";
import { AlertTriangle, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SegmentedControl } from "@/components/ui/segmented";
import {
  formatCurrency,
  formatDuration,
  formatDate,
  formatDateShort,
  formatTime,
  hoursBetween,
} from "@/lib/utils";
import { getOrgSettings, workDayWindowHm } from "@/lib/org-settings";
import { formatDateTimeTz, timeEntryGridSpan, tzDayStartUtc, tzMinutesOfDay, todayStrInTz } from "@/lib/tz";
import { balanceForPerson, toPayPaymentRow, type PayPaymentRow, type PersonBalance } from "@/lib/payroll-math";
import { getCrewStatus } from "@/lib/crew-status";
import { firstNameOf, pillColorForPerson } from "@/lib/employee-color";
import { TimecardStack, type Grouping, type StackEntry } from "./timecard-stack";
import { hmToMin } from "@/lib/tz";
import { AddEntryButton } from "../timeclock/add-entry-button";
import { EditEntryButton } from "./edit-entry-button";
import { OpenEntryEditor } from "./open-entry-editor";
import { DuplicateEntryButton } from "./duplicate-entry-button";
import type { JobCode } from "@/lib/types";
import { jobLabel } from "@/lib/schedule-options";
import { tolerateMissingColumns } from "@/lib/inspection/schema";
import { comparePlanToActual, needsAttention as needsAttentionRows, explain, type PlannedDay } from "@/lib/plan-vs-actual";
// The schedule's own answer for one person on one day. The SAME pure pick /schedule's crew board
// and /timeclock's "Next up" use, so the three surfaces cannot name different jobs for the same
// Wednesday (crew-plan.ts).
import { pickScheduledJobForDay } from "../timeclock/crew-plan";

export const dynamic = "force-dynamic";

// The pay-week window as UTC instants, anchored on the org's LOCAL day — not the
// (UTC-on-Vercel) server day — so a Pacific evening shift buckets into the right
// week. Starts Monday unless Settings → Scheduling says the week starts Sunday
// (org settings week_start). `start`/`end` are the UTC instants of local
// midnight, end exclusive.
function weekRange(offset: number, tz: string, weekStart: "sunday" | "monday") {
  const todayStr = todayStrInTz(tz);
  const utcDow = new Date(`${todayStr}T00:00:00Z`).getUTCDay(); // Sunday = 0
  const dow = weekStart === "sunday" ? utcDow : (utcDow + 6) % 7; // days since the week started
  const startDate = new Date(`${todayStr}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - dow - offset * 7);
  const start = tzDayStartUtc(startDate.toISOString().slice(0, 10), tz);
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + 7);
  const end = tzDayStartUtc(endDate.toISOString().slice(0, 10), tz);
  // The 7 local day-strings of the week — the time grid's columns.
  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setUTCDate(d.getUTCDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  return { start, end, days };
}

/** ── THE OWED ROW'S READS ────────────────────────────────────────────────────────────────────
 *
 *  This page used to carry its own roster of every person with hours, gross and a paid badge — a
 *  read-only mirror of /payroll sitting two inches under a grid of the same hours. Erik: "there is
 *  way too much in my face i dont even know what it all is and it looks like duplicates." The Pay
 *  page now owns "what do I owe" with real payments behind it, so the mirror collapses to ONE row
 *  carrying its headline figure and a way in.
 *
 *  The figure is computed by balanceForPerson — the SAME pure function /payroll uses, so the two
 *  screens cannot disagree about a man's money. Only the READ CONTRACT is copied here, and it is
 *  copied rather than shared because it has to behave identically: PostgREST stops at its
 *  db-max-rows cap with a 200 and no error, so a bare read is how a short list becomes a confident
 *  wrong number. Page it, advance by the rows ACTUALLY returned, stop only on an empty page. If
 *  either half of that contract is ever changed on /payroll, change it here in the same breath. */
const BALANCE_MONTHS = 18;
const PAGE_ROWS = 1000;
const MAX_PAGES = 12;
/** One projection, used by both entry reads, so a column can never go missing from one of them
 *  (THE PROJECTION LAW: the failure is always a select list). */
const BALANCE_ENTRY_COLS =
  "id, profile_id, clock_in, clock_out, lunch_minutes, miles, paid_at, mileage_paid_at, rate_override, profiles(full_name)";

type WholeRead<T> = { rows: T[]; problem: string | null };

async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<WholeRead<T>> {
  const out: T[] = [];
  for (let i = 0, from = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(from, from + PAGE_ROWS - 1);
    if (error || !data) return { rows: [], problem: "read failed" };
    if (!data.length) return { rows: out, problem: null };
    out.push(...data);
    from += data.length;
  }
  return { rows: [], problem: "too many rows to read at once" };
}

export default async function TimecardsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; entry?: string; group?: string }>;
}) {
  const { week, entry: entryParam, group } = await searchParams;
  const offset = Math.max(0, parseInt(week ?? "0", 10) || 0);
  /* ── HOW THE LEDGER IS STACKED ────────────────────────────────────────────────────────────
   *  By Day or By Person, in the URL, because he is not choosing it once: he pages weeks with
   *  the arrows, taps a shift, saves, and the page revalidates under him. A ?group= ride-along
   *  survives every one of those AND a refresh, where component state would have quietly put him
   *  back on By Day each time. It changes the GROUPING INSIDE each week and nothing else — never
   *  the span, so the number in a week header is always summed from the rows under it. */
  const grouping: Grouping = group === "person" ? "person" : "day";
  /** Every link back to this page carries the grouping, or the toggle resets the moment he pages
   *  a week or opens an entry (the paging arrows, the stack rows, the Fix These rows). */
  const hrefFor = (weekOffset: number, extra?: string) =>
    `/timecards?week=${weekOffset}${grouping === "person" ? "&group=person" : ""}${extra ? `&${extra}` : ""}`;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  if (!me || !isStaffRole(me.role)) {
    redirect("/timeclock");
  }

  const [{ data: members }, { data: jobCodes }, { data: jobs }, { data: org }, crew] = await Promise.all([
    // hourly_rate + bill_rate feed the edit/add modals' pay-rate anchor + the
    // bill-rate tripwire. Safe to select flat here — the page redirects non-staff
    // above, so the rates never serialize into a tech's props.
    supabase.from("profile_pay").select("id, full_name, hourly_rate, bill_rate").eq("active", true).order("full_name"),
    supabase.from("job_codes").select("*").eq("active", true).order("code"),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    // The live crew pulse (who's on the clock now) — moved here from My Day's
    // CrewBoard so presence lives next to the hours it becomes.
    getCrewStatus(supabase),
  ]);
  // Render times in the BUSINESS timezone, not the UTC server's, so the list
  // matches the (browser-local) edit modal instead of being hours off.
  const orgSettings = getOrgSettings((org as any)?.settings);
  const tz = orgSettings.timezone;

  const { start, end, days: weekDayStrs } = weekRange(offset, tz, orgSettings.week_start);

  // rate_override MUST be selected here: the edit modal round-trips it on save, so
  // omitting the column made every unrelated week-list edit send undefined→null and
  // WIPE a supervisor override (the cn-v291 wipe-fix silently defeated). paid_at /
  // mileage_paid_at let the modal show the payroll locks instead of a save error.
  const { data: entries } = await supabase
    .from("time_entries")
    .select(
      "id, profile_id, clock_in, clock_out, lunch_minutes, miles, rate_override, paid_at, mileage_paid_at, job_id, job_code, status, notes, source, profiles:profile_id(full_name), job:job_id(job_number, name), time_allocations(job_id, job_code, hours, description)",
    )
    .gte("clock_in", start.toISOString())
    .lt("clock_in", end.toISOString())
    .order("clock_in", { ascending: true });
  // The pay spine (rate + commute baseline) rides the staff-scoped profile_pay view, not this
  // embed: 0216 revoked those columns from the authenticated role. This grid read them through
  // an ALIASED embed — profiles:profile_id(...) — which two earlier sweeps' patterns missed,
  // so the whole page 42501'd until this merge landed.
  const payMap = await payRateMap(supabase);
  for (const e of (entries ?? []) as any[]) {
    if (!e?.profile_id || !e.profiles) continue;
    e.profiles = { ...e.profiles, ...(payMap.get(String(e.profile_id)) ?? {}) };
  }
  /** The commute baseline, per person, for the By Person mileage split (cn-v138). Off the
   *  staff-scoped view, never off `profiles` (0216). */
  const baselineById: Record<string, number> = {};
  for (const [id, r] of payMap) baselineById[id] = Number(r.commute_baseline_miles ?? 0);

  // "Needs attention" pull — open entries that should have been closed: anything
  // still open from a PAST day (a forgotten clock-out) or open more than 12 hours
  // today. One cheap org-wide query (open entries are a handful at most), so the
  // strip works regardless of which week is being viewed.
  //
  // AND THE ZERO-HOUR ROWS (0193). A forgotten shift is now closed at zero hours by the DB when
  // its owner punches in again, so the person is never locked out of their own timecard. But a
  // CLOSED row does not match `status = 'open'`, so without this it would have vanished from the
  // one screen that exists to catch it — a real day silently worth nothing. `auto_closed_reason`
  // is null on every ordinary shift, so this adds exactly the rows that need a human.
  const { data: openNow } = await supabase
    .from("time_entries")
    .select(
      "id, profile_id, clock_in, clock_out, lunch_minutes, miles, job_id, job_code, status, notes, source, rate_override, auto_closed_reason, profiles:profile_id(full_name), job:job_id(job_number, name), time_allocations(job_id, job_code, hours, description)",
    )
    .or("status.eq.open,auto_closed_reason.not.is.null")
    .order("clock_in", { ascending: true });
  const todayStartMs = tzDayStartUtc(todayStrInTz(tz), tz).getTime();
  const needsAttention = (openNow ?? []).filter((e: any) => {
    // A zero-closed row needs the office WHENEVER it happened — it is not a forgotten shift any
    // more, it is a shift with no hours on it, and that never ages out of being wrong.
    if (e.auto_closed_reason) return true;
    const inMs = new Date(e.clock_in).getTime();
    return inMs < todayStartMs || Date.now() - inMs > 12 * 3_600_000;
  });

  /**
   * PLAN vs ACTUAL for the week on screen. What the plan said, against where the hours landed.
   *
   * WHY THIS FEEDER GREW A SECOND READ (2026-09-18). It used to hand comparePlanToActual the
   * crew_day_assignments rows and nothing else, so any day with hours and no assignment row came
   * back "unplanned". ET Electric has written 24 of those rows in the app's whole life and none
   * since 2026-08-07 — the /timeclock week grid that wrote them lost both of its population
   * mechanisms in cn-v590 and the grid itself went in cn-v951 — so EVERY day anybody worked
   * produced a finding. Erik got five in one card, all of them about the job he and Jimmy had
   * genuinely been on all week: "we worked on the job that was in the schedule and the time cards
   * say Jason Waldow. Is this box accurate in any way that can help us?"
   *
   * It was not. So the plan now comes from where he actually keeps it — the JOB SCHEDULE — and
   * crew_day_assignments goes back to being what it is, a per-day OVERRIDE (0139/0170) that wins
   * when it exists and is silent when it does not. Three things are read:
   *
   *   1. THE OVERRIDE, as before, tolerantly (the 0170 `kind` column is young and a payroll review
   *      page must not go blank because one column isn't there yet).
   *   2. THE JOBS whose scheduled window touches this week, with their roster (assigned_to).
   *   3. THEIR SEGMENTS — every segment of those jobs, not just the week's, because SEGMENTS-FIRST
   *      only works if you can tell "this job has segments and none cover Wednesday" from "this
   *      job has no segments at all". 0266 gives every org member the read; this page is staff.
   *
   * No status filter on the jobs: a job finished on Friday was still scheduled Monday, and
   * dropping it would resurrect exactly the false findings this is here to stop.
   */
  const weekFirst = weekDayStrs[0];
  const weekLast = weekDayStrs[6];
  type WeekJob = {
    id: string;
    job_number: string | null;
    name: string | null;
    assigned_to: string[] | null;
    scheduled_start: string | null;
    scheduled_end: string | null;
  };
  const [planRows, { data: weekJobRows }] = await Promise.all([
    tolerateMissingColumns<{ profile_id: string; work_date: string; job_id: string | null; kind: string }[]>(() =>
      supabase
        .from("crew_day_assignments")
        .select("profile_id, work_date, job_id, kind")
        .gte("work_date", weekFirst)
        .lte("work_date", weekLast),
    ),
    supabase
      .from("jobs")
      .select("id, job_number, name, assigned_to, scheduled_start, scheduled_end")
      .lte("scheduled_start", end.toISOString())
      .or(`scheduled_end.gte.${start.toISOString()},and(scheduled_end.is.null,scheduled_start.gte.${start.toISOString()})`),
  ]);
  const weekJobs = (weekJobRows ?? []) as unknown as WeekJob[];
  let weekSegs: { job_id: string; start_date: string; end_date: string }[] = [];
  if (weekJobs.length) {
    const { data: segRows } = await supabase
      .from("job_schedule_segments")
      .select("job_id, start_date, end_date")
      .in(
        "job_id",
        weekJobs.map((j) => j.id),
      );
    weekSegs = (segRows ?? []) as typeof weekSegs;
  }
  /* WHICH DAYS EACH JOB RUNS — segments-first, with the scheduled_start→scheduled_end MIRROR
   * behind it. Copied in shape from timeclock/next-up.tsx and schedule/crew-board-panel.tsx,
   * which is the point: the card that tells a man where he is going and the card that tells the
   * office where he went must read the calendar the same way, or they disagree about the same
   * Wednesday. A segmented job runs only on its segment days (its base range is stretched
   * min-start→max-end, so a Mon+Fri job would otherwise claim Wednesday); a job with no segments
   * runs across its own window. The org-local days are resolved HERE because tz is a server
   * concern and crew-plan.ts stays pure. */
  const segsByJob = new Map<string, { start: string; end: string }[]>();
  for (const s of weekSegs) {
    if (!s.job_id) continue;
    const list = segsByJob.get(s.job_id) ?? [];
    list.push({ start: s.start_date, end: s.end_date });
    segsByJob.set(s.job_id, list);
  }
  const rangesByJob = new Map<string, { start: string; end: string }[]>();
  for (const j of weekJobs) {
    const segs = segsByJob.get(j.id);
    if (segs?.length) {
      rangesByJob.set(j.id, segs);
      continue;
    }
    if (!j.scheduled_start) continue; // unscheduled: it says nothing about any day, and that stands
    const s = todayStrInTz(tz, new Date(j.scheduled_start));
    const e = j.scheduled_end ? todayStrInTz(tz, new Date(j.scheduled_end)) : s;
    rangesByJob.set(j.id, [{ start: s, end: e < s ? s : e }]);
  }
  /** Every job that was RUNNING on each day of the week, whoever the roster names. This is the
   *  half of Erik's sentence the per-person pick cannot answer: jobs.assigned_to is a coarse list
   *  nobody grooms, so hours landing on a job the calendar had open that day are not a warning,
   *  even when the roster never named that person. */
  const calendarJobsByDay = new Map<string, Set<string>>();
  for (const d of weekDayStrs) {
    const running = new Set<string>();
    for (const [jobId, ranges] of rangesByJob) {
      if (ranges.some((r) => r.start <= d && d <= r.end)) running.add(jobId);
    }
    calendarJobsByDay.set(d, running);
  }
  const jobsByPerson = new Map<string, WeekJob[]>();
  for (const j of weekJobs) {
    for (const pid of j.assigned_to ?? []) {
      if (!pid) continue;
      const list = jobsByPerson.get(String(pid)) ?? [];
      list.push(j);
      jobsByPerson.set(String(pid), list);
    }
  }
  const actualDays = (entries ?? []).map((e: any) => ({
    profileId: String(e.profile_id ?? ""),
    workDate: todayStrInTz(tz, new Date(e.clock_in)),
    jobId: e.job_id ?? null,
    // THE SAME ONE RULE. This hand-rolled `hoursBetween(...) - lunch/60` instead of handing
    // hoursBetween the lunch it already knows how to deduct, which skipped the clamp — a
    // short shift with a long lunch came out NEGATIVE here and zero everywhere else, and a
    // negative day is read as "no hours", which is the difference between a no_show finding
    // and an unplanned one. Two formulas that agree on ordinary days are still two formulas.
    hours: e.clock_out ? hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes) : 0,
  }));
  /* THE PLAN, BOTH LAYERS. Assignments for the whole week (a no-hours one is still a no_show), and
   * a schedule-derived day only where hours actually landed — a scheduled day nobody worked is
   * silence by design, so manufacturing rows for it would only make work for comparePlanToActual
   * to throw away. Precedence is settled INSIDE that function, not by the order of this array. */
  const NO_SINGLE_DAYS: ReadonlyMap<string, string | null> = new Map();
  const plannedDays: PlannedDay[] = (planRows ?? []).map((r) => ({
    profileId: r.profile_id,
    workDate: r.work_date,
    jobId: r.job_id,
    kind: (r.kind === "off" ? "off" : "job") as "job" | "off",
    source: "assignment" as const,
  }));
  for (const k of new Set(actualDays.filter((d) => d.profileId).map((d) => `${d.profileId}|${d.workDate}`))) {
    const [profileId, workDate] = k.split("|");
    const sched = pickScheduledJobForDay(jobsByPerson.get(profileId) ?? [], workDate, rangesByJob, NO_SINGLE_DAYS);
    if (sched) plannedDays.push({ profileId, workDate, jobId: sched.id, kind: "job", source: "schedule" });
  }
  const drift = needsAttentionRows(comparePlanToActual(plannedDays, actualDays, calendarJobsByDay));
  const nameById = new Map<string, string>(((members ?? []) as any[]).map((m) => [m.id, m.full_name ?? "Crew member"]));
  // THE NAME, NOT THE NUMBER. Erik, three separate bug reports: "timecards and all jobs need to be
  // displayed as job name not job number everywhere" / "need to see job name not job number" /
  // "this week should show jobs worked not job codes". A number is a filing reference; nobody
  // recognises their own week from J-022. jobLabel is the SSOT and already prefers the name — these
  // three call sites were hand-rolling the label instead of asking it.
  const jobLabelById = new Map<string, string>(((jobs ?? []) as any[]).map((j) => [j.id, jobLabel(j)]));
  // ...AND EVERY JOB A FINDING CAN NAME. That list above is the 50 newest jobs — a picker, not a
  // dictionary — so a drift line about anything older read "a job", which is no help at all on the
  // one card that exists to say where the hours went. The week's scheduled jobs and the week's own
  // entries both carry job_number/name already, so they fill the gaps for free.
  for (const j of weekJobs) jobLabelById.set(j.id, jobLabel(j));
  for (const e of (entries ?? []) as any[]) {
    if (e.job_id && e.job) jobLabelById.set(String(e.job_id), jobLabel(e.job));
  }

  /* WHO IS IN THIS WEEK — names for the grid legend, in the order their first shift lands.
   *  (The per-person TALLY that used to be built here — hours, miles, a Card each — is gone: it
   *  was a second rendering of the stack's own shifts, and it is now the stack's By Person
   *  grouping, summing the same rows. The hours-per-job-code tally died before it, Erik:
   *  analytics territory, clutter on a payroll review page.) */
  const legendNames = new Map<string, string>();
  for (const e of (entries ?? []) as any[]) {
    const id = String(e.profile_id ?? "");
    if (id && !legendNames.has(id)) legendNames.set(id, e.profiles?.full_name ?? "—");
  }
  const label = `${start.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })} – ${new Date(
    end.getTime() - 1,
  ).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}`;

  // ── THE week grid (Erik: "I work a lot better seeing the blocks located in
  // their time allotment") — every entry is a pill positioned by clock-in →
  // clock-out, ONE COLOR PER PERSON (stable hash of profile id), open entries
  // running to the live now line. A heavier column divider marks the day a new
  // PAY PERIOD starts, so the payroll week reads against the pay cycle.
  const todayStr = todayStrInTz(tz);
  const workWin = workDayWindowHm((org as any)?.settings);
  // The single-week grid arrays died with the single-week grid: each week in the stack
  // builds its own events from the wide read below.
  /* ── THE SCROLLING RECORD ────────────────────────────────────────────────────────────────
     Erik: "continuous scroll which should also be on timecards with pay period break lines."
     A separate, LIGHT read: only what a pill needs, over a wide span, so the stack has weeks to
     scroll through without dragging the edit modal's whole projection (rate_override, allocations,
     payroll locks) across six months of rows. The single-week `entries` above still feeds the
     per-person lists and the editor, unchanged. */
  const stackFrom = new Date(start.getTime() - 26 * 7 * 86_400_000).toISOString();
  const stackTo = new Date(end.getTime() + 8 * 7 * 86_400_000).toISOString();
  const { data: stackRows } = await supabase
    .from("time_entries")
    .select(
      /* job_code / source / notes / miles ride along now that this list is THE list: they are
         four flat columns, not the editor's projection, and two of them are disclosures (0168's
         manual/offline provenance) that must not go quiet just because a row is three weeks old.
         time_allocations is still NOT here — an embed across six months of rows is the thing this
         read exists to avoid, so split lines stay on the anchored week's deep read below. */
      "id, profile_id, clock_in, clock_out, lunch_minutes, job_id, job_code, source, notes, miles, profiles:profile_id(full_name), job:job_id(job_number, name)",
    )
    .gte("clock_in", stackFrom)
    .lt("clock_in", stackTo)
    /* DESCENDING, because LIMIT applies after ORDER. Ascending kept the OLDEST 4000 rows, so the
       moment an org crossed the cap the CURRENT week — the page's anchor and default view — went
       blank while six-month-old weeks rendered fine. Overflow now eats the far end of the scroll,
       which the "Six months back" notice already marks as bounded. Render order is irrelevant:
       the stack groups by day and the grid positions by minutes. */
    .order("clock_in", { ascending: false })
    .limit(4000);
  /* The deep link names the ENTRY'S OWN WEEK. The stack shows 26 weeks but this page anchors on
     ?week=, so a link stamped with the PAGE's offset pointed a two-weeks-ago entry at the current
     week — the editor still opened (the fallback fetch), but a refresh or share of that URL lost
     the week it belonged to. Pure day-string arithmetic against the anchor week's first day. */
  const anchorStartMs = Date.parse(`${weekDayStrs[0]}T00:00:00Z`);
  const weekOf = (dayStr: string): number => {
    const ms = Date.parse(`${dayStr}T00:00:00Z`);
    if (!Number.isFinite(ms) || !Number.isFinite(anchorStartMs)) return offset;
    return Math.max(0, offset - Math.floor((ms - anchorStartMs) / (7 * 86_400_000)));
  };
  /* ── THE DETAIL THAT USED TO BE A SECOND LIST ─────────────────────────────────────────────
   *
   *  Under the stack sat one Card per person, re-listing that person's week: the job, the code
   *  badge, manual/offline, lunch, the hours, the notes, the split lines, and a duplicate +
   *  pencil pair. The SAME SHIFTS the stack was already drawing. Erik: "it looks like duplicates
   *  … lets try and mold as much together as possible." So the detail moves ONTO the stack's row
   *  and the cards go; By Person is now a grouping of this one ledger, not a second copy of it.
   *
   *  Split lines and the two controls need the editor's whole projection (allocations, the
   *  payroll locks, rate_override), which is read for the ANCHORED WEEK only — which is exactly
   *  the span those cards ever covered, so nothing that existed is lost. A row from an older week
   *  still opens its editor with one tap (the ?entry= door below fetches the row it needs), so an
   *  older row is never a dead end, just quieter. */
  const detailById = new Map<
    string,
    { allocations: { jobCode: string | null; hours: number; description: string | null }[]; controls: ReactNode }
  >();
  for (const e of (entries ?? []) as any[]) {
    detailById.set(String(e.id), {
      allocations: ((e.time_allocations ?? []) as any[]).map((a) => ({
        jobCode: a.job_code ?? null,
        hours: Number(a.hours ?? 0),
        description: a.description ?? null,
      })),
      controls: (
        <>
          {e.status === "closed" && (
            <DuplicateEntryButton
              id={e.id}
              profileId={e.profile_id}
              personName={e.profiles?.full_name}
              members={members ?? []}
            />
          )}
          <EditEntryButton
            entry={e}
            jobCodes={(jobCodes ?? []) as JobCode[]}
            jobs={jobs ?? []}
            members={members ?? []}
            isStaff
            jobCodesEnabled={orgSettings.timeclock_job_codes}
          />
        </>
      ),
    });
  }

  const toStackEntry = (e: any): StackEntry => {
    const { dayStr, startMin, endMin } = timeEntryGridSpan(e.clock_in, e.clock_out, tz);
    /* ONE WEEK, ONE NUMBER (Erik: "it looks like duplicates").
     *
     * This mapper used to run an open shift against `Date.now()` and hand the stack a LIVE,
     * growing figure, while every other total on this page — and every total on /payroll — counts
     * closed shifts only. So the moment anybody was on the clock the same week showed two numbers
     * that disagreed, and neither said why. Two totals that differ by a shift in progress is not a
     * detail; it is the whole reason the page read as duplicated.
     *
     * The rule is now the app's one rule: hoursBetween, lunch deducted (the SSOT in lib/utils).
     * An open shift is worth ZERO hours — it has not been worked yet, and nothing gets paid on a
     * guess. But it is real and it is happening, so it still DRAWS on the grid, and `open` carries
     * the fact up to the stack, which says "still on the clock" where the number would be. Stated,
     * not hidden: the old live number was the app quietly counting hours nobody had earned. */
    const open = !e.clock_out;
    const detail = detailById.get(String(e.id));
    const color = pillColorForPerson(e.profile_id);
    return {
      id: String(e.id),
      personId: String(e.profile_id ?? ""),
      personName: e.profiles?.full_name ?? "—",
      person: firstNameOf(e.profiles?.full_name),
      dayStr,
      clockIn: String(e.clock_in),
      startMin,
      endMin,
      hours: open ? 0 : hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes),
      open,
      miles: Number(e.miles ?? 0),
      label: `${firstNameOf(e.profiles?.full_name)}${e.job ? ` · ${jobLabel(e.job)}` : ""}`,
      /* THE DAY IT ENDED, WHEN THAT IS NOT THE DAY IT STARTED.
       *
       * A row is filed under its clock-IN day — the By Day group header, or the day that leads
       * the row in By Person — and the span beside it is times only. So a shift punched 10:00 PM
       * Monday and closed 6:30 AM Tuesday read "10:00 PM–6:30 AM" under Monday, with nothing on
       * screen saying the clock-out was the next morning. timeEntryGridSpan clamps exactly this
       * case at 1440, so the app knows these shifts happen; the per-person card this row replaced
       * printed the DATE on both ends and never had the ambiguity.
       *
       * The hours were always right (hoursBetween is a duration), but this row is now the only
       * rendering of the shift and Erik pays people off it. So the out-day is named whenever it
       * differs, and stays out of the way on the ordinary shifts that end when they started. */
      sub: (() => {
        const from = formatTime(e.clock_in, tz);
        if (!e.clock_out) return `${from}–now`;
        const crossed = todayStrInTz(tz, new Date(e.clock_out)) !== dayStr;
        return `${from}–${formatTime(e.clock_out, tz)}${crossed ? ` ${formatDateShort(e.clock_out, tz)}` : ""}`;
      })(),
      color: color.pill,
      dot: color.dot,
      href: hrefFor(weekOf(dayStr), `entry=${e.id}`),
      // THE NAME, NOT THE NUMBER, and still a way into the job itself (jobLabel is the SSOT).
      job: e.job_id && e.job ? { href: `/jobs/${e.job_id}`, label: jobLabel(e.job) } : null,
      jobCode: e.job_code ?? null,
      source: e.source === "manual" ? "manual" : e.source === "offline" ? "offline" : null,
      lunchMin: Number(e.lunch_minutes ?? 0),
      notes: e.notes ?? null,
      allocations: detail?.allocations,
      controls: detail?.controls,
    };
  };

  /* ONE LIST, AND THE ANCHORED WEEK IS ALWAYS IN IT. The wide read is capped at 4000 rows, so on
     a busy org a week deep in the scroll can fall off the far end — which mattered little when a
     second list rendered it anyway, and matters now that this is the only one. Any anchored-week
     entry the wide read missed is added from the deep read. Then sorted by day and start time, so
     a day reads top to bottom in the order it was worked (the wide read comes back DESC, which is
     a cap trick, not a reading order). */
  const seenStackIds = new Set<string>();
  const stackEntries: StackEntry[] = [];
  for (const row of (stackRows ?? []) as any[]) {
    seenStackIds.add(String(row.id));
    stackEntries.push(toStackEntry(row));
  }
  for (const e of (entries ?? []) as any[]) {
    if (!seenStackIds.has(String(e.id))) stackEntries.push(toStackEntry(e));
  }
  stackEntries.sort((a, b) => (a.dayStr < b.dayStr ? -1 : a.dayStr > b.dayStr ? 1 : a.startMin - b.startMin));

  const gridLegend = [...legendNames.entries()].map(([pid, name]) => ({
    id: pid,
    name,
    dot: pillColorForPerson(pid).dot,
  }));
  const gridNow = { dayStr: todayStr, min: tzMinutesOfDay(new Date(), tz) };
  const onClock = crew.filter((c) => c.clockedIn);

  const supId = getOrgSettings((org as any)?.settings).timecard_supervisor_id;
  const approver = supId
    ? (members?.find((m: any) => m.id === supId)?.full_name ?? "—")
    : "Owner";

  /* ── WHAT HE OWES, IN ONE ROW ──────────────────────────────────────────────────────────────
   *
   *  WHAT WAS HERE: the "Pay period" card — every person with hours, their gross, and a paid
   *  badge. It answered a real question in July, when nothing else did. It is now a read-only
   *  mirror of /payroll printed two inches under a grid of the same hours, which is exactly what
   *  Erik is looking at when he says "way too much in my face i dont even know what it all is and
   *  it looks like duplicates" and "mold as much together as possible". /payroll shipped last
   *  night with real payments behind that question, so this becomes its headline and a door.
   *
   *  THE SAME ARITHMETIC, NOT A SECOND ONE: balanceForPerson (pure, unit-tested) over the same
   *  reads /payroll makes, so the figure he taps and the figure he lands on cannot disagree.
   *
   *  AND THE SAME REFUSAL: a balance is subtraction, so a list that came back short or broken
   *  does not read as an error, it reads as a confident wrong number. Any broken read and this
   *  row shows NO figure at all — just the way in (MONEY: never invent a figure). */
  const balanceWindowYmd = (() => {
    const d = new Date(`${todayStr}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - BALANCE_MONTHS);
    return d.toISOString().slice(0, 10);
  })();
  const balanceWindowIso = tzDayStartUtc(balanceWindowYmd, tz).toISOString();
  const [balClosed, balOpen, balPayments, balRuns, balRates, rolesRes] = await Promise.all([
    readAll<any>((from, to) =>
      supabase
        .from("time_entries")
        .select(BALANCE_ENTRY_COLS)
        .eq("status", "closed")
        .not("clock_out", "is", null)
        .gte("clock_in", balanceWindowIso)
        .order("id")
        .range(from, to),
    ),
    // Open shifts ride along so balanceForPerson can SEE them; hoursBetween prices them at zero,
    // so they can never inflate a balance — the same rule the grid above now obeys.
    readAll<any>((from, to) =>
      supabase
        .from("time_entries")
        .select(BALANCE_ENTRY_COLS)
        .is("clock_out", null)
        .gte("clock_in", balanceWindowIso)
        .order("id")
        .range(from, to),
    ),
    // EVERY payment, all time, never windowed: `paid` is an all-time sum by contract, and a
    // payment dropped by a date filter reappears on screen as money he still owes.
    readAll<any>((from, to) =>
      supabase
        .from("pay_payments")
        .select("id, profile_id, amount, paid_on, method, reference, note, needs_check, voided_at, created_at")
        .order("id")
        .range(from, to),
    ),
    // The FROZEN half of earned. kind='base' ONLY — mileage dollars must never reach a wages
    // balance (0095's two-lock rule).
    readAll<any>((from, to) =>
      supabase
        .from("payroll_runs")
        .select("profile_id, period_start, period_end, gross")
        .eq("kind", "base")
        .order("id")
        .range(from, to),
    ),
    // The rate multiplies every unlocked dollar, so a dropped read prices every unpaid hour at
    // zero and "You Owe $0" is a lie. It refuses with the other four.
    payRateMapRead(supabase),
    /* WHO IS THE CREW AND WHO IS THE HOUSE (2026-09-18). Erik, on this row reading "You Owe
     * $47,855.95 across 3 people": $40,498 of it is HIS OWN time at his own $125 rate, which is a
     * draw against the business, not a wage he owes an employee. So the headline was a debt to
     * Brian and Jimmy nearly six times bigger than the one he actually has, and that headline is
     * the figure he acts on. The ROLE is the only thing that separates the two and it is not on
     * profile_pay (0215 carries the PAY columns, not role), so it comes off `profiles` — the same
     * read, for the same reason, that /payroll made tonight, so the two screens compose the total
     * the same way. Not a money read: it changes how the total is COMPOSED, never what any one
     * person is owed. */
    supabase.from("profiles").select("id, role"),
  ]);
  const owedUnreadable = [balClosed, balOpen, balPayments, balRuns, balRates].some((r) => !!r.problem);
  /* NOTHING SILENT, BUT NOT A REFUSAL. If the roles read broke, every person's balance is still
   * exactly right and only the split is unknown — so the headline keeps counting everyone (the old
   * behaviour, which is never LOW) and the line underneath says why, out loud. Shrinking a figure
   * he pays people off, quietly, on a read we are not sure of, is the one move not available. */
  const rolesKnown = !rolesRes.error && Array.isArray(rolesRes.data);
  const ownerIds = new Set<string>(
    ((rolesRes.data ?? []) as { id?: string | null; role?: string | null }[])
      .filter((p) => p?.id && p.role === "owner")
      .map((p) => String(p!.id)),
  );
  let owedTotal = 0;
  let owedPeople = 0;
  let ownerDraw = 0;
  let ownerDrawNames: string[] = [];
  let ownerDrawIsViewer = false;
  if (!owedUnreadable) {
    // Rates come from the staff-scoped profile_pay view, not the embed (0215/0216 revoked those
    // columns from the authenticated role).
    attachRates(balClosed.rows, balRates.rates, (e: any) => ({ id: e.profile_id, holder: e }));
    attachRates(balOpen.rows, balRates.rates, (e: any) => ({ id: e.profile_id, holder: e }));
    const push = <T,>(m: Map<string, T[]>, k: string, v: T) => {
      const a = m.get(k);
      if (a) a.push(v);
      else m.set(k, [v]);
    };
    const entriesByPerson = new Map<string, any[]>();
    for (const e of [...balClosed.rows, ...balOpen.rows]) {
      const id = e.profile_id ? String(e.profile_id) : "";
      if (id) push(entriesByPerson, id, e);
    }
    const lockedByPerson = new Map<string, { period_start: string; period_end: string; gross: number }[]>();
    for (const r of balRuns.rows) {
      const id = r.profile_id ? String(r.profile_id) : "";
      if (id) {
        push(lockedByPerson, id, {
          period_start: String(r.period_start),
          period_end: String(r.period_end),
          gross: Number(r.gross ?? 0),
        });
      }
    }
    const paymentsByPerson = new Map<string, PayPaymentRow[]>();
    for (const p of balPayments.rows.map(toPayPaymentRow)) push(paymentsByPerson, p.profileId, p);

    const ids = new Set<string>([...entriesByPerson.keys(), ...lockedByPerson.keys(), ...paymentsByPerson.keys()]);
    const balances: PersonBalance[] = [...ids].map((id) =>
      balanceForPerson({
        profileId: id,
        name: nameById.get(id) ?? "—",
        entries: entriesByPerson.get(id) ?? [],
        lockedRuns: lockedByPerson.get(id) ?? [],
        payments: paymentsByPerson.get(id) ?? [],
        tz,
        fallbackRate: Number(balRates.rates.get(id)?.hourly_rate ?? 0),
      }),
    );
    // /payroll's rule, word for word: what he OWES, not a net position. A man who is ahead does
    // not reduce what the next man is owed, so only positive balances are summed — and a zero or
    // negative balance is not a person he owes, so it is not in the count either.
    const owing = balances.filter((b) => b.owed > 0.005);
    // THE HEADLINE COUNTS THE CREW. An owner's balance keeps a line of its own below, so the
    // figure is neither lost nor misread — the same split /payroll's board makes, said shorter.
    const crewOwing = rolesKnown ? owing.filter((b) => !ownerIds.has(b.profileId)) : owing;
    const ownerOwing = rolesKnown ? owing.filter((b) => ownerIds.has(b.profileId)) : [];
    owedPeople = crewOwing.length;
    owedTotal = Math.round(crewOwing.reduce((s, b) => s + b.owed, 0) * 100) / 100;
    ownerDraw = Math.round(ownerOwing.reduce((s, b) => s + b.owed, 0) * 100) / 100;
    ownerDrawNames = ownerOwing.map((b) => firstNameOf(b.name));
    ownerDrawIsViewer = ownerOwing.length === 1 && ownerOwing[0].profileId === (user?.id ?? "");
  }
  /* Said once, in the register of whoever is reading it: Erik sees "your own", an office manager
   * sees the name. Either way it names the money, says what kind of money it is, and the whole row
   * is already the way in to Pay, where it can be recorded (NO DEAD ENDS). */
  const ownerDrawLine = !rolesKnown
    ? "Everyone with a balance is counted here. The roles could not be read just now, so an owner draw cannot be told apart from wages."
    : ownerDraw > 0.005
      ? ownerDrawIsViewer
        ? `Your own ${formatCurrency(ownerDraw)} is a draw, not wages, so it is not in that figure.`
        : `${ownerDrawNames.join(" and ")} ${ownerDrawNames.length > 1 ? "are owners" : "is an owner"}, so ${formatCurrency(ownerDraw)} of draw is not in that figure.`
      : null;

  /* ── FIX THESE ─────────────────────────────────────────────────────────────────────────────
   *
   *  TWO CARDS BECOME ONE. "Different from the plan" and "Needs attention" sat back to back with
   *  near-identical amber chrome and no line between them, so they read as one long
   *  undifferentiated warning list — Erik: "i dont even know what it all is and it looks like
   *  duplicates". They ARE one list, so this stops pretending otherwise and puts them in the
   *  order the money is in.
   *
   *  WORST MONEY FIRST. A broken shift is hours that are WRONG — a forgotten clock-out inflating
   *  a week, or a 0193 ghost auto-closed at zero and worth nothing — and that is the next check.
   *  A plan drift is hours that are probably RIGHT but filed against the wrong job, which costs
   *  later, at invoicing. So broken rows first in normal weight, drift under a rule in lighter
   *  type.
   *
   *  THE TWO FEEDERS: `needsAttention` above (broken shifts, untouched), and the plan comparison
   *  from lib/plan-vs-actual. That second one was rebuilt on 2026-09-18 — it took the plan from
   *  crew_day_assignments alone, a table nobody has written to since August, so every worked day
   *  came back "nothing planned" and the drift half of this card had never once been right. It
   *  reads the JOB SCHEDULE now (see the feeder above); the rendering here did not change. */
  const entryIdByPersonDay = new Map<string, string>();
  for (const e of (entries ?? []) as any[]) {
    const k = `${e.profile_id}|${todayStrInTz(tz, new Date(e.clock_in))}`;
    if (!entryIdByPersonDay.has(k)) entryIdByPersonDay.set(k, String(e.id));
  }
  const brokenRows = (needsAttention as any[]).map((e) => {
    const day = todayStrInTz(tz, new Date(e.clock_in));
    const openHrs = formatDuration(hoursBetween(e.clock_in, new Date(), 0));
    return {
      id: String(e.id),
      name: e.profiles?.full_name ?? "—",
      when: formatDateTimeTz(e.clock_in, tz),
      job: e.job ? jobLabel(e.job) : null,
      /* A zero-closed row is NOT open (audit 7: "Brian · open 98h" on a shift 0193 closed at zero
         on Monday was a lie that grew by the hour). Say what the system actually did, with its
         reason. Kept word for word from the card this replaces. */
      badge: e.auto_closed_reason
        ? `auto-closed — ${String(e.auto_closed_reason).replace(/_/g, " ")}`
        : new Date(e.clock_in).getTime() < todayStartMs
          ? `open ${openHrs} · past day`
          : `open ${openHrs}`,
      // The deep link names the ENTRY'S OWN WEEK, not the page's (same reason as the grid pills).
      href: hrefFor(weekOf(day), `entry=${e.id}`),
    };
  });
  const driftRows = drift.slice(0, 8).map((r) => {
    const entryId = entryIdByPersonDay.get(`${r.profileId}|${r.workDate}`);
    return {
      key: `${r.profileId}|${r.workDate}`,
      date: formatDate(r.workDate),
      text: explain(r, (id) => jobLabelById.get(id) ?? "a job", nameById.get(r.profileId) ?? "Someone"),
      /* ONE WAY IN, NOT TWO. A drift row with hours has an entry behind it, so it opens that
         entry's editor through the ?entry= door OpenEntryEditor already answers — no second
         mechanism invented here. A no_show has no entry to open BY DEFINITION (that is what
         no_show means), and a row with nowhere to go is a dead end, so that one goes to its day
         on the calendar, where the stale plan actually lives. */
      href: entryId ? hrefFor(weekOf(r.workDate), `entry=${entryId}`) : `/schedule?view=day&date=${r.workDate}`,
    };
  });
  const fixCount = brokenRows.length + drift.length;

  // The ?entry= deep link (a grid pill tap) — find the entry and auto-open its editor below.
  // The stack scrolls 26 weeks, but `entries` holds ONE week — so a tap on any pill outside the
  // anchor week found nothing and silently opened nothing (Erik: "i cant get into the timecard
  // entry by clicking on it i had to go around into the job"). Missing from the week? Fetch the
  // row itself, same projection the editor round-trips.
  let focusEntry = entryParam
    ? (([...(entries ?? []), ...(openNow ?? [])] as any[]).find((e) => e.id === entryParam) ?? null)
    : null;
  if (entryParam && !focusEntry) {
    const { data: one } = await supabase
      .from("time_entries")
      .select(
        "id, profile_id, clock_in, clock_out, lunch_minutes, miles, rate_override, paid_at, mileage_paid_at, job_id, job_code, status, notes, source, profiles:profile_id(full_name), job:job_id(job_number, name), time_allocations(job_id, job_code, hours, description)",
      )
      .eq("id", entryParam)
      .maybeSingle();
    if (one) {
      if ((one as any).profile_id && (one as any).profiles) {
        (one as any).profiles = { ...(one as any).profiles, ...(payMap.get(String((one as any).profile_id)) ?? {}) };
      }
      focusEntry = one as any;
    }
  }

  return (
    <div>
      <PageHeader title="Timecards" description={`Review your crew's hours by week.  ·  Approver: ${approver}`}>
        <div className="flex flex-wrap items-center gap-2">
          <AddEntryButton
            isStaff
            /* Opens on the viewer BY NAME. Erik read his own name twice in this picker — once as
               "Me" and once as himself — and took it for two records of one man. */
            viewerId={user?.id}
            jobCodesEnabled={orgSettings.timeclock_job_codes}
            members={members ?? []}
            jobCodes={(jobCodes ?? []) as JobCode[]}
            jobs={jobs ?? []}
            tz={tz}
          />
          <Link
            href={hrefFor(offset + 1)}
            className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
            title="Previous week"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <span className="min-w-[140px] text-center text-sm font-medium text-slate-700">
            {offset === 0 ? "This week" : label}
          </span>
          <Link
            href={hrefFor(Math.max(0, offset - 1))}
            className={`rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50 ${
              offset === 0 ? "pointer-events-none opacity-40" : ""
            }`}
            title="Next week"
          >
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </PageHeader>

      {/* Live presence — the crew pulse that used to be My Day's CrewBoard: who's on
          the clock RIGHT NOW, living next to the hours it becomes (Erik, cn-v503). The block
          stays exactly where cn-v503 put it and reads the same getCrewStatus; only the SIZE
          changed. It was text-xs pills wrapped into one line, and this is the thing he checks
          from a ladder in the sun — 10px of grey inside a pill is not readable at arm's length.
          One person per row, at reading size. */}
      {crew.length > 0 && (
        <Card className="mb-4">
          <CardContent className="py-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">On the clock</span>
              <span className="text-xs text-slate-500">
                {onClock.length} of {crew.length}
              </span>
            </div>
            {onClock.length === 0 ? (
              <p className="mt-1 text-base text-slate-400">Nobody right now</p>
            ) : (
              <ul className="mt-0.5">
                {onClock.map((c) => (
                  <li key={c.id} className="flex min-h-[44px] items-center gap-2.5 text-base">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-green-500" aria-hidden />
                    <span className="shrink-0 font-medium text-slate-900">{c.name}</span>
                    {c.jobLabel && <span className="min-w-0 truncate text-slate-500">{c.jobLabel}</span>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── THE LEDGER, ONCE ──────────────────────────────────────────────────────────────────
          The week as pills in their time allotment on a desktop, as a list of shifts on a phone,
          and under it — until now — the SAME shifts again, one Card per person. Erik: "it looks
          like duplicates … lets try and mold as much together as possible."

          They are one list now, stacked either way you need to read it: By Day to answer "what
          happened Tuesday", By Person to answer "what do I owe Brian for this week". Same rows,
          same arithmetic, same tap into the editor. The toggle regroups INSIDE each week and
          never changes the span, so a header's number always belongs to the rows beneath it. */}
      <div className="mb-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <span className="min-w-0 text-sm font-semibold text-slate-900">
            Hours Worked
            <span className="ml-2 text-xs font-normal text-slate-500">tap any shift to fix it</span>
          </span>
          <SegmentedControl
            activeId={grouping}
            items={[
              { id: "day", label: "By Day", href: `/timecards?week=${offset}` },
              { id: "person", label: "By Person", href: `/timecards?week=${offset}&group=person` },
            ]}
          />
        </div>
        {/* The color key belongs to the grouping that needs decoding. By Person writes each
            person's name across the top of their own shifts, so it needs no legend. */}
        {grouping === "day" && gridLegend.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {gridLegend.map((p) => (
              <span key={p.id} className="flex items-center gap-1 text-xs text-slate-600">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.dot}`} aria-hidden /> {p.name}
              </span>
            ))}
          </div>
        )}
        {/* THE WEEKS RUN, AND THE PAY PERIODS ARE MARKED ACROSS THEM. The single week behind two
            arrows is gone: reading "what did we pay him last period" used to mean clicking back,
            reading, clicking back, reading, and holding both halves in your head — for the one
            number this page exists to produce. Same grid and same scroll hook as the schedule. */}
        <TimecardStack
          entries={stackEntries}
          anchorWeek={weekDayStrs}
          todayStr={todayStr}
          workStartMin={hmToMin(workWin.start)}
          workEndMin={hmToMin(workWin.end)}
          tz={tz}
          nowMin={gridNow.min}
          paySchedule={orgSettings.pay_schedule}
          payAnchor={orgSettings.pay_anchor}
          group={grouping}
          baselineById={baselineById}
        />
      </div>

      {/* A grid pill tap lands here: mount THAT entry's editor already open.
          Keyed by id so tapping a different pill remounts fresh state. */}
      {focusEntry && (
        <OpenEntryEditor
          key={focusEntry.id}
          entry={focusEntry}
          jobCodes={(jobCodes ?? []) as JobCode[]}
          jobs={jobs ?? []}
          members={members ?? []}
          jobCodesEnabled={orgSettings.timeclock_job_codes}
        />
      )}

      {/* ONE ROW WHERE THE ROSTER WAS. The Pay page owns "what do I owe" now, with the payments
          behind it; this is its headline and the door. The WHOLE ROW is the target (a link inside
          a row is a smaller thing to hit than the row), 44px, and the figure is the same
          balanceForPerson arithmetic that page runs — or no figure at all. */}
      <Link
        href="/payroll"
        className="mb-4 flex min-h-[44px] w-full items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 active:bg-slate-50"
      >
        <span className="min-w-0 flex-1">
          {owedUnreadable ? (
            <>
              <span className="block text-base font-semibold text-slate-900">Open Pay</span>
              {/* NOTHING SILENT, and never a figure he could act on that might be wrong. */}
              <span className="block text-sm text-slate-500">
                No amount is shown here right now because the pay records could not be read whole. Your hours below are
                fine.
              </span>
            </>
          ) : owedPeople === 0 ? (
            <>
              {/* "The crew" when he is carrying a draw of his own, because "everyone" with a figure
                  sitting right under it contradicts itself. */}
              <span className="block text-base font-semibold text-slate-900">
                {ownerDraw > 0.005 ? "The crew is paid up" : "Everyone is paid up"}
              </span>
              <span className="block text-sm text-slate-500">Open Pay</span>
            </>
          ) : (
            <>
              <span className="block text-base font-semibold text-slate-900">You Owe {formatCurrency(owedTotal)}</span>
              <span className="block text-sm text-slate-500">
                across {owedPeople} {owedPeople === 1 ? "person" : "people"} · Open Pay
              </span>
            </>
          )}
          {/* THE OWNER'S OWN MONEY, QUIETER AND STILL SAID. It is not wages, so it is not in the
              headline; it is real, so it does not disappear. */}
          {!owedUnreadable && ownerDrawLine && (owedPeople > 0 || ownerDraw > 0.005) && (
            <span className="mt-0.5 block text-xs text-slate-500">{ownerDrawLine}</span>
          )}
        </span>
        <ChevronRight className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
      </Link>

      {/* ── FIX THESE ─────────────────────────────────────────────────────────────────────────
          One amber card where "Needs attention" and "Different from the plan" used to sit back to
          back. Both are still here, both feeders untouched — broken hours first (money on the
          next check), plan drift under the rule in lighter type (money at invoicing).

          KEPT FROM THE PLAN CARD, because it is the reason that list is allowed to exist: this is
          NOT a discipline tool. A mismatch is nearly always a stale plan, not somebody lying — a
          crew gets pulled to a callback, a job finishes early. The value is the office seeing it
          on Friday rather than at invoicing, when the hours are already on the wrong job and the
          customer is already looking at the number. */}
      {fixCount > 0 ? (
        <Card className="mb-4 border-amber-200 bg-amber-50/60">
          <CardContent className="py-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
              <AlertTriangle className="h-4 w-4 shrink-0" /> Fix These ({fixCount})
            </h3>
            {brokenRows.length > 0 && (
              <ul className="divide-y divide-amber-200/60">
                {brokenRows.map((r) => (
                  <li key={r.id}>
                    {/* The WHOLE ROW opens that entry's editor, through the ?entry= door that was
                        already there and simply had a small button in front of it. */}
                    <Link
                      href={r.href}
                      scroll={false}
                      className="flex min-h-[44px] items-center gap-2 py-2 text-sm active:bg-amber-100/60"
                    >
                      <span className="min-w-0 flex-1 text-slate-800">
                        <span className="font-medium">{r.name}</span>
                        <span className="text-slate-500"> · in {r.when}</span>
                        {r.job && <span className="text-slate-500"> · {r.job}</span>}
                        <Badge tone="amber" className="ml-2">
                          {r.badge}
                        </Badge>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-amber-700" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {driftRows.length > 0 && (
              <>
                {brokenRows.length > 0 && <div className="my-1 border-t border-amber-200/80" />}
                <ul>
                  {driftRows.map((r) => (
                    <li key={r.key}>
                      <Link
                        href={r.href}
                        scroll={false}
                        className="flex min-h-[44px] items-center gap-2 py-2 text-sm font-light text-slate-600 active:bg-amber-100/60"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="text-xs tabular-nums text-slate-400">{r.date}</span> {r.text}
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-amber-700" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
                {drift.length > driftRows.length && (
                  <p className="text-xs text-slate-400">+{drift.length - driftRows.length} more this week.</p>
                )}
                <p className="mt-1 text-xs text-slate-500">
                  A plan line is usually the plan moving and nobody updating it. Worth a look before these hours go on
                  an invoice.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        /* NOTHING SILENT: a missing warning has to be AFFIRMED. Without this line the page looks
           exactly the same when everything is clean and when the check never ran, and "no news"
           is not something you can trust a payroll week to. */
        <p className="mb-4 flex min-h-[44px] items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 text-sm font-medium text-emerald-900">
          <Check className="h-4 w-4 shrink-0" aria-hidden /> Nothing needs fixing this week.
        </p>
      )}

      {/* THE DAILY REPORTS CARD IS GONE FROM HERE — it lives on My Day now (cn-v958).
          A crew lead's debrief says what got done and WHAT MATERIALS ARE NEEDED TOMORROW, and
          tomorrow is a My Day question, not a payroll-review one. It was the single biggest
          block competing for room with the money Erik opens this page for ("way too much in my
          face i dont even know what it all is"). The whole card moved intact — the person, the
          reviewed badge, did-today, materials-tomorrow, the GPS day story and Mark Reviewed —
          and the bell/push deep link moved with it, so a daily_report notification still lands
          on the page that holds the report. */}

      {/* THE THREE STAT TILES AND THE PER-PERSON CARDS ARE GONE (Erik: "way too much in my face i
          dont even know what it all is and it looks like duplicates").

          The tiles predate the week stack — "Crew hours" and "People with entries" came with the
          original page in June, "Business miles" with cn-v138 — and the stack took over what two
          of them said without anyone retiring them:

            · "Crew hours" restated the week total the stack header prints two inches above it,
              and DISAGREED with it whenever somebody was on the clock. The stack header is now
              the one week number.
            · "People with entries" was the length of the list immediately below it.
            · "Business miles" survives per person, in the stack's By Person grouping, on the
              person header where a mileage settlement is actually read. Miles stay DATA — no
              app-computed dollars, here or there: mileage pay is a human-typed settlement on
              /payroll, never rate × miles.

          The per-person Cards that used to render here went the same way, and for the harder
          reason: they were not a summary of the stack, they were a SECOND RENDERING of its
          shifts, which is the duplicate Erik was actually looking at. Everything they carried —
          the initials header, the week hours, the mileage split, and per shift the times, the job
          link, the code badge, manual/offline, lunch, the hours, duplicate, pencil, the notes and
          the split lines — now rides on the stack's one row, under [By Day | By Person] above.
          The EmptyState that stood in for them went too: the stack says "No hours this week" in
          each week it owns, so there is exactly one of those on screen instead of two.

          Also long gone, and staying gone (Erik 7/15, analytics territory): "Hours by job code",
          "Hours this pay period", "Accumulated hours · all time". */}
    </div>
  );
}
