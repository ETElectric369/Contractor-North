"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { User, CalendarSync } from "lucide-react";
import { Select } from "@/components/ui/input";
import { Badge, statusTone } from "@/components/ui/badge";
import { MoveToDay } from "@/components/move-to-day";
import { setJobAssignee, moveJobDay } from "./actions";

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
  assigned_to: string[] | null;
  customers: { name: string } | null;
}

export function JobScheduleCard({
  job,
  members,
  date,
}: {
  job: SchedJob;
  members: Member[];
  /** The day (yyyy-mm-dd) this card is rendered on — the range moveJobDay
   *  shifts. Without it the job's earliest range moves. */
  date?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const assignee = job.assigned_to?.[0] ?? "";
  const time = job.scheduled_start
    ? new Date(job.scheduled_start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "";

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2.5 text-xs shadow-sm">
      <div className="flex items-start justify-between gap-1">
        <Link href={`/jobs/${job.id}`} className="flex items-center gap-1.5 font-medium text-slate-900 hover:text-brand">
          {/* Legend says color = record type; a job dot is the job color (blue),
              not the assignee's — identity is the Select below (audit cn-v328). */}
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-blue-500" />
          {job.name}
        </Link>
        <Badge tone={statusTone(job.status)}>{job.status.replace("_", " ")}</Badge>
      </div>
      <div className="mt-0.5 text-slate-400">
        {time && <span>{time} · </span>}
        {job.customers?.name ?? job.job_number}
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <User className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        <Select
          value={assignee}
          disabled={pending}
          className="h-7 flex-1 text-xs"
          onChange={(e) =>
            start(async () => {
              await setJobAssignee(job.id, e.target.value);
              router.refresh();
            })
          }
        >
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name ?? "Unnamed"}
            </option>
          ))}
        </Select>
      </div>

      {/* The ONE reschedule idiom (replaces the raw date input, whose writer
          collapsed multi-range schedules to a single window): moveJobDay shifts
          only this day's range, read-modify-write, proposal-aware. Trimming or
          adding ranges stays on the job page's Scheduled control. */}
      <MoveToDay
        label={`Move ${job.name}`}
        triggerClassName="mt-1.5 flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-slate-200 text-xs font-medium text-slate-600 hover:border-brand hover:text-brand"
        onPick={async (iso) => {
          if (!iso) return { ok: false, error: "Pick a day." };
          let res = await moveJobDay(job.id, date ?? null, iso);
          if (!res.ok && res.needsProposalConfirm) {
            if (!confirm(`${res.error} Move it anyway?`)) return res;
            res = await moveJobDay(job.id, date ?? null, iso, { cancelProposals: true });
          }
          if (res.ok) router.refresh();
          return res;
        }}
      >
        <CalendarSync className="h-4 w-4 shrink-0" /> Move to a Day
      </MoveToDay>
    </div>
  );
}
