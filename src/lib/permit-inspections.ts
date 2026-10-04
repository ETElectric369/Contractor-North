import type { Blockable } from "@/lib/waiting-on";

/**
 * A PERMIT KNOWS WHO STILL HAS TO COME (0378) — THE one rule, in one place, with teeth.
 *
 * Erik, 2026-10-03, on a job worked 12 October whose permit needs two authorities (0378's header
 * carries the job and his whole specification):
 *
 *   "when we do the job we have to get it inspected by both the Town of Truckee and Liberty Utilities
 *    before Liberty will put the meter back on, so final inspections come with permits."
 *   "Liberty's inspection is after the town puts the tag on in and involves putting the meter back on
 *    in the same visit."
 *
 * So one permit needs SEVERAL visits, from DIFFERENT authorities, IN ORDER — and the last one is the
 * moment the customer has power. There are no stages ("final", he said when asked): what varies is
 * the authority.
 *
 * ── THE GATE, WHICH IS THE PART TO GET RIGHT ─────────────────────────────────────────────────────
 * Position 2 is not bookable until position 1 has PASSED: the town's tag is what lets the utility be
 * called. Nothing in the database records "waits for" — the position plus THE PREVIOUS ROW'S result
 * says it (0378's own comment). So the rule is written ONCE, here, as a pure function, and every
 * door reads it: the permit card, Needs You, the job's own line.
 *
 *   THE PREVIOUS ROW, NOT "every earlier row". A failed final is re-inspected as a NEW row, so a
 *   permit can read [1 town failed, 2 town passed, 3 utility]. "Every earlier row passed" would wedge
 *   that permit shut forever; "the one in front of me passed" lets the re-inspection clear the way,
 *   which is what actually happens on site.
 *
 *   AND THE RE-INSPECTION SITS WHERE THE VISIT IT REPLACES SAT. A new booking is written on the END
 *   (nextPosition), so on Thursday's own job — town at 1 and utility at 2, both booked for one
 *   morning — a town retry lands at 3, BEHIND the utility. Read literally, the retry then waits for
 *   the utility and the utility waits for the failed town: the permit is wedged shut and the card
 *   says "book another visit" forever, however many visits are booked. So the order each authority's
 *   visits happen in is worked out here (`inOrder`): a visit that did not pass and a later visit from
 *   the SAME authority are one chain, the replacement sits right behind the one it replaces, and the
 *   replaced visit is history — it gates nobody. Nothing is renumbered in the database: no write has
 *   to shuffle positions, and 0378 keeps them unique.
 *
 *   THE GATE IS ABOUT NAGGING, NEVER ABOUT WRITING. Both of that job's inspections are ALREADY booked
 *   for the morning of Thursday 15 October — he booked them by phone, days ahead, before the town had
 *   been anywhere. So nothing here may stop a person booking a blocked inspection. What the gate
 *   decides is what the app calls READY and what it dares put in a pile of things waiting on him:
 *   an inspection that is not yet unblocked is NOT overdue and is NOT his to do.
 *
 * ── THE PERMIT'S VERDICT ─────────────────────────────────────────────────────────────────────────
 * Every surface asks the same question — "where does this permit stand?" — so they all read ONE
 * answer, `permitInspectionStand`. It names the one thing that happens next and who it belongs to.
 * `hisToDo` is the whole of what may nag; `waitingOnThem` is the whole of what waits with a day.
 *
 * ── WHAT IT NEVER DOES ───────────────────────────────────────────────────────────────────────────
 * No clock of its own: `todayStr` is the COMPANY's day, handed in (the hydration law — never the
 * browser's clock). No stored copy of any of this: a permit's stand is DERIVED from its rows every
 * time it is asked, so there is no second place for it to go stale. permits.authority is a different
 * fact and stays what it is: who ISSUED the permit, not who inspects it.
 */

