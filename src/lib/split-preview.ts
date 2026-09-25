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
import { todayStrInTz, tzDateTimeUtc, tzOffsetMs } from "./tz";
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
  /** What payroll will PAY for the two parts: each entry rounded to 0.01 h on its own (hoursBetween),
   *  then added. Can differ from shiftHours by a hundredth (audit v994 SW9). */
  paidHours: number;
  /** paidHours minus shiftHours, to the hundredth: 0, or a rounding hundredth either way. */
  roundingDrift: number;
  /** true when the parts will be PAID exactly what the shift was (the footer's green "same"). */
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

/** "2:30pm" in the org's wall clock: the words the sheet, the toast and Nort all use for a cut. */
export function splitClock(isoOrMs: string | number, tz = "America/Los_Angeles"): string {
  const t = typeof isoOrMs === "number" ? isoOrMs : ms(isoOrMs);
  return Number.isFinite(t) ? clockTime(t, tz) : "";
}

/** "14:30": the value an <input type="time"> holds for an instant, in the org's wall clock. */
export function clockInputValue(iso: string, tz = "America/Los_Angeles"): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const h = parts.find((p) => p.type === "hour")?.value ?? "00";
  const m = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${h === "24" ? "00" : h}:${m}`;
}

/**
 * The instant a wall-clock "HH:MM" names inside this shift. The shift's own clock-in day first; a
 * shift that runs past midnight also tries the day it ended, so "01:30" on a 10pm-3am shift is the
 * next morning. Null when the time is unreadable or falls outside the shift (the preview then says
 * which times are allowed).
 */
export function atFromClockTime(entry: Pick<SplitEntry, "clock_in" | "clock_out">, hm: string, tz = "America/Los_Angeles"): string | null {
  if (!/^\d{1,2}:\d{2}$/.test(String(hm ?? "").trim()) || !entry.clock_out) return null;
  const a = ms(entry.clock_in);
  const b = ms(entry.clock_out);
  const days = [...new Set([todayStrInTz(tz, new Date(a)), todayStrInTz(tz, new Date(b))])];
  for (const d of days) {
    const iso = tzDateTimeUtc(d, hm.trim().padStart(5, "0"), tz);
    if (!iso) continue;
    const t = ms(iso);
    if (t > a && t < b) return new Date(t).toISOString();
  }
  return null;
}

/** True when a base-pay or mileage lock is on the shift: it was settled on its day. */
export function isPaidEntry(e: Pick<SplitEntry, "paid_at" | "mileage_paid_at">): boolean {
  return !!(e.paid_at || e.mileage_paid_at);
}

/**
 * THE PAID-HOURS ROUNDING CHECK, on its own. Payroll rounds each ENTRY to 0.01 h (hoursBetween), so
 * two pieces of a paid shift can round to a cent of an hour more or less than the shift was paid
 * for. Returns that difference in hours (0 when the cut keeps the paid total, or the shift is not
 * base-paid). split_time_entry refuses a non-zero one; the sheet's default and its chips skip it.
 */
export function paidRoundingDiff(entry: SplitEntry, at: string, lunchOn?: SplitSide | null): number {
  if (!entry.paid_at || !entry.clock_out) return 0;
  const a = ms(entry.clock_in);
  const b = ms(entry.clock_out);
  const t = ms(at);
  if (!Number.isFinite(t) || t <= a || t >= b) return 0;
  const lunch = Math.max(0, Number(entry.lunch_minutes) || 0);
  const side: SplitSide = lunchOn ?? (t - a >= b - t ? "left" : "right");
  const l = hoursBetween(entry.clock_in, at, side === "left" ? lunch : 0);
  const r = hoursBetween(at, entry.clock_out, side === "right" ? lunch : 0);
  const whole = hoursBetween(entry.clock_in, entry.clock_out, lunch);
  return Math.round((l + r - whole) * 100) / 100;
}

/**
 * On a paid shift, the nearest whole minute to `at` (within `reach` minutes, `prefer` direction
 * first) whose cut keeps the paid hours; `at` itself when it already does, or when nothing near does.
 * So the sheet never OPENS on a cut it would refuse, and a chip never lands on one.
 */
export function paidSafeSplitAt(
  entry: SplitEntry,
  at: string,
  opts: { lunchOn?: SplitSide | null; prefer?: 1 | -1; reach?: number } = {},
): string {
  if (!entry.paid_at || !entry.clock_out || paidRoundingDiff(entry, at, opts.lunchOn) === 0) return at;
  const a = ms(entry.clock_in) + MIN_PIECE_MS;
  const b = ms(entry.clock_out) - MIN_PIECE_MS;
  // Whole minutes: the sheet holds the cut as an HH:MM, so a candidate with seconds would be
  // re-read a few seconds away and could round the other way.
  const t = Math.floor(ms(at) / 60_000) * 60_000;
  const dir = opts.prefer ?? 1;
  if (t >= a && t <= b && paidRoundingDiff(entry, iso(t), opts.lunchOn) === 0) return iso(t);
  for (let k = 1; k <= (opts.reach ?? 7); k++) {
    for (const sign of [dir, -dir]) {
      const c = t + sign * k * 60_000;
      if (c < a || c > b) continue;
      if (paidRoundingDiff(entry, iso(c), opts.lunchOn) === 0) return iso(c);
    }
  }
  return at;
}

/**
 * The time the "Split At" picker opens on: the middle of the shift, rounded to the nearest 15 minutes
 * of the org's wall clock. Falls back to the exact middle (to the minute) when rounding would leave a
 * piece under a minute, which only happens on a very short shift. On a paid shift, a middle that would
 * move the paid hours by a rounding cent steps to the nearest minute that does not.
 */
export function defaultSplitAt(entry: SplitEntry, tz = "America/Los_Angeles", stepMinutes = 15): string | null {
  if (!entry.clock_out) return null;
  const a = ms(entry.clock_in);
  const b = ms(entry.clock_out);
  if (!(b - a >= 2 * MIN_PIECE_MS)) return null;
  const mid = a + (b - a) / 2;
  const step = stepMinutes * 60_000;
  // The zone's offset in whole minutes: the wall-clock read behind tzOffsetMs drops milliseconds, and
  // a middle on a half second otherwise came back as a cut at hh:mm:00.500.
  const off = Math.round(tzOffsetMs(tz, new Date(mid)) / 60_000) * 60_000;
  const rounded = Math.round((mid + off) / step) * step - off;
  if (rounded - a >= MIN_PIECE_MS && b - rounded >= MIN_PIECE_MS) return paidSafeSplitAt(entry, iso(rounded));
  const toMinute = Math.floor(mid / 60_000) * 60_000;
  return paidSafeSplitAt(entry, iso(toMinute - a >= MIN_PIECE_MS && b - toMinute >= MIN_PIECE_MS ? toMinute : mid));
}

/** The -15 / +15 chips: move the cut, never past a minute from either end of the shift, and (on a
 *  paid shift) never onto a minute that would move the paid hours: it steps on in the same direction. */
export function nudgeSplitAt(
  entry: SplitEntry,
  at: string,
  deltaMinutes: number,
  opts: { lunchOn?: SplitSide | null } = {},
): string {
  if (!entry.clock_out) return at;
  const lo = ms(entry.clock_in) + MIN_PIECE_MS;
  const hi = ms(entry.clock_out) - MIN_PIECE_MS;
  if (hi < lo) return at;
  const moved = iso(Math.min(hi, Math.max(lo, ms(at) + deltaMinutes * 60_000)));
  return paidSafeSplitAt(entry, moved, { lunchOn: opts.lunchOn, prefer: deltaMinutes < 0 ? -1 : 1 });
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
  // PAYROLL ROUNDS EACH ENTRY (audit v994 SW9): 08:00:20 to 13:00:50 cut at 10:00 is 1.99 + 3.01 =
  // 5.00 paid, while the summed seconds say 5.01. The green "same as the shift" is only said when
  // the parts will be PAID what the shift was; otherwise the footer names the hundredth.
  const paidHours = Math.round((left.hours + right.hours) * 100) / 100;
  const roundingDrift = Math.round((paidHours - shiftHours) * 100) / 100;

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
    // shift did. On a paid shift that would move pay; the database refuses it, and so does this, in
    // the same sentence (time, then the hours it would move).
    const diff = paidRoundingDiff(entry, at, side);
    if (diff !== 0) {
      return `Cutting at ${clockTime(t, tz)} would change the paid hours on this shift by ${Math.abs(diff)} h. Move the split a minute earlier or later.`;
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
    paidHours,
    roundingDrift,
    sameAsShift: problem === null && paidHours === shiftHours,
  };
}
