import {
  permitInspectionStand,
  standLine,
  type InspectionStandState,
  type PermitInspection,
} from "@/lib/permit-inspections";
import { AFFORDANCES, waitingRow, type ActionItem, type WaitingItem } from "./types";
import { jobWords } from "./words";

/**
 * THE INSPECTION A PERMIT IS STILL WAITING ON, ON NEEDS YOU (0378).
 *
 * ONE ROW PER PERMIT, NEVER ONE PER INSPECTION. A permit's visits are a sequence, and only one of
 * them is the next thing: the one rule (lib/permit-inspections permitInspectionStand) names it. Both
 * of the October job's inspections are booked for the same morning and they are ONE line, about the
 * town, because the utility cannot be called until the town has tagged it.
 *
 * ── THE GATE DECIDES WHAT MAY NAG ────────────────────────────────────────────────────────────────
 *   HIS (a Now row, the badge counts it)       nobody has phoned them yet · the day went by and
 *                                             nobody wrote up what happened · the last visit failed
 *   THEIRS (a Waiting row, with the day)       booked for today or later: it is on the books, not on
 *                                             him, and it comes back on the day it is booked for
 *   NEITHER (nothing, anywhere)                an inspection still waiting on the one in front of it.
 *                                             It is not overdue and it is not his, so it is in no
 *                                             pile — it is on the permit's card, where the person who
 *                                             wants it looks, and it becomes his the moment the one
 *                                             in front passes.
 *
 * THE BADGE STAYS HONEST (the badge invariant): the his-to-do rows roll up into one pile (piles.ts
 * `permit_inspections`), so a company with four open permits adds one to the badge, not four; and a
 * waiting row is never counted at all.
 *
 * NOTHING HERE IS MONEY, so it is the one feeder of its kind a tech could read. It stays staff-only
 * all the same: the whole inbox is, and booking an inspection is the office's phone call.
 */

/** The newest permits one build looks at; a capped read says "N+", never a short count. */
export const PERMITS_READ_CAP = 200;

/** The columns the feeder's permit read asks for (the projection law: one list, one place). The
 *  customer rides along because a job is named by its number AND its customer AND where it is. */
export const PERMIT_FEED_COLUMNS = "id, permit_number, job_id, jobs(id, job_number, name, status, customers(name))";

export type PermitFeedRow = {
  id: string;
  permit_number?: string | null;
  job_id?: string | null;
  jobs?: FeedJob | FeedJob[] | null;
};

type FeedJob = {
  id?: string | null;
  job_number?: string | null;
  name?: string | null;
  status?: string | null;
  customers?: { name?: string | null } | { name?: string | null }[] | null;
};

/** A cancelled job's inspections are nobody's business. Every other job's still are — a job marked
 *  complete can easily be waiting on the utility, which is the whole state this lane adds. */
export const DEAD_JOB_STATUS = "cancelled";

/** THE CHIP each state says: the STATE it is in, never the verb (the button is the verb). */
export const INSPECTION_CHIP: Partial<Record<InspectionStandState, string>> = {
  to_book: "To Book",
  overdue: "Not Written Up",
  needs_another: "Failed",
};

/** THE BUTTON each chip opens with. One place, so the chip and the door can never drift apart. */
export const INSPECTION_DOOR: Record<string, string> = {
  "To Book": "Book It",
  "Not Written Up": "Say How It Went",
  Failed: "Book Another Visit",
  Cancelled: "Book Another Visit",
};

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export interface PermitInspectionFeed {
  /** Rows for Needs You's NOW list (before the pile rolls them up). */
  now: Omit<ActionItem, "stream">[];
  /** Rows for the Waiting fold, each with the day it comes back. */
  waiting: WaitingItem[];
  /** Every job whose permit still wants an inspection: Jobs Needing A Day asks it for no date. */
  awaitingJobIds: Set<string>;
}

export function permitInspectionItems(input: {
  permits: readonly PermitFeedRow[] | null | undefined;
  /** Every inspection on those permits (0378), any order. */
  inspections: readonly PermitInspection[] | null | undefined;
  todayStr: string;
}): PermitInspectionFeed {
  const byPermit = new Map<string, PermitInspection[]>();
  for (const r of input.inspections ?? []) {
    const k = String(r?.permit_id ?? "");
    if (!k) continue;
    byPermit.set(k, [...(byPermit.get(k) ?? []), r]);
  }

  const now: Omit<ActionItem, "stream">[] = [];
  const waiting: WaitingItem[] = [];
  const awaitingJobIds = new Set<string>();

  for (const p of input.permits ?? []) {
    const job = one(p?.jobs ?? null);
    const jobId = String(p?.job_id ?? job?.id ?? "");
    // A PERMIT ON NO JOB HAS NO DOOR. Its card lives on a job's Permits tab, so a row for it would
    // open nothing (the standalone list is retired: /permits sends you to Jobs). No dead doors.
    if (!jobId) continue;
    if (String(job?.status ?? "") === DEAD_JOB_STATUS) continue;

    const rows = byPermit.get(String(p.id)) ?? [];
    const stand = permitInspectionStand(rows, input.todayStr);
    if (stand.state === "none" || stand.state === "clear") continue;
    awaitingJobIds.add(jobId);

    const why = standLine(stand) ?? "";
    const number = String(p.permit_number ?? "").trim();
    const href = `/jobs/${jobId}?tab=permits`;
    const title = jobWords(job);

    if (stand.waitingOnThem) {
      // Nothing waits without a day, and a booked inspection HAS one: the day it is booked for is the
      // day it comes back. waitingRow refuses a row with no real day, which cannot happen here.
      const row = waitingRow({ id: `permitinsp-${p.id}`, kind: "permit_inspection", title, why, backOn: stand.day, href });
      if (row) waiting.push(row);
      continue;
    }

    now.push({
      id: `permitinsp-${p.id}`, // synthetic (kind-prefixed): open-only, answered on the permit itself
      kind: "permit_inspection",
      title,
      // The why line (≤140, the why-line law): what is owed, which permit it is on, and whose job it
      // is — a job is named by its number AND its customer AND where, and the title carries the rest.
      subtitle: [why, number ? `Permit ${number}` : null, one(job?.customers ?? null)?.name ?? null]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 140),
      who: null,
      // A missed write-up is DATED by the day it was booked for, so it sorts oldest first and reads
      // honestly. One nobody has phoned carries no date: there is none to carry, and inventing one is
      // what 0178 was written to stop.
      when: stand.state === "overdue" ? stand.day : null,
      since: stand.day,
      // A failed final needs somebody most of all (isOpenPermit says the same about the permit).
      urgency: stand.state === "needs_another" ? 2 : 1,
      done: false,
      href,
      affordances: AFFORDANCES.permit_inspection,
      chip: chipFor(stand.state, stand.row?.result ?? null),
    });
  }

  return { now, waiting, awaitingJobIds };
}

/** The chip's words: the state, and for a visit that did not pass, which way it did not. */
export function chipFor(state: InspectionStandState, result: string | null): string {
  if (state === "needs_another") return result === "cancelled" ? "Cancelled" : "Failed";
  return INSPECTION_CHIP[state] ?? "To Book";
}