/** 0378: scheduled_window's check constraint, with the words a person reads. Title Case: they sit in a picker. */
export const INSPECTION_WINDOWS: readonly [InspectionWindow, string][] = [
  ["morning", "Morning"],
  ["afternoon", "Afternoon"],
  ["all_day", "All Day"],
];

/** 0378: result's check constraint. Nothing else may be written. */
export const INSPECTION_RESULTS: readonly [InspectionResult, string][] = [
  ["passed", "Passed"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
];

/** 0378: position between 1 and 20, and authority 1..80 characters. The forms refuse past these
 *  rather than letting the database refuse in SQL words nobody can read. */
export const MAX_INSPECTION_POSITION = 20;
export const AUTHORITY_MAX = 80;
export const INSPECTOR_MAX = 80;
/** 0378's own CHECK on notes. A FAILED inspection must carry its reason (Erik, 2026-10-03: "Inspection
 *  Status: Passed or Failed (if failed, why)") — a failure nobody wrote a reason on is a visit you
 *  have to make again to find out what it was for. */
export const WHY_MAX = 2000;

export type InspectionWindow = "morning" | "afternoon" | "all_day";
export type InspectionResult = "passed" | "failed" | "cancelled";

/** One visit an authority makes about a permit (public.permit_inspections, 0378). */
export interface PermitInspection {
  id: string;
  permit_id?: string | null;
  authority: string;
  position: number;
  scheduled_for: string | null;
  scheduled_window: InspectionWindow | null;
  inspector?: string | null;
  result: InspectionResult | null;
  result_on?: string | null;
  notes?: string | null;
}

/** The columns every reader of this table asks for (the projection law: one list, one place). */
export const PERMIT_INSPECTION_COLUMNS =
  "id, permit_id, authority, position, scheduled_for, scheduled_window, inspector, result, result_on, notes";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const isYmd = (v: unknown): v is string => typeof v === "string" && YMD.test(v);

export const windowLabel = (w: string | null | undefined): string | null =>
  INSPECTION_WINDOWS.find(([v]) => v === w)?.[1] ?? null;

export const resultLabel = (r: string | null | undefined): string | null =>
  INSPECTION_RESULTS.find(([v]) => v === r)?.[1] ?? null;

/** What the order needs to know about a row: where it was written down, who is coming, and whether
 *  they passed. Optional, so a caller with only positions still reads in position order. */
type Ordinal = { position: number; authority?: string | null; result?: string | null };

/** A visit that did not pass invites another from the same authority — that is what a re-inspection
 *  IS. A passed visit does not, and neither does one nobody has written up yet (two visits booked for
 *  one authority is two visits, not a retry). */
const didNotPass = (r: Pick<Ordinal, "result">): boolean => r.result === "failed" || r.result === "cancelled";

/** The same authority however it was typed: the box is free text, and a retry is booked by typing the
 *  name again or picking it from the suggestions. Blank never matches blank — a row with no authority
 *  0378 would refuse is nobody's retry. */
const authorityKey = (a: string | null | undefined): string => String(a ?? "").trim().toLowerCase();

/**
 * THE ORDER THE VISITS ACTUALLY HAPPEN IN, with each one said to be SUPERSEDED or not — the one walk
 * the card's list and the gate both read, so they can never disagree about which visit is in front of
 * which.
 *
 * Position order first (a stable sort, so two rows that somehow share a position — 0378 forbids it, an
 * older row set might not — keep the order they arrived in). Then each authority's visits are gathered
 * into ONE CHAIN: a visit that did not pass is replaced by that authority's next visit, and the
 * replacement belongs directly behind it, not on the end behind an authority that cannot come until it
 * has passed. Everything but the last of a chain is SUPERSEDED: history, which gates nobody.
 */
function ordered<T extends Ordinal>(rows: readonly T[] | null | undefined): { row: T; superseded: boolean }[] {
  const byPosition = (rows ?? [])
    .filter(Boolean)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(a.r.position ?? 0) - Number(b.r.position ?? 0) || a.i - b.i)
    .map(({ r }) => r);

  const chains: T[][] = [];
  /** The chain an authority's NEXT visit joins: it has one only while its last visit did not pass. */
  const awaitingAnother = new Map<string, T[]>();
  for (const r of byPosition) {
    const who = authorityKey(r.authority);
    const replacing = who ? awaitingAnother.get(who) : undefined;
    const chain = replacing ?? [];
    if (!replacing) chains.push(chain); // nothing to replace: this visit starts its own place in line
    chain.push(r);
    if (!who) continue;
    if (didNotPass(r)) awaitingAnother.set(who, chain);
    else awaitingAnother.delete(who);
  }
  return chains.flatMap((chain) => chain.map((row, i) => ({ row, superseded: i < chain.length - 1 })));
}

