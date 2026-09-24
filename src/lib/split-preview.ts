/**
 * SPLIT PREVIEW: what one cut of a closed shift will produce, before anyone taps Split Shift.
 *
 * A split is a CUT (migration 0288, split_time_entry): the shift keeps its id as the first piece and
 * a second, ordinary entry starts at the cut. The pieces partition the shift, so they can never add
 * up to more than it did. This file is the same set of rules the database enforces, in the same
 * words, so the sheet can say "Total 5.5 h, same as the shift" and grey the button out before the
 * RPC has to refuse anything. The database stays the boundary; this only spares a round trip.
 *
 * Pure: no clock, no network. The sheet, Nort's fill and the tests all call it.
 */
import { todayStrInTz, tzOffsetMs } from "./tz";
import { hoursBetween } from "./utils";

export type SplitSide = "left" | "right";

/** The columns of a time entry a split reads. */
export interface SplitEntry {
  clock_in: string;
  clock_out: string | null;
  status?: string | null;
  lunch_minutes?: number | null;
  miles?: number | null;
  paid_at?: string | null;
  mileage_paid_at?: string | null;
}

export interface SplitPiece {
  start: string;
  end: string;
  lunchMinutes: number;
  miles: number;
  /** hoursBetween's figure: worked hours rounded to 0.01, the number payroll and billing read. */
  hours: number;
}

export interface SplitPreview {
  /** false when the cut cannot be made; `problem` says why in the sentence the database uses. */
  ok: boolean;
  problem: string | null;
  at: string;
  left: SplitPiece;
  right: SplitPiece;
  lunchOn: SplitSide;
  milesOn: SplitSide;
  /** The shift as it stands, and the two pieces added back up (their worked seconds, summed, then
   *  rounded once: the footer's "Total 5.5 h, same as the shift"). */
  shiftHours: number;
  totalHours: number;
  /** true when the pieces add back to exactly the shift's worked time. */
  sameAsShift: boolean;
}

const MIN_PIECE_MS = 60_000;

const ms = (iso: string) => new Date(iso).getTime();
const iso = (t: number) => new Date(t).toISOString();

