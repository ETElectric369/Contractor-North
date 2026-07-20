import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { ACTIVE_JOB_STATUSES, pickMemberCurrentJob } from "@/lib/job-status";
import { payPeriodBounds, todayBoundsInTz, todayStrInTz, tzDayStartUtc } from "@/lib/tz";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TimeclockPanel } from "./timeclock-panel";
import { AutoClockoutPrompt } from "./auto-clockout-prompt";
import { CrewAssignments } from "./crew-assignments";
import { listWeekAssignments, setCrewDayAssignment } from "./crew-actions";
import { CrewWeekGrid } from "./crew-week-grid";
import { getOrgSettings } from "@/lib/org-settings";
import { AddEntryButton } from "./add-entry-button";
import { aggregatePayrollEntries } from "@/lib/payroll-math";
import { hoursBetween, formatCurrency, formatDate, formatDuration, formatTime } from "@/lib/utils";
import { translator } from "@/lib/i18n";
import type { JobCode, TimeEntry } from "@/lib/types";
import { jobLabel, jobSiteLabel } from "@/lib/schedule-options";

export const dynamic = "force-dynamic";

export default async function TimeclockPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  // hourly_rate = the caller's OWN pay rate (self-row read), feeding the tech's
  // "My pay period" summary below — no one else's rate ever loads here.
  const { data: prof } = await supabase
    .from("profiles")
    .select("language, role, home_address, hourly_rate")
    .eq("id", user?.id ?? "")
    .maybeSingle();
  const lang = prof?.language ?? "en";
  const t = translator(lang);
  const isStaff = !!prof && isStaffRole(prof.role);

  const { data: members } = isStaff
    ? await supabase
        .from("profiles")
        // hourly_rate + bill_rate feed the add/edit modals' pay-rate anchor and
        // bill-rate tripwire — selected ONLY inside this staff branch, so the crew's
        // rates never serialize into a tech's page props.
        .select("id, full_name, hourly_rate, bill_rate")
        .eq("active", true)
        .order("full_name")
    : { data: [] as { id: string; full_name: string | null }[] };

  const [openRes, codesRes, jobsRes, weekRes, orgRes, crewJobsRes, leadRes] = await Promise.all([
    supabase
      .from("time_entries")
      // Include any mid-shift switch segments already recorded on the open entry,
      // so the panel re-seeds the split after a page reload instead of losing it.
      .select("*, time_allocations(job_id, job_code, hours, description, sort_order)")
      .eq("profile_id", user?.id ?? "")
      .eq("status", "open")
      .maybeSingle(),
    supabase.from("job_codes").select("*").eq("active", true).order("code"),
    supabase
      .from("jobs")
      // customers(name) feeds the codes-off job identity label (customer · address).
      .select("id, job_number, name, address, city, state, zip, code_template_id, customers(name)")
      .in("status", ACTIVE_JOB_STATUSES)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("time_entries")
      // The job label fields ride along for the tech's read-only "My timecard" card
      // and the week summary below — entries can point at finished jobs, so the
      // ACTIVE-jobs options list can't resolve the label.
      .select("*, job:job_id(job_number, name, address, customers(name))")
      .eq("profile_id", user?.id ?? "")
      .gte("clock_in", weekAgo)
      .order("clock_in", { ascending: false }),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    // Staff crew-assignment board: which active job carries each member. Fetched
    // ONLY here (staff) so crew rosters never serialize into a tech's page props.
    // status/scheduled_start/created_at feed the board's priority pick below.
    isStaff
      ? supabase.from("jobs").select("id, assigned_to, status, scheduled_start, created_at").in("status", ACTIVE_JOB_STATUSES)
      : Promise.resolve({ data: [] as { id: string; assigned_to: string[] | null }[] }),
    // crew_lead is selected SEPARATELY (not in the profile select above) so this page
    // keeps working even if migration 0128 hasn't landed yet — an unknown column
    // would fail the whole profile read and de-staff the page.
    supabase.from("profiles").select("crew_lead").eq("id", user?.id ?? "").maybeSingle(),
  ]);
  const orgSettings = getOrgSettings((orgRes.data as any)?.settings);
  const crewLead = !!(leadRes.data as any)?.crew_lead;
  // Codes on (default) = today's behavior everywhere. Codes off = no code pickers on
  // any timeclock surface, and job labels lead with customer · street address.
  const jobCodesOn = orgSettings.timeclock_job_codes;

  // Each member's current assignment for the staff crew-assignment board — the SAME
  // priority the clock-in job resolution uses (the shared pick in lib/job-status):
  // TIER 0 the explicit crew DAY-assignment for the org-local today (0139 — the
  // precedence law: a planned day-assignment WINS and pushes everywhere) →
  // scheduled TODAY (segment covering the org-local day, or scheduled_start
  // inside it) → in_progress → newest other active job. The old `.find()` over an
  // UNORDERED query pointed a member on several jobs at an arbitrary one (e.g. a
  // stale on_hold job). One batched segments read — no N+1.
  const crewJobs = ((crewJobsRes.data ?? []) as {
    id: string;
    assigned_to: string[] | null;
    status?: string | null;
    scheduled_start?: string | null;
    created_at?: string | null;
  }[]);
  const { todayStr } = todayBoundsInTz(orgSettings.timezone);
  const currentAssignment: Record<string, string> = {};
  // Today's day-assignment JOB per member — the tier-0 source for the board's
  // inferred-current pick below. (The planner UI's own rows — incl. the ★ lead
  // checkboxes — seed from listWeekAssignments, not from this map.)
  const dayAssignments: Record<string, string> = {};
  if (isStaff && crewJobs.length) {
    const { dayStart, dayEnd } = todayBoundsInTz(orgSettings.timezone);
    const [{ data: segRows }, dayRes] = await Promise.all([
      supabase
        .from("job_schedule_segments")
        .select("job_id")
        .in("job_id", crewJobs.map((j) => j.id))
        .lte("start_date", todayStr)
        .gte("end_date", todayStr),
      // Fails soft (empty) until migration 0139 lands — an unknown table must
      // never de-board the page (the 0128 crew_lead precedent).
      supabase
        .from("crew_day_assignments")
        .select("profile_id, job_id")
        .eq("work_date", todayStr),
    ]);
    for (const r of ((dayRes.data ?? []) as { profile_id: string; job_id: string }[])) {
      dayAssignments[r.profile_id] = r.job_id;
    }
    const segToday = new Set(((segRows ?? []) as { job_id: string }[]).map((s) => s.job_id));
    for (const m of members ?? []) {
      const mine = crewJobs.filter((cj) => (cj.assigned_to ?? []).includes(m.id));
      // Tier-0 lookup searches the FULL active set, not just the member's
      // assigned jobs — the day-assignment wins even if the additive
      // write-through hasn't put them on jobs.assigned_to (yet).
      const dayJobId = dayAssignments[m.id] ?? null;
      if (dayJobId && !mine.some((j) => j.id === dayJobId)) {
        const dayJob = crewJobs.find((j) => j.id === dayJobId);
        if (dayJob) mine.unshift(dayJob);
      }
      const pick = pickMemberCurrentJob(mine, segToday, dayStart, dayEnd, dayJobId);
      if (pick) currentAssignment[m.id] = pick.id;
    }
  }

  // The week grid's data (staff render) — the same read the grid's client paging
  // uses (listWeekAssignments, offset 0 = this week), called server-side so the
  // grid hydrates with the current week instead of flashing empty.
  const weekAssignments = isStaff ? await listWeekAssignments(0) : null;

  // Attach each job's template codes so the code picker can narrow to the right codes.
  const { data: tmplData } = await supabase.from("job_code_templates").select("id, codes");
  const tmplMap = new Map((tmplData ?? []).map((t: any) => [t.id as string, (t.codes ?? []) as string[]]));
  const jobOptions = ((jobsRes.data ?? []) as any[]).map((j) => ({
    ...j,
    customer_name: (j.customers?.name as string | undefined) ?? null,
    codes: j.code_template_id ? tmplMap.get(j.code_template_id) : undefined,
  }));

  // The crew day-planner's shared prop bundle (staff only) — the SAME data feeds
  // the day-picker board (right column) and the CrewWeekGrid (under the clock):
  // current-week rows server-fetched above, week paging + saves through the
  // crew-actions pair, labels per the org's codes flag.
  const crewPlan = isStaff
    ? {
        members: (members ?? []).map((m: any) => ({ id: m.id as string, full_name: (m.full_name ?? null) as string | null })),
        jobs: jobOptions.map((j: any) => ({
          id: j.id as string,
          job_number: (j.job_number ?? null) as string | null,
          name: (j.name ?? null) as string | null,
          address: (j.address ?? null) as string | null,
          customer_name: (j.customer_name ?? null) as string | null,
        })),
        weekRows: weekAssignments?.rows ?? [],
        tz: orgSettings.timezone,
        weekStart: orgSettings.week_start,
        jobCodesEnabled: jobCodesOn,
        setCrewDayAssignment,
        listWeekAssignments,
      }
    : null;

  // The label a week-old entry's JOB shows on this page: the job number (codes on,
  // unchanged) or the customer · address identity (codes off). Entries can point at
  // finished jobs, so this reads the entry's own join, not the active-jobs options.
  const weekJobTag = (e: TimeEntry): string | null => {
    const j = (e as any).job as
      | { job_number?: string | null; name?: string | null; address?: string | null; customers?: { name?: string | null } | null }
      | null;
    if (!j) return null;
    return jobCodesOn
      ? (j.job_number ?? null)
      : jobSiteLabel({ ...j, customer_name: j.customers?.name ?? null });
  };

  const openEntry = (openRes.data as TimeEntry) ?? null;
  // The open entry's switch-recorded allocations, in the order they were written.
  const openAllocations = (((openRes.data as any)?.time_allocations ?? []) as any[])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((a) => ({
      job_id: (a.job_id ?? null) as string | null,
      job_code: (a.job_code ?? null) as string | null,
      hours: Number(a.hours) || 0,
      description: (a.description ?? null) as string | null,
    }));
  const week = (weekRes.data ?? []) as TimeEntry[];

  // Geofence auto-clock-out completion: the tech's most recent auto-closed entry that
  // still has no code breakdown — prompt them to answer the clock-out questions.
  let autoPrompt:
    | { id: string; clock_in: string; clock_out: string; lunch_minutes: number; jobId: string | null; jobLabel: string }
    | null = null;
  if (user) {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const { data: autoEntry } = await supabase
      .from("time_entries")
      .select("id, clock_in, clock_out, lunch_minutes, job_id, job:job_id(job_number, name, address, customers(name))")
      .eq("profile_id", user.id)
      .eq("source", "auto_gps")
      .eq("status", "closed")
      .gte("clock_out", threeDaysAgo)
      .order("clock_out", { ascending: false })
      .limit(1)
      .maybeSingle();
    if ((autoEntry as any)?.clock_out) {
      const { count } = await supabase
        .from("time_allocations")
        .select("id", { count: "exact", head: true })
        .eq("time_entry_id", (autoEntry as any).id);
      if (!count) {
        const j = (autoEntry as any).job;
        autoPrompt = {
          id: (autoEntry as any).id,
          clock_in: (autoEntry as any).clock_in,
          clock_out: (autoEntry as any).clock_out,
          lunch_minutes: (autoEntry as any).lunch_minutes ?? 0,
          jobId: (autoEntry as any).job_id ?? null,
          jobLabel: j
            ? jobCodesOn
              ? jobLabel(j)
              : jobSiteLabel({ ...j, customer_name: j.customers?.name ?? null })
            : "the jobsite",
        };
      }
    }
  }

  // The old "Recent entries" table lived here — removed by Erik's call (2026-07 notes):
  // entries already live on /timecards, so the clock page stays a clock, not a ledger.

  // Aggregate the week's hours (closed entries only) — per job CODE (codes on,
  // unchanged), or per JOB identity when the org turned codes off (every badge
  // would otherwise read "—").
  const perCode = new Map<string, number>();
  let weekTotal = 0;
  for (const e of week) {
    if (e.status !== "closed" || !e.clock_out) continue;
    const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    weekTotal += h;
    const key = (jobCodesOn ? e.job_code : weekJobTag(e)) ?? "—";
    perCode.set(key, (perCode.get(key) ?? 0) + h);
  }

  // MY TIMECARD (techs only) — the same week of the caller's entries, grouped by
  // org-local day for the read-only card below the clock panel. Techs can't reach
  // /timecards (office-only), so this is their view of their own hours; edits stay
  // office work on purpose (no edit affordances here). Staff skip it — they have
  // the full crew ledger at /timecards.
  type MyTimecardRow = {
    id: string;
    in: string;
    out: string | null; // null = still on the clock
    lunch: number;
    hours: number | null; // closed entries only; open shows "on the clock"
    jobTag: string | null; // job number (codes on) or customer · address (codes off)
  };
  const myTimecard: { day: string; label: string; rows: MyTimecardRow[]; total: number }[] = [];
  if (!isStaff) {
    const tz = orgSettings.timezone;
    const byDay = new Map<string, { label: string; rows: MyTimecardRow[]; total: number }>();
    for (const e of week) {
      // Org-local day key via the tz SSOT (same primitive timeEntryGridSpan uses) —
      // not an inline toLocaleDateString fork of the day-boundary logic.
      const day = todayStrInTz(tz, new Date(e.clock_in));
      if (!byDay.has(day)) {
        byDay.set(day, {
          label: new Date(e.clock_in).toLocaleDateString("en-US", {
            timeZone: tz,
            weekday: "short",
            month: "short",
            day: "numeric",
          }),
          rows: [],
          total: 0,
        });
      }
      const g = byDay.get(day)!;
      const closed = e.status === "closed" && !!e.clock_out;
      const h = closed ? hoursBetween(e.clock_in, e.clock_out as string, e.lunch_minutes) : null;
      // The query is newest-first; unshift so each day's punches read in clock order.
      g.rows.unshift({
        id: e.id,
        in: formatTime(e.clock_in, tz),
        out: e.clock_out ? formatTime(e.clock_out, tz) : null,
        lunch: Math.max(0, Number(e.lunch_minutes) || 0),
        hours: h,
        jobTag: weekJobTag(e),
      });
      if (h != null) g.total += h;
    }
    // Map insertion order = newest day first (the query order), which is what the card wants.
    for (const [day, g] of byDay) myTimecard.push({ day, ...g });
  }

  // MY PAY PERIOD (techs only) — the same period summary the office reads on
  // /timecards, for THIS tech alone: total hours + base pay via the EXACT
  // /payroll math (aggregatePayrollEntries — per-entry rate_override honored,
  // lunch deducted) + the paid/unpaid state /payroll's Mark-paid stamps
  // (paid_at). Mileage dollars never appear — mileage is a human-stated
  // settlement on /payroll (payroll-two-buckets doctrine), never app-computed.
  let myPeriod:
    | {
        label: string;
        hours: number;
        gross: number;
        state: "paid" | "partly" | "unpaid";
        /** The $48.50 lesson (mirrors /payroll's open-entries banner): a still-open shift is
         *  EXCLUDED by the closed-only filter below — say so, or the period under-counts silently. */
        openNotCounted: boolean;
      }
    | null = null;
  if (!isStaff && user) {
    const tz = orgSettings.timezone;
    const period = payPeriodBounds(orgSettings.pay_schedule, orgSettings.pay_anchor, todayStrInTz(tz));
    const { data: periodEntries } = await supabase
      .from("time_entries")
      .select("profile_id, clock_in, clock_out, lunch_minutes, rate_override, paid_at, mileage_paid_at")
      .eq("profile_id", user.id)
      .eq("status", "closed")
      .not("clock_out", "is", null)
      .gte("clock_in", tzDayStartUtc(period.start, tz).toISOString())
      .lt("clock_in", tzDayStartUtc(period.end, tz).toISOString());
    const [row] = aggregatePayrollEntries(
      (periodEntries ?? []) as any[],
      tz,
      Number((prof as any)?.hourly_rate ?? 0),
    );
    if (row) {
      // Inclusive last day as a date STRING so formatDate prints it literally.
      const endIncl = new Date(new Date(`${period.end}T00:00:00Z`).getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      const openInMs = openEntry ? new Date(openEntry.clock_in).getTime() : null;
      myPeriod = {
        label: `${formatDate(period.start)} – ${formatDate(endIncl)}`,
        hours: row.paidHours + row.unpaidHours,
        gross: Math.round((row.paidGross + row.unpaidGross) * 100) / 100,
        state: row.unpaidHours === 0 ? "paid" : row.paidHours > 0 ? "partly" : "unpaid",
        openNotCounted:
          openInMs != null &&
          openInMs >= tzDayStartUtc(period.start, tz).getTime() &&
          openInMs < tzDayStartUtc(period.end, tz).getTime(),
      };
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t("tc_title")} description={t("tc_desc")}>
        <AddEntryButton
          isStaff={isStaff}
          members={members ?? []}
          jobCodes={(codesRes.data ?? []) as JobCode[]}
          jobs={jobOptions}
          jobCodesEnabled={jobCodesOn}
        />
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          {autoPrompt && (
            <AutoClockoutPrompt
              entry={autoPrompt}
              jobCodes={(codesRes.data ?? []) as JobCode[]}
              jobs={jobOptions}
              jobCodesEnabled={jobCodesOn}
            />
          )}
          <TimeclockPanel
            openEntry={openEntry}
            openAllocations={openAllocations}
            jobCodes={(codesRes.data ?? []) as JobCode[]}
            jobs={jobOptions}
            lang={lang}
            autoLunch={orgSettings.auto_lunch_30}
            homeAddress={(prof as any)?.home_address ?? ""}
            isStaff={isStaff}
            crewLead={crewLead}
            jobCodesEnabled={jobCodesOn}
          />

          {/* THE CREW WEEK — directly under the timeclock (staff only): the org week
              as a timecards-style grid showing ONLY the day-assignments (job pill +
              ★ lead per member per day). A cell tap opens its inline editor. */}
          {crewPlan && <CrewWeekGrid {...crewPlan} />}

          {/* MY TIMECARD (techs only) — the week's punches, grouped by day, read-only:
              date, in–out, lunch, hours, job number, + the week total. Edits are office
              work (/timecards), which techs can't reach — so no edit buttons here. */}
          {!isStaff && myTimecard.length > 0 && (
            <Card className="mt-6">
              <CardContent className="py-5">
                <div className="mb-1 flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">My timecard</h3>
                  <span className="text-xs text-slate-400">Last 7 days</span>
                </div>
                <div className="divide-y divide-slate-100">
                  {myTimecard.map((d) => (
                    <div key={d.day} className="py-2.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold uppercase tracking-wide text-slate-500">{d.label}</span>
                        {d.total > 0 && <span className="font-medium text-slate-500">{formatDuration(d.total)}</span>}
                      </div>
                      {d.rows.map((r) => (
                        <div key={r.id} className="mt-1 flex items-center justify-between gap-3 text-sm">
                          <span className="min-w-0 truncate text-slate-700">
                            {r.in}–{r.out ?? "now"}
                            {r.lunch > 0 ? ` · ${r.lunch}m lunch` : ""}
                            {r.jobTag ? ` · ${r.jobTag}` : ""}
                          </span>
                          <span className="shrink-0 text-slate-600">
                            {r.hours != null ? formatDuration(r.hours) : "on the clock"}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-3 text-sm">
                  <span className="font-semibold text-slate-900">Week total</span>
                  <span className="font-bold text-slate-900">{formatDuration(weekTotal)}</span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* MY PAY PERIOD (techs only) — hours + base pay + paid state for the
              current period, mirroring what the office sees on /timecards.
              Mileage $ is deliberately absent (settled by a human on /payroll). */}
          {!isStaff && myPeriod && (
            <Card className="mt-4">
              <CardContent className="py-4">
                <div className="mb-1 flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold text-slate-900">My pay period</h3>
                  <span className="text-xs text-slate-400">{myPeriod.label}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-600">{formatDuration(myPeriod.hours)}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-bold text-slate-900">{formatCurrency(myPeriod.gross)}</span>
                    {myPeriod.state === "paid" ? (
                      <Badge tone="green">paid</Badge>
                    ) : myPeriod.state === "partly" ? (
                      <Badge tone="amber">partly paid</Badge>
                    ) : (
                      <Badge tone="slate">unpaid</Badge>
                    )}
                  </span>
                </div>
                {myPeriod.openNotCounted && (
                  <p className="mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                    Your current shift is still on the clock and not counted yet — these totals update
                    when you clock out.
                  </p>
                )}
                <p className="mt-1.5 text-xs text-slate-400">
                  Base pay only — mileage is tracked in miles and settled separately by the office.
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6 lg:col-span-2">
          {/* The office's day-planner board — day strip + per-member job/★-lead lines.
              A day row here WINS: the tech's job-less Clock In resolves to it (with
              `current` as the inferred today-fallback, shown as "auto"). Staff only. */}
          {crewPlan && <CrewAssignments {...crewPlan} current={currentAssignment} />}
          <Card>
            <CardContent className="py-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-900">
                {t("tc_thisWeek")}
              </h3>
              <div className="mb-3 text-3xl font-bold text-slate-900">
                {formatDuration(weekTotal)}
              </div>
              <div className="space-y-1.5">
                {[...perCode.entries()].map(([code, h]) => (
                  <div
                    key={code}
                    className="flex items-center justify-between text-sm"
                  >
                    <Badge tone="slate">{code}</Badge>
                    <span className="text-slate-600">{formatDuration(h)}</span>
                  </div>
                ))}
                {perCode.size === 0 && (
                  <p className="text-sm text-slate-400">No closed entries yet.</p>
                )}
              </div>
              {/* The Recent-entries table left this page (it duplicated /timecards) — keep the
                  door to the ledger for STAFF only: /timecards bounces non-staff right back
                  here, so a tech's "My timecard →" link was a dead loop. Techs see their
                  week's numbers above; no link. */}
              {isStaff && (
                <div className="mt-4 border-t border-slate-100 pt-3">
                  <Link href="/timecards" className="text-sm font-medium text-brand hover:underline">
                    Crew Hours →
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
