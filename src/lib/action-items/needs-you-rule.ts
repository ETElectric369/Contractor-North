import type { ActionItem, ActionKind, Group, Level, Say } from "./types";
import { companyDay } from "./jobs-needing-a-day";

/**
 * NEEDS YOU'S ONE RULE (the redraw, 2026-11): which of the four tiles a row sits in, and whether it
 * carries a mark. Pure: no catalog, no clock (today comes in), no database. The build stamps every
 * row with it once (query.ts), the list counts with it on the server and again over its live rows
 * after an optimistic removal, so the header, the tiles and the strip can never disagree.
 *
 * A MARK IS RARE ON PURPOSE. NOW (the red octagon) is a thing that costs money or a legal right if it
 * waits past today, and only five kinds can ever be it. SOON (the amber triangle, said "Due") is a
 * row whose own CLOCK is close or just went by: a day somebody picked (a follow-up day, a set-aside
 * day, a come-back day), a day an outside party set (a due day, an offer's last day, a discount's
 * last day, a legal deadline, the authority's booked inspection), the day the crew stands on the job,
 * or the day an outside party did something that needs an answer (a lead came in, an inspection
 * failed). The day the office's own paper was born (made, sent, worked, photographed, taken, visited)
 * is never a clock, so age alone marks nothing (cn-v1162: the owner found the box blended together
 * when every row that had waited a while wore a triangle). Age is the ORDER's job (types.ts
 * sortActionItems, oldest first), never the mark's. Everything else is drawn plain. `urgency` stays
 * the feeders' input; this file is the only reader that turns it into a mark.
 */

/** The four tiles, in the order they are drawn and sorted. On screen they are Get Paid, Sales,
 *  Operations and Bookkeeping (the owner's names, 2026-11-11; the words live in the catalog). These
 *  ids are never shown, so they did not follow the rename. */
export const GROUP_ORDER: Group[] = ["get_paid", "win_work", "run_jobs", "keep_books"];

/**
 * Which tile each kind sits in. Its keys are in AFFORDANCES' order (tests/badge-economy.test.ts
 * compares the two key lists). Every pile's kinds share one group: a pile cannot straddle two tiles.
 */
export const KIND_GROUP: Record<ActionKind, Group> = {
  job_to_schedule: "run_jobs",
  inquiry: "win_work",
  appointment: "run_jobs",
  inspection_writeup: "win_work",
  organize: "keep_books",
  invoice_overdue: "get_paid",
  quote_awaiting: "win_work",
  // A yes is won work, and what it needs next is a day on the calendar: running the job.
  quote_accepted: "run_jobs",
  invoice_draft: "get_paid",
  visit_unbilled: "get_paid",
  quote_draft: "win_work",
  // Its door is the job's invoices tab: a lien is how a company gets paid.
  lien_deadline: "get_paid",
  // Not signed is not locked: the deal is still being won.
  contract_unsigned: "win_work",
  time_stray: "run_jobs",
  // Shares the Done, Not Billed pile with visit_unbilled, so it must share its tile.
  job_unbilled_work: "get_paid",
  materials_needed: "run_jobs",
  job_on_hold: "run_jobs",
  stock_short: "keep_books",
  supplier_paper: "keep_books",
  supplier_pay: "keep_books",
  receipt_unbilled: "keep_books",
  permit_inspection: "run_jobs",
};

/**
 * A clock that went by this many company days ago, or fewer, still marks its row. Older, the row is
 * simply old, and old is the order's job, not the mark's (cn-v1162, the owner's to reverse). A late
 * invoice keeps its own rule (it is listed only while late, and turns NOW at thirty days).
 */
export const DUE_PASSED_DAYS = 7;
/**
 * An estimate's offer this close to its last day is Due. The build's read uses the same number to
 * list it (query.ts imports it from here: the rule cannot import the build, which imports the rule).
 */
export const QUOTE_EXPIRY_SOON_DAYS = 5;
/** An invoice this many days past its due day is NOW. */
export const NOW_INVOICE_LATE_DAYS = 30;
/** A lien deadline this close, or past, is NOW: lien-math's own prelim window. */
export const NOW_LIEN_DAYS = 7;
/** A prompt-pay discount this close to its last day is NOW: the feeder's own urgent window. */
export const NOW_DISCOUNT_DAYS = 3;
/** A discount this close is SOON, so it ramps up instead of jumping from no mark to NOW. */
export const SOON_DISCOUNT_DAYS = 7;

/** The only kinds that can ever be NOW. Anything else that feels urgent is SOON until the owner says. */
export const NOW_KINDS: readonly ActionKind[] = ["quote_accepted", "time_stray", "lien_deadline", "supplier_pay", "invoice_overdue"];

/**
 * How many company days AHEAD of its clock a kind is already Due. Absent is 0: the day itself. An
 * offer ramps up over its last days; materials' 1 is its read's own bound (today's and tomorrow's crews).
 */
