import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { ACTIVE_JOB_STATUSES, pickMemberCurrentJob } from "@/lib/job-status";
import { todayBoundsInTz } from "@/lib/tz";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TimeclockPanel } from "./timeclock-panel";
import { AutoClockoutPrompt } from "./auto-clockout-prompt";
import { CrewAssignments } from "./crew-assignments";
import { getOrgSettings } from "@/lib/org-settings";
import { AddEntryButton } from "./add-entry-button";
import { hoursBetween, formatDuration } from "@/lib/utils";
import { translator } from "@/lib/i18n";
import type { JobCode, TimeEntry } from "@/lib/types";
import { jobLabel } from "@/lib/schedule-options";

export const dynamic = "force-dynamic";

export default async function TimeclockPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const { data: prof } = await supabase
    .from("profiles")
    .select("language, role, home_address")
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
      .select("id, job_number, name, address, city, state, zip, code_template_id")
      .in("status", ACTIVE_JOB_STATUSES)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("time_entries")
      .select("*")
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

  // Each member's current assignment for the staff crew-assignment board — the SAME
  // priority the clock-in job resolution uses (the shared tier-1 pick in
  // lib/job-status): scheduled TODAY (segment covering the org-local day, or
  // scheduled_start inside it) → in_progress → newest other active job. The old
  // `.find()` over an UNORDERED query pointed a member on several jobs at an
  // arbitrary one (e.g. a stale on_hold job). One batched segments read — no N+1.
  const crewJobs = ((crewJobsRes.data ?? []) as {
    id: string;
    assigned_to: string[] | null;
    status?: string | null;
    scheduled_start?: string | null;
    created_at?: string | null;
  }[]);
  const currentAssignment: Record<string, string> = {};
  if (isStaff && crewJobs.length) {
    const { dayStart, dayEnd, todayStr } = todayBoundsInTz(orgSettings.timezone);
    const { data: segRows } = await supabase
      .from("job_schedule_segments")
      .select("job_id")
      .in("job_id", crewJobs.map((j) => j.id))
      .lte("start_date", todayStr)
      .gte("end_date", todayStr);
    const segToday = new Set(((segRows ?? []) as { job_id: string }[]).map((s) => s.job_id));
    for (const m of members ?? []) {
      const mine = crewJobs.filter((cj) => (cj.assigned_to ?? []).includes(m.id));
      const pick = pickMemberCurrentJob(mine, segToday, dayStart, dayEnd);
      if (pick) currentAssignment[m.id] = pick.id;
    }
  }

  // Attach each job's template codes so the code picker can narrow to the right codes.
  const { data: tmplData } = await supabase.from("job_code_templates").select("id, codes");
  const tmplMap = new Map((tmplData ?? []).map((t: any) => [t.id as string, (t.codes ?? []) as string[]]));
  const jobOptions = ((jobsRes.data ?? []) as any[]).map((j) => ({
    ...j,
    codes: j.code_template_id ? tmplMap.get(j.code_template_id) : undefined,
  }));

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
      .select("id, clock_in, clock_out, lunch_minutes, job_id, job:job_id(job_number, name)")
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
          jobLabel: j ? jobLabel(j) : "the jobsite",
        };
      }
    }
  }

  // The old "Recent entries" table lived here — removed by Erik's call (2026-07 notes):
  // entries already live on /timecards, so the clock page stays a clock, not a ledger.

  // Aggregate hours per job code for the week (closed entries only).
  const perCode = new Map<string, number>();
  let weekTotal = 0;
  for (const e of week) {
    if (e.status !== "closed" || !e.clock_out) continue;
    const h = hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes);
    weekTotal += h;
    const key = e.job_code ?? "—";
    perCode.set(key, (perCode.get(key) ?? 0) + h);
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t("tc_title")} description={t("tc_desc")}>
        <AddEntryButton
          isStaff={isStaff}
          members={members ?? []}
          jobCodes={(codesRes.data ?? []) as JobCode[]}
          jobs={jobOptions}
        />
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          {autoPrompt && (
            <AutoClockoutPrompt entry={autoPrompt} jobCodes={(codesRes.data ?? []) as JobCode[]} jobs={jobOptions} />
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
          />
        </div>

        <div className="space-y-6 lg:col-span-2">
          {/* The office's who's-on-which-job board — what a tech's job-less Clock In
              resolves against. Staff only. */}
          {isStaff && (
            <CrewAssignments
              members={(members ?? []).map((m: any) => ({ id: m.id, full_name: m.full_name }))}
              jobs={jobOptions.map((j: any) => ({ id: j.id, job_number: j.job_number, name: j.name }))}
              current={currentAssignment}
            />
          )}
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
