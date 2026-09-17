import Link from "next/link";
import { Suspense } from "react";
import { isStaffRole } from "@/lib/actions/perms";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { payPeriodBounds, todayStrInTz, tzDayStartUtc } from "@/lib/tz";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TimeclockPanel } from "./timeclock-panel";
import { NextUp } from "./next-up";
import { AutoClockoutPrompt } from "./auto-clockout-prompt";
import { autoClockoutPromptState } from "./close-math";
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

  // The caller's OWN row, read twice over. `profiles` carries the plain fields (language,
  // role); home_address (the MILEAGE ORIGIN) and hourly_rate live behind the profile_pay view,
  // because 0216 revoked those columns from the authenticated role. profile_pay is staff-or-SELF,
  // so a person reading their own address and rate is exactly what it allows, and nobody else's
  // ever loads here.
  //
  // hourly_rate MUST come from THIS read. "My pay period" below hands it to
  // aggregatePayrollEntries as the fallback pay rate, and it was being read off `prof` — a select
  // that asks for language and role only, on a table whose rate column is revoked twice over. The
  // fallback was therefore 0, so a tech with no per-entry rate_override saw a real week of work
  // priced at $0.00 under an "unpaid" badge. A wrong number on a pay screen is worse than none.
  const [{ data: prof }, { data: selfPay }] = await Promise.all([
    supabase.from("profiles").select("language, role").eq("id", user?.id ?? "").maybeSingle(),
    supabase.from("profile_pay").select("home_address, hourly_rate").eq("id", user?.id ?? "").maybeSingle(),
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

  const [openRes, codesRes, jobsRes, weekRes, orgRes, leadRes] = await Promise.all([
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

  // Attach each job's template codes so the code picker can narrow to the right codes.
  const { data: tmplData } = await supabase.from("job_code_templates").select("id, codes");
  const tmplMap = new Map((tmplData ?? []).map((t: any) => [t.id as string, (t.codes ?? []) as string[]]));
  const jobOptions = ((jobsRes.data ?? []) as any[]).map((j) => ({
    ...j,
    customer_name: (j.customers?.name as string | undefined) ?? null,
    codes: j.code_template_id ? tmplMap.get(j.code_template_id) : undefined,
  }));

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

  // THE WEEK TOTAL (closed entries only) — the one number that survived the right-hand
  // "This week" card. That card broke the week down per job CODE, which is the exact shape
  // Erik threw off /timecards: "analytics territory, clutter on a payroll review page". It
  // was no less clutter here, and it spoke in codes (J-009, J-013) on a page he steers by
  // job NAME. The total now sits inside "My timecard", against the seven days it totals.
  let weekTotal = 0;
  for (const e of week) {
    if (e.status !== "closed" || !e.clock_out) continue;
    weekTotal += hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
  }

  // MY TIMECARD (everyone) — the caller's OWN week of entries, grouped by org-local day for
  // the read-only card below the clock panel, ending in the week total above. Techs can't
  // reach /timecards (office-only), so this is the only place they see their own hours.
  // Staff read it too now: the right-hand card that used to carry their week total is gone,
  // and the office punches a clock as well. Edits stay office work on purpose (no edit
  // affordances here) — staff have the door to the whole crew's ledger above.
  type MyTimecardRow = {
    id: string;
    in: string;
    out: string | null; // null = still on the clock
    lunch: number;
    hours: number | null; // closed entries only; open shows "on the clock"
    jobTag: string | null; // job number (codes on) or customer · address (codes off)
  };
  const myTimecard: { day: string; label: string; rows: MyTimecardRow[]; total: number }[] = [];
  if (user) {
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
      // The caller's own rate, off profile_pay (see the read at the top) — NOT off `prof`,
      // whose table no longer carries the column.
      Number((selfPay as any)?.hourly_rate ?? 0),
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

      <div className="space-y-6">
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

        {/* NEXT UP — the OTHER question a tech brings to this page (see next-up.tsx for the
         *  precedence and why it never guesses past the schedule). It sits directly under the clock
         *  button because that is where the question gets asked: thumb already there, phone already
         *  out. Everyone gets their OWN two days, staff included.
         *
         *  STREAMED, not awaited (the audit-v921 lesson: the phone lag was a page body sitting on a
         *  query before anything painted). The clock is the reason this page exists, so it paints
         *  first and these two rows arrive a beat later under a placeholder that keeps its space —
         *  no reflow under a thumb that is already moving. */}
        {user && (
          <Suspense
            fallback={
              <Card>
                <CardContent className="py-4">
                  <h3 className="mb-1 text-sm font-semibold text-slate-900">Next up</h3>
                  <p className="py-2 text-sm text-slate-400">Checking the schedule…</p>
                </CardContent>
              </Card>
            }
          >
            <NextUp userId={user.id} tz={orgSettings.timezone} />
          </Suspense>
        )}

        {/* WHERE THE CREW WEEK BOARD STOOD — three doors, staff only.
         *
         *  Erik: "we have this time off box that was showing the scheduled jobs too but then
         *  stopped and now its just in the way and doesnt show anything so we still need the
         *  functionality", and then: "do we need the crew week? lets try and mold as much
         *  together as possible and simplify, i lean towards the schedule".
         *
         *  The board is deleted, not moved. It was a SECOND per-day editor for
         *  crew_day_assignments, and cn-v590 took away the two things that ever filled it (the
         *  dashed schedule pill and the "Fill from the schedule" button) on his own instruction —
         *  so for seven weeks a correctly-empty grid and a dead one looked exactly alike. The
         *  schedule's Everyone's Day already answers who is on what, off real assignments and
         *  segments, so this page goes back to its one job: am I on the clock.
         *
         *  WHAT SURVIVES THE BOARD: the crew_day_assignments ROWS, and the writers in
         *  crew-actions.ts that make them. A day-assignment is still tier 0 of the job-less
         *  clock-in (timeclock/actions.ts, migration 0139 — the precedence law) and still feeds
         *  plan-vs-actual on /timecards. Deleting those writers would break a punch, not a board.
         *
         *  NOTHING SILENT / NO DEAD ENDS: a door that closes gets another named where it stood,
         *  and the whole row is the target (44px, easier to hit than a link inside it). */}
        {isStaff && (
          <div className="grid gap-2 sm:grid-cols-3">
            <Link
              href="/schedule?view=crew"
              className="flex min-h-[44px] flex-col justify-center rounded-lg border border-slate-200 bg-white px-4 py-3 active:bg-slate-50"
            >
              {/* TODAY, not "this week" — the door is named for what it OPENS. /schedule?view=crew
                *  renders CrewBoardPanel, which is Everyone's DAY: one day, paged a day at a time
                *  (crew-board-panel.tsx prevHref/nextHref shift by one). A door promising a week
                *  and opening a day is the same small lie Erik reported about the box this row
                *  replaces, and it is the thing NOT-ANNOYING and NOTHING SILENT exist to stop. */}
              <span className="text-sm font-semibold text-slate-900">Who&apos;s On What Today</span>
              <span className="text-xs text-slate-500">Everyone&apos;s Day on the schedule, one lane per person</span>
            </Link>
            <Link
              href="/timecards"
              className="flex min-h-[44px] flex-col justify-center rounded-lg border border-slate-200 bg-white px-4 py-3 active:bg-slate-50"
            >
              <span className="text-sm font-semibold text-slate-900">Crew Hours</span>
              <span className="text-xs text-slate-500">The whole crew&apos;s week, and what needs a human</span>
            </Link>
            <Link
              href="/payroll"
              className="flex min-h-[44px] flex-col justify-center rounded-lg border border-slate-200 bg-white px-4 py-3 active:bg-slate-50"
            >
              <span className="text-sm font-semibold text-slate-900">Pay</span>
              <span className="text-xs text-slate-500">What everyone is owed, and marking it paid</span>
            </Link>
          </div>
        )}

        {/* MY TIMECARD (everyone) — the caller's own week of punches, grouped by day, read-only:
            date, in-out, lunch, hours, the job by NAME, and the week total that used to live in
            the right-hand card. Edits are office work (/timecards), so no edit buttons here. */}
        {myTimecard.length > 0 && (
          <Card>
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
          <Card>
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
    </div>
  );
}
