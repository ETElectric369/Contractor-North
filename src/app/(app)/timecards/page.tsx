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
  formatDuration,
  formatDate,
  formatTime,
  hoursBetween,
  initials,
} from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { formatDateTimeTz, payPeriodBounds, tzDayStartUtc, todayStrInTz } from "@/lib/tz";
import { summarizeMileage } from "@/lib/mileage-math";
import { AddEntryButton } from "../timeclock/add-entry-button";
import { EditEntryButton } from "./edit-entry-button";
import { DuplicateEntryButton } from "./duplicate-entry-button";
import { MarkReportReviewedButton } from "./mark-report-reviewed-button";
import type { DailyReportSummary } from "../timeclock/actions";
import type { JobCode } from "@/lib/types";
import { jobLabel } from "@/lib/schedule-options";

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
  return { start, end };
}

export default async function TimecardsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { week } = await searchParams;
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

  const [{ data: members }, { data: jobCodes }, { data: jobs }, { data: org }] = await Promise.all([
    // hourly_rate + bill_rate feed the edit/add modals' pay-rate anchor + the
    // bill-rate tripwire. Safe to select flat here — the page redirects non-staff
    // above, so the rates never serialize into a tech's props.
    supabase.from("profiles").select("id, full_name, hourly_rate, bill_rate").eq("active", true).order("full_name"),
    supabase.from("job_codes").select("*").eq("active", true).order("code"),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);
  // Render times in the BUSINESS timezone, not the UTC server's, so the list
  // matches the (browser-local) edit modal instead of being hours off.
  const orgSettings = getOrgSettings((org as any)?.settings);
  const tz = orgSettings.timezone;

  const { start, end } = weekRange(offset, tz, orgSettings.week_start);

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
      "id, profile_id, clock_in, clock_out, lunch_minutes, miles, rate_override, paid_at, mileage_paid_at, job_id, job_code, status, notes, source, profiles:profile_id(full_name, commute_baseline_miles), job:job_id(job_number, name), time_allocations(job_id, job_code, hours, description)",
    )
    .gte("clock_in", start.toISOString())
    .lt("clock_in", end.toISOString())
    .order("clock_in", { ascending: true });

  // "Needs attention" pull — open entries that should have been closed: anything
  // still open from a PAST day (a forgotten clock-out) or open more than 12 hours
  // today. One cheap org-wide query (open entries are a handful at most), so the
  // strip works regardless of which week is being viewed.
  const { data: openNow } = await supabase
    .from("time_entries")
    .select(
      "id, profile_id, clock_in, clock_out, lunch_minutes, miles, job_id, job_code, status, notes, source, rate_override, profiles:profile_id(full_name), job:job_id(job_number, name), time_allocations(job_id, job_code, hours, description)",
    )
    .eq("status", "open")
    .order("clock_in", { ascending: true });
  const todayStartMs = tzDayStartUtc(todayStrInTz(tz), tz).getTime();
  const needsAttention = (openNow ?? []).filter((e: any) => {
    const inMs = new Date(e.clock_in).getTime();
    return inMs < todayStartMs || Date.now() - inMs > 12 * 3_600_000;
  });

  // Group by tech.
  const byTech = new Map<string, { name: string; entries: any[]; hours: number; miles: number }>();
  const perCode = new Map<string, number>();
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
      const code = e.job_code ?? "—";
      perCode.set(code, (perCode.get(code) ?? 0) + h);
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

  const supId = getOrgSettings((org as any)?.settings).timecard_supervisor_id;
  const approver = supId
    ? (members?.find((m: any) => m.id === supId)?.full_name ?? "—")
    : "Owner";

  // Each employee's TOTAL accumulated hours, all time (not just this week).
  const { data: allClosed } = await supabase
    .from("time_entries")
    .select("profile_id, clock_in, clock_out, lunch_minutes")
    .eq("status", "closed")
    .not("clock_out", "is", null);
  const accumByProfile = new Map<string, number>();
  for (const e of allClosed ?? []) {
    accumByProfile.set(
      e.profile_id,
      (accumByProfile.get(e.profile_id) ?? 0) + hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes),
    );
  }
  const accumList = (members ?? [])
    .map((m: any) => ({ name: m.full_name ?? "—", hours: accumByProfile.get(m.id) ?? 0 }))
    .filter((x: any) => x.hours > 0)
    .sort((a: any, b: any) => b.hours - a.hours);

  // Hours in the CURRENT pay period (payroll view), per employee.
  const settings = getOrgSettings((org as any)?.settings);
  const period = payPeriodBounds(settings.pay_schedule, settings.pay_anchor, todayStrInTz(tz));
  const periodStartMs = tzDayStartUtc(period.start, tz).getTime();
  const periodEndMs = tzDayStartUtc(period.end, tz).getTime();
  const periodByProfile = new Map<string, number>();
  for (const e of allClosed ?? []) {
    const t = new Date(e.clock_in).getTime();
    if (t >= periodStartMs && t < periodEndMs)
      periodByProfile.set(e.profile_id, (periodByProfile.get(e.profile_id) ?? 0) + hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes));
  }
  const periodList = (members ?? [])
    .map((m: any) => ({ name: m.full_name ?? "—", hours: periodByProfile.get(m.id) ?? 0 }))
    .filter((x: any) => x.hours > 0)
    .sort((a: any, b: any) => b.hours - a.hours);
  const periodLabel = `${formatDate(period.start)} – ${formatDate(new Date(new Date(`${period.end}T00:00:00Z`).getTime() - 86_400_000))}`;

  return (
    <div>
      <PageHeader title="Timecards" description={`Review your crew's hours by week.  ·  Approver: ${approver}`}>
        <div className="flex flex-wrap items-center gap-2">
          <AddEntryButton
            isStaff
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

      {/* Forgotten clock-outs inflate hours until someone closes them — surface
          them HERE, where payroll reviews, instead of waiting to be stumbled on. */}
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
                      {e.job && <span className="text-slate-500"> · {e.job.job_number}</span>}
                      <Badge tone="amber" className="ml-2">
                        {pastDay ? `open ${formatDuration(openHrs)} · past day` : `open ${formatDuration(openHrs)}`}
                      </Badge>
                    </div>
                    <EditEntryButton
                      entry={e}
                      jobCodes={(jobCodes ?? []) as JobCode[]}
                      jobs={jobs ?? []}
                      members={members ?? []}
                      isStaff
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
          to; "Mark reviewed" checks a report off (0128's filed → reviewed). */}
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

      {perCode.size > 0 && (
        <Card className="mb-6">
          <CardContent className="py-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Hours by job code
            </div>
            <div className="flex flex-wrap gap-2">
              {[...perCode.entries()].map(([code, h]) => (
                <span key={code} className="flex items-center gap-1.5 rounded-lg bg-slate-100 px-2.5 py-1 text-xs">
                  <Badge tone="slate">{code}</Badge>
                  <span className="font-medium text-slate-700">{formatDuration(h)}</span>
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="mb-6">
        <CardContent className="py-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Hours this pay period
            </span>
            <span className="text-xs text-slate-500">{periodLabel}</span>
          </div>
          {periodList.length === 0 ? (
            <p className="text-sm text-slate-400">No hours logged this pay period yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {periodList.map((a: any) => (
                <li key={a.name} className="flex items-center justify-between py-1.5 text-sm">
                  <span className="text-slate-700">{a.name}</span>
                  <span className="font-semibold tabular-nums text-slate-900">{formatDuration(a.hours)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {accumList.length > 0 && (
        <Card className="mb-6">
          <CardContent className="py-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              Accumulated hours · all time
            </div>
            <ul className="divide-y divide-slate-100">
              {accumList.map((a: any) => (
                <li key={a.name} className="flex items-center justify-between py-1.5 text-sm">
                  <span className="text-slate-700">{a.name}</span>
                  <span className="font-semibold tabular-nums text-slate-900">{formatDuration(a.hours)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

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
