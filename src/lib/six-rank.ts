// TASKS & REMINDERS — the one place that says which of a person's open Reminders are on their day,
// in what order, and which rows the database is even asked for. Shared by My Day's card
// (planner/page.tsx), the morning push digest (action-items/digest.ts) and the Reminders page's pin
// glyph (tasks/tasks-view.tsx), so the rule can never be written twice and drift.
//
// WHY IT CHANGED (Erik, 2026-09-30, /planner): "the tasks keep disappearing even the pinned ones, I
// think those reminders should be visible". He was right, and it was by design: a pin was
// focus_date = TODAY exactly, so at midnight the row stopped matching the pin arm, stopped matching
// the pool cut, and was not even FETCHED the next morning. Nothing was written and nothing was said.
// He also named the card himself: "instead of todayy's 6 lets not limit it and call it something
// more clear like Tasks & Reminders".
//
// So, now:
//   · A PIN IS A PROMISE AND IT CARRIES. focus_date <= today is a pin that still stands. One set
//     BEFORE today is a CARRIED pin: it leads the card, oldest first, wearing "Carried From <Day>".
//     It leaves when he unpins it or checks it off — never because a day turned over.
//   · THERE IS NO DISPLAY CAP. The card shows every open Reminder a rank claims. The only bound left
//     is on the FETCH (MY_DAY_POOL_LIMIT), ordered so that neither a pin nor the freshest deadline can
//     be the row that gets cut (RANK_POOL_ORDER says why, term by term), and the card says how many
//     more there are rather than dropping them in silence.
//   · A PLAIN UNDATED REMINDER IS VISIBLE. It ranks last, but it ranks. That is what lets the Add
//     line stop stamping a pin on everything it types (planner/your-list.tsx) — a pin means a pin
//     again.
//
// RANK ORDER (every rank is a filter + a total order; no rank has a cap):
//   1a. CARRIED PINS — focus_date < today. Oldest first: the thing he has walked past longest leads.
//   1b. TODAY'S PINS — focus_date = today.
//   2.  OVERDUE — due < today; priority desc, then due DESC (a yesterday-miss beats a June-8
//       zombie). The old 3-row auto-fill cap is gone with the display cap: a missed deadline is not
//       something to hide from him.
//   3.  DUE TODAY.
//   4.  FLAGGED UNDATED — priority >= 1, no due date.
//   5.  PLAIN UNDATED — the rest of his open Reminders (Erik: "those reminders should be visible").
//
// WHAT STILL NEVER RANKS: a FUTURE due date (the ⋯ sheet promises "it waits on your Reminders list
// till then", and a card full of next month is the stockpile he quit My Day over); category 'office'
// with no date (batch work behind the Office door — a STATED date still ranks it, ranks 2-3); a job's
// task (0358 — a job's tasks are the JOB's list, worked on the job and in the Now card, never a
// person's reminders); a SUBTASK (parent_id set — it renders nested under its parent); anything not
// open.

import { formatDate } from "@/lib/utils";

/** A pin on a day at or before today is a pin that STILL STANDS. The one definition of "pinned" —
 *  every surface asks this, nobody re-writes `focus_date === todayStr` again. */
export function isPinned(focusDate: string | null | undefined, todayStr: string): boolean {
  return !!focusDate && focusDate <= todayStr;
}

/** The day a CARRIED pin was set, or null when it is today's pin (or no pin at all). The card draws
 *  "Carried From <Day>" off this, so a pin that survived the night says so instead of looking new. */
export function pinCarriedFrom(focusDate: string | null | undefined, todayStr: string): string | null {
  return focusDate && focusDate < todayStr ? focusDate : null;
}

/**
 * THE CARRIED-PIN CHIP FOR ONE ROW — the day a standing pin was set, or null when there is nothing
 * TRUE to say about this row: no pin, today's pin, no company day to measure against, or a Reminder
 * that is DONE.
 *
 * The status gate is the whole reason this exists. Checking a Reminder off does not clear its
 * focus_date (nothing does, on purpose: un-checking it restores the pin it had), so a chip gated on
 * the DATE alone stood under a struck-through title — "Carried From Yesterday" about work already
 * finished, in /tasks' Done fold and under a just-checked row on My Day. The pin GLYPH was already
 * gated on status at both doors; the chip was not. Now both surfaces ask this one function, so there
 * is one gate to get right instead of two to keep in step.
 */
