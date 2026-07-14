// The end-of-day money-leak detectors — the "Apache Ct" sweep. One voice ramble
// proved three silent leaks the system never surfaced: an open 26-hour time entry
// attached to no job, a worked job with zero recorded costs (30' of Romex nobody
// billed), and a worked job with no return visit scheduled. These are the PURE
// row→finding rules for all three, shared by getActionItems (RLS client, feeds
// the inbox + dock badge) and the daily cron's "Close out your day" push
// (service client) so the two surfaces can never disagree on what counts as a leak.
//
// HARD BOUNDARY: detectors only DETECT — they never infer hours, dollars, or
// clock-out times. Every finding is a question ("has no job", "no costs yet"),
// never a filled-in answer.

/** A same-day shift can run long, but nothing legit runs this long: an open entry
 *  past this many hours is flagged even when the UTC date-cut (below) misses an
 *  evening start. Can never flag a normal shift opened this morning. */
export const OPEN_ENTRY_STALE_HOURS = 14;
/** How far back to look for closed-with-no-job entries (covers Fri → Mon). */
export const STRAY_CLOSED_LOOKBACK_DAYS = 3;
/** A job worked within this window with zero costs/materials = the Romex leak. */
export const UNBILLED_WORK_DAYS = 2;
/** A job worked within this window with nothing scheduled next = the lost return. */
export const NEEDS_RETURN_DAYS = 3;

/** yyyy-mm-dd that is `days` before todayStr — the bounded-window cut for the
 *  time_entries feeders (compared against timestamptz columns; the ≤1-day UTC
 *  fuzz only widens the window, never narrows it). */
