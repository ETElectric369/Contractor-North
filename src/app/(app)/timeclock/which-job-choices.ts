/**
 * "WHICH JOB ARE YOU ON?" — the rule for which jobs the sheet offers, and in what order. Pure, so
 * the ordering is pinned without a database (which-job-sheet.test.ts).
 *
 * Erik, 2026-09-26, asked "When the clock can't tell the job, should it ask? One tap at clock-in,
 * with a 'Skip, the office will pick' option so it never blocks": "yes". The duplicate punches
 * began with a punch the schedule didn't cover (day two of a job scheduled for one day), which
 * landed on no job with nothing asking. The person holding the phone knows where he is standing,
 * so the sheet puts the likely jobs first, one tap each:
 *   1. the job he last punched on in the past three days, while it is still going;
 *   2. the jobs on today's schedule (anyone's: he may be helping a crewmate);
 *   3. the rest of the jobs in progress, newest first.
 * Nothing else: a job scheduled for another day, or finished, is the office's to pick.
 *
 * WHAT A ROW CARRIES: the job's id, the one label the Timeclock uses (codes on: the job's name;
 * codes off: customer · street), and a short reason. Never a price: the read behind it selects no
 * money column, and a tech's sheet is the same sheet.
 */
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { jobLabel, jobSiteLabel } from "@/lib/schedule-options";
import { todayStrInTz } from "@/lib/tz";

export type WhichJobOption = {
  id: string;
  label: string;
  /** Why it is near the top ("Where you worked last", "On today's schedule"); none for the rest. */
  why?: string;
};

/** The answer to a pick: the server action reports a sentence, never a code.
 *  `stale` = the refusal is because the PUNCH is no longer what this screen shows (it closed, or
 *  got its job some other way): the block must re-render from the server, not sit on the old
 *  facts. The shell has no pull-to-refresh, so the sentence can't ask for one — the component
 *  does the refresh itself. `label` = the job it landed on, for the sentence that says so. */
export type WhichJobResult = { ok: boolean; error?: string; stale?: boolean; label?: string };

export type WhichJobChoices =
  | { ok: true; jobs: WhichJobOption[]; isStaff: boolean }
  | { ok: false; error: string; isStaff: boolean };

/** The columns the sheet's job read selects: labels and schedule, nothing that costs money. */
export const WHICH_JOB_COLUMNS = "id, job_number, name, address, status, scheduled_start, scheduled_end, created_at, customers(name)";

/** How far back "the job he last punched on" looks. */
export const LAST_JOB_LOOKBACK_MS = 3 * 86_400_000;

/** A punch that closed longer ago than this is the office's to move (Timecards), not the sheet's. */
export const CLOSED_PICK_WINDOW_MS = 24 * 3_600_000;

export type ChoiceJob = {
  id: string;
  job_number?: string | null;
  name?: string | null;
  address?: string | null;
  status?: string | null;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  created_at?: string | null;
  customers?: { name?: string | null } | { name?: string | null }[] | null;
};

/** The Timeclock's own label for a job: codes on = its name, codes off = customer · street. */
export function whichJobLabel(j: ChoiceJob, codesOn: boolean): string {
  if (codesOn) return jobLabel(j);
  const c = Array.isArray(j.customers) ? j.customers[0] : j.customers;
  return jobSiteLabel({ ...j, customer_name: c?.name ?? null });
}

const active = (j: ChoiceJob) => ACTIVE_JOB_STATUSES.includes(String(j.status ?? "") as (typeof ACTIVE_JOB_STATUSES)[number]);

