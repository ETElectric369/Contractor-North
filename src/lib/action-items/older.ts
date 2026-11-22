import type { ActionKind } from "./types";
import type { PileCount, ReadFacts } from "./piles";
import { companyDay } from "./jobs-needing-a-day";

/**
 * OLDER (cn-v1175). The owner's pick, asked and answered: an unanswered visit, write-up or unsent draft
 * stops being counted after thirty days and moves to a grey Older fold, still listed with its buttons;
 * a new lead never ages out. His words over it: "its overwhelming to the eye to have anything extra on
 * the screen".
 *
 * ONE RULE, PURE AND DATED BY ARGUMENT. A row is OLDER when its kind ages out (a visit to close out, an
 * inspection to write up, an estimate written and never sent) and its day is OLDER_AFTER_DAYS company
 * days or more before today. Its day is the visit's own day (appointments.starts_at) for a visit, and
 * the day it was written (quotes.created_at) for a draft: the day the thing began waiting. Every other
 * kind never ages out (a lead, money, a legal clock, a job needing a day). No day is never older: a row
 * is offered on the board when in doubt, never folded away on a guess.
 *
 * An older row is drawn in the Older fold at the bottom of the board, with the buttons it had, and is
 * counted by no number: not its tile, not the header, not the dock's badge. The fold says its own count
 * in grey (a count of old things is inventory, never a badge).
 */
export const OLDER_AFTER_DAYS = 30;

/** The only kinds that age out, and the day each is dated by (what its feeder passes as `day`). */
export const AGING_KINDS: readonly ActionKind[] = ["appointment", "inspection_writeup", "quote_draft"];

/** Does this kind ever age out? */
export function agesOut(kind: ActionKind): boolean {
  return AGING_KINDS.includes(kind);
}

/**
 * IS THIS ROW OLDER: a kind that ages out, whose day (the visit's day; the draft's written day) is
 * thirty company days or more before today. `todayStr` is the company's today (yyyy-mm-dd), `tz` its zone.
 */
export function isOlder(kind: ActionKind, day: string | null | undefined, ctx: { todayStr: string; tz?: string | null }): boolean {
  if (!agesOut(kind)) return false;
  const d = companyDay(day, ctx.tz ?? null);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(ctx.todayStr)) return false;
  const days = Math.round((Date.parse(`${ctx.todayStr}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 86_400_000);
  return Number.isFinite(days) && days >= OLDER_AFTER_DAYS;
}

/**
 * A FEEDER'S COUNT, SPLIT INTO ITS BOARD HALF AND ITS OLDER HALF. A feeder that drops rows in code keeps
 * `fresh` rows on the board and `older` rows for the fold, and draws at most `drawn` of each. Which half
 * a short read leaves short depends on the read's order:
 *   · oldest first (the rows not read are the NEWEST): the board half is short ("N+"); the older half is
 *     short too only when every row read was older (the cut fell before the first fresh row);
 *   · newest first (the rows not read are the OLDEST): the older half is short; the board half is short
 *     too only when every row read was fresh.
 * `edgeOlder` is whether the last row read (the newest for oldest first, the oldest for newest first)
 * is older. A half that is not short says its true number when it kept more than it draws.
 */
export function splitKeptCount(
  r: ReadFacts,
  kept: { fresh: number; older: number },
  drawn: number | null,
  order: "oldestFirst" | "newestFirst",
  edgeOlder: boolean,
): { fresh: PileCount; older: PileCount } {
  const read = (r.data ?? []).length;
  const short = typeof r.count === "number" && r.count > read;
  const real = (n: number): PileCount => (drawn !== null && n > drawn ? { total: n } : {});
  if (!short) return { fresh: real(kept.fresh), older: real(kept.older) };
  if (order === "oldestFirst") return { fresh: { capped: true }, older: edgeOlder ? { capped: true } : real(kept.older) };
  return { older: { capped: true }, fresh: edgeOlder ? real(kept.fresh) : { capped: true } };
}
