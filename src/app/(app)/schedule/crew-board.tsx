import Link from "next/link";
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";
import { Badge, statusTone } from "@/components/ui/badge";
import { jobStatusLabel } from "@/lib/job-status";

export type CrewJob = { id: string; label: string; status: string; customer: string | null; assigned: string[] };
export type CrewAppt = { id: string; title: string; type: string; time: string; jobId: string | null; who: string | null; assigned: string | null };
export type Lane = { id: string; name: string; jobs: CrewJob[]; appts: CrewAppt[] };

/** The all-crew swimlane: one column per person for the day, so the whole crew's load is visible at
 *  a glance — who's slammed, who has room to take another job. Horizontally scrolls on a phone. */
export function CrewBoard({
  dayLabel,
  isToday,
  prevHref,
  nextHref,
  todayHref,
  lanes,
  unassigned,
}: {
  dayLabel: string;
  isToday: boolean;
  prevHref: string;
  nextHref: string;
  todayHref: string;
  lanes: Lane[];
  unassigned: Lane;
}) {
  const columns = [...lanes, unassigned].filter((l) => l.id === "__unassigned__" ? l.jobs.length + l.appts.length > 0 : true);

  return (
    <div className="mx-auto max-w-6xl">
      {/* Header: back to the calendar + the day + prev/today/next */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Link
            href="/schedule"
            className="inline-flex h-9 items-center gap-1 rounded-lg px-2 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <ChevronLeft className="h-4 w-4 shrink-0" /> Calendar
          </Link>
          <h1 className="text-lg font-bold tracking-tight text-slate-900">Everyone&apos;s Day</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <Link href={prevHref} aria-label="Previous day" className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:border-brand hover:text-brand">
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <span className="min-w-[7rem] text-center text-sm font-semibold text-slate-700">
            {isToday ? "Today" : dayLabel}
          </span>
          <Link href={nextHref} aria-label="Next day" className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:border-brand hover:text-brand">
            <ChevronRight className="h-4 w-4" />
          </Link>
          {!isToday && (
            <Link href={todayHref} className="ml-1 inline-flex h-8 items-center gap-1 rounded-lg border border-slate-200 px-2 text-xs font-medium text-slate-600 hover:border-brand hover:text-brand">
              <Calendar className="h-3.5 w-3.5" /> Today
            </Link>
          )}
        </div>
      </div>

      {/* Swimlanes — one column per crew member (+ Unassigned). Scrolls sideways on a phone. */}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((lane) => {
          const load = lane.jobs.length + lane.appts.length;
          const unassignedLane = lane.id === "__unassigned__";
          return (
            <div key={lane.id} className="flex w-56 shrink-0 flex-col rounded-xl border border-slate-200 bg-slate-50/60">
              <div className={`flex items-center justify-between gap-2 rounded-t-xl border-b px-3 py-2 ${unassignedLane ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white"}`}>
                <span className="truncate text-sm font-semibold text-slate-900">{lane.name}</span>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${load === 0 ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>
                  {load === 0 ? "open" : load}
                </span>
              </div>
              <div className="flex flex-col gap-1.5 p-2">
                {load === 0 && <p className="px-1 py-4 text-center text-xs text-slate-400">Nothing scheduled — has room.</p>}
                {lane.jobs.map((j) => (
                  <Link
                    key={j.id}
                    href={`/jobs/${j.id}`}
                    className="rounded-lg border border-slate-200 bg-white p-2 text-xs shadow-sm hover:border-brand"
                  >
                    <div className="flex items-start justify-between gap-1">
                      <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{j.label}</span>
                      <Badge tone={statusTone(j.status)}>{jobStatusLabel(j.status)}</Badge>
                    </div>
                    {j.customer && <div className="mt-0.5 truncate text-slate-400">{j.customer}</div>}
                  </Link>
                ))}
                {lane.appts.map((a) => (
                  <Link
                    key={a.id}
                    href={a.jobId ? `/jobs/${a.jobId}` : "/schedule"}
                    className="rounded-lg border border-slate-200 bg-white p-2 text-xs shadow-sm hover:border-brand"
                  >
                    <div className="flex items-center gap-1.5">
                      <Badge tone={a.type === "inspection" ? "amber" : "blue"}>{a.type}</Badge>
                      <span className="text-slate-500">{a.time}</span>
                    </div>
                    <div className="mt-0.5 truncate font-medium text-slate-900">{a.title}</div>
                    {a.who && <div className="truncate text-slate-400">{a.who}</div>}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
        {columns.length === 0 && (
          <p className="px-1 py-8 text-sm text-slate-400">No crew yet — add team members to see their day.</p>
        )}
      </div>
    </div>
  );
}
