import type { ActionItem, ActionKind, Group, Level, Say } from "./types";
import { companyDay } from "./jobs-needing-a-day";

/**
 * NEEDS YOU'S ONE RULE (the redraw, 2026-11): which of the four tiles a row sits in, and whether it
 * carries a mark. Pure: no catalog, no clock (today comes in), no database. The build stamps every
 * row with it once (query.ts), the list counts with it on the server and again over its live rows
 * after an optimistic removal, so the header, the tiles and the strip can never disagree.
 *
 * A MARK IS RARE ON PURPOSE. NOW (the red octagon) is a thing that costs money or a legal right if it
 * waits past today, and only five kinds can ever be it. SOON (the amber triangle) is a thing that has
 * sat a week, or whose day is close. Everything else is drawn plain. `urgency` stays the feeders'
 * input; this file is the only reader that turns it into a mark.
 */

/** The four tiles, in the order they are drawn and sorted. */
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

/** A row that has sat this many company days, counted from `since ?? when`, is SOON. */
export const SOON_AFTER_DAYS = 7;
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
 * THE MARK A ROW CARRIES. It reads only kind, id, urgency, when and since, so a feeder's words can
 * change without moving a mark. Days are the company's days, never UTC's.
 */
export function levelOf(item: Pick<ActionItem, "kind" | "id" | "urgency" | "when" | "since">, ctx: LevelContext): Level {
  if (isUnreadLine(item)) return "none";
  const age = daysPast(item.since ?? item.when, ctx);
  const sat = age !== null && age >= SOON_AFTER_DAYS;
  const past = daysPast(item.when, ctx); // past the row's own day (negative: days still to go)
  switch (item.kind) {
    case "quote_accepted":
      return "now"; // a yes nobody has acted on: the customer is waiting for a day
    case "time_stray":
      // urgency 2 is a clock still running from a past day: every hour on it is wrong pay.
      return item.urgency === 2 ? "now" : sat ? "soon" : "none";
    case "lien_deadline":
      // The feeder emits only inside lien-math's windows; a legal clock is never left unmarked.
      return past !== null && -past <= NOW_LIEN_DAYS ? "now" : "soon";
    case "supplier_pay":
      if (past === null) return "none";
      return -past <= NOW_DISCOUNT_DAYS ? "now" : -past <= SOON_DISCOUNT_DAYS ? "soon" : "none";
    case "invoice_overdue":
      // Only late invoices are emitted, so every one is at least SOON.
      return past !== null && past >= NOW_INVOICE_LATE_DAYS ? "now" : "soon";
    case "invoice_draft":
    case "inquiry":
      return item.urgency >= 1 || sat ? "soon" : "none";
    case "quote_awaiting":
    case "job_on_hold":
      // Listed only once its day came (or it went quiet a week): being here is the reason to look.
      return "soon";
    case "materials_needed":
      return item.when ? "soon" : "none"; // the crew's day is set: buy before the truck rolls
    case "permit_inspection":
      return item.urgency === 2 || !!item.when || sat ? "soon" : "none";
    case "supplier_paper":
      return "none"; // a rollup of papers that carry their own dates: undated on purpose
    case "visit_unbilled":
    case "job_unbilled_work":
    case "inspection_writeup":
    case "quote_draft":
    case "contract_unsigned":
    case "job_to_schedule":
    case "appointment":
    case "receipt_unbilled":
    case "stock_short":
    case "organize":
      return sat ? "soon" : "none";
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
