// Crew day-assignment helpers — SERVER-SAFE and PURE (no hooks, no "use client"), so server
// code can import them without an RSC boundary crash (the /timecards lesson: hmToMin lives in
// lib/tz, not the client time-grid).
//
// WHAT THIS FILE USED TO BE. It was the shared spine of two crew planners on /timeclock — a
// day-picker board (crew-assignments.tsx) and the week grid (crew-week-grid.tsx) — carrying
// their week math, their label helpers, their optimistic row patch and the "auto hint" types.
// Both surfaces are gone (cn-v951): the grid was a second per-day editor for crew_day_assignments
// whose only two ways of filling itself were deleted in cn-v590, and Erik's answer to "do we need
// the crew week" was "i lean towards the schedule". Everyone's Day on /schedule answers who is on
// what, and the ROWS live on through crew-actions.ts, which the schedule now writes through.
//
// So every helper those two components alone used went with them rather than sitting here as
// dead weight. What is left is the one pure pick below.

/** SCHEDULE-only pick for a day: among the given jobs, the one the schedule puts on `ds` — a
 *  job_schedule_segments range covering the day (inclusive bounds), or a scheduled_start that
 *  falls on it (the caller resolves scheduled_start to an org-local day into schedDayByJob, so
 *  timezone stays a server concern and this stays pure). Earliest scheduled_start wins, mirroring
 *  pickJobScheduledToday's tie-break, and a segment-only job sorts last on the same "9999"
 *  sentinel. Returns null when the schedule says nothing about that day, which is a real answer:
 *  nobody has put this person anywhere, and a truthful blank beats a confident guess (cn-v590). */
export function pickScheduledJobForDay<
  T extends { id: string; scheduled_start?: string | null },
>(
  jobs: T[],
  ds: string,
  segsByJob: ReadonlyMap<string, { start: string; end: string }[]>,
  schedDayByJob: ReadonlyMap<string, string | null>,
): T | null {
  const hits = jobs
    .filter(
      (j) =>
        (segsByJob.get(j.id) ?? []).some((r) => r.start <= ds && ds <= r.end) ||
        schedDayByJob.get(j.id) === ds,
    )
    .sort((a, b) => (a.scheduled_start ?? "9999").localeCompare(b.scheduled_start ?? "9999"));
  return hits[0] ?? null;
}
