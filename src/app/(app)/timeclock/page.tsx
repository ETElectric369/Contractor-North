import Link from "next/link";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TimeclockPanel } from "./timeclock-panel";
import { AutoClockoutPrompt } from "./auto-clockout-prompt";
import { getOrgSettings } from "@/lib/org-settings";
import { AddEntryButton } from "./add-entry-button";
import { EditEntryButton } from "../timecards/edit-entry-button";
import { hoursBetween, formatDuration } from "@/lib/utils";
import { formatDateTimeTz } from "@/lib/tz";
import { translator } from "@/lib/i18n";
import type { JobCode, TimeEntry } from "@/lib/types";

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

  const [openRes, codesRes, jobsRes, weekRes, orgRes] = await Promise.all([
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
      .in("status", ["scheduled", "in_progress", "estimate"])
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("time_entries")
      .select("*")
      .eq("profile_id", user?.id ?? "")
      .gte("clock_in", weekAgo)
      .order("clock_in", { ascending: false }),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);
  const orgSettings = getOrgSettings((orgRes.data as any)?.settings);

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
          jobLabel: j ? `${j.job_number} · ${j.name}` : "the jobsite",
        };
      }
    }
  }

  // Recent entries table: personal for EVERYONE — /timecards is the one crew-wide
  // map (staff get a link under the table). Editable inline.
  const { data: recentData } = await supabase
    .from("time_entries")
    .select("*, job:job_id(job_number, name)")
    .eq("profile_id", user?.id ?? "")
    .gte("clock_in", weekAgo)
    .order("clock_in", { ascending: false })
    .limit(60);
  const recent = (recentData ?? []) as any[];

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
          />
        </div>

        <div className="space-y-6 lg:col-span-2">
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
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-900">{t("tc_recent")}</h3>
        </div>
        <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-5 py-2.5 font-semibold">Clock in</th>
              <th className="px-3 py-2.5 font-semibold">Clock out</th>
              <th className="px-3 py-2.5 font-semibold">Code</th>
              <th className="px-3 py-2.5 text-right font-semibold">Lunch</th>
              <th className="px-3 py-2.5 text-right font-semibold">Hours</th>
              <th className="px-5 py-2.5 text-right font-semibold">Edit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {recent.map((e) => (
              <tr key={e.id}>
                <td className="px-5 py-2.5 text-slate-700">{formatDateTimeTz(e.clock_in, orgSettings.timezone)}</td>
                <td className="px-3 py-2.5 text-slate-500">
                  {e.clock_out ? formatDateTimeTz(e.clock_out, orgSettings.timezone) : <Badge tone="green">{t("tc_open")}</Badge>}
                </td>
                <td className="px-3 py-2.5">
                  {e.job && (
                    <Link href={`/jobs/${e.job_id}`} className="mr-1 font-medium text-brand hover:underline">
                      {e.job.job_number}
                    </Link>
                  )}
                  {e.job_code ? <Badge tone="slate">{e.job_code}</Badge> : e.job ? null : "—"}
                  {e.source === "manual" && <Badge tone="amber" className="ml-1">manual</Badge>}
                </td>
                <td className="px-3 py-2.5 text-right text-slate-500">{e.lunch_minutes}m</td>
                <td className="px-3 py-2.5 text-right font-medium text-slate-800">
                  {e.clock_out ? formatDuration(hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes)) : "—"}
                </td>
                <td className="px-5 py-2.5 text-right">
                  <EditEntryButton entry={e} jobCodes={(codesRes.data ?? []) as JobCode[]} jobs={jobsRes.data ?? []} members={members ?? []} isStaff={isStaff} />
                </td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-6 text-center text-slate-400">
                  {t("tc_noEntries")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
        {isStaff && (
          <div className="border-t border-slate-100 px-5 py-3">
            <Link href="/timecards" className="text-sm font-medium text-brand hover:underline">
              Crew Hours →
            </Link>
          </div>
        )}
      </Card>
    </div>
  );
}