export function carriedPin(
  t: { focus_date?: string | null; status?: string | null },
  todayStr: string | null | undefined,
  /** The row's done-ness when the surface knows better than `status` — My Day's optimistic check. */
  done?: boolean,
): string | null {
  if (!todayStr) return null;
  if (done ?? t.status === "done") return null;
  return pinCarriedFrom(t.focus_date, todayStr);
}

/**
 * The day a carried pin was set, in the fewest words that are still TRUE: "Yesterday", then the
 * weekday while it is still this past week ("Monday"), then the date ("Sep 12"). A weekday on its own
 * past six days back would be a lie — three Mondays ago also reads "Monday" — so it stops there.
 * Pure UTC math on the org-local day strings, so it never slides a day on a phone in another zone.
 */
export function carriedDay(dayStr: string, todayStr: string): string {
  const d = new Date(`${dayStr}T00:00:00Z`);
  const t = new Date(`${todayStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(t.getTime())) return dayStr;
  const days = Math.round((t.getTime() - d.getTime()) / 86_400_000);
  if (days === 1) return "Yesterday";
  if (days > 1 && days <= 6) return d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return formatDate(dayStr);
}

/** THE PIN ARM, as PostgREST writes it. `lte`, not `eq`: a carried pin has to be FETCHED to be shown
 *  (that was defect 1 — the row left the query at midnight, so no code downstream ever saw it). */
export function pinArm(todayStr: string): string {
  return `focus_date.lte.${todayStr}`;
}

/**
 * WHO IS READING THE POOL. The two readers differ in exactly one documented way, named here so the
 * cut itself is never copied:
 *   · "my_day" — the card. Every open Reminder, plain undated ones included: they must be VISIBLE.
 *   · "push"   — the morning digest. A push may only NAME a bounded, dated-or-chosen set (the badge
 *     invariant in action-items/types.ts: no pushed number is the length of an undated set), so an
 *     undated Reminder rides it only when it is flagged or pinned.
 */
export type PoolScope = "my_day" | "push";

/**
 * ONE ARM, BOTH LANGUAGES. Each arm of the pool cut is written once, as the PostgREST filter the
 * database gets AND as the predicate that means the same thing, on the same line — because the two
 * have to agree and the only way to keep them agreeing is to never write them apart. The SQL side
 * feeds the fetch (rankPoolCut); the predicate side lets the push assert its own narrower pool where
 * it ranks (inRankPool), and lets a test drive the real pool shape without a database.
 */
interface PoolArm {
  sql: string;
  test: (t: SixRankTask) => boolean;
}

function poolArms(todayStr: string, scope: PoolScope): PoolArm[] {
  return [
    { sql: pinArm(todayStr), test: (t) => isPinned(t.focus_date, todayStr) },
    { sql: `due_date.lte.${todayStr}`, test: (t) => !!t.due_date && (t.due_date as string) <= todayStr },
    scope === "my_day"
      ? { sql: "due_date.is.null", test: (t) => t.due_date == null }
      : { sql: "and(due_date.is.null,priority.gte.1)", test: (t) => t.due_date == null && (Number(t.priority) || 0) >= 1 },
  ];
}

/** The `.or()` cut for the ranked pool. ONE place; `scope` is the only difference between readers. */
export function rankPoolCut(todayStr: string, scope: PoolScope): string {
  return poolArms(todayStr, scope)
    .map((a) => a.sql)
    .join(",");
}

/** Would this row be IN the pool for that reader? The same arms, asked in TypeScript. */
export function inRankPool(t: SixRankTask, todayStr: string, scope: PoolScope): boolean {
  return poolArms(todayStr, scope).some((a) => a.test(t));
}

/** Every column the rank reads — created_at included, because the tiebreak is part of the rule. */
export const RANK_POOL_SELECT = "id, title, category, priority, due_date, focus_date, job_id, created_at";

/** BUILD FOR MILLIONS: a company with thousands of open Reminders must not pull them all. */
export const MY_DAY_POOL_LIMIT = 60;
/** The digest reads the whole company's pool once and splits it per person, so its bound is bigger. */
export const PUSH_POOL_LIMIT = 500;
/** How many of a person's day a PUSH may name. A notification is a sentence, not a list. */
export const PUSH_SIX = 6;

/**
 * THE ORDER THE BOUND CUTS IN, WRITTEN ONCE — as the terms the database gets (rankPoolQuery) and as
 * the comparison those terms MEAN (byPoolOrder). Two languages, one list, on purpose: the first
 * attempt at this build sorted its fixtures one way in the suite and sent the database another, so a
 * green suite proved nothing about the rows a phone would actually get back.
 *
 * WHY THESE TERMS, IN THIS ORDER:
 *  1. focus_date ASC, NULLS LAST — every standing pin ahead of everything unpinned, the carried ones
 *     first (the card leads with them too). A pin can never be the row the bound cuts: that was the
 *     other half of Erik's "the tasks keep disappearing even the pinned ones".
 *     KNOWN AND BOUNDED COST: a pin on a FUTURE day (the debrief pins tomorrow's picks) rides the
 *     head of the fetch as well, though it does not rank until its day comes. It costs as many rows
 *     as one debrief pinned, and buying it back would mean a second read of the same table — so it is
 *     named here rather than forked around.
 *  2. priority DESC, NULLS LAST — urgent, then high, then the rest: the first term every rank sorts
 *     by, so the fetch and the card agree about what matters. (tasks.priority is NOT NULL since 0018;
 *     the nulls term is stated anyway so the SQL and the comparison stay literally identical.)
 *  3. due_date DESC, NULLS LAST — THE FRESHEST DATE SURVIVES THE CUT. Ascending read oldest-first:
 *     with 60-odd overdue reminders from June in the pool, the bound kept the June zombies and the
 *     thing due TODAY was never fetched at all — Erik's own complaint, one layer down, and a straight
 *     contradiction of rank 2's "a yesterday-miss beats a June-8 zombie". Descending keeps today,
 *     then yesterday's miss, and cuts the oldest end of the backlog. Undated reminders sort last, so
 *     a Someday pile is cut before a deadline is.
 *  4. created_at ASC, then 5. id ASC — the total order: no two rows can tie, so the same pool comes
 *     back in the same sequence however the heap happened to hand it over, and the card stops
 *     shuffling between polls.
 *
 * Whatever the bound DID leave behind is never dropped in silence: it is counted on the card's
 * "All Reminders · N More For You" line.
 */
export const RANK_POOL_ORDER: { column: keyof SixRankTask; ascending: boolean; nullsFirst: boolean }[] = [
  { column: "focus_date", ascending: true, nullsFirst: false },
  { column: "priority", ascending: false, nullsFirst: false },
  { column: "due_date", ascending: false, nullsFirst: false },
  { column: "created_at", ascending: true, nullsFirst: false },
  { column: "id", ascending: true, nullsFirst: false },
];

/** The pool order as a COMPARISON — the same terms, so a test drives the real order or none at all. */
export function byPoolOrder(a: SixRankTask, b: SixRankTask): number {
  for (const { column, ascending, nullsFirst } of RANK_POOL_ORDER) {
    const av = a[column] ?? null;
    const bv = b[column] ?? null;
    if (av === null && bv === null) continue;
    if (av === null) return nullsFirst ? -1 : 1;
    if (bv === null) return nullsFirst ? 1 : -1;
    const c =
      typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    if (c !== 0) return ascending ? c : -c;
  }
  return 0;
}

/**
 * Shape a tasks read into THE ranked pool: the cut, the order the bound must cut in, and the bound.
 * Hand it a query already narrowed to the caller's own rows (My Day's mineCut, the digest's org +
 * job_id null) — this adds only the parts that are the RULE.
 */
export function rankPoolQuery<Q>(
  q: Q,
  { todayStr, scope, limit }: { todayStr: string; scope: PoolScope; limit?: number },
): Q {
  let a = (q as any).or(rankPoolCut(todayStr, scope));
  for (const { column, ascending, nullsFirst } of RANK_POOL_ORDER) a = a.order(column, { ascending, nullsFirst });
  return a.limit(limit ?? (scope === "my_day" ? MY_DAY_POOL_LIMIT : PUSH_POOL_LIMIT)) as Q;
}

export interface SixRankTask {
  id: string;
  /** Only "open" rows rank; anything else is dropped defensively. */
  status?: string | null;
  /** 0 normal · 1 high · 2 urgent (tasks.priority). */
  priority?: number | null;
  /** yyyy-mm-dd due date, if any. */
  due_date?: string | null;
  /** yyyy-mm-dd. On or before today = a pin that still stands (isPinned); before today = carried. */
  focus_date?: string | null;
  /** tasks.category — 'office' is excluded from the UNDATED ranks only. */
  category?: string | null;
  /** A job task never ranks (0358): these are Reminders. */
  job_id?: string | null;
  /** Subtasks (parent_id set) never rank — they nest under their parent. */
  parent_id?: string | null;
  /** The tiebreak that stops the list shuffling: the oldest thing keeps its place. */
  created_at?: string | null;
}

export interface SixRankContext {
  /** The org-local day, yyyy-mm-dd. */
  todayStr: string;
  /** A BOUND, not a display cap: the push passes PUSH_SIX. The card passes nothing — Erik's call,
   *  "lets not limit it". */
  slots?: number;
}

const prio = (t: SixRankTask) => Number(t.priority) || 0;
const made = (t: SixRankTask) => String(t.created_at ?? "");
/** THE TOTAL ORDER (Part D). Two rows can never compare equal, so the same pool always comes back in
 *  the same sequence however the database happened to hand it over. */
const byTotal = (a: SixRankTask, b: SixRankTask) =>
  prio(b) - prio(a) || made(a).localeCompare(made(b)) || String(a.id).localeCompare(String(b.id));
/** The tiebreak alone, for a rank with its own middle term (overdue's due DESC). */
const byTail = (a: SixRankTask, b: SixRankTask) =>
  made(a).localeCompare(made(b)) || String(a.id).localeCompare(String(b.id));

/**
 * Pick a person's Tasks & Reminders out of an open-task pool, in rank order. Uncapped unless the
 * caller passes `slots` (the push does). Pure and never mutates the input.
 */
export function rankSix<T extends SixRankTask>(tasks: T[], ctx: SixRankContext): T[] {
  const { todayStr } = ctx;
  const slots = ctx.slots ?? Number.POSITIVE_INFINITY;

  // Top-level OPEN Reminders only — subtasks, done/cancelled rows and job tasks never rank.
  const pool = tasks.filter(
    (t) => t.parent_id == null && t.job_id == null && (t.status == null || t.status === "open"),
  );

  const picked: T[] = [];
  const taken = new Set<string>();
  const take = (rows: T[]) => {
    for (const t of rows) {
      if (picked.length >= slots) return;
      if (taken.has(t.id)) continue;
      picked.push(t);
      taken.add(t.id);
    }
  };
  // Sort helpers copy via filter() first, so sort() never touches the caller's array.
  const undated = (t: T) => t.due_date == null && t.category !== "office";

  // 1a. CARRIED pins — oldest first: the thing he has walked past longest leads the day.
  take(
    pool
      .filter((t) => !!pinCarriedFrom(t.focus_date, todayStr))
      .sort((a, b) => String(a.focus_date).localeCompare(String(b.focus_date)) || byTotal(a, b)),
  );
  // 1b. Today's pins.
  take(pool.filter((t) => t.focus_date === todayStr).sort(byTotal));
  // 2. Overdue — priority desc, then due DESC (the freshest miss first). No cap: see the header.
  take(
    pool
      .filter((t) => !!t.due_date && (t.due_date as string) < todayStr)
      .sort(
        (a, b) =>
          prio(b) - prio(a) || (b.due_date as string).localeCompare(a.due_date as string) || byTail(a, b),
      ),
  );
  // 3. Due today.
  take(pool.filter((t) => t.due_date === todayStr).sort(byTotal));
  // 4. Flagged undated — office stays behind the Office door.
  take(pool.filter((t) => undated(t) && prio(t) >= 1).sort(byTotal));
  // 5. Plain undated — Erik: "those reminders should be visible".
  take(pool.filter((t) => undated(t)).sort(byTotal));

  return picked;
}

/**
 * IS THIS ROW ON TODAY'S CARD? Asked by the words the app says about a row — the ⋯ sheet's "it waits
 * on your Reminders list till then" (planner/your-list movedWords) and the duplicate answer that has
 * to decide whether an existing Reminder needs a pin to be seen (tasks/actions createTask). It calls
 * the real rank, so a sentence can never promise something the card then contradicts.
 */
export function ranksToday(t: SixRankTask, todayStr: string): boolean {
  return rankSix([t], { todayStr }).length === 1;
}
