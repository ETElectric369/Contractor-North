import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TimeclockPanel } from "./timeclock-panel";
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
  const isStaff = !!prof && ["owner", "admin", "office"].includes(prof.role);

  const { data: members } = isStaff
    ? await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("active", true)
        .order("full_name")
    : { data: [] as { id: string; full_name: string | null }[] };

  const [openRes, codesRes, jobsRes, weekRes, orgRes] = await Promise.all([
    supabase
      .from("time_entries")
      .select("*")
      .eq("profile_id", user?.id ?? "")
      .eq("status", "open")
      .maybeSingle(),
    supabase.from("job_codes").select("*").eq("active", true).order("code"),
    supabase
      .from("jobs")
      .select("id, job_number, name, address, city, state, zip")
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

  const openEntry = (openRes.data as TimeEntry) ?? null;
  const week = (weekRes.data ?? []) as TimeEntry[];

  // Recent entries table: staff see the whole crew (with names + edit), everyone
  // else sees their own. Editable inline.
  let recentQ = supabase
    .from("time_entries")
    .select("*, profiles:profile_id(full_name), job:job_id(job_number, name)")
    .gte("clock_in", weekAgo)
    .order("clock_in", { ascending: false })
    .limit(60);
  if (!isStaff) recentQ = recentQ.eq("profile_id", user?.id ?? "");
  const { data: recentData } = await recentQ;
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
          jobs={jobsRes.data ?? []}
        />
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <TimeclockPanel
            openEntry={openEntry}
            jobCodes={(codesRes.data ?? []) as JobCode[]}
            jobs={jobsRes.data ?? []}
            lang={lang}
            autoLunch={orgSettings.auto_lunch_30}
            homeAddress={(prof as any)?.home_address ?? ""}
            mileageRate={orgSettings.mileage_rate ?? 0}
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
              {isStaff && <th className="px-5 py-2.5 font-semibold">Who</th>}
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
                {isStaff && (
                  <td className="px-5 py-2.5 font-medium text-slate-700">{e.profiles?.full_name ?? "—"}</td>
                )}
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
                <td colSpan={isStaff ? 7 : 6} className="px-5 py-6 text-center text-slate-400">
                  {t("tc_noEntries")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </Card>
    </div>
  );
}