export const DUE_AHEAD_DAYS: Partial<Record<ActionKind, number>> = { quote_awaiting: QUOTE_EXPIRY_SOON_DAYS, materials_needed: 1 };

/**
 * The only kinds that can ever be Due (SOON): each has a real clock. Three are read on `when` (the
 * NOW kinds that ramp up); the rest on the row's `clock`, which only their feeders set.
 */
export const DUE_KINDS: readonly ActionKind[] = [
  "invoice_overdue",
  "lien_deadline",
  "supplier_pay",
  "materials_needed",
  "inquiry",
  "quote_awaiting",
  "invoice_draft",
  "job_on_hold",
  "permit_inspection",
];

/** The money a tile adds up, staff only: the figures the app can stand behind for that tile. */
export const GROUP_MONEY_KINDS: Record<Group, readonly ActionKind[]> = {
  get_paid: ["invoice_overdue", "invoice_draft"],
  win_work: ["quote_draft", "quote_awaiting"],
  run_jobs: [],
  keep_books: ["supplier_paper"],
};

/** A "Couldn't Check" line: about a read, never a thing. It is never marked and never piled. */
export function isUnreadLine(item: Pick<ActionItem, "id">): boolean {
  return item.id.endsWith("-unread");
}

export type LevelContext = { todayStr: string; tz?: string | null };

