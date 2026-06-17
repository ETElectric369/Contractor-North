"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { User } from "lucide-react";
import { Select } from "@/components/ui/input";
import { Badge, statusTone } from "@/components/ui/badge";
import { colorForMember } from "@/lib/employee-color";
import { setJobAssignee, setJobSchedule } from "./actions";

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
}: {
  job: SchedJob;
  members: Member[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const assignee = job.assigned_to?.[0] ?? "";
  const color = colorForMember(assignee || null, members);
  const time = job.scheduled_start
    ? new Date(job.scheduled_start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "";

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2.5 text-xs shadow-sm">
      <div className="flex items-start justify-between gap-1">
        <Link href={`/jobs/${job.id}`} className="flex items-center gap-1.5 font-medium text-slate-900 hover:text-brand">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${color.dot}`} />
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

      <input
        type="date"
        defaultValue={job.scheduled_start ? new Date(job.scheduled_start).toISOString().slice(0, 10) : ""}
        disabled={pending}
        className="mt-1.5 h-7 w-full rounded-md border border-slate-200 px-2 text-xs text-slate-600"
        onChange={(e) => {
          const v = e.target.value;
          // Canonical writer: sets the day window (timezone-correct, advances
          // status). Single-day write here intentionally collapses to one window.
          start(async () => {
            if (v) {
              await setJobSchedule(
                job.id,
                new Date(`${v}T08:00`).toISOString(),
                new Date(`${v}T16:00`).toISOString(),
              );
            } else {
              await setJobSchedule(job.id, null, null);
            }
            router.refresh();
          });
        }}
      />
    </div>
  );
}
