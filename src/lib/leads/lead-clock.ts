/**
 * HOW LONG A LEAD HAS WAITED (cn-v1170). Erik, 2026-11-19: "next to time stamp running clock since
 * lead arrival". The row shows the arrival time and, beside it, this: "14m", "2h 14m", "3d 4h".
 *
 * No thresholds and no colour: nobody has said when a wait becomes late. Pure: the caller hands the
 * clock's now and the unit templates (a lib never imports a catalog; the English is the default).
 */

export type ElapsedParts = { d: number; h: number; m: number };

/** Whole days, hours and minutes from `fromIso` to `nowMs`. A time ahead of now (a phone's clock
 *  a little behind the server's) reads as zero; a date that does not parse is null. */
export function elapsedParts(fromIso: string | null | undefined, nowMs: number): ElapsedParts | null {
  const from = Date.parse(String(fromIso ?? ""));
  if (!Number.isFinite(from) || !Number.isFinite(nowMs)) return null;
  const minutes = Math.max(0, Math.floor((nowMs - from) / 60_000));
  return { d: Math.floor(minutes / 1440), h: Math.floor((minutes % 1440) / 60), m: minutes % 60 };
}

/** The three shapes, as templates with {d} {h} {m}. */
export type ElapsedUnits = { minutes: string; hoursMinutes: string; daysHours: string };
export const ENGLISH_ELAPSED_UNITS: ElapsedUnits = { minutes: "{m}m", hoursMinutes: "{h}h {m}m", daysHours: "{d}d {h}h" };

/** Under an hour: minutes. Under a day: hours and minutes. After that: days and hours. */
export function sayElapsed(
  fromIso: string | null | undefined,
  nowMs: number,
  units: ElapsedUnits = ENGLISH_ELAPSED_UNITS,
): string | null {
  const p = elapsedParts(fromIso, nowMs);
  if (!p) return null;
  const tpl = p.d > 0 ? units.daysHours : p.h > 0 ? units.hoursMinutes : units.minutes;
  return tpl.replace("{d}", String(p.d)).replace("{h}", String(p.h)).replace("{m}", String(p.m));
}
