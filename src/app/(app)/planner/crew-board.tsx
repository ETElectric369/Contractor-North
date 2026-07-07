"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { CrewMember } from "@/lib/crew-status";

/**
 * The boss's live crew board — every active member, on/off the clock right now, their job, and
 * hours today. Erik: "boss needs to see what everyone is doing all the time." The open shift's
 * hours tick live (30s); suppressHydrationWarning on the ticking text because a Date.now()-
 * derived value differs server↔client on first paint (the #418 lesson). Clocked-in first.
 */
export function CrewBoard({ crew }: { crew: CrewMember[] }) {
  const [now, setNow] = useState(() => Date.now());
  const anyOn = crew.some((c) => c.clockedIn);

  useEffect(() => {
    if (!anyOn) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [anyOn]);

  const liveHours = (c: CrewMember) =>
    c.closedHoursToday +
    (c.clockedIn && c.clockInIso ? Math.max(0, (now - new Date(c.clockInIso).getTime()) / 3_600_000) : 0);
  const fmt = (h: number) => `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}m`;

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
            <div className="shrink-0 text-right">
              <div className="text-sm font-semibold tabular-nums text-slate-700" suppressHydrationWarning>
                {fmt(liveHours(c))}
              </div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400">today</div>
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
