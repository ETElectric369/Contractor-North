import Link from "next/link";
import { CalendarDays, MapPin, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { NewJobButton } from "./new-job-button";
import type { Job } from "@/lib/types";

export const dynamic = "force-dynamic";

function dayKey(d: string | null) {
  if (!d) return "Unscheduled";
  return new Date(d).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

function timeLabel(d: string | null) {
  if (!d) return "";
  return new Date(d).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function SchedulePage() {
  const supabase = await createClient();

  const [{ data: jobsData }, { data: customers }] = await Promise.all([
    supabase
      .from("jobs")
      .select("*, customers(name)")
      .order("scheduled_start", { ascending: true, nullsFirst: false }),
    supabase.from("customers").select("id, name").order("name"),
  ]);

  const jobs = (jobsData ?? []) as (Job & { customers: { name: string } | null })[];

  // Group by day.
  const groups = new Map<string, typeof jobs>();
  for (const j of jobs) {
    const key = dayKey(j.scheduled_start);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(j);
  }

  return (
    <div>
      <PageHeader title="Schedule" description="Jobs and dispatch agenda.">
        <NewJobButton customers={customers ?? []} />
      </PageHeader>

      {jobs.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No jobs scheduled"
          description="Create a job and set a start time to build your schedule."
        >
          <NewJobButton customers={customers ?? []} />
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {[...groups.entries()].map(([day, items]) => (
            <div key={day}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700">
                <CalendarDays className="h-4 w-4 text-slate-400" /> {day}
                <span className="text-slate-400">· {items.length}</span>
              </h2>
              <Card className="divide-y divide-slate-100">
                {items.map((j) => (
                  <Link
                    key={j.id}
                    href={`/jobs/${j.id}`}
                    className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50"
                  >
                    <div className="w-16 shrink-0 text-sm font-medium text-slate-500">
                      {j.scheduled_start ? (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" /> {timeLabel(j.scheduled_start)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-slate-900">{j.name}</div>
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <span>{j.job_number}</span>
                        {j.customers?.name && <span>· {j.customers.name}</span>}
                        {j.address && (
                          <span className="flex items-center gap-0.5">
                            <MapPin className="h-3 w-3" /> {j.address}
                          </span>
                        )}
                      </div>
                    </div>
                    <Badge tone={statusTone(j.status)}>
                      {j.status.replace("_", " ")}
                    </Badge>
                  </Link>
                ))}
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