/** Company days from the value's day to today: positive once it is past, negative while ahead. Null: no day. */
function daysPast(value: string | null | undefined, ctx: LevelContext): number | null {
  const day = companyDay(value, ctx.tz);
  if (!day) return null;
  const n = Math.round((Date.parse(`${ctx.todayStr}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000);
  return Number.isFinite(n) ? n : null;
}

/**
 * IS THIS CLOCK DUE: no more than `ahead` company days away, or gone by no more than DUE_PASSED_DAYS.
 * No day is never due.
 */
export function isDue(day: string | null | undefined, ctx: LevelContext, ahead = 0): boolean {
  const p = daysPast(day, ctx);
  return p !== null && p >= -ahead && p <= DUE_PASSED_DAYS;
}

/**
 * A ROW HAS ONE CLOCK. When its paper carries two (an estimate's follow-up day and its offer's last
 * day), the row's clock is the first that is due for its kind, else the first that is set, else null.
 * The feeders call this; the rule reads only what they stamped.
 */
export function dueClock(kind: ActionKind, days: readonly (string | null | undefined)[], ctx: LevelContext): string | null {
  const ahead = DUE_AHEAD_DAYS[kind] ?? 0;
  const set = days.filter((d): d is string => !!d && !!String(d).trim());
  return set.find((d) => isDue(d, ctx, ahead)) ?? set[0] ?? null;
}

/**
 * THE MARK A ROW CARRIES. It reads only kind, id, urgency, when and clock, so a feeder's words can
 * change without moving a mark. `since` (the row's age) is not read: age is the order, never a mark
 * (cn-v1162). Days are the company's days, never UTC's.
 */
export function levelOf(item: Pick<ActionItem, "kind" | "id" | "urgency" | "when" | "clock">, ctx: LevelContext): Level {
  if (isUnreadLine(item)) return "none";
  const past = daysPast(item.when, ctx); // past the row's own day (negative: days still to go)
  switch (item.kind) {
    case "quote_accepted":
      return "now"; // a yes nobody has acted on: the customer is waiting for a day
    case "time_stray":
      // urgency 2 is a clock still running from a past day: every hour on it is wrong pay.
      // A closed shift on no job, or the rollup of them, has no clock: plain.
      return item.urgency === 2 ? "now" : "none";
    case "lien_deadline":
      // The feeder emits only inside lien-math's windows; a legal clock is never left unmarked.
      return past !== null && -past <= NOW_LIEN_DAYS ? "now" : "soon";
    case "supplier_pay":
      if (past === null) return "none";
      return -past <= NOW_DISCOUNT_DAYS ? "now" : -past <= SOON_DISCOUNT_DAYS ? "soon" : "none";
    case "invoice_overdue":
      // Only late invoices are emitted, so every one is at least SOON.
      return past !== null && past >= NOW_INVOICE_LATE_DAYS ? "now" : "soon";
    case "materials_needed": // the crew's day, today or tomorrow: buy before the truck rolls
    case "inquiry": // a follow-up day that came, or the day a new lead came in
    case "quote_awaiting": // a follow-up day that came, or an offer ending inside five days
    case "invoice_draft": // the day it was set aside until has come
    case "job_on_hold": // its come-back day has come
    case "permit_inspection": // the booked day went by unwritten, or the day it failed
      return isDue(item.clock, ctx, DUE_AHEAD_DAYS[item.kind] ?? 0) ? "soon" : "none";
    case "supplier_paper": // a rollup of papers that carry their own dates: undated on purpose
    case "visit_unbilled":
    case "job_unbilled_work":
    case "inspection_writeup":
    case "quote_draft":
    case "contract_unsigned":
    case "job_to_schedule":
    case "appointment": // a visit nobody closed out is not amber (the owner, 2026-11-11)
    case "receipt_unbilled":
    case "stock_short":
    case "organize":
      return "none"; // no clock: each day these hold is the day the office's own paper was born
  }
}

const RANK: Record<Level, number> = { now: 2, soon: 1, none: 0 };

/** The most urgent of several marks (a pile wears its most urgent child's). None when there are none. */
export function maxLevel(levels: readonly (Level | null | undefined)[]): Level {
  let best: Level = "none";
  for (const l of levels) if (l && RANK[l] > RANK[best]) best = l;
  return best;
}

export type TileSummary = {
  group: Group;
  /** Open rows in this tile that are not NOW (a pile counts one). */
  count: number;
  /** Of those, the SOON ones. */
  soon: number;
  /** Staff only: the sum of `amount` over this tile's money rows. Null: nothing to say, or a tech. */
  money: number | null;
  /** A pile that adds to this tile's money hit its read's cap: the sum is "at least" (drawn with "+"). */
  moneyCapped: boolean;
  /** Its "Couldn't Check" lines, so a closed tile never hides a failed read. */
  unread: number;
};

export type NeedsYouSummary = {
  /** Open rows marked NOW (the strip). */
  now: number;
  /** Open rows marked SOON. */
  soon: number;
  /** Every other open row. now + soon + more = the open rows. */
  more: number;
  /** The four tiles in GROUP_ORDER. Their counts add up to soon + more, their soon to soon. */
  tiles: TileSummary[];
  /** The tile that opens first (openFirst). */
  open: Group | null;
};

type Countable = Pick<ActionItem, "id" | "kind" | "done" | "group" | "level" | "amount" | "pile">;

/**
 * THE COUNTS: the header's three and each tile's. It counts the open rows (not ticked done) as
 * they are, a pile as one row with its own mark. A filter, never a sort: the order is the server's.
 */
export function summarize(rows: readonly Countable[], opts: { isStaff: boolean }): NeedsYouSummary {
  const open = rows.filter((r) => !r.done);
  const tiles: TileSummary[] = GROUP_ORDER.map((group) => ({ group, count: 0, soon: 0, money: null, moneyCapped: false, unread: 0 }));
  const byGroup = new Map(tiles.map((t) => [t.group, t]));
  let now = 0;
  let soon = 0;
  for (const r of open) {
    const level = r.level ?? "none";
    if (level === "now") {
      now++;
      continue;
    }
    if (level === "soon") soon++;
    const tile = byGroup.get(r.group ?? KIND_GROUP[r.kind]);
    if (!tile) continue;
    tile.count++;
    if (level === "soon") tile.soon++;
    if (isUnreadLine(r)) tile.unread++;
    if (opts.isStaff && GROUP_MONEY_KINDS[tile.group].includes(r.kind)) {
      if (r.pile?.capped) tile.moneyCapped = true;
      if (typeof r.amount === "number" && Number.isFinite(r.amount)) tile.money = (tile.money ?? 0) + r.amount;
    }
  }
  return { now, soon, more: open.length - now - soon, tiles, open: openFirst(tiles) };
}

/** THE TILE THAT OPENS FIRST: the first in the fixed order with a SOON row, else the first with any row. */
export function openFirst(tiles: readonly Pick<TileSummary, "group" | "count" | "soon">[]): Group | null {
  const ordered = GROUP_ORDER.map((g) => tiles.find((t) => t.group === g)).filter((t): t is Pick<TileSummary, "group" | "count" | "soon"> => !!t);
  return ordered.find((t) => t.soon > 0)?.group ?? ordered.find((t) => t.count > 0)?.group ?? null;
}

/** A phrase that fills a money slot. */
const saysMoney = (s: Say | undefined): boolean => !!s?.vars && ("money" in s.vars || "money2" in s.vars);

/**
 * THE TECH'S BELT, AT THE ONE EXIT. Techs see no prices. Each money feeder is already gated on
 * staff, and row-words drops `amount` for a tech, but a money slot inside a phrase had no second
 * guard. So for a viewer who is not staff every row leaves the build with no amount and without any
 * `what` or `whoSay` that fills `money` / `money2` (the row then says its title and subtitle), a
 * pile's children too. Staff rows come back as the same object, untouched.
 */
export function withoutMoneyForTech(row: ActionItem, isStaff: boolean): ActionItem {
  if (isStaff) return row;
  const out: ActionItem = { ...row, amount: null };
  if (saysMoney(out.what)) delete out.what;
  if (saysMoney(out.whoSay)) delete out.whoSay;
  if (out.children) out.children = out.children.map((c) => withoutMoneyForTech(c, false));
  return out;
}
