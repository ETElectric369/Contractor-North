"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { User, CalendarSync, Check, ChevronDown } from "lucide-react";
import { Badge, statusTone } from "@/components/ui/badge";
import { MoveToDay } from "@/components/move-to-day";
import { setJobCrew, moveJobDay } from "./actions";

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
  const [open, setOpen] = useState(false);
  // Optimistic local crew set so ticking several people in a row feels instant (each toggle sends
  // the FULL set → additive). Seeded from the job; a page reload re-seeds from the server.
  const [crew, setCrew] = useState<string[]>((job.assigned_to ?? []).filter(Boolean));
  const nameOf = (id: string) => members.find((m) => m.id === id)?.full_name ?? "Unnamed";
  const time = job.scheduled_start
    ? new Date(job.scheduled_start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "";

  const toggle = (memberId: string) => {
    const next = crew.includes(memberId) ? crew.filter((x) => x !== memberId) : [...crew, memberId];
    setCrew(next); // optimistic
    start(async () => {
      await setJobCrew(job.id, next);
      router.refresh();
    });
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-2.5 text-xs shadow-sm">
      <div className="flex items-start justify-between gap-1">
        <Link href={`/jobs/${job.id}`} className="flex items-center gap-1.5 font-medium text-slate-900 hover:text-brand">
          {/* Legend says color = record type; a job dot is the job color (blue), not the assignee's. */}
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-blue-500" />
          {job.name}
        </Link>
        <Badge tone={statusTone(job.status)}>{job.status.replace("_", " ")}</Badge>
      </div>
      <div className="mt-0.5 text-slate-400">
        {time && <span>{time} · </span>}
        {job.customers?.name ?? job.job_number}
      </div>

      {/* Crew — MULTI-assign. Ticking a second person ADDS them; the old single Select silently
          overwrote the whole crew ("no way to put both me and Brian on it" — audit + pulse P1). */}
      <div className="relative mt-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={pending}
          className="flex h-7 w-full items-center gap-1.5 rounded-md border border-slate-200 px-2 text-xs text-slate-700 hover:border-brand disabled:opacity-60"
        >
          <User className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          <span className="flex-1 truncate text-left">
            {crew.length ? crew.map(nameOf).join(", ") : <span className="text-slate-400">Assign crew</span>}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-[75]" onClick={() => setOpen(false)} />
            <div className="absolute left-0 top-full z-[80] mt-1 max-h-56 w-full min-w-[10rem] overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
              {members.length === 0 ? (
                <div className="px-3 py-1.5 text-xs text-slate-400">No crew yet</div>
              ) : (
                members.map((m) => {
                  const on = crew.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggle(m.id)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "border-brand bg-brand text-white" : "border-slate-300"}`}
                      >
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      {m.full_name ?? "Unnamed"}
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>

      {/* The ONE reschedule idiom (replaces the raw date input, whose writer collapsed multi-range
          schedules to a single window): moveJobDay shifts only this day's range, read-modify-write,
          proposal-aware. Trimming or adding ranges stays on the job page's Scheduled control. */}
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