export function daysAgoStr(todayStr: string, days: number): string {
  return new Date(Date.parse(`${todayStr}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export type TimeEntryRow = {
  id: string;
  status?: string | null;
  job_id?: string | null;
  clock_in?: string | null;
  clock_out?: string | null;
  profiles?: { full_name?: string | null } | null;
  time_allocations?: { job_id?: string | null }[] | null;
};

export type StrayTimeFinding = {
  entryId: string;
  /** First name (or "Someone") — for "{name}'s {day} entry…" */
  name: string;
  /** true = still clocked in from a past day; false = closed with no job. */
  openStill: boolean;
  /** clock_in ISO — the sort key and the "{day}" label source. */
  when: string;
};

const firstName = (full: string | null | undefined) => (full ?? "").trim().split(/\s+/)[0] || "Someone";

/**
 * Detector 1 — STRAY TIME. An entry is stray when it is:
 *  (a) still OPEN from a past day (started before today, or running
 *      OPEN_ENTRY_STALE_HOURS+ — the hour rule catches evening starts the
 *      UTC date-cut misses), i.e. a clock silently accruing payroll; or
 *  (b) CLOSED on a past day with job_id NULL and no split allocations —
 *      real hours nobody can bill or cost to a job.
 * Today's no-job closes are left alone: the EOD form may still attach them.
 * Accepts overlapping row sets (open feeder + recent feeder) — dedupes by id.
 */
export function detectStrayTime(rows: TimeEntryRow[], todayStr: string, nowMs: number = Date.now()): StrayTimeFinding[] {
  const out: StrayTimeFinding[] = [];
  const seen = new Set<string>();
  for (const e of rows ?? []) {
    if (!e?.id || seen.has(e.id)) continue;
    seen.add(e.id);
    if (e.status === "open") {
      if (!e.clock_in) continue;
      const startedPastDay = e.clock_in.slice(0, 10) < todayStr;
      const staleMs = nowMs - Date.parse(e.clock_in);
      if (!startedPastDay && !(Number.isFinite(staleMs) && staleMs >= OPEN_ENTRY_STALE_HOURS * 3_600_000)) continue;
      out.push({ entryId: e.id, name: firstName(e.profiles?.full_name), openStill: true, when: e.clock_in });
    } else if (e.status === "closed" && !e.job_id) {
      // A split shift assigns its jobs via time_allocations — that's attached, not stray.
      if ((e.time_allocations?.length ?? 0) > 0) continue;
      if (!e.clock_out || e.clock_out.slice(0, 10) >= todayStr) continue;
      out.push({ entryId: e.id, name: firstName(e.profiles?.full_name), openStill: false, when: e.clock_in ?? e.clock_out });
    }
  }
  return out;
}

export type WorkedJob = {
  /** Most recent clock_in touching this job (entry or allocation). */
  lastWorked: string;
  /** Someone is on the job RIGHT NOW — suppress "nothing scheduled next" noise. */
  hasOpenEntry: boolean;
  /** Worked within the tighter UNBILLED_WORK_DAYS window (vs the 3-day fetch). */
  workedInUnbilledWindow: boolean;
};

/**
 * Roll recent time entries (fetched with clock_in ≥ NEEDS_RETURN_DAYS back) up to
 * the jobs they touched — via the entry's own job_id AND every split-allocation's
 * job_id — so detectors 2 & 3 reason about jobs, not entries.
 */
export function rollupWorkedJobs(rows: TimeEntryRow[], todayStr: string): Map<string, WorkedJob> {
  const unbilledCut = daysAgoStr(todayStr, UNBILLED_WORK_DAYS);
  const map = new Map<string, WorkedJob>();
  for (const e of rows ?? []) {
    if (!e?.clock_in) continue;
    const jobIds = new Set<string>();
    if (e.job_id) jobIds.add(e.job_id);
    for (const a of e.time_allocations ?? []) if (a?.job_id) jobIds.add(a.job_id);
    for (const id of jobIds) {
      const cur = map.get(id);
      const next: WorkedJob = {
        lastWorked: cur && cur.lastWorked > e.clock_in ? cur.lastWorked : e.clock_in,
        hasOpenEntry: (cur?.hasOpenEntry ?? false) || e.status === "open",
        workedInUnbilledWindow: (cur?.workedInUnbilledWindow ?? false) || e.clock_in >= unbilledCut,
      };
      map.set(id, next);
    }
  }
  return map;
}

export type JobRow = {
  id: string;
  job_number?: string | null;
  name?: string | null;
  status?: string | null;
  scheduled_start?: string | null;
};

export type JobLeakFinding = { job: JobRow; lastWorked: string };

/** "Apache Ct" / a readable handle for the job in titles and push bodies. */
export const jobLabel = (j: JobRow): string => j.name || j.job_number || "a job";

/**
 * Detector 2 — UNBILLED WORK: time logged in the last UNBILLED_WORK_DAYS but ZERO
 * costs (bills), ZERO purchase orders, and ZERO materials-list items. Skips jobs
 * already sitting on the billing board as done-not-invoiced (status complete/
 * invoiced with no real invoice) so the same job isn't reported twice.
 */
export function detectUnbilledWork(opts: {
  jobs: JobRow[];
  worked: Map<string, WorkedJob>;
  /** Jobs with ANY bill, PO, or materials-list item — costs exist, no leak. */
  costedJobIds: Set<string>;
  /** Jobs with ANY non-void invoice — for the done-not-invoiced dedupe. */
  invoicedJobIds: Set<string>;
}): JobLeakFinding[] {
  const out: JobLeakFinding[] = [];
  for (const j of opts.jobs ?? []) {
    const w = opts.worked.get(j.id);
    if (!w?.workedInUnbilledWindow) continue;
    if (j.status === "cancelled") continue;
    if (opts.costedJobIds.has(j.id)) continue;
    // Done-not-invoiced already owns this job on the money board — don't double-report.
    if ((j.status === "complete" || j.status === "invoiced") && !opts.invoicedJobIds.has(j.id)) continue;
    out.push({ job: j, lastWorked: w.lastWorked });
  }
  return out;
}

/**
 * Detector 3 — NO RETURN VISIT: an in-flight job (not complete/invoiced/cancelled)
 * worked in the last NEEDS_RETURN_DAYS with NOTHING on the calendar from today on —
 * no future/today scheduled_start, no scheduled appointment, no schedule segment.
 * Suppressed while someone is clocked in (you're literally standing on the job) and
 * for jobs the inbox already lists as "to schedule" (estimate/scheduled, undated).
 */
export function detectNeedsReturn(opts: {
  jobs: JobRow[];
  worked: Map<string, WorkedJob>;
  todayStr: string;
  /** Jobs with a scheduled (not cancelled) appointment starting today or later. */
  futureApptJobIds: Set<string>;
  /** Jobs with a schedule segment ending today or later. */
  futureSegmentJobIds: Set<string>;
}): JobLeakFinding[] {
  const out: JobLeakFinding[] = [];
  for (const j of opts.jobs ?? []) {
    const w = opts.worked.get(j.id);
    if (!w || w.hasOpenEntry) continue;
    const status = j.status ?? "";
    if (status === "complete" || status === "invoiced" || status === "cancelled") continue;
    // Already surfaced as a job_to_schedule inbox item — same ask, don't say it twice.
    // (to_be_scheduled replaced "estimate" as the waiting-room status, lifecycle rework.)
    if (!j.scheduled_start && (status === "estimate" || status === "to_be_scheduled" || status === "scheduled")) continue;
    const hasFutureStart = !!j.scheduled_start && j.scheduled_start.slice(0, 10) >= opts.todayStr;
    if (hasFutureStart || opts.futureApptJobIds.has(j.id) || opts.futureSegmentJobIds.has(j.id)) continue;
    out.push({ job: j, lastWorked: w.lastWorked });
  }
  return out;
}
