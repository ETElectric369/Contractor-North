import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TimeclockPanel } from "./timeclock-panel";
import { formatDateTime, hoursBetween, formatDuration } from "@/lib/utils";
import type { JobCode, TimeEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function TimeclockPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [openRes, codesRes, jobsRes, weekRes] = await Promise.all([
    supabase
      .from("time_entries")
      .select("*")
      .eq("profile_id", user?.id ?? "")
      .eq("status", "open")
      .maybeSingle(),
    supabase.from("job_codes").select("*").eq("active", true).order("code"),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .in("status", ["scheduled", "in_progress", "estimate"])
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("time_entries")
      .select("*")
      .eq("profile_id", user?.id ?? "")
      .gte("clock_in", weekAgo)
      .order("clock_in", { ascending: false }),
  ]);

  const openEntry = (openRes.data as TimeEntry) ?? null;
  const week = (weekRes.data ?? []) as TimeEntry[];

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
      <PageHeader
        title="Timeclock"
        description="Clock in and out, log lunch, and record what you worked on."
      />

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <TimeclockPanel
            openEntry={openEntry}
            jobCodes={(codesRes.data ?? []) as JobCode[]}
            jobs={jobsRes.data ?? []}
          />
        </div>

        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardContent className="py-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-900">
                This week
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
          <h3 className="text-sm font-semibold text-slate-900">Recent entries</h3>
        </div>
        <table className="w-full text-sm">
          <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-5 py-2.5 font-semibold">Clock in</th>
              <th className="px-3 py-2.5 font-semibold">Clock out</th>
              <th className="px-3 py-2.5 font-semibold">Code</th>
              <th className="px-3 py-2.5 text-right font-semibold">Lunch</th>
              <th className="px-5 py-2.5 text-right font-semibold">Hours</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {week.map((e) => (
              <tr key={e.id}>
                <td className="px-5 py-2.5 text-slate-700">
                  {formatDateTime(e.clock_in)}
                </td>
                <td className="px-3 py-2.5 text-slate-500">
                  {e.clock_out ? formatDateTime(e.clock_out) : (
                    <Badge tone="green">open</Badge>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  {e.job_code ? <Badge tone="slate">{e.job_code}</Badge> : "—"}
                </td>
                <td className="px-3 py-2.5 text-right text-slate-500">
                  {e.lunch_minutes}m
                </td>
                <td className="px-5 py-2.5 text-right font-medium text-slate-800">
                  {e.clock_out
                    ? formatDuration(
                        hoursBetween(e.clock_in, e.clock_out, e.lunch_minutes),
                      )
                    : "—"}
                </td>
              </tr>
            ))}
            {week.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-6 text-center text-slate-400">
                  No entries in the last 7 days.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
