// The end-of-day money-leak detectors — the "Acacia Ct" sweep. One voice ramble
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
import { LONG_SHIFT_HOURS } from "@/lib/long-shift";
import { todayStrInTz } from "@/lib/tz";

/** An open entry past this many hours is flagged even when the UTC date-cut (below)
 *  misses an evening start. THE SHARED LONG-SHIFT RULE (lib/long-shift, 2026-09-24):
 *  the inbox, the office's clock-out sheet, the crew's Timeclock and the hourly job
 *  all call a clock forgotten at the same hour, instead of 12 here, 14 there. */
export const OPEN_ENTRY_STALE_HOURS = LONG_SHIFT_HOURS;
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
  /** A time code (Drive, Shop, PTO) on a job-less entry is where the hours went, not a missing job. */
  job_code?: string | null;
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
 *  (b) CLOSED on a past day with job_id NULL — real hours nobody can bill or cost to a job —
 *      unless its time code is one the org marked NON-BILLABLE (job_codes.billable = false:
 *      Shop, PTO, Drive where the org says so). That time was filed job-less on purpose.
 *      A BILLABLE code with no job (ROUGH, SVC split off to "no job") is still stray: it is
 *      exactly the hours nobody bills, and the split sheet can make one.
 * Today's no-job closes are left alone: the EOD form may still attach them.
 * Accepts overlapping row sets (open feeder + recent feeder) — dedupes by id.
 *
 * `nonBillableCodes` is the same predicate labor billing uses (labor-billing.ts). Empty = every
 * job-less close is stray, the safe default for a caller without the org's codes.
 *
 * `tz` is the ORG's timezone, and `todayStr` is the org's day. Given it, "a past day" is judged on
 * the org's calendar. Without it the old UTC date slice stands, which calls a Pacific 6 PM close
 * "tomorrow" and so skips the evening before for a day.
 */
export function detectStrayTime(
  rows: TimeEntryRow[],
  todayStr: string,
  nowMs: number = Date.now(),
  nonBillableCodes: ReadonlySet<string> = new Set(),
  tz?: string,
): StrayTimeFinding[] {
  const out: StrayTimeFinding[] = [];
  const seen = new Set<string>();
  const dayOf = (iso: string) => (tz ? todayStrInTz(tz, new Date(iso)) : iso.slice(0, 10));
  for (const e of rows ?? []) {
    if (!e?.id || seen.has(e.id)) continue;
    seen.add(e.id);
    if (e.status === "open") {
      if (!e.clock_in) continue;
      const startedPastDay = dayOf(e.clock_in) < todayStr;
      const staleMs = nowMs - Date.parse(e.clock_in);
      if (!startedPastDay && !(Number.isFinite(staleMs) && staleMs >= OPEN_ENTRY_STALE_HOURS * 3_600_000)) continue;
      out.push({ entryId: e.id, name: firstName(e.profiles?.full_name), openStill: true, when: e.clock_in });
    } else if (e.status === "closed" && !e.job_id) {
      // Non-billable time (Shop, PTO) is job-less on purpose: its code says where the hours went.
      const code = (e.job_code ?? "").trim();
      if (code && nonBillableCodes.has(code)) continue;
      if (!e.clock_out || dayOf(e.clock_out) >= todayStr) continue;
      out.push({ entryId: e.id, name: firstName(e.profiles?.full_name), openStill: false, when: e.clock_in ?? e.clock_out });
    }
  }
  return out;
}

export type WorkedJob = {
  /** Most recent clock_in on this job. */
  lastWorked: string;
  /** Someone is on the job RIGHT NOW — suppress "nothing scheduled next" noise. */
  hasOpenEntry: boolean;
  /** Worked within the tighter UNBILLED_WORK_DAYS window (vs the 3-day fetch). */
  workedInUnbilledWindow: boolean;
};

/**
 * Roll recent time entries (fetched with clock_in ≥ NEEDS_RETURN_DAYS back) up to
 * the jobs they touched (a split shift is ordinary entries, one job each, 0288) so
 * detectors 2 & 3 reason about jobs, not entries.
 */