/** Scheduled on the org's `todayStr`: a segment covers it, or (no segment rows) its own window does. */
function onToday(j: ChoiceJob, segToday: ReadonlySet<string>, todayStr: string, tz: string): boolean {
  if (segToday.has(j.id)) return true;
  if (!j.scheduled_start) return false;
  const s = Date.parse(j.scheduled_start);
  if (!Number.isFinite(s)) return false;
  const e = j.scheduled_end ? Date.parse(j.scheduled_end) : s;
  const startDay = todayStrInTz(tz, new Date(s));
  const endDay = todayStrInTz(tz, new Date(Number.isFinite(e) && e >= s ? e : s));
  return startDay <= todayStr && todayStr <= endDay;
}

/**
 * Order the rows. `jobs` is every job the reads brought back (the last one, today's, the ones in
 * progress), in any order and possibly repeated; each job appears once, in the first group it
 * belongs to.
 */
export function orderWhichJobChoices(input: {
  jobs: ChoiceJob[];
  lastJobId: string | null;
  segToday: ReadonlySet<string>;
  todayStr: string;
  tz: string;
  codesOn: boolean;
}): WhichJobOption[] {
  const byId = new Map<string, ChoiceJob>();
  for (const j of input.jobs ?? []) if (j?.id && !byId.has(j.id)) byId.set(j.id, j);
  const out: WhichJobOption[] = [];
  const taken = new Set<string>();
  const add = (j: ChoiceJob, why?: string) => {
    if (taken.has(j.id)) return;
    taken.add(j.id);
    out.push({ id: j.id, label: whichJobLabel(j, input.codesOn), ...(why ? { why } : {}) });
  };

  const last = input.lastJobId ? byId.get(input.lastJobId) : undefined;
  if (last && active(last)) add(last, "Where you worked last");

  const all = [...byId.values()].filter(active);
  const today = all
    .filter((j) => onToday(j, input.segToday, input.todayStr, input.tz))
    .sort((a, b) => String(a.scheduled_start ?? "").localeCompare(String(b.scheduled_start ?? "")));
  for (const j of today) add(j, "On today's schedule");

  const going = all
    .filter((j) => j.status === "in_progress")
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  for (const j of going) add(j);
  return out;
}

/** Which moment the sheet is asked at: right after the punch in, or right after the clock-out. */
export type WhichJobMoment = "in" | "out";
export type WhichJobAsk = { entryId: string; moment: WhichJobMoment };

/**
 * THE ONE RULE EVERY CLOCK DOOR USES to decide whether to ask: only a punch that is saved (ok, with
 * its id) and that the clock couldn't put on a job (noJob). A punch whose job was known, a refusal,
 * or an answer without the entry id asks nothing, so the clock stays two buttons.
 */
export function askAfterPunch(
  res: { ok: boolean; id?: string; noJob?: boolean } | null | undefined,
  moment: WhichJobMoment,
): WhichJobAsk | null {
  return res?.ok && res.noJob && res.id ? { entryId: res.id, moment } : null;
}

/** What a tap on a job row came to, in words (the sheet shows it; pure so it is pinned). */
export type PickOutcome =
  | { kind: "placed"; sentence: string }
  | { kind: "stale"; sentence: string }
  | { kind: "refused"; sentence: string };

/**
 * One tap on a row: the checked write, and the sentence for whatever happened. Nothing silent: a
 * refusal, a punch that moved underneath, or a dropped connection each come back as a plain line,
 * and the punch stays saved, on no job, in every one of them.
 */
export async function pickOutcome(
  put: (entryId: string, jobId: string) => Promise<WhichJobResult>,
  entryId: string,
  job: WhichJobOption,
): Promise<PickOutcome> {
  let res: WhichJobResult;
  try {
    res = await put(entryId, job.id);
  } catch {
    return { kind: "refused", sentence: "No connection, so the punch is still on no job. Try again when you have a bar or two, or skip." };
  }
  if (res?.ok) return { kind: "placed", sentence: `Your punch is on ${res.label || job.label}.` };
  const sentence = res?.error || "That didn't go through. Your punch is saved, still on no job.";
  return res?.stale ? { kind: "stale", sentence } : { kind: "refused", sentence };
}
