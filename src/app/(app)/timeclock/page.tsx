import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { ACTIVE_JOB_STATUSES, pickMemberCurrentJob } from "@/lib/job-status";
import { payPeriodBounds, todayBoundsInTz, todayStrInTz, tzDayStartUtc, weekDayStrs } from "@/lib/tz";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TimeclockPanel } from "./timeclock-panel";
import { AutoClockoutPrompt } from "./auto-clockout-prompt";
import { autoClockoutPromptState } from "./close-math";
import { listWeekAssignments, setCrewDayAssignment } from "./crew-actions";
import { CrewWeekGrid } from "./crew-week-grid";
import { pickScheduledJobForDay, type CrewAutoPlan } from "./crew-plan";
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
  // The caller's own row. home_address is the MILEAGE ORIGIN, and it lives behind the
  // profile_pay view now (0216 revoked it from the authenticated role) — narrowing this select
  // without a second read silently blanked it, so the tech's drive started from nowhere.
  // profile_pay is staff-or-SELF, so a tech reading their own address is exactly what it allows.
  const [{ data: prof }, { data: selfPay }] = await Promise.all([
    supabase.from("profiles").select("language, role").eq("id", user?.id ?? "").maybeSingle(),
    supabase.from("profile_pay").select("home_address").eq("id", user?.id ?? "").maybeSingle(),
  ]);
  const lang = prof?.language ?? "en";
  const t = translator(lang);
  const isStaff = !!prof && isStaffRole(prof.role);

  const { data: members } = isStaff
    ? await supabase
        // profile_pay, not profiles: those columns are revoked from the authenticated role
        // (0215/0216) because RLS cannot restrict columns. The view hands the whole org to
        // office staff and only your own row to anyone else, so this staff branch is now
        // enforced by the database rather than by the branch itself.
        .from("profile_pay")
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
      .order("created_at", { ascending: false }),
      // NO LIMIT. This was .limit(50) ordered newest-first, so it dropped the OLDEST still-active
      // jobs — exactly the long-running ones a crew is most likely to be clocking into. That is
      // the "Not all are listed" report, and it also explains the nameless "Assigned job" option
      // on the crew board: the board infers a job the dropdown can't name. The sibling query below
      // reads the same ACTIVE_JOB_STATUSES set with no limit, which is the tell that the cap was
      // incidental rather than intended.
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
  // The current org week's 7 day-strings — bounds for the schedule read that
  // feeds the planner's muted "auto" hints below (today + future days only).
  const thisWeekDays = weekDayStrs(todayStr, orgSettings.week_start, 0);
  /**
   * NO SUGGESTED ASSIGNMENTS (cn-v590). This used to infer a job per member per day and draw it on
   * the board as a dashed pill. Erik: "honestly i dont think we should suggest crew assignments,
   * theres too much complication going on here and its confusing with the pills and suggestions."
   *
   * He's right, and it was never worth what it cost. It saved nothing, vanished on refresh, made
   * every cell ambiguous — planned, or guessed? — and made plan-vs-actual impossible, because you
   * cannot diff reality against an opinion. An EMPTY cell means nobody has decided, which is TRUE,
   * and a truthful blank beats a confident guess.
   *
   * The crew calendar is the single source of truth for who works which job on which day, and
   * everything on it is now a decision somebody made.
   */

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

  // The crew calendar's props (staff only). ONE surface now — the day-picker board that used to
  // sit in the right column was a second way to edit the same rows, which is exactly the
  // "too much complication" the owner named. Two controls for one fact is the complication.
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

  // The label a week-old entry's JOB shows on this page. Entries can point at finished jobs, so
  // this reads the entry's own join, not the active-jobs options.
  //
  // NAME, NOT NUMBER (cn-v697). Erik, on this exact list: "this week should show jobs worked not
  // job codes" — and twice more elsewhere, "timecards and all jobs need to be displayed as job
  // name not job number everywhere". The codes-on branch returned a bare `job_number`, so his
  // week read J-009, J-013, J-017 — three different dwellings at 300 W Lake Blvd whose only
  // distinguishing text lives in the NAME. jobLabel is the SSOT and already prefers the name,
  // falling back to the number for a job that hasn't got one.
  //
  // The codes-OFF branch keeps jobSiteLabel: an org with codes off navigates by whose house the
  // crew is at, which is a different question, not a worse answer to this one.
  const weekJobTag = (e: TimeEntry): string | null => {
    const j = (e as any).job as
      | { job_number?: string | null; name?: string | null; address?: string | null; customers?: { name?: string | null } | null }
      | null;
    if (!j) return null;
    return jobCodesOn ? jobLabel(j) : jobSiteLabel({ ...j, customer_name: j.customers?.name ?? null });
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
    | {
        id: string;
        clock_in: string;
        clock_out: string;
        lunch_minutes: number;
        jobId: string | null;
        jobLabel: string;
        /** Hours already recorded on the entry (mid-shift switch segments) — the
         *  prompt asks only about the remainder. */
        allocatedHours: number;
      }
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
      // How much of the shift is ALREADY recorded (mid-shift switch segments now
      // survive the geofence close). Ask only about what's still unallocated —
      // seeding the full shift onto the entry's post-switch job is what re-filed a
      // whole day onto the wrong customer.
      const { data: allocRows } = await supabase
        .from("time_allocations")
        .select("hours")
        .eq("time_entry_id", (autoEntry as any).id);
      const allocatedHours = ((allocRows ?? []) as { hours: number | null }[]).reduce(
        (s, a) => s + (Number(a.hours) || 0),
        0,
      );
      // Surface the prompt when there's unallocated time to break down OR when a >5h
      // shift's auto-close skipped the 30-min meal (lunch still 0) even though the switch
      // segments + tail already allocated the whole day — the switched-close meal-skip
      // regression. The pure gate (autoClockoutPromptState) is unit-tested in close-math.
      const grossHours = hoursBetween((autoEntry as any).clock_in, (autoEntry as any).clock_out, 0);
      const { show } = autoClockoutPromptState({
        grossHours,
        lunchMinutes: (autoEntry as any).lunch_minutes ?? 0,
        allocatedHours,
      });
      if (show) {
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
          allocatedHours: Math.round(allocatedHours * 100) / 100,
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

      {/* min-w-0 on BOTH columns is load-bearing: the CrewWeekGrid's fixed-min-width
          scroller lives inside these grid items, and a grid item's automatic minimum
          (min-width:auto) would otherwise size the item to the scroller's full
          content width — stretching the whole page sideways on phones and pushing
          the columns past the viewport on desktop (the cn-v523 fallout). With
          min-w-0 the wide grid scrolls INSIDE its own overflow-x container, the
          /timecards pattern. */}
      <div className="grid gap-6 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
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
            homeAddress={(selfPay as { home_address?: string | null } | null)?.home_address ?? ""}
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

        <div className="min-w-0 space-y-6 lg:col-span-2">
          {/* The office's day-planner board — day strip + per-member job/★-lead lines.
              A day row here WINS: the tech's job-less Clock In resolves to it (with
              autoPlan as the inferred fallback, shown as "auto"). Staff only. */}
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
