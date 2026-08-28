import { attachRates, payRateMap } from "@/lib/profile-columns";
import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { redirect } from "next/navigation";
import { AlertTriangle, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { FactsGrid, StatTile } from "@/components/ui/stat-tile";
import { Badge } from "@/components/ui/badge";
import {
  formatCurrency,
  formatDuration,
  formatDate,
  formatTime,
  hoursBetween,
  initials,
} from "@/lib/utils";
import { getOrgSettings, workDayWindowHm } from "@/lib/org-settings";
import { formatDateTimeTz, payPeriodBounds, timeEntryGridSpan, tzDayStartUtc, tzMinutesOfDay, todayStrInTz } from "@/lib/tz";
import { summarizeMileage } from "@/lib/mileage-math";
import { aggregatePayrollEntries } from "@/lib/payroll-math";
import { getCrewStatus } from "@/lib/crew-status";
import { firstNameOf, pillColorForPerson } from "@/lib/employee-color";
import { TimecardStack } from "./timecard-stack";
import { hmToMin } from "@/lib/tz";
import { AddEntryButton } from "../timeclock/add-entry-button";
import { EditEntryButton } from "./edit-entry-button";
import { OpenEntryEditor } from "./open-entry-editor";
import { DuplicateEntryButton } from "./duplicate-entry-button";
import { MarkReportReviewedButton } from "./mark-report-reviewed-button";
import type { DailyReportSummary } from "../timeclock/actions";
import type { JobCode } from "@/lib/types";
import { jobLabel } from "@/lib/schedule-options";
import { tolerateMissingColumns } from "@/lib/inspection/schema";
import { comparePlanToActual, needsAttention as needsAttentionRows, explain } from "@/lib/plan-vs-actual";

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

export default async function TimecardsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; entry?: string }>;
}) {
  const { week, entry: entryParam } = await searchParams;
  const offset = Math.max(0, parseInt(week ?? "0", 10) || 0);
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

  // Crew-lead daily reports — the office review surface the daily_report bell/push
  // (url "/timecards") and the planner card's "Review in timecards" land on. Last 14
  // org-local days, newest first; the planner card shows TODAY only, so this is where
  // yesterday's report lives (with the GPS day story + the filed→reviewed check-off).
  const reportsSince = todayStrInTz(tz, new Date(Date.now() - 14 * 86_400_000));
  const { data: reportRows } = await supabase
    .from("daily_reports")
    .select("id, profile_id, report_date, did_today, materials_tomorrow, gps_summary, status, created_at, profiles:profile_id(full_name)")
    .gte("report_date", reportsSince)
    .order("report_date", { ascending: false })
    .order("created_at", { ascending: false });
  const dailyReports = ((reportRows ?? []) as any[]).map((r) => ({
    id: r.id as string,
    report_date: r.report_date as string,
    did_today: (r.did_today ?? null) as string | null,
    materials_tomorrow: (r.materials_tomorrow ?? null) as string | null,
    gps: (r.gps_summary ?? null) as DailyReportSummary | null,
    status: (r.status ?? "filed") as string,
    name: (r.profiles?.full_name ?? "Crew member") as string,
  }));

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
  {
    const pay = await payRateMap(supabase);
    for (const e of (entries ?? []) as any[]) {
      if (!e?.profile_id || !e.profiles) continue;
      e.profiles = { ...e.profiles, ...(pay.get(String(e.profile_id)) ?? {}) };
    }
  }

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
   * PLAN vs ACTUAL for the week on screen. What the crew calendar said, against where the hours
   * actually landed. This is only meaningful now that the calendar holds real rows instead of a
   * suggestion that vanished on refresh — you cannot be wrong about a guess.
   *
   * Read tolerantly: the 0170 `kind` column is young, and a payroll review page must not go blank
   * because one column isn't there yet.
   */
  const planRows = await tolerateMissingColumns<{ profile_id: string; work_date: string; job_id: string | null; kind: string }[]>(
    () =>
      supabase
        .from("crew_day_assignments")
        .select("profile_id, work_date, job_id, kind")
        .gte("work_date", weekDayStrs[0])
        .lte("work_date", weekDayStrs[6]),
  );
  const drift = needsAttentionRows(
    comparePlanToActual(
      (planRows ?? []).map((r) => ({
        profileId: r.profile_id,
        workDate: r.work_date,
        jobId: r.job_id,
        kind: (r.kind === "off" ? "off" : "job") as "job" | "off",
      })),
      (entries ?? []).map((e: any) => ({
        profileId: e.profile_id,
        workDate: todayStrInTz(tz, new Date(e.clock_in)),
        jobId: e.job_id ?? null,
        hours: e.clock_out ? hoursBetween(e.clock_in, e.clock_out) - (Number(e.lunch_minutes) || 0) / 60 : 0,
      })),
    ),
  );
  const nameById = new Map<string, string>(((members ?? []) as any[]).map((m) => [m.id, m.full_name ?? "Crew member"]));
  // THE NAME, NOT THE NUMBER. Erik, three separate bug reports: "timecards and all jobs need to be
  // displayed as job name not job number everywhere" / "need to see job name not job number" /
  // "this week should show jobs worked not job codes". A number is a filing reference; nobody
  // recognises their own week from J-022. jobLabel is the SSOT and already prefers the name — these
  // three call sites were hand-rolling the label instead of asking it.
  const jobLabelById = new Map<string, string>(((jobs ?? []) as any[]).map((j) => [j.id, jobLabel(j)]));

  // Group by tech. (The hours-per-job-code tally that lived here is gone —
  // Erik: analytics territory, clutter on a payroll review page.)
  const byTech = new Map<string, { name: string; entries: any[]; hours: number; miles: number }>();
  let crewTotal = 0;
  let crewMiles = 0;

  for (const e of entries ?? []) {
    const name = (e as any).profiles?.full_name ?? "—";
    const rec =
      byTech.get(e.profile_id) ?? { name, entries: [] as any[], hours: 0, miles: 0 };
    rec.entries.push(e);
    rec.miles += Number(e.miles ?? 0);
    crewMiles += Number(e.miles ?? 0);
    if (e.status === "closed" && e.clock_out) {
      const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
      rec.hours += h;
      crewTotal += h;
    }
    byTech.set(e.profile_id, rec);
  }

  // Split each person's miles into the commute baseline vs reimbursable business
  // miles (baseline subtracted once per day-driven).
  const techs = [...byTech.values()]
    .map((rec) => {
      const baseline = Number(rec.entries[0]?.profiles?.commute_baseline_miles ?? 0);
      return { ...rec, baseline, mileage: summarizeMileage(rec.entries, baseline, tz) };
    })
    .sort((a, b) => b.hours - a.hours);
  const crewBusinessMiles = Math.round(techs.reduce((s, t) => s + t.mileage.business, 0) * 10) / 10;
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
    .select("id, profile_id, clock_in, clock_out, lunch_minutes, job_id, profiles:profile_id(full_name), job:job_id(job_number, name)")
    .gte("clock_in", stackFrom)
    .lt("clock_in", stackTo)
    .order("clock_in", { ascending: true })
    .limit(4000);
  const stackEntries = ((stackRows ?? []) as any[]).map((e) => {
    const { dayStr, startMin, endMin } = timeEntryGridSpan(e.clock_in, e.clock_out, tz);
    // The paid hours, lunch already deducted by the same rule the rest of the app uses — a total
    // on a pay-period line that disagreed with payroll would be worse than no total at all.
    const gross = (new Date(e.clock_out ?? Date.now()).getTime() - new Date(e.clock_in).getTime()) / 3_600_000;
    const lunch = Number(e.lunch_minutes ?? 0) / 60;
    return {
      id: e.id as string,
      dayStr,
      startMin,
      endMin,
      hours: Math.max(0, Math.round((gross - lunch) * 100) / 100),
      label: `${firstNameOf(e.profiles?.full_name)}${e.job ? ` · ${jobLabel(e.job)}` : ""}`,
      sub: `${formatTime(e.clock_in, tz)}–${e.clock_out ? formatTime(e.clock_out, tz) : "now"}`,
      color: pillColorForPerson(e.profile_id).pill,
      href: `/timecards?week=${offset}&entry=${e.id}`,
    };
  });

  const gridLegend = [...byTech.entries()].map(([pid, rec]) => ({
    id: pid,
    name: rec.name,
    dot: pillColorForPerson(pid).dot,
  }));
  const gridNow = { dayStr: todayStr, min: tzMinutesOfDay(new Date(), tz) };
  const onClock = crew.filter((c) => c.clockedIn);

  const supId = getOrgSettings((org as any)?.settings).timecard_supervisor_id;
  const approver = supId
    ? (members?.find((m: any) => m.id === supId)?.full_name ?? "—")
    : "Owner";

  // ── PAY-PERIOD BREAKDOWN (Erik 7/15 — replaces the all-time-hours and
  // hours-per-job-code clutter): the pay period CONTAINING the viewed week,
  // one row per employee — total hours, base pay, and the paid state. Pay
  // mirrors /payroll EXACTLY (the same aggregatePayrollEntries: per-entry
  // rate_override honored, lunch deducted, paid/unpaid split by the paid_at
  // lock that /payroll's Mark-paid stamps). Mileage dollars are deliberately
  // absent — mileage settles as a human-stated amount on /payroll, never an
  // app-computed figure (payroll-two-buckets doctrine).
  const period = payPeriodBounds(orgSettings.pay_schedule, orgSettings.pay_anchor, weekDayStrs[0]);
  const { data: periodEntries } = await supabase
    .from("time_entries")
    .select("profile_id, clock_in, clock_out, lunch_minutes, miles, paid_at, mileage_paid_at, rate_override, profiles(full_name)")
    .eq("status", "closed")
    .not("clock_out", "is", null)
    .gte("clock_in", tzDayStartUtc(period.start, tz).toISOString())
    .lt("clock_in", tzDayStartUtc(period.end, tz).toISOString());
  // Rates merged from the staff-scoped profile_pay view (0215/0216 revoked them from the
  // authenticated role, so the embed cannot carry them). Without this every rate reads 0.
  attachRates((periodEntries ?? []) as any[], await payRateMap(supabase), (e: any) => ({ id: e.profile_id, holder: e }));
  const periodRows = aggregatePayrollEntries((periodEntries ?? []) as any[], tz);
  // The $48.50 lesson (mirrors /payroll's open-entries banner): still-open entries are
  // EXCLUDED by the closed-only filter above — name the gap or the period card silently
  // under-counts a whole shift. openNow (org-wide open set) is already fetched above.
  const periodStartMs = tzDayStartUtc(period.start, tz).getTime();
  const periodEndMs = tzDayStartUtc(period.end, tz).getTime();
  const openInPeriod = (openNow ?? []).filter((e: any) => {
    const t = new Date(e.clock_in).getTime();
    return t >= periodStartMs && t < periodEndMs;
  });
  const openPeriodNames = [
    ...new Set(openInPeriod.map((e: any) => e.profiles?.full_name).filter(Boolean)),
  ] as string[];
  // Inclusive last day as a date STRING so formatDate renders it literally
  // (formatting the UTC-midnight instant in the business tz shifts a day back).
  const periodEndIncl = new Date(new Date(`${period.end}T00:00:00Z`).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const periodLabel = `${formatDate(period.start)} – ${formatDate(periodEndIncl)}`;

  // The ?entry= deep link (a week-grid pill tap) — find the entry among this
  // week's rows or the org-wide open set, and auto-open its editor below.
  const focusEntry = entryParam
    ? (([...(entries ?? []), ...(openNow ?? [])] as any[]).find((e) => e.id === entryParam) ?? null)
    : null;

  return (
    <div>
      <PageHeader title="Timecards" description={`Review your crew's hours by week.  ·  Approver: ${approver}`}>
        <div className="flex flex-wrap items-center gap-2">
          <AddEntryButton
            isStaff
            jobCodesEnabled={orgSettings.timeclock_job_codes}
            members={members ?? []}
            jobCodes={(jobCodes ?? []) as JobCode[]}
            jobs={jobs ?? []}
            tz={tz}
          />
          <Link
            href={`/timecards?week=${offset + 1}`}
            className="rounded-lg border border-slate-300 bg-white p-2 text-slate-600 hover:bg-slate-50"
            title="Previous week"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <span className="min-w-[140px] text-center text-sm font-medium text-slate-700">
            {offset === 0 ? "This week" : label}
          </span>
          <Link
            href={`/timecards?week=${Math.max(0, offset - 1)}`}
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
          the clock RIGHT NOW, living next to the hours it becomes (Erik, cn-v503). */}
      {crew.length > 0 && (
        <Card className="mb-4">
          <CardContent className="py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">On the clock</span>
              {onClock.length === 0 && <span className="text-sm text-slate-400">Nobody right now</span>}
              {onClock.map((c) => (
                <span
                  key={c.id}
                  className="flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-900"
                >
                  <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" aria-hidden />
                  {c.name}
                  {c.jobLabel && <span className="font-normal text-emerald-700">· {c.jobLabel}</span>}
                </span>
              ))}
              <span className="ml-auto text-xs text-slate-500">
                {onClock.length} of {crew.length}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* THE PRIMARY VIEW — the week as a Google-Calendar-style time grid: each
          entry a pill in its time allotment, one color per person (legend above),
          the heavier divider = a pay-period boundary day. The editable per-person
          table stays below — this grid is display; edits keep their tools. */}
      <div className="mb-4">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-semibold text-slate-900">Hours</span>
          {gridLegend.map((p) => (
            <span key={p.id} className="flex items-center gap-1 text-xs text-slate-600">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${p.dot}`} aria-hidden /> {p.name}
            </span>
          ))}
        </div>
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

      {/* PAY PERIOD — the money view of the period containing this week (the
          heavier grid divider above marks where it starts). Same math as
          /payroll; the badge is the paid_at state /payroll's Mark-paid stamps. */}
      <Card className="mb-4">
        <CardContent className="py-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Pay period
            </span>
            <span className="text-xs text-slate-500">
              {periodLabel} ·{" "}
              <Link href="/payroll" className="font-medium text-brand hover:underline">
                Payroll →
              </Link>
            </span>
          </div>
          {openInPeriod.length > 0 && (
            <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
              {openInPeriod.length} open {openInPeriod.length === 1 ? "entry" : "entries"} (
              {openPeriodNames.join(", ")}) not counted — close {openInPeriod.length === 1 ? "it" : "them"}{" "}
              below and these totals will update.
            </p>
          )}
          {periodRows.length === 0 ? (
            <p className="text-sm text-slate-400">No hours logged this pay period yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {periodRows.map((r) => {
                const hours = r.paidHours + r.unpaidHours;
                const gross = Math.round((r.paidGross + r.unpaidGross) * 100) / 100;
                return (
                  <li key={r.profileId} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                    <span className="min-w-0 truncate text-slate-700">{r.name}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="tabular-nums text-slate-500">{formatDuration(hours)}</span>
                      <span className="font-semibold tabular-nums text-slate-900">{formatCurrency(gross)}</span>
                      {r.unpaidHours === 0 ? (
                        <Badge tone="green">paid</Badge>
                      ) : r.paidHours > 0 ? (
                        <Badge tone="amber">partly paid</Badge>
                      ) : (
                        <Badge tone="slate">unpaid</Badge>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Forgotten clock-outs inflate hours until someone closes them — surface
          them HERE, where payroll reviews, instead of waiting to be stumbled on. */}
      {/* PLAN vs ACTUAL — where the hours went against where the calendar said they would.
          NOT a discipline tool: a mismatch is nearly always a stale plan, not somebody lying — a
          crew gets pulled to a callback, a job finishes early. The value is that the office sees
          it on Friday rather than at invoicing, when the hours are already on the wrong job and
          the customer is already looking at the number. */}
      {drift.length > 0 && (
        <Card className="mb-4">
          <CardContent className="py-4">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Different from the plan
            </h3>
            <ul className="space-y-1 text-sm text-slate-600">
              {drift.slice(0, 8).map((r) => (
                <li key={`${r.profileId}|${r.workDate}`} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-xs tabular-nums text-slate-400">{formatDate(r.workDate)}</span>
                  <span>
                    {explain(r, (id) => jobLabelById.get(id) ?? "a job", nameById.get(r.profileId) ?? "Someone")}
                  </span>
                </li>
              ))}
            </ul>
            {drift.length > 8 && (
              <p className="mt-1 text-xs text-slate-400">+{drift.length - 8} more this week.</p>
            )}
            <p className="mt-2 text-xs text-slate-400">
              Usually the plan moved and nobody updated it. Worth a look before these hours go on an invoice.
            </p>
          </CardContent>
        </Card>
      )}

      {needsAttention.length > 0 && (
        <Card className="mb-4 border-amber-200 bg-amber-50/60">
          <CardContent className="py-4">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700">
              <AlertTriangle className="h-3.5 w-3.5" /> Needs attention
            </div>
            <ul className="divide-y divide-amber-200/60">
              {needsAttention.map((e: any) => {
                const openHrs = hoursBetween(e.clock_in, new Date(), 0);
                const pastDay = new Date(e.clock_in).getTime() < todayStartMs;
                return (
                  <li key={e.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <div className="min-w-0 text-slate-700">
                      <span className="font-medium">{e.profiles?.full_name ?? "—"}</span>
                      <span className="text-slate-500"> · in {formatDateTimeTz(e.clock_in, tz)}</span>
                      {e.job && <span className="text-slate-500"> · {jobLabel(e.job)}</span>}
                      <Badge tone="amber" className="ml-2">
                        {/* A zero-closed row is NOT open (audit 7: "Brian · open 98h" on a shift
                            0193 closed at zero on Monday was a lie that grew by the hour). Say
                            what the system actually did, with its reason. */}
                        {e.auto_closed_reason
                          ? `auto-closed — ${String(e.auto_closed_reason).replace(/_/g, " ")}`
                          : pastDay ? `open ${formatDuration(openHrs)} · past day` : `open ${formatDuration(openHrs)}`}
                      </Badge>
                    </div>
                    <EditEntryButton
                      entry={e}
                      jobCodes={(jobCodes ?? []) as JobCode[]}
                      jobs={jobs ?? []}
                      members={members ?? []}
                      isStaff
                      jobCodesEnabled={orgSettings.timeclock_job_codes}
                    />
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Crew-lead daily reports — what got done + materials needed tomorrow, with the
          GPS day story. This is the review surface the daily_report notification deep-links
          to; "Mark reviewed" checks a report off (0128's filed → reviewed).
          KNOWN GAP (audit 2026-07-16): 0128's design says "filed for office EDITING" and the
          update RLS grants staff that write, but no UI anywhere edits a report's
          did_today/materials_tomorrow — this list is read+review only. Build the edit
          affordance here if the office ever needs to correct a filed report. */}
      {dailyReports.length > 0 && (
        <Card className="mb-4 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <span className="text-sm font-semibold text-slate-800">Daily reports</span>
            <span className="text-xs font-medium text-slate-500">last 14 days</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {dailyReports.map((r) => (
              <li key={r.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 text-sm">
                    <span className="font-semibold text-slate-900">{r.name}</span>
                    <span className="ml-2 text-slate-500">{formatDate(r.report_date)}</span>
                    {r.status === "reviewed" && <Badge tone="green" className="ml-2">reviewed</Badge>}
                  </div>
                  {r.status !== "reviewed" && <MarkReportReviewedButton id={r.id} />}
                </div>
                {r.did_today && (
                  <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{r.did_today}</p>
                )}
                {r.materials_tomorrow && (
                  <p className="mt-1 whitespace-pre-line text-sm text-amber-700">
                    <span className="font-medium">Materials for tomorrow:</span> {r.materials_tomorrow}
                  </p>
                )}
                {r.gps && (
                  <div className="mt-1.5 text-xs text-slate-500">
                    <span className="font-medium text-slate-600">{formatDuration(Number(r.gps.total_hours) || 0)}</span>
                    {Number(r.gps.miles) > 0 && <span> · {Number(r.gps.miles).toFixed(1)} mi</span>}
                    {r.gps.first_in && <span> · first in {formatTime(r.gps.first_in, tz)}</span>}
                    {r.gps.last_out && <span> · last out {formatTime(r.gps.last_out, tz)}</span>}
                    {(r.gps.jobs ?? []).length > 0 && (
                      <span>
                        {" · "}
                        {(r.gps.jobs ?? [])
                          .map((jr) => `${jr.label} ${formatDuration(Number(jr.hours) || 0)}`)
                          .join(" · ")}
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <FactsGrid cols={3} className="mb-4 sm:max-w-2xl">
        <StatTile label={`Crew hours (${label})`} value={formatDuration(crewTotal)} />
        <StatTile label="People with entries" value={techs.length} />
        {/* Miles are DATA — no app-computed dollars here. Mileage pay is a
            human-typed settlement on /payroll, never rate×miles. */}
        <StatTile
          label={
            <>
              Business miles
              {crewMiles > crewBusinessMiles ? <span className="text-slate-400"> · {crewMiles.toFixed(1)} logged</span> : null}
            </>
          }
          value={`${crewBusinessMiles.toFixed(1)} mi`}
        />
      </FactsGrid>

      {/* The "Hours by job code", "Hours this pay period" (hours-only) and
          "Accumulated hours · all time" cards left this page (Erik 7/15 —
          analytics territory / clutter). The Pay-period card under the week
          grid is the one money summary now. */}

      {techs.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="No time entries this week"
          description="Clock-ins for the selected week will show up here."
        />
      ) : (
        <div className="space-y-4">
          {techs.map((rec) => (
            <Card key={rec.name}>
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
                    {initials(rec.name)}
                  </div>
                  <span className="text-sm font-semibold text-slate-900">{rec.name}</span>
                </div>
                <span className="text-sm font-bold text-slate-900">
                  {formatDuration(rec.hours)}
                  {rec.mileage.recorded > 0 && (
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      {rec.baseline > 0
                        ? `${rec.mileage.business.toFixed(1)} mi business · ${rec.mileage.recorded.toFixed(1)} logged`
                        : `${rec.mileage.recorded.toFixed(1)} mi`}
                    </span>
                  )}
                </span>
              </div>
              <ul className="divide-y divide-slate-100">
                {rec.entries.map((e: any) => {
                  const h =
                    e.status === "closed" && e.clock_out
                      ? hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes)
                      : null;
                  return (
                    <li key={e.id} className="px-5 py-3">
                      <div className="flex items-center justify-between text-sm">
                        <div className="text-slate-700">
                          {formatDateTimeTz(e.clock_in, tz)}
                          {" → "}
                          {e.clock_out ? formatDateTimeTz(e.clock_out, tz) : (
                            <Badge tone="green">open</Badge>
                          )}
                          {e.job && (
                            <Link href={`/jobs/${e.job_id}`} className="ml-2 font-medium text-brand hover:underline">
                              {jobLabel(e.job)}
                            </Link>
                          )}
                          {e.job_code && (
                            <Badge tone="slate" className="ml-2">
                              {e.job_code}
                            </Badge>
                          )}
                          {e.source === "manual" && (
                            <Badge tone="amber" className="ml-1">manual</Badge>
                          )}
                          {/* DISCLOSURE IS THE GUARD (0168). An offline punch's start time came
                              from the phone, not the server clock — nothing can prove it was made
                              live rather than backdated, so the card says where it came from and
                              lets the office judge. */}
                          {e.source === "offline" && (
                            <Badge tone="blue" className="ml-1" title="Punched with no signal — time came from the phone">
                              offline
                            </Badge>
                          )}
                          {e.lunch_minutes > 0 && (
                            <span className="ml-2 text-xs text-slate-400">
                              lunch {e.lunch_minutes}m
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-slate-800">
                            {h != null ? formatDuration(h) : "—"}
                          </span>
                          {e.status === "closed" && <DuplicateEntryButton id={e.id} />}
                          <EditEntryButton
                            entry={e}
                            jobCodes={(jobCodes ?? []) as JobCode[]}
                            jobs={jobs ?? []}
                            members={members ?? []}
                            isStaff
                            jobCodesEnabled={orgSettings.timeclock_job_codes}
                          />
                        </div>
                      </div>
                      {e.notes && (
                        <p className="mt-1 text-xs text-slate-500">{e.notes}</p>
                      )}
                      {e.time_allocations && e.time_allocations.length > 0 && (
                        <ul className="mt-1.5 space-y-1">
                          {e.time_allocations.map((a: any, i: number) => (
                            <li key={i} className="flex items-start gap-2 text-xs text-slate-600">
                              {a.job_code && <Badge tone="blue">{a.job_code}</Badge>}
                              <span className="text-slate-500">{formatDuration(a.hours)}</span>
                              {a.description && <span>· {a.description}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