/** The order the authorities come in, with a re-inspection sitting right behind the visit it replaces
 *  (`ordered`) — what the card lists, top to bottom, and what the gate reads. */
export function inOrder<T extends Ordinal>(rows: readonly T[] | null | undefined): T[] {
  return ordered(rows).map((o) => o.row);
}

/** The place the next authority booked goes. Clamped to 0378's ceiling, so the form never offers a
 *  position the database refuses. */
export function nextPosition(rows: readonly { position: number }[] | null | undefined): number {
  const used = (rows ?? []).map((r) => Number(r.position ?? 0)).filter((n) => Number.isFinite(n));
  return Math.min(MAX_INSPECTION_POSITION, Math.max(0, ...used, 0) + 1);
}

/**
 * THE ROW IN FRONT of this position — not "position - 1": positions have gaps the moment a row is
 * deleted, and a gap must not be read as "nothing in front of me".
 *
 * It is the row in front IN THE ORDER THE VISITS HAPPEN (`ordered`), and a SUPERSEDED visit is skipped:
 * a town visit that failed and was re-booked is history, so it no longer stands in front of the retry
 * that replaced it (which would wait for itself) nor in front of the utility behind it (which must wait
 * for the RETRY). Positions are unique per permit (0378), so the position names the row; one that has
 * just been deleted from another screen still reads what sorts before it.
 */
export function previousOf<T extends Ordinal>(rows: readonly T[] | null | undefined, position: number): T | null {
  const seq = ordered(rows);
  const mine = Number(position);
  const at = seq.findIndex((o) => Number(o.row.position ?? 0) === mine);
  const before = (at >= 0 ? seq.slice(0, at) : seq.filter((o) => Number(o.row.position ?? 0) < mine)).filter(
    (o) => !o.superseded,
  );
  return before.length ? before[before.length - 1].row : null;
}

/** THE GATE. Can this position be called yet? Only a PASS in front opens it: a failed or cancelled
 *  visit in front means the tag isn't on, so the utility has nothing to come to. A failed visit that
 *  has been RE-BOOKED is not in front of anybody (previousOf): the retry stands in its place. */
export function isUnblocked(rows: readonly PermitInspection[] | null | undefined, position: number): boolean {
  const prev = previousOf(rows, position);
  return !prev || prev.result === "passed";
}

/** Who has to pass before this one can be called, or null when nothing is in its way. */
export function blockedBy(rows: readonly PermitInspection[] | null | undefined, position: number): string | null {
  const prev = previousOf(rows, position);
  return !prev || prev.result === "passed" ? null : prev.authority;
}

/** Nobody has written up this visit yet. 0378 keeps result NULL until they have been. */
export const isOpenInspection = (r: Pick<PermitInspection, "result">): boolean => !r.result;

/** Every visit still owed on this permit (the open rows, in order) — what "who still has to come" means. */
export function outstandingInspections(rows: readonly PermitInspection[] | null | undefined): PermitInspection[] {
  return inOrder(rows).filter(isOpenInspection);
}

