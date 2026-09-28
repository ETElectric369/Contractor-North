"use client";

import Link from "next/link";
import { Clock } from "lucide-react";
import { Badge, statusTone } from "@/components/ui/badge";
import { jobStatusLabel } from "@/lib/job-status";
import { initials } from "@/lib/utils";
import { dayBlockWords, readJobBlock } from "@/lib/schedule/job-block";

interface Member {
  id: string;
  full_name: string | null;
}
interface SchedJob {
  id: string;
  name: string;
  job_number: string;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  planned_minutes?: number | null;
  assigned_to: string[] | null;
  customers: { name: string } | null;
}

/**
 * ONE JOB ON THE DAY DRILL: its name (the job), and its block and crew as one 44px tap that opens the
 * tile's sheet (day, time, crew: schedule/tile-sheet), the same sheet a tap on its block in the grid
 * opens. The old card carried its own crew dropdown, which sent the whole crew list from a page that
 * could be stale, and its own Move; both live in the sheet now, once. Times are the company's clock
 * (the old card printed the server's UTC hour).
 */
export function JobScheduleCard({
  job,
  members,
  tz,
  workDay,
  day,
  onOpen,
}: {
  job: SchedJob;
  members: Member[];
  tz: string;
  workDay: { start: string; end: string };
  /** The day the drill is showing (YYYY-MM-DD, the company's): the line says what the grid draws on it,
   *  so a worked day kept as history reads "Worked day", never the plan's hours. Absent: the plan's
   *  first day. */
  day?: string;
  /** Opens the tile's sheet for this job on this day. Absent (the crew): the block is read, not tapped. */
  onOpen?: () => void;
}) {
  const at = {
    scheduledStart: job.scheduled_start,
    scheduledEnd: job.scheduled_end,
    plannedMinutes: job.planned_minutes ?? null,
    tz,
    workDay,
  };
  const nameOf = (id: string) => members.find((m) => m.id === id)?.full_name ?? "Unnamed";
  const crew = (job.assigned_to ?? []).filter(Boolean);
  const onDay = day ?? readJobBlock(at).day;
  const time = onDay ? dayBlockWords({ day: onDay, ...at }).words : "Worked day · no day planned yet";

  const inside = (
    <>
      <Clock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      <span className="min-w-0 flex-1 truncate text-left text-slate-700">{time}</span>
      <span className="flex shrink-0 items-center -space-x-1">
        {crew.length === 0 ? (
          <span className="rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[11px] text-slate-400">Nobody</span>
        ) : (
          crew.map((id) => (
            <span
              key={id}
              title={nameOf(id)}
              className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-[10px] font-semibold text-white ring-2 ring-white"
            >
              {initials(nameOf(id))}
            </span>
          ))
        )}
      </span>
    </>
  );

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2.5 text-xs shadow-sm">
      <div className="flex items-start justify-between gap-1">
        <Link href={`/jobs/${job.id}`} className="flex min-h-11 items-center gap-1.5 font-medium text-slate-900 hover:text-brand">
          {/* Legend says color = record type; a job dot is the job color (blue), not the assignee's. */}
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-blue-500" />
          {job.name}
        </Link>
        <Badge tone={statusTone(job.status)}>{jobStatusLabel(job.status)}</Badge>
      </div>
      <div className="text-slate-400">{job.customers?.name ?? job.job_number}</div>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${job.name}: day, time and crew`}
          className="mt-2 flex min-h-11 w-full items-center gap-2 rounded-md border border-slate-200 px-2 hover:border-brand"
        >
          {inside}
        </button>
      ) : (
        <div className="mt-2 flex min-h-11 w-full items-center gap-2 px-2">{inside}</div>
      )}
    </div>
  );
}