const clockTime = (t: number, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
    .format(new Date(t))
    .replace(/\s+/g, "")
    .toLowerCase();

const dayLabel = (t: number, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(new Date(t));

/** True when a base-pay or mileage lock is on the shift: it was settled on its day. */
export function isPaidEntry(e: Pick<SplitEntry, "paid_at" | "mileage_paid_at">): boolean {
  return !!(e.paid_at || e.mileage_paid_at);
}

/**
 * The time the "Split At" picker opens on: the middle of the shift, rounded to the nearest 15 minutes
 * of the org's wall clock. Falls back to the exact middle (to the minute) when rounding would leave a
 * piece under a minute, which only happens on a very short shift.
 */
export function defaultSplitAt(entry: SplitEntry, tz = "America/Los_Angeles", stepMinutes = 15): string | null {
  if (!entry.clock_out) return null;
  const a = ms(entry.clock_in);
  const b = ms(entry.clock_out);
  if (!(b - a >= 2 * MIN_PIECE_MS)) return null;
  const mid = a + (b - a) / 2;
  const step = stepMinutes * 60_000;
  const off = tzOffsetMs(tz, new Date(mid));
  const rounded = Math.round((mid + off) / step) * step - off;
  if (rounded - a >= MIN_PIECE_MS && b - rounded >= MIN_PIECE_MS) return iso(rounded);
  const toMinute = Math.floor(mid / 60_000) * 60_000;
  return iso(toMinute - a >= MIN_PIECE_MS && b - toMinute >= MIN_PIECE_MS ? toMinute : mid);
}

/** The -15 / +15 chips: move the cut, never past a minute from either end of the shift. */
export function nudgeSplitAt(entry: SplitEntry, at: string, deltaMinutes: number): string {
  if (!entry.clock_out) return at;
  const lo = ms(entry.clock_in) + MIN_PIECE_MS;
  const hi = ms(entry.clock_out) - MIN_PIECE_MS;
  if (hi < lo) return at;
  return iso(Math.min(hi, Math.max(lo, ms(at) + deltaMinutes * 60_000)));
}

/** Seconds a piece works: its span minus its lunch. The number the database asserts is unchanged. */
export function workedSeconds(start: string, end: string, lunchMinutes = 0): number {
  return (ms(end) - ms(start)) / 1000 - Math.max(0, lunchMinutes || 0) * 60;
}

/**
 * Preview one cut at `at`. `lunchOn` null/undefined puts the lunch on the longer piece (the sheet's
 * default, and the RPC's); `milesOn` defaults to the first piece. Lunch and miles move whole.
 */
export function splitPreview(
  entry: SplitEntry,
  at: string,
  lunchOn?: SplitSide | null,
  opts: { milesOn?: SplitSide | null; tz?: string } = {},
): SplitPreview {
  const tz = opts.tz ?? "America/Los_Angeles";
  const lunch = Math.max(0, Number(entry.lunch_minutes) || 0);
  const miles = Math.max(0, Number(entry.miles) || 0);
  const a = ms(entry.clock_in);
  const b = entry.clock_out ? ms(entry.clock_out) : NaN;
  const t = ms(at);
  const spanL = t - a;
  const spanR = b - t;
  const side: SplitSide = lunchOn ?? (spanL >= spanR ? "left" : "right");
  const milesOn: SplitSide = opts.milesOn ?? "left";

  const left: SplitPiece = {
    start: entry.clock_in,
    end: at,
    lunchMinutes: side === "left" ? lunch : 0,
    miles: milesOn === "left" ? miles : 0,
    hours: 0,
  };
  const right: SplitPiece = {
    start: at,
    end: entry.clock_out ?? at,
    lunchMinutes: side === "right" ? lunch : 0,
    miles: milesOn === "right" ? miles : 0,
    hours: 0,
  };
  left.hours = hoursBetween(left.start, left.end, left.lunchMinutes);
  right.hours = hoursBetween(right.start, right.end, right.lunchMinutes);
  const shiftHours = entry.clock_out ? hoursBetween(entry.clock_in, entry.clock_out, lunch) : 0;
  const summed =
    Math.max(0, workedSeconds(left.start, left.end, left.lunchMinutes)) +
    Math.max(0, workedSeconds(right.start, right.end, right.lunchMinutes));
  const totalHours = Math.round((summed / 3600) * 100) / 100;

  const problem = ((): string | null => {
    if (!entry.clock_out || (entry.status != null && entry.status !== "closed")) {
      return "That shift is still running. Use Switch Job to start the next part now.";
    }
    if (!(b > a)) return "That shift has no length, so there is nothing to split.";
    if (!Number.isFinite(t) || t <= a || t >= b) {
      return `Pick a split time inside the shift, between ${clockTime(a, tz)} and ${clockTime(b, tz)}.`;
    }
    if (spanL < MIN_PIECE_MS || spanR < MIN_PIECE_MS) return "Each part has to be at least a minute long.";
    const lunchPieceSpan = side === "left" ? spanL : spanR;
    if (lunch > 0 && lunchPieceSpan - lunch * 60_000 < MIN_PIECE_MS) {
      return `The ${lunch}-minute lunch does not fit in the ${side === "left" ? "first" : "second"} part. Put it on the other part.`;
    }
    if (isPaidEntry(entry) && todayStrInTz(tz, new Date(t)) !== todayStrInTz(tz, new Date(a))) {
      return `That shift is already paid, so both parts have to stay on ${dayLabel(a, tz)}.`;
    }
    // Payroll rounds each ENTRY to 0.01 h, so two pieces can round to a cent more or less than the
    // shift did. On a paid shift that would move pay; the database refuses it, and so does this.
    if (entry.paid_at && Math.round((left.hours + right.hours) * 100) !== Math.round(shiftHours * 100)) {
      return "That split would change the paid hours on this shift by a rounding cent. Move the split time by a minute.";
    }
    return null;
  })();

  return {
    ok: problem === null,
    problem,
    at,
    left,
    right,
    lunchOn: side,
    milesOn,
    shiftHours,
    totalHours,
    sameAsShift: problem === null && totalHours === shiftHours,
  };
}