/** "Oct 15", from a date-only day. Noon UTC, rendered in UTC: the literal day, in any zone, never
 *  yesterday because the reader is east of the company. */
export function shortDayWords(ymd: string | null | undefined): string | null {
  if (!isYmd(ymd)) return null;
  const t = Date.parse(`${ymd}T12:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

/** "Thu Oct 15" — THE WEEKDAY IS THE POINT: an inspection is booked as "Thursday morning", and a
 *  bare "Oct 15" makes a person count on a calendar. Built from two parts rather than one format,
 *  which writes "Thu, Oct 15" and reads like a letterhead. */
export function dayWords(ymd: string | null | undefined): string | null {
  const day = shortDayWords(ymd);
  if (!day) return null;
  const weekday = new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" });
  return `${weekday} ${day}`;
}

/** "Thu Oct 15, morning" — the day and the part of it, which is all an inspector ever gives you. */
export function bookedWords(r: Pick<PermitInspection, "scheduled_for" | "scheduled_window">): string | null {
  const day = dayWords(r.scheduled_for);
  if (!day) return null;
  const w = windowLabel(r.scheduled_window);
  return w ? `${day}, ${w.toLowerCase()}` : day;
}

/**
 * THE ONE LINE A ROW SAYS on the permit's card, in the order a person asks: who, when, how it went.
 *   "Town of Truckee · Thu Oct 15, morning"                            booked, nothing written up yet
 *   "Town of Truckee · Passed Oct 15 · Dana"                           it happened
 *   "Liberty Utilities · Not booked yet"                               nobody has called them
 *   "Liberty Utilities · Thu Oct 15, morning · Waits for Town of..."   booked, and the gate still shut
 *
 * A BOOKED ROW THAT IS STILL BLOCKED SAYS BOTH. He booked both authorities for one morning by phone,
 * so hiding either half would lie: the day is real and so is the order they have to come in.
 */
export function inspectionLine(rows: readonly PermitInspection[], row: PermitInspection): string {
  const who = row.authority.trim();
  const said = resultLabel(row.result);
  if (said) {
    const on = shortDayWords(row.result_on ?? null);
    return [who, on ? `${said} ${on}` : said, (row.inspector ?? "").trim() || null].filter(Boolean).join(" · ");
  }
  const booked = bookedWords(row);
  const waits = blockedBy(rows, row.position);
  return [who, booked ?? (waits ? null : "Not booked yet"), waits ? `Waits for ${waits}` : null]
    .filter(Boolean)
    .join(" · ");
}

/**
 * WHERE A PERMIT STANDS — one verdict, read by every door.
 *
 *   none           no inspections written down at all
 *   to_book        the next one is unblocked and nobody has called them: HIS
 *   booked         the next one has a day, today or later: THEIRS, and it comes back on that day
 *   overdue        the next one's day has gone by and nobody said how it went: HIS
 *   needs_another  the last visit did not pass, so somebody has to come again: HIS
 *   clear          every visit is settled and the last one passed, so the job is done (0378's own
 *                  answer to "when is the job done?"). NOT "the meter is on": a utility being last is
 *                  a fact about THAT job, and this app also serves decks, plumbing and painting.
 *
 * `needs_another` is also the answer when every open row is BLOCKED (the one in front failed): then
 * the thing that needs doing is another visit from the authority that failed, never the blocked row.
 * That is how a blocked inspection stays out of every pile without anything going quiet.
 */
export type InspectionStandState = "none" | "to_book" | "booked" | "overdue" | "needs_another" | "clear";

export interface InspectionStand {
  state: InspectionStandState;
  /** Who the verdict is about ("Liberty Utilities"), or null for `none` / `clear`. */
  authority: string | null;
  /** The row the verdict is about, when there is one. */
  row: PermitInspection | null;
  /** The day: the booked day (`booked` / `overdue`), or the day the last visit failed. */
  day: string | null;
  window: InspectionWindow | null;
  /** Is this the company's move? Exactly the states that may nag. */
  hisToDo: boolean;
  /** Waiting on somebody else, with the day it comes back. Never both this and `hisToDo`. */
  waitingOnThem: boolean;
  /** Every visit still owed, for the card's own list. */
  outstanding: PermitInspection[];
}

export function permitInspectionStand(
  rows: readonly PermitInspection[] | null | undefined,
  todayStr: string,
): InspectionStand {
  const ord = inOrder(rows);
  const open = ord.filter(isOpenInspection);
  const base = { row: null as PermitInspection | null, day: null as string | null, window: null as InspectionWindow | null, outstanding: open };

  if (!ord.length) return { ...base, state: "none", authority: null, hisToDo: false, waitingOnThem: false };

  // Nothing open: either the last one passed (done), or somebody has to come again.
  if (!open.length) {
    const last = ord[ord.length - 1];
    if (last.result === "passed") {
      return { ...base, state: "clear", authority: null, hisToDo: false, waitingOnThem: false };
    }
    return {
      ...base,
      state: "needs_another",
      authority: last.authority,
      row: last,
      day: isYmd(last.result_on) ? last.result_on : null,
      hisToDo: true,
      waitingOnThem: false,
    };
  }

  // THE GATE PICKS THE SUBJECT: the first open row that can actually be called. A blocked row is
  // never the subject — it is not his and it is not late.
  const next = open.find((r) => isUnblocked(ord, r.position));
  if (!next) {
    // Every open row waits on one in front that did not pass. THAT one is the work: the visit the
    // first open row is actually waiting for, never "the last failure anywhere" — a failure that has
    // already been re-booked is superseded and is nobody's work any more.
    const stuck = previousOf(ord, open[0].position) ?? ord[ord.length - 1];
    return {
      ...base,
      state: "needs_another",
      authority: stuck.authority,
      row: stuck,
      day: isYmd(stuck.result_on) ? stuck.result_on : null,
      hisToDo: true,
      waitingOnThem: false,
    };
  }

  const day = isYmd(next.scheduled_for) ? next.scheduled_for : null;
  if (!day) {
    return { ...base, state: "to_book", authority: next.authority, row: next, day: null, window: next.scheduled_window, hisToDo: true, waitingOnThem: false };
  }
  if (day < todayStr) {
    return { ...base, state: "overdue", authority: next.authority, row: next, day, window: next.scheduled_window, hisToDo: true, waitingOnThem: false };
  }
  return { ...base, state: "booked", authority: next.authority, row: next, day, window: next.scheduled_window, hisToDo: false, waitingOnThem: true };
}

/** Every visit passed, so the job is genuinely finished (0378's own answer to "when is the job
 *  done?"). Derived from the one verdict, so there is no second definition. */
export const allInspectionsPassed = (rows: readonly PermitInspection[] | null | undefined, todayStr: string): boolean =>
  permitInspectionStand(rows, todayStr).state === "clear";

/**
 * THE ONE LINE THE JOB AND THE CARD SAY. Plain words, the reader is an electrician between jobs.
 *   "Waiting on Liberty Utilities — Thu Oct 15, morning"
 *   "Town of Truckee inspection to book"
 *   "Town of Truckee was booked Oct 15 — record the inspection status"
 *   "Town of Truckee failed Oct 15 — book another visit"
 */
export function standLine(stand: InspectionStand): string | null {
  const who = stand.authority;
  // PLAIN, AND TRUE IN EVERY TRADE. This said "the meter is on", which is a fact about an ELECTRICAL
  // job whose last authority is the utility — nothing in the data says a utility came, and 0378 is
  // explicit that the utility being last is a fact about the world and not in the schema. So a deck
  // permit whose one county inspection passed told the builder the meter was on.
  if (!who) return stand.state === "clear" ? "Every inspection passed — the job is done" : null;
  const on = (d: string | null) => shortDayWords(d) ?? "";
  switch (stand.state) {
    case "booked": {
      const when = stand.row ? bookedWords(stand.row) : null;
      return `Waiting on ${who}${when ? ` — ${when}` : ""}`;
    }
    case "to_book":
      return `${who} inspection to book`;
    case "overdue":
      return `${who} was booked ${on(stand.day)} — record the inspection status`;
    case "needs_another": {
      const said = stand.row?.result === "cancelled" ? "cancelled" : "failed";
      const d = on(stand.day);
      return `${who} ${said}${d ? ` ${d}` : ""} — book another visit`;
    }
    default:
      return null;
  }
}

/**
 * A JOB CAN HAVE MORE THAN ONE PERMIT (electrical and building), so its ONE line is the most pressing
 * of their verdicts: his own move first, then what is waiting on somebody else. `clear` and `none`
 * never win — a job says nothing about a permit that wants nothing.
 *
 * The order inside each group is the order the permits came in, so the line is stable between reads.
 */
const STAND_RANK: Record<InspectionStandState, number> = {
  needs_another: 0,
  overdue: 1,
  to_book: 2,
  booked: 3,
  clear: 9,
  none: 9,
};

export function mostPressingStand(stands: readonly InspectionStand[]): InspectionStand | null {
  const live = (stands ?? []).filter((s) => s && STAND_RANK[s.state] < 9);
  if (!live.length) return null;
  return live.reduce((best, s) => (STAND_RANK[s.state] < STAND_RANK[best.state] ? s : best), live[0]);
}

/**
 * THE AUTHORITIES THIS COMPANY HAS CALLED BEFORE, offered as suggestions under a free text box.
 *
 * NEVER A FIXED LIST AND NEVER A DROPDOWN THAT CANNOT TAKE A NEW NAME: every town, county and
 * utility names itself differently, and a list this app invented would be wrong in the next county.
 * So the field is typed, and these are only a shortcut past the typing. The company's own spellings
 * win, exactly as they were entered ("Liberty Utilities" today, "NV Energy" in the next valley).
 */
export const AUTHORITY_SUGGESTION_MAX = 12;

export function authoritySuggestions(
  rows: readonly { authority?: string | null }[] | null | undefined,
  max = AUTHORITY_SUGGESTION_MAX,
): string[] {
  const seen = new Map<string, string>();
  for (const r of rows ?? []) {
    const a = String(r?.authority ?? "").trim();
    if (!a) continue;
    const key = a.toLowerCase();
    if (!seen.has(key)) seen.set(key, a);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b)).slice(0, Math.max(0, max));
}

/**
 * THE JOB'S WAITING STATE, IN THE WORDS THE DATABASE ALREADY HAS (0178's jobs.blocked_on /
 * blocked_since, whose vocabulary is lib/waiting-on).
 *
 * DERIVED, NEVER STORED. 0178 gave jobs and appointments a `blocked_on` and a `blocked_since` and
 * nothing in the app has ever written one. The temptation here is to start writing them from an
 * inspection — and that would be a second copy of a fact the permit's own rows already hold, free to
 * go stale the moment a row is edited from another screen. So the shape is borrowed and the value is
 * worked out from the rows every time it is asked. `isWaiting` / `isSchedulable` then answer
 * correctly for a job whose permit is waiting on an authority, which is the whole reason 0178's
 * columns exist: a job waiting on somebody else must never be asked for a date.
 *
 * ONLY `booked` is a wait. `to_book`, `overdue` and `needs_another` are HIS — those are the "to be
 * inspected" half of 0178's pair, an action, and they should nag.
 */
export function inspectionBlock(stand: InspectionStand): Blockable | null {
  if (!stand.waitingOnThem || !stand.authority) return null;
  return { blocked_on: `${stand.authority} inspection`, blocked_since: null };
}
