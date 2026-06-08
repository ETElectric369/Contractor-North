import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  formatDuration,
  formatDateTime,
  formatCurrency,
  hoursBetween,
  initials,
} from "@/lib/utils";
import { getOrgSettings } from "@/lib/org-settings";
import { AddEntryButton } from "../timeclock/add-entry-button";
import { EditEntryButton } from "./edit-entry-button";
import type { JobCode } from "@/lib/types";

export const dynamic = "force-dynamic";

function weekRange(offset: number) {
  const now = new Date();
  const day = (now.getDay() + 6) % 7; // Monday = 0
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(now.getDate() - day - offset * 7);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
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
  if (!me || !["owner", "admin", "office"].includes(me.role)) {
    redirect("/timeclock");
  }

  const [{ data: members }, { data: jobCodes }, { data: jobs }, { data: org }] = await Promise.all([
    supabase.from("profiles").select("id, full_name").eq("active", true).order("full_name"),
    supabase.from("job_codes").select("*").eq("active", true).order("code"),
    supabase
      .from("jobs")
      .select("id, job_number, name")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);
  const mileageRate = getOrgSettings((org as any)?.settings).mileage_rate;

  const { start, end } = weekRange(offset);

  const { data: entries } = await supabase
    .from("time_entries")
    .select(
      "id, profile_id, clock_in, clock_out, lunch_minutes, miles, job_code, status, notes, source, profiles:profile_id(full_name), time_allocations(job_code, hours, description)",
    )
    .gte("clock_in", start.toISOString())
    .lt("clock_in", end.toISOString())
    .order("clock_in", { ascending: true });

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

  const techs = [...byTech.values()].sort((a, b) => b.hours - a.hours);
  const label = `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date(
    end.getTime() - 1,
  ).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  return (
    <div>
      <PageHeader title="Timecards" description="Review your crew's hours by week.">
        <div className="flex flex-wrap items-center gap-2">
          <AddEntryButton
            isStaff
            members={members ?? []}
            jobCodes={(jobCodes ?? []) as JobCode[]}
            jobs={jobs ?? []}
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

      <div className="mb-4 grid grid-cols-3 gap-4 sm:max-w-2xl">
        <Card>
          <CardContent className="py-4">
            <div className="text-2xl font-bold text-slate-900">{formatDuration(crewTotal)}</div>
            <div className="text-xs text-slate-500">Crew hours ({label})</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-2xl font-bold text-slate-900">{techs.length}</div>
            <div className="text-xs text-slate-500">People with entries</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4">
            <div className="text-2xl font-bold text-slate-900">{crewMiles.toFixed(1)} mi</div>
            <div className="text-xs text-slate-500">
              {mileageRate > 0 ? `${formatCurrency(crewMiles * mileageRate)} · ` : ""}Crew miles
            </div>
          </CardContent>
        </Card>
      </div>

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
                  {rec.miles > 0 && (
                    <span className="ml-2 text-xs font-normal text-slate-400">{rec.miles.toFixed(1)} mi</span>
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
                          {formatDateTime(e.clock_in)}
                          {" → "}
                          {e.clock_out ? formatDateTime(e.clock_out) : (
                            <Badge tone="green">open</Badge>
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
                          <EditEntryButton
                            entry={e}
                            jobCodes={(jobCodes ?? []) as JobCode[]}
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
