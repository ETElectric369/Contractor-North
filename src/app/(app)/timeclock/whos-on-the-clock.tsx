import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { CrewMember } from "@/lib/crew-status";
import { sinceWords } from "@/lib/crew-pulse";
import { clockDoorWords, isLongOpenShift } from "@/lib/long-shift";
import { todayStrInTz, weekWindowInTz, type WeekStart } from "@/lib/tz";

/**
 * WHO'S ON THE CLOCK, ON THE TIME CLOCK (Erik, 2026-10-27: "keep the who's on the clock with Time
 * Clock instead of Timecards"). The crew pulse cn-v503 drew at the top of Money › Timecards — who is
 * on the clock RIGHT NOW, one person per row at reading size, each row the way to clock that person
 * out (2026-09-24: "an option to [end] an employees time clock and clock out for them") — lives on
 * the page he punches from. The office only: a tech's Clock page is unchanged, and his "who else is
 * on" is My Day's Now card (lib/crew-pulse), which is not touched either.
 *
 * A failed read is SAID (crew null), never drawn as nobody; "since" is the SHIFT's start (the first
 * piece after a Switch Job, lib/shift-chain, the starts the page could read) and a clock running
 * LONG_SHIFT_HOURS or more is tinted, because it was probably forgotten. A row opens that entry's
 * clock-out sheet on Timecards (?entry=), on the week the entry's own clock-in day belongs to.
 */
export const CREW_UNREAD = "Couldn’t read who’s on the clock — reload to try again.";

/** How many weeks back Timecards pages to show `dayStr`'s week (?week=N counts weeks into the past; 0 = this week). */
export function weeksBack(dayStr: string, todayStr: string, weekStart: WeekStart, tz: string): number {
  const thisWeek = weekWindowInTz(todayStr, weekStart, tz, 0).days[0];
  const a = Date.parse(`${thisWeek}T00:00:00Z`);
  const b = Date.parse(`${dayStr}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b >= a) return 0;
  return Math.ceil((a - b) / (7 * 86_400_000));
}

export function WhosOnTheClock({
  crew,
  starts,
  selfId,
  tz,
  todayStr,
  weekStart,
  nowMs = Date.now(),
}: {
  /** null = the read failed (said); the whole active crew otherwise. */
  crew: CrewMember[] | null;
  /** entry id → the shift's start (lib/shift-chain), for pieces cut at a Switch Job. */
  starts: ReadonlyMap<string, string>;
  selfId: string | null;
  tz: string;
  todayStr: string;
  weekStart: WeekStart;
  nowMs?: number;
}) {
  if (crew === null) {
    return (
      <Card>
        <CardContent className="py-3">
          <p className="text-sm text-amber-800">{CREW_UNREAD}</p>
        </CardContent>
      </Card>
    );
  }
  if (crew.length === 0) return null;
  const onClock = crew.filter((c) => c.clockedIn);
  return (
    <Card>
      <CardContent className="py-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Who&rsquo;s On The Clock</span>
          <span className="text-xs text-slate-500">
            {onClock.length} of {crew.length}
          </span>
        </div>
        {onClock.length === 0 ? (
          <p className="mt-1 text-base text-slate-400">Nobody right now</p>
        ) : (
          <ul className="mt-0.5">
            {onClock.map((c) => {
              const since0 = (c.entryId && starts.get(c.entryId)) || c.clockIn;
              const inMs = since0 ? Date.parse(since0) : NaN;
              const long = Number.isFinite(inMs) && isLongOpenShift(inMs, nowMs);
              // The entry's OWN clock-in day decides which week's ledger holds it on Timecards.
              const inDay = c.clockIn ? todayStrInTz(tz, new Date(c.clockIn)) : todayStr;
              const body = (
                <>
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-green-500" aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col py-1">
                    <span className="truncate">
                      <span className="font-medium text-slate-900">{c.name}</span>
                      {c.jobLabel && <span className="text-slate-500"> · {c.jobLabel}</span>}
                    </span>
                    {since0 && <span className={`truncate text-sm ${long ? "text-amber-800" : "text-slate-500"}`}>since {sinceWords(since0, tz, todayStr)}</span>}
                  </span>
                </>
              );
              return (
                <li key={c.id}>
                  {c.entryId ? (
                    <Link
                      href={`/timecards?week=${weeksBack(inDay, todayStr, weekStart, tz)}&entry=${encodeURIComponent(c.entryId)}`}
                      scroll={false}
                      className={`-mx-2 flex min-h-[44px] items-center gap-2.5 rounded-lg px-2 text-base active:bg-slate-100 ${long ? "bg-amber-50 text-amber-900" : ""}`}
                    >
                      {body}
                      <span className={`flex shrink-0 items-center gap-0.5 text-sm font-medium ${long ? "text-amber-800" : "text-slate-600"}`}>
                        {clockDoorWords(c.name, { self: !!selfId && c.id === selfId }).clockOut}
                        <ChevronRight className="h-4 w-4" aria-hidden />
                      </span>
                    </Link>
                  ) : (
                    <div className="flex min-h-[44px] items-center gap-2.5 text-base">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