export function rollupWorkedJobs(rows: TimeEntryRow[], todayStr: string): Map<string, WorkedJob> {
  const unbilledCut = daysAgoStr(todayStr, UNBILLED_WORK_DAYS);
  const map = new Map<string, WorkedJob>();
  for (const e of rows ?? []) {
    if (!e?.clock_in) continue;
    const jobIds = new Set<string>();
    if (e.job_id) jobIds.add(e.job_id);
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

/** "Acacia Ct" / a readable handle for the job in titles and push bodies. */
export const jobLabel = (j: JobRow): string => j.name || j.job_number || "a job";

/** The invoice columns costedJobIds reads: its status, and the KIND of each line (0342). */
export const COSTED_INVOICE_COLUMNS = "job_id, status, invoice_items(line_kind)";

/**
 * WHICH JOBS HAVE COSTS ON THE RECORD — THE ONE RULE (NY-feeders, 0366). My Day's "No Costs Yet" and
 * the 6 PM "Close out your day" push both ask it, so they can never disagree about a job. A job is
 * costed when it has ANY of:
 *   · a bill (a cost recorded on it),
 *   · a purchase order,
 *   · a materials list with at least one line,
 *   · a live (non-void) invoice carrying a MATERIALS line (invoice_items.line_kind 'materials', 0342):
 *     the materials were billed straight onto the invoice, which is exactly "costs recorded". Before
 *     this, a job whose parts went on the invoice by hand was told it had "no costs recorded".
 * Rows as read (the four reads are the caller's; the invoice read names COSTED_INVOICE_COLUMNS).
 */
export function costedJobIds(rows: {
  bills?: readonly { job_id?: string | null }[] | null;
  purchaseOrders?: readonly { job_id?: string | null }[] | null;
  materialLists?: readonly { job_id?: string | null; material_list_items?: readonly unknown[] | null }[] | null;
  invoices?: readonly { job_id?: string | null; status?: string | null; invoice_items?: readonly { line_kind?: string | null }[] | null }[] | null;
}): Set<string> {
  const out = new Set<string>();
  const add = (id: string | null | undefined) => {
    if (id) out.add(id);
  };
  for (const b of rows.bills ?? []) add(b.job_id);
  for (const p of rows.purchaseOrders ?? []) add(p.job_id);
  for (const m of rows.materialLists ?? []) if ((m.material_list_items?.length ?? 0) > 0) add(m.job_id);
  for (const i of rows.invoices ?? []) {
    if (i.status === "void") continue;
    if ((i.invoice_items ?? []).some((l) => l?.line_kind === "materials")) add(i.job_id);
  }
  return out;
}

/**
 * Detector 2 — UNBILLED WORK: time logged in the last UNBILLED_WORK_DAYS but ZERO
 * costs (bills), ZERO purchase orders, ZERO materials-list items and no materials line on a live
 * invoice (costedJobIds, the one rule). Skips jobs already sitting on the billing board as
 * done-not-invoiced (status complete/invoiced with no real invoice) so the same job isn't reported
 * twice.
 */
export function detectUnbilledWork(opts: {
  jobs: JobRow[];
  worked: Map<string, WorkedJob>;
  /** Jobs with costs on the record (costedJobIds: a bill, a PO, a materials-list line, or a
   *  materials line on a live invoice) — no leak. */
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
 * Detector 3 — NO RETURN VISIT, for the 6 PM "Close out your day" push (eod-sweep). My Day no longer
 * asks this: its Jobs Needing A Day (jobs-needing-a-day.ts) asks whether ANYTHING is ahead of a job,
 * with no three-day window. This one stays the evening's question about the day just worked: an
 * in-flight job (not complete/invoiced/cancelled)
 * worked in the last NEEDS_RETURN_DAYS with NOTHING on the calendar from today on —
 * no future/today scheduled_start, no scheduled appointment, no schedule segment.
 * Suppressed while someone is clocked in (you're literally standing on the job) and
 * for jobs the inbox already lists as "to schedule" (estimate/scheduled, undated).
 * NOT A JOB ON HOLD (NY-hold, 0366): a held job waits on purpose, and it comes back on its own day
 * with its reason. Asking for a return visit on it, on My Day or in the 6 PM push, is the nag Erik
 * stopped opening My Day over ("stockpiled with things i cant act on or already have on hold").
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
    if (status === "on_hold") continue; // waiting on purpose, with its own day (0366)
    // Already surfaced as a job_to_schedule inbox item — same ask, don't say it twice.
    // (to_be_scheduled replaced "estimate" as the waiting-room status, lifecycle rework.)
    if (!j.scheduled_start && (status === "estimate" || status === "to_be_scheduled" || status === "scheduled")) continue;
    const hasFutureStart = !!j.scheduled_start && j.scheduled_start.slice(0, 10) >= opts.todayStr;
    if (hasFutureStart || opts.futureApptJobIds.has(j.id) || opts.futureSegmentJobIds.has(j.id)) continue;
    out.push({ job: j, lastWorked: w.lastWorked });
  }
  return out;
}
