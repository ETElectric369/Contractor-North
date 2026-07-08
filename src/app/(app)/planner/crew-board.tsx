"use client";

import Link from "next/link";
import { Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { CrewMember } from "@/lib/crew-status";

/**
 * The boss's live crew presence board — every active member, on/off the clock right now, and the
 * job they're on. Erik: "boss needs to see what everyone is doing all the time." Hours deliberately
 * live only in payroll (/timecards) now, so this is presence-only — no ticking totals, no
 * per-person hours table (Erik: that table isn't needed anywhere but payroll).
 */
export function CrewBoard({ crew }: { crew: CrewMember[] }) {
  const onCount = crew.filter((c) => c.clockedIn).length;
  const sorted = [...crew].sort(
    (a, b) => Number(b.clockedIn) - Number(a.clockedIn) || a.name.localeCompare(b.name),
  );

  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-slate-400" />
          <span className="text-sm font-semibold text-slate-800">Crew</span>
        </div>
        <span className="text-xs font-medium text-slate-500">
          {onCount} of {crew.length} on the clock
        </span>
      </div>
      <div className="divide-y divide-slate-50">
        {sorted.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-5 py-2.5">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${c.clockedIn ? "bg-green-500" : "bg-slate-200"}`}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-slate-800">{c.name}</div>
              <div className="truncate text-xs text-slate-500">
                {c.clockedIn
                  ? c.jobLabel
                    ? `On the clock · ${c.jobLabel}`
                    : "On the clock · no job set"
                  : "Off the clock"}
              </div>
            </div>
          </div>
        ))}
      </div>
      <Link
        href="/timecards"
        className="block border-t border-slate-100 px-5 py-2 text-center text-xs font-medium text-brand hover:bg-slate-50"
      >
        Open timecards
      </Link>
    </Card>
  );
}
